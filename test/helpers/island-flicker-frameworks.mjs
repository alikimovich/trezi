// LKM-140: measure shadow flicker on real Next.js (Webpack dev) and Vite/CSS fixtures in system WebKit.
import './with-service-owners.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { waitForReachable } from '../../src/main/devserver-net.ts'
import { PREVIEW_HOST, withPort } from '../../src/main/project-detect.ts'
import { MDX_HELPER_CONTENT } from '../../src/main/setup-mdx.ts'
import { NEXT_ADAPTER_CONTENT, NEXT_LOADER_CONTENT } from '../../src/main/setup-next.ts'
import { REACT_HELPER_CONTENT } from '../../src/main/setup-react.ts'
import { spawnHostBridge } from './host-bridge.mjs'
import { measureFramework, resetPreviewSource } from './island-flicker-framework-core.mjs'

if (process.platform !== 'darwin' || !existsSync('out/native/Trezi.app/Contents/MacOS/TreziHost')) {
  console.log('ISLAND-FLICKER-FRAMEWORKS SKIP — build the macOS native host first.')
  process.exit(0)
}

async function install(cwd) {
  const installed = spawnSync('bun', ['install'], { cwd, stdio: 'pipe', timeout: 120000 })
  if (installed.status !== 0) {
    console.log(
      'ISLAND-FLICKER-FRAMEWORKS SKIP — could not install fixture dependencies:',
      (installed.stderr || installed.stdout)?.toString().slice(0, 240)
    )
    process.exit(0)
  }
}

/** A port the kernel just handed out from its ephemeral range. */
async function ephemeralPort() {
  const probe = createServer()
  await new Promise((done, fail) => {
    probe.once('error', fail)
    probe.listen(0, PREVIEW_HOST, done)
  })
  const { port } = probe.address()
  await new Promise((done) => probe.close(done))
  return port
}

/**
 * Not a port from 7777: Trezi's own allocator and other dev-server tests (a parallel
 * dependency-refresh-vite, another checkout) probe that range too, and could take the
 * port between the probe and this server's bind. Next then exits only after the URL
 * already answered with the stranger's app. A server that still exits before it is
 * reachable starts again on a fresh port.
 */
async function withServer({ cwd, command, framework, urlPath, run }, attempt = 1) {
  const port = await ephemeralPort()
  const server = spawn('/bin/sh', ['-c', withPort(command, framework, port)], {
    cwd,
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      BROWSER: 'none',
      PORT: String(port),
      HOST: PREVIEW_HOST,
      HOSTNAME: PREVIEW_HOST
    }
  })
  const url = `http://${PREVIEW_HOST}:${port}${urlPath}`
  let retry = false
  try {
    const deadline = Date.now() + 120000
    const reachable = await waitForReachable(
      [url],
      () => Date.now() > deadline || server.exitCode !== null
    )
    if (server.exitCode !== null && attempt < 3) {
      console.log(
        `ISLAND-FLICKER-FRAMEWORKS port ${port} lost before ${framework} bound it; retrying`
      )
      retry = true
    } else {
      assert.ok(reachable && server.exitCode === null, `dev server reachable at ${url}`)
      return await run(url)
    }
  } finally {
    try {
      if (server?.pid) process.kill(-server.pid, 'SIGTERM')
    } catch {}
  }
  if (retry) return withServer({ cwd, command, framework, urlPath, run }, attempt + 1)
}

async function withHost(run) {
  const host = spawnHostBridge(
    resolve('out/native/Trezi.app/Contents/MacOS/TreziHost'),
    resolve('out/native'),
    'ephemeral'
  )
  try {
    await once(host, 'ready', { signal: AbortSignal.timeout(15000) })
    host.send('visible', { view: 'preview', visible: true })
    const page = (code) => host.request('evaluate', { view: 'preview', code })
    async function wait(check, label = 'page', polls = 200) {
      for (let i = 0; i < polls; i++) {
        try {
          if (await check()) return
        } catch {}
        await Bun.sleep(100)
      }
      throw Error('timed out: ' + label)
    }
    return await run({ host, page, wait })
  } finally {
    host.send('quit')
  }
}

/**
 * Cache-busted preview loads; each waits until the new document (not the old one) has the card.
 * Vite's full-reload of the old page, sent when the source was just rewritten, can cancel a
 * navigation that is still starting and reload the old URL instead: the load is sent again.
 */
function opener(host, page, wait, url) {
  let seq = 0
  return async () => {
    let failure
    for (let attempt = 0; attempt < 4; attempt++) {
      const href = `${url}${url.includes('?') ? '&' : '?'}trezi-load=${++seq}`
      host.send('load', { view: 'preview', url: href })
      try {
        return await wait(
          () =>
            page(
              `location.href === ${JSON.stringify(href)} && !!document.querySelector("#shadow-phone")`
            ),
          href,
          50
        )
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }
}

/** True once `url` (the page or the island module) carries `css`; else what it serves instead. */
function servedAt(url) {
  return async (css) => {
    const text = await (await fetch(url, { cache: 'no-store' })).text()
    if (text.includes(css)) return true
    const at = text.indexOf('rgba(0, 0, 0, 0.35)')
    return at < 0 ? `no shadow literal in ${url}` : text.slice(Math.max(0, at - 30), at + 110)
  }
}

/** The LKM-133 live-write drag, a reset to the initial source, then the override drag. */
async function measureBoth({
  host,
  page,
  wait,
  url,
  served,
  label,
  root,
  sourceFile,
  component,
  format
}) {
  const open = opener(host, page, wait, url)
  await open()
  const run = (withOverrides) =>
    measureFramework({
      label,
      page,
      waitForCard: open,
      served,
      root,
      sourceFile,
      component,
      withOverrides
    })
  await run(false)
  await resetPreviewSource(page, root, sourceFile, format, open, served)
  await run(true)
}

async function prepareNext(root) {
  await cp(resolve('test/fixtures/next-app'), root, {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.endsWith('bun.lock')
  })
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  pkg.dependencies.next = '16.3.5'
  pkg.dependencies['@next/mdx'] = '16.3.5'
  pkg.dependencies.react = '19.3.0'
  pkg.dependencies['react-dom'] = '19.3.0'
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg))
  await mkdir(join(root, '.trezi'), { recursive: true })
  for (const [file, text] of Object.entries({
    'trezi-next.cjs': NEXT_ADAPTER_CONTENT,
    'trezi-next-loader.cjs': NEXT_LOADER_CONTENT,
    'trezi-source.cjs': REACT_HELPER_CONTENT,
    'trezi-mdx.mjs': MDX_HELPER_CONTENT
  }))
    await writeFile(join(root, '.trezi', file), text)
  await install(root)
}

async function prepareVite(root) {
  await cp(resolve('test/fixtures/island-flicker-vite'), root, {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.endsWith('bun.lock')
  })
  await install(root)
}

const nextRoot = await mkdtemp(join(tmpdir(), 'trezi-flicker-next-'))
const viteRoot = await mkdtemp(join(tmpdir(), 'trezi-flicker-vite-'))
try {
  await prepareNext(nextRoot)
  await prepareVite(viteRoot)

  await withHost(async ({ host, page, wait }) => {
    await withServer({
      cwd: nextRoot,
      command: 'bun run dev --webpack',
      framework: 'next',
      urlPath: '/shadow-flicker',
      run: (url) =>
        measureBoth({
          host,
          page,
          wait,
          url,
          served: servedAt(url),
          label: 'next',
          root: nextRoot,
          sourceFile: 'app/shadow-flicker/ShadowPhone.tsx',
          component: 'ShadowPhone',
          format: 'tsx'
        })
    })

    await withServer({
      cwd: viteRoot,
      command: 'bun run dev',
      framework: 'vite',
      urlPath: '/',
      run: (url) =>
        measureBoth({
          host,
          page,
          wait,
          url,
          served: servedAt(new URL('/src/phone.js', url).href),
          label: 'vite',
          root: viteRoot,
          sourceFile: 'src/phone.js',
          component: 'Shadow',
          format: 'js'
        })
    })
  })

  console.log('ISLAND-FLICKER-FRAMEWORKS PASS')
} finally {
  await rm(nextRoot, { recursive: true, force: true })
  await rm(viteRoot, { recursive: true, force: true })
}
