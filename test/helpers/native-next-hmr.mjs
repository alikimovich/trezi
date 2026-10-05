// The islands go through the service's editing and source owners: the real Swift ones.
import './with-service-owners.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChatIslands } from '../../src/main/chat-islands.ts'
import { findFreePort, waitForReachable } from '../../src/main/devserver-net.ts'
import { PREVIEW_HOST, withPort } from '../../src/main/project-detect.ts'
import { MDX_HELPER_CONTENT } from '../../src/main/setup-mdx.ts'
import { NEXT_ADAPTER_CONTENT, NEXT_LOADER_CONTENT } from '../../src/main/setup-next.ts'
import { REACT_HELPER_CONTENT } from '../../src/main/setup-react.ts'
import { spawnHostBridge } from './host-bridge.mjs'

if (process.platform !== 'darwin' || !existsSync('out/native/Trezi.app/Contents/MacOS/TreziHost')) {
  console.log('NATIVE-NEXT-HMR SKIP — build the macOS native host first.')
  process.exit(0)
}
const root = await mkdtemp(join(tmpdir(), 'trezi-hmr-'))
let host, server
try {
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
  const card = await readFile(join(root, 'app/Card.tsx'), 'utf8')
  await writeFile(join(root, 'app/Leaf.tsx'), card.replace("'use client'\n", ''))
  await writeFile(
    join(root, 'app/Card.tsx'),
    "'use client'; import Leaf from './Leaf'; import Effect from './Effect'; export default function Card({label}:{label:string}) {return <><Leaf label={label}/><Effect/></> }"
  )
  await writeFile(
    join(root, 'app/hover-effect.ts'),
    `'use client';
import { useEffect, type RefObject } from 'react';
const RADIUS = 32;
function attach(node: HTMLElement) {
  const enter = () => { node.style.width = RADIUS + 'px' };
  node.addEventListener('mouseenter', enter);
  return () => node.removeEventListener('mouseenter', enter);
}
export default function HoverEffect({ targetRef }: {targetRef: RefObject<HTMLDivElement | null>}) {
  const install = attach;
  useEffect(() => install(targetRef.current!), [targetRef, install]);
  return null;
}`
  )
  await writeFile(
    join(root, 'app/Effect.tsx'),
    `'use client';
import { useRef } from 'react';
import dynamic from 'next/dynamic';
const HoverEffect = dynamic(() => import('./hover-effect'), {ssr:false});
export default function Effect() {
  const ref = useRef<HTMLDivElement>(null);
  return <><HoverEffect targetRef={ref}/><div ref={ref} data-hover-effect style={{height:20}}>Hover effect</div></>;
}`
  )
  const installed = spawnSync('bun', ['install'], { cwd: root, stdio: 'inherit', timeout: 120000 })
  if (installed.error) throw installed.error
  if (installed.status !== 0) throw Error('install failed')
  // Trezi's runtime owner is tested in runtime-owner; here the project's own server,
  // started with the same command and port, in its own process group.
  const port = await findFreePort(7777)
  server = spawn('/bin/sh', ['-c', withPort('bun run dev --webpack', 'next', port)], {
    cwd: root,
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
  const info = { url: `http://${PREVIEW_HOST}:${port}` }
  const deadline = Date.now() + 120000
  assert.ok(
    await waitForReachable([info.url], () => Date.now() > deadline || server.exitCode !== null),
    'the Next dev server is reachable'
  )
  host = spawnHostBridge(
    resolve('out/native/Trezi.app/Contents/MacOS/TreziHost'),
    resolve('out/native'),
    'ephemeral'
  )
  await once(host, 'ready', { signal: AbortSignal.timeout(15000) })
  host.send('visible', { view: 'preview', visible: true })
  host.send('load', { view: 'preview', url: info.url })
  const page = (code) => host.request('evaluate', { view: 'preview', code })
  async function wait(check, label = 'page update') {
    for (let i = 0; i < 200; i++) {
      try {
        if (await check()) return
      } catch {}
      await Bun.sleep(100)
    }
    throw Error('timed out: ' + label)
  }
  await wait(() => page('!!document.querySelector("button")'))

  await wait(async () => {
    await page('document.querySelector("button").click()')
    return page('document.querySelector("button").textContent.includes(": 1")')
  })
  await page('window.hmrSentinel=42')
  await Bun.sleep(1500)
  const file = join(root, 'app/Leaf.tsx')
  const code = await readFile(file, 'utf8')
  await writeFile(file, code.replace('{label}: {count}', 'Updated {label}: {count}'))
  await wait(() => page('document.body.innerText.includes("Updated First")'))
  assert.equal(
    await page('window.hmrSentinel'),
    42,
    'Agent-style source edits use HMR without a page reload'
  )
  // Exercise the same validated source transaction used by chat controls.
  const shadowCode = (await readFile(file, 'utf8'))
    .replace('import { useState }', 'const SHADOW_BLUR = 12;\nimport { useState }')
    .replace(
      '<button onClick=',
      '<button style={{boxShadow: `0px 8px ${SHADOW_BLUR}px rgba(0,0,0,0.3)`}} onClick='
    )
  await writeFile(file, shadowCode)
  const shadow = () => page('document.querySelector("button").style.boxShadow')
  await wait(async () => String(await shadow()).includes('12px'))
  const initial = await shadow()
  const islands = new ChatIslands(() => {})
  islands.register('test', root, 'test', () => 1)
  const made = await islands.tool('test', root, {
    action: 'define',
    engine: 'agent',
    manifest: {
      file: 'app/Leaf.tsx',
      component: 'Card',
      title: 'Shadow',
      params: [
        {
          id: 'blur',
          label: 'Blur',
          kind: 'number',
          min: 0,
          max: 100,
          apply: { strategy: 'literal', anchor: 'const SHADOW_BLUR = ' }
        }
      ]
    },
    blocks: [{ id: 'shadow', title: 'Shadow', kind: 'group', params: ['blur'] }]
  })
  assert.ok(made.id, JSON.stringify(made))
  await islands.settle('test', true)
  const interact = async (action, values = {}) => {
    const view = islands.sessions.get('test').views.get(made.id)
    await islands.interact({
      chat: 'test',
      id: made.id,
      revision: view.revision,
      sourceRevision: view.sourceRevision,
      operation: crypto.randomUUID(),
      action,
      values
    })
  }
  await interact('commit', { blur: 36 })
  await wait(async () => String(await shadow()).includes('36px'))
  assert.equal(await page('window.hmrSentinel'), 42, 'Control commit must not reload the page')
  await interact('undo')
  await wait(async () => (await shadow()) === initial)
  assert.equal(await page('window.hmrSentinel'), 42, 'Undo must not reload the page')
  console.log('Component, source controls and Undo passed; checking imported hover callback.')
  const effect = await islands.tool('test', root, {
    action: 'define',
    engine: 'agent',
    manifest: {
      file: 'app/hover-effect.ts',
      component: 'Effect',
      title: 'Hover radius',
      params: [
        {
          id: 'radius',
          label: 'Radius',
          kind: 'number',
          min: 1,
          max: 100,
          apply: { strategy: 'literal', anchor: 'const RADIUS = ' }
        }
      ]
    },
    blocks: [{ id: 'geometry', title: 'Geometry', kind: 'group', params: ['radius'] }]
  })
  assert.ok(effect.id, JSON.stringify(effect))
  await islands.settle('test', true)
  const radius = () =>
    page(
      `(()=>{const el=document.querySelector('[data-hover-effect]');el.dispatchEvent(new MouseEvent('mouseenter'));return el.style.width})()`
    )
  assert.equal(await radius(), '32px')
  const changeEffect = async (action, values = {}) => {
    const v = islands.sessions.get('test').views.get(effect.id)
    await islands.interact({
      chat: 'test',
      id: effect.id,
      revision: v.revision,
      sourceRevision: v.sourceRevision,
      operation: crypto.randomUUID(),
      action,
      values
    })
  }
  await changeEffect('commit', { radius: 80 })
  await wait(async () => (await radius()) === '80px', 'imported radius 80')
  await changeEffect('undo')
  await wait(async () => (await radius()) === '32px')
  assert.equal(
    await page('window.hmrSentinel'),
    42,
    'Imported imperative effects refresh without navigation'
  )
  console.log(
    'NATIVE-NEXT-HMR PASS — Next 16.3.5 Webpack Fast Refresh, island source commit and Undo in system WebKit without page reload; no provider calls.'
  )
} finally {
  host?.send('quit')
  try {
    if (server?.pid) process.kill(-server.pid, 'SIGTERM')
  } catch {}
  await rm(root, { recursive: true, force: true })
}
