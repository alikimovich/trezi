import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { previewLoads } from '../main/preview-loads'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

type Page = (code: string) => Promise<unknown>
const TITLES = ['Reload Without Cache', 'Restart Dev Server (clean cache)']

/**
 * LKM-197: the preview toolbar's "…" menu. Its entries are picked through the shell's
 * `preview-more` action (the same `previewMenuAction` a click reaches). Reload Without
 * Cache must navigate the preview again; Restart Dev Server (clean cache) must pass
 * through "Restarting <name> with a clean cache…", delete `node_modules/.vite` under
 * the project (which only a `cleanCache` start does) and load the page again.
 */
export async function checkToolbarMore(host: NativeBridge, page: Page) {
  const state = await host.request('shellInspect')
  assert.deepEqual(state.moreMenu, TITLES, 'the … menu lists both entries')
  assert.equal(state.moreEnabled, true, 'the … menu is enabled with a running preview')
  assert.equal(
    await host.request('shellPerform', { action: 'preview-more', row: 'nothing' }),
    false,
    'an unknown entry is refused'
  )

  // Reload Without Cache: the page navigates again (a script-set marker is gone).
  assert.equal(await page('(() => { window.moreMarker = 1; return window.moreMarker })()'), 1)
  const reloaded = previewLoads.nextLoad(null, 15000)
  assert.equal(
    await host.request('shellPerform', { action: 'preview-more', row: 'reload-hard' }),
    true,
    'Reload Without Cache is performed'
  )
  const reload = await reloaded.done
  assert.equal(
    reload?.outcome,
    'loaded',
    `Reload Without Cache loads the page: ${JSON.stringify(reload)}`
  )
  await waitFor(
    async () => (await page('typeof window.moreMarker')) === 'undefined',
    'the page was reloaded by Reload Without Cache',
    5000
  )

  // Restart Dev Server (clean cache): the stale Vite cache is removed by the clean start.
  const entry = nativeWorkspace.active
  assert.ok(entry, 'a project is active')
  const cache = join(entry.root, 'node_modules', '.vite')
  const modules = join(entry.root, 'node_modules')
  const hadModules = existsSync(modules)
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, 'stale.json'), '{}')
  const labels = new Set<string>()
  const watch = setInterval(() => {
    const status = nativeWorkspace.state.status
    if (status.kind === 'busy') labels.add(status.label)
  }, 10)
  try {
    const restarted = previewLoads.nextLoad(null, 45000)
    assert.equal(
      await host.request('shellPerform', { action: 'preview-more', row: 'restart-clean' }),
      true,
      'Restart Dev Server (clean cache) is performed'
    )
    const label = `Restarting ${entry.name} with a clean cache…`
    await waitFor(
      () => labels.has(label) && nativeWorkspace.state.status.kind === 'running',
      'the clean restart passes through its status and runs again',
      45000,
      () => ({ labels: [...labels], status: nativeWorkspace.state.status })
    )
    assert.equal(existsSync(cache), false, 'the clean start removed node_modules/.vite')
    const load = await restarted.done
    assert.equal(
      load?.outcome,
      'loaded',
      `the preview loads after the restart: ${JSON.stringify(load)}`
    )
    await waitFor(
      async () => (await page('!!document.querySelector("#native-title")')) === true,
      'the fixture page shows after the restart',
      15000
    )
  } finally {
    clearInterval(watch)
    if (!hadModules) rmSync(modules, { recursive: true, force: true })
    else rmSync(cache, { recursive: true, force: true })
  }
}
