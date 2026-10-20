import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  managedBrowserCodexConfig,
  managedBrowserDirectory,
  managedBrowserEnv,
  managedBrowserPath,
  managedBrowserWrapper
} from '../main/backends/managed-browser-path'
import { previewServers } from '../main/preview-evidence'
import { projectKey } from '../shared/projectKey'
import type { NativeBridge } from './bridge'
import { nativeWorkspace } from './workspace-runtime'

type Page = (code: string) => Promise<unknown>
const SESSION = 'trezi-native-focus'
const USER_STATE =
  'JSON.stringify({url:location.href,width:innerWidth,x:scrollX,y:scrollY,selection:getSelection()?.toString(),active:document.activeElement?.tagName,title:document.title})'

/** Real Vercel CLI through the same managed wrapper the provider helper puts on PATH. */
export async function checkManagedAgentBrowser(host: NativeBridge, page: Page, artifacts: string) {
  const active = nativeWorkspace.active
  assert.ok(active, 'an open project for browser verification')
  const server = previewServers.get(projectKey(active.root))
  assert.ok(server, 'Trezi-managed preview server is running')
  // The provider helper's own resolution: same functions, same bundle base. LOCAL-WEBKIT-4:
  // a bundle resolves only the copy packaged inside Trezi.app, never the checkout's bin.
  const managedDir = managedBrowserDirectory(__dirname)
  assert.ok(managedDir, 'managed browser directory resolves from the built bundle')
  assert.ok(
    managedDir.endsWith('.app/Contents/Resources/browser/bin/managed'),
    `packaged managed wrapper: ${managedDir}`
  )
  const wrapper = managedBrowserWrapper(__dirname)
  assert.equal(wrapper, join(managedDir, 'agent-browser'), 'verified absolute managed wrapper')
  const helperPath = managedBrowserPath(managedDir, process.env.PATH, process.execPath)
  // LKM-269: real provider shells, with a global agent-browser first on the inherited PATH
  // and a throwaway ZDOTDIR profile that reorders PATH like a login shell does on macOS.
  const fixture = join(artifacts, 'managed-route')
  const globalBin = join(fixture, 'global/bin')
  mkdirSync(globalBin, { recursive: true })
  writeFileSync(join(globalBin, 'agent-browser'), '#!/bin/sh\necho GLOBAL\n', { mode: 0o755 })
  writeFileSync(join(fixture, '.zprofile'), `export PATH="${globalBin}:$PATH"\n`)
  const inherited = `${globalBin}:${process.env.PATH ?? '/usr/bin:/bin'}`
  const shell = (flags: string, script: string, env: Record<string, string>) => {
    const proc = spawnSync('/bin/zsh', [flags, script], {
      env: { ...env, ZDOTDIR: fixture, HOME: fixture },
      encoding: 'utf8'
    })
    assert.equal(proc.status, 0, proc.stderr)
    return proc.stdout.trim()
  }
  const route = managedBrowserEnv(__dirname, inherited, process.execPath)
  assert.equal(route.TREZI_AGENT_BROWSER, wrapper, 'helper environment carries the wrapper')
  assert.equal(
    shell('-c', 'command -v agent-browser', route),
    wrapper,
    'non-login shell resolves the wrapper'
  )
  assert.equal(
    shell('-lc', 'echo "$TREZI_AGENT_BROWSER"', route),
    wrapper,
    'a login shell that rebuilds PATH still has the absolute wrapper'
  )
  assert.equal(
    shell('-lc', 'command -v agent-browser', route),
    join(globalBin, 'agent-browser'),
    'fixture: a login shell alone would pick the global CLI'
  )
  const codex = managedBrowserCodexConfig(__dirname, inherited, process.execPath)
  assert.equal(codex.allow_login_shell, false, 'Codex shell tool runs without a login shell')
  assert.equal(
    shell('-c', 'command -v agent-browser', { ...codex.shell_environment_policy?.set }),
    wrapper,
    'Codex dispatch environment resolves agent-browser to the managed wrapper'
  )
  const focus = () => host.request('smokeFocusSnapshot') as Promise<Record<string, unknown>>
  const before = await focus()
  let expectedFocus = before
  const userBefore = await page(USER_STATE)
  const samples: Record<string, unknown>[] = []
  const run = async (phase: string, args: string[], started?: () => Promise<void>) => {
    const proc = spawn(process.execPath, [wrapper, '--session', SESSION, ...args], {
      cwd: active.root,
      env: { ...process.env, PATH: helperPath },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      proc.once('error', reject)
      proc.once('exit', resolve)
    })
    if (started) await started()
    const code = await exited
    assert.equal(code, 0, `${phase}: ${stderr.slice(-1000)} ${stdout.slice(-500)}`)
    const after = await focus()
    samples.push({ phase, ...after })
    for (const field of [
      'frontmostPID',
      'key',
      'responder',
      'resignCount',
      'keyLostCount',
      'activationCount',
      'cursorX',
      'cursorY'
    ])
      assert.equal(after[field], expectedFocus[field], `${phase}: ${field} changed`)
    assert.equal(await page(USER_STATE), userBefore, `${phase}: visible preview changed`)
    return stdout
  }
  let failure: unknown = null
  try {
    const url = new URL('/filter.html', server.url).href
    await run('cold open', ['open', url])
    await run('warm navigation', ['open', url])
    const screenshot = join(artifacts, 'managed-agent-browser.png')
    await run('first screenshot', ['screenshot', screenshot])
    assert.ok(existsSync(screenshot), 'Vercel agent-browser saved a screenshot')
    await run('click filter', ['click', '#filter-design'])
    await run('type search', ['fill', '#search', 'tokens'])
    assert.match(await run('read input', ['get', 'text', '#echo']), /tokens/)
    // The CLI remains alive while Finder becomes frontmost. Browser completion
    // must leave that app active instead of reactivating Trezi or Chrome.
    await run('another app frontmost', ['wait', '1000'], async () => {
      assert.equal(await host.request('smokeActivateFinder'), true, 'Finder is running')
      // Trezi resigns key asynchronously after the test activates Finder: take the
      // baseline once Finder is frontmost and two consecutive samples agree.
      let previous = JSON.stringify(await focus())
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const current = await focus()
        const serialized = JSON.stringify(current)
        expectedFocus = current
        if (current.frontmostBundle === 'com.apple.finder' && serialized === previous) break
        previous = serialized
      }
      assert.equal(expectedFocus.frontmostBundle, 'com.apple.finder')
    })
  } catch (error) {
    failure = error
  }
  try {
    await run('close own session', ['close'])
  } catch (error) {
    failure ??= error
  } finally {
    await host.request('smokeFocus', { restore: true })
  }
  if (failure) throw failure
  console.log(`Managed agent-browser focus: ${JSON.stringify({ before, samples })}`)
}
