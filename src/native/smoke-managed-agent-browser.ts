import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { managedBrowserDirectory, managedBrowserPath } from '../main/backends/managed-browser-path'
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
  // The provider helper's own resolution: same functions, same bundle base (out/native).
  const managedDir = managedBrowserDirectory(__dirname)
  assert.ok(managedDir, 'managed browser directory resolves from the built bundle')
  const wrapper = join(managedDir, 'agent-browser')
  const helperPath = managedBrowserPath(managedDir, process.env.PATH, process.execPath)
  const resolved = helperPath
    .split(':')
    .map((dir) => join(dir, 'agent-browser'))
    .find(existsSync)
  assert.equal(resolved, wrapper, 'agent-browser on the helper PATH is the managed wrapper')
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
