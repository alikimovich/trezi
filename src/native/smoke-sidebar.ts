import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NativeBridge } from './bridge'
import { preparePreviewInput } from './smoke-input'
import { nativeWorkspace } from './workspace-runtime'

type FocusHost = Pick<NativeBridge, 'request'>
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fails with every leftover the host reports: tracking menu, sheet/popover, key/main window, inactive app. */
export function assertSidebarFocusClean(report: { problems?: string[] }, stage: string) {
  const problems = report?.problems
  assert.ok(Array.isArray(problems), `Sidebar ${stage}: host returned no focus report`)
  assert.equal(
    problems.length,
    0,
    `Sidebar ${stage} left the foreground dirty: ${problems.join('; ')}`
  )
}

/** Dismiss menus, sheets, popovers and hover, re-key the main window, then require a clean foreground.
 *  Waits for AppKit activation and Bun's sheet dismissal to settle; it never retries a capture. */
export async function restoreSidebarFocus(host: FocusHost, stage: string, settleMs = 3000) {
  let report = await host.request('sidebarFocus', { cleanup: true })
  for (const end = Date.now() + settleMs; report?.problems?.length && Date.now() < end; ) {
    await pause(80)
    report = await host.request('sidebarFocus')
  }
  assertSidebarFocusClean(report, stage)
}

/** Teardown runs on success and failure; a cleanup failure never hides the original error. */
export async function withSidebarCleanup(
  host: FocusHost,
  body: () => Promise<void>,
  teardown: () => Promise<void> = async () => {}
) {
  let failure: unknown
  try {
    await body()
  } catch (error) {
    failure = error
  }
  try {
    await teardown()
    await restoreSidebarFocus(host, 'teardown')
  } catch (cleanup) {
    if (!failure) throw cleanup
    if (failure instanceof Error)
      failure.message += `\n(sidebar teardown also failed: ${(cleanup as Error)?.message ?? cleanup})`
  }
  if (failure) throw failure
}

/** Runs in checkProjectSwitching's two-project fixture, inside the normal native suite. */
export async function checkVisibleSidebar(host: NativeBridge, artifacts: string) {
  const initial = await host.request('shellInspect')
  assert.deepEqual(
    initial.sidebarActions,
    ['new-project', 'open-project'],
    'No Settings gear in the sidebar'
  )
  const entries = [...nativeWorkspace.state.projects]
  assert.equal(entries.length, 2, 'Sidebar fixture requires two projects')
  // LKM-372: a third project whose favicon.png passes the lookup's byte sniff but cannot be
  // decoded; the sidebar must keep its folder. Opening it makes it the active project until the
  // loop selects the other rows. Its own folder name keeps it apart from checkChatGate's
  // 'Folder Gamma', which expects a never-opened root; teardown closes and removes it.
  const invalidRoot = join(dirname(entries[0].root), 'Folder Invalid Icon')
  rmSync(invalidRoot, { recursive: true, force: true })
  mkdirSync(invalidRoot, { recursive: true })
  writeFileSync(join(invalidRoot, 'index.html'), '<h1 id="third-project">Third project</h1>')
  writeFileSync(
    join(invalidRoot, 'favicon.png'),
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('corrupt: not a PNG body')])
  )
  await nativeWorkspace.command({ type: 'open', root: invalidRoot })
  const invalid = nativeWorkspace.state.projects.find((p) => p.root === invalidRoot)
  assert.ok(invalid, 'Invalid-favicon project opened')
  const withFavicon = entries.find((p) => existsSync(join(p.root, 'favicon.png')))
  const without = entries.find((p) => p !== withFavicon)
  assert.ok(withFavicon && without, 'Sidebar fixture requires one project with a favicon')
  const titles = { favicon: withFavicon.name, missing: without.name, invalid: invalid.name }
  const rowID = (key: string) => `project:${key}`
  const wait = async (check: () => Promise<boolean>, stage = 'state') => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await pause(80)
    }
    throw new Error(
      `Sidebar fixture ${stage} did not settle: ${JSON.stringify(await host.request('sidebarVerification'))}`
    )
  }
  const inspect = () => host.request('sidebarVerification')
  const evidence: any[] = []
  await withSidebarCleanup(
    host,
    async () => {
      if (initial.sidebarCollapsed) await host.request('shellPerform', { action: 'toggle-sidebar' })
      await preparePreviewInput(host, true)
      await wait(async () => {
        const state = await inspect()
        return (
          state.rows.length === 3 &&
          state.rows.some((r: any) => r.storedArtwork) &&
          state.rows.some((r: any) => r.offeredIcon && !r.storedArtwork)
        )
      }, 'favicon rows')
      for (const width of [260, 180]) {
        assert.equal(
          await host.request('shellPerform', { action: 'sidebar-width', row: String(width) }),
          true
        )
        await wait(
          async () => Math.abs((await inspect()).width - width) < 2,
          `content width ${width}`
        )
        for (const entry of entries) {
          assert.equal(
            await host.request('shellPerform', { action: 'select-row', row: rowID(entry.key) }),
            true
          )
          await wait(
            async () =>
              nativeWorkspace.active?.key === entry.key &&
              (await inspect()).rows.some((r: any) => r.id === rowID(entry.key) && r.selected)
          )
          const other = entries.find((p) => p.key !== entry.key)!
          for (const hover of [false, true]) {
            const stem = `sidebar-${width}-${entries.indexOf(entry)}-${hover ? 'hover' : 'rest'}`
            await preparePreviewInput(host, true)
            await pause(350)
            const state = await host.request('sidebarVerification', {
              hover: hover ? rowID(other.key) : ''
            })
            assertSidebarFocusClean(await host.request('sidebarFocus'), `${stem} before capture`)
            let image: any
            try {
              image = await host.request('captureVisibleSidebar')
            } catch (error) {
              // Keep the capture guard's own message; add what held the foreground.
              const focus = await host.request('sidebarFocus').catch(() => null)
              throw new Error(
                `${stem}: ${(error as Error).message}; focus after failure: ${JSON.stringify(focus)}`
              )
            }
            writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
            writeFileSync(
              join(artifacts, `${stem}.json`),
              JSON.stringify(
                { ...state, text: image.text, imageWidth: image.width, imageHeight: image.height },
                null,
                2
              )
            )
            assertSidebarCapture(
              state,
              image,
              width,
              rowID(entry.key),
              hover ? rowID(other.key) : '',
              stem
            )
            assertFaviconRows(state, titles, stem)
            evidence.push({
              capture: `${stem}.png`,
              assertions:
                'foreground/OCR, favicon (colours, fit, painted centre) vs folder (missing/invalid favicon)/template/scaling/tint, containment/spacing/centres, selection/hover/actions',
              state
            })
          }
        }
        const menu = await host.request('sidebarVerification', {
          menu: rowID(entries[1].key),
          memory: true
        })
        assert.deepEqual(menu.titles, ['Project Memory…', 'Close Project'])
        assert.equal(menu.project, entries[1].key)
        assert.equal(menu.opened, true, 'Native context menu entered tracking')
        assert.equal(menu.closed, true, 'Native context menu cancelled cleanly')
        await wait(async () => {
          const s = await host.request('sheetInspect')
          return s.visible && s.fields.includes('content')
        })
        await host.request('sheetPerform', { action: 'cancel' })
        await wait(async () => !(await host.request('sheetInspect')).visible)
        await restoreSidebarFocus(host, `context menu/Project Memory at ${width}`)
        // Move the second row to the front through production pasteboard/validate/accept delegates.
        const before = [...nativeWorkspace.state.projects].map((p) => p.key)
        const drag = await host.request('sidebarVerification', { drag: rowID(before[1]), index: 0 })
        assert.deepEqual(drag, {
          noOpRejected: true,
          nestedRejected: true,
          valid: true,
          accepted: true
        })
        await wait(
          async () =>
            nativeWorkspace.state.projects[0].key === before[1] &&
            (await inspect()).rows[0].id === rowID(before[1])
        )
        assert.equal(
          nativeWorkspace.active?.key,
          entries[1].key,
          'Reorder preserves active project'
        )
        await restoreSidebarFocus(host, `reorder at ${width}`)
        evidence.push({
          width,
          menu,
          memoryOpened: true,
          drag,
          orderBefore: before,
          orderAfter: nativeWorkspace.state.projects.map((p) => p.key),
          focusRestored: true
        })
      }
      writeFileSync(join(artifacts, 'sidebar-interactions.json'), JSON.stringify(evidence, null, 2))
      console.log(
        'NATIVE SIDEBAR PASS — foreground 260/180px captures; favicon row plus no-favicon and invalid-favicon folder rows in one slot; both selections, hover, native menu/memory action and drag delegates/backend reorder; foreground restored after each interaction. Inspect sidebar-*.png for favicon and glyph fidelity.'
      )
    },
    async () => {
      await nativeWorkspace.command({ type: 'close', key: invalid.key })
      rmSync(invalidRoot, { recursive: true, force: true })
      await host.request('shellPerform', {
        action: 'sidebar-width',
        row: String(initial.sidebarWidth)
      })
      if (initial.sidebarCollapsed) await host.request('shellPerform', { action: 'toggle-sidebar' })
    }
  )
}

/** The centre pixel of the core fixture's favicon (`writeSmokeProject`). */
export const FAVICON_CENTER = [0xf0, 0x6a, 0x1c]

/** Favicon vs folder per row (LKM-372): the decoded favicon fills the slot with its own
 *  colours and aspect; missing or undecodable artwork keeps the template folder. */
export function assertRowIcon(row: any, stem: string) {
  const detail = `${stem}: ${JSON.stringify(row)}`
  assert.ok(row.inkFraction > 0, `Blank icon slot: ${detail}`)
  if (row.storedArtwork) {
    assert.ok(
      row.offeredIcon && row.favicon && !row.folder && !row.template,
      `Favicon row: ${detail}`
    )
    assert.equal(Math.max(row.imageWidth, row.imageHeight), 16, `Favicon fit: ${detail}`)
  } else assert.ok(row.folder && row.template, `Folder fallback: ${detail}`)
  assert.ok(row.scaling && row.tintCorrect && row.contained, detail)
  assert.ok(Math.abs(row.iconMidY - row.textMidY) <= 1, `Icon/label centres: ${detail}`)
}

/** The sidebar fixture's three projects: a valid favicon, none, and an undecodable one. */
export function assertFaviconRows(
  state: any,
  titles: { favicon: string; missing: string; invalid: string },
  stem: string
) {
  const row = (title: string) => {
    const found = state.rows.find((r: any) => r.title === title)
    assert.ok(found, `${stem}: no row ${title}`)
    return found
  }
  const favicon = row(titles.favicon),
    missing = row(titles.missing),
    invalid = row(titles.invalid)
  assert.ok(favicon.storedArtwork && favicon.favicon && !favicon.folder, `${stem}: favicon row`)
  assert.equal(favicon.imageWidth, 16, `${stem}: 16×16 favicon fills the slot`)
  assert.equal(favicon.imageHeight, 16, `${stem}: 16×16 favicon fills the slot`)
  assert.ok(favicon.inkFraction > 0.4, `${stem}: favicon painted ${favicon.inkFraction}`)
  const center = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(favicon.centerColor)
  assert.ok(
    center && FAVICON_CENTER.every((v, i) => Math.abs(parseInt(center[i + 1], 16) - v) <= 32),
    `${stem}: favicon centre ${favicon.centerColor}`
  )
  assert.ok(!missing.offeredIcon && missing.folder, `${stem}: no-favicon row keeps the folder`)
  assert.ok(
    invalid.offeredIcon && !invalid.storedArtwork && invalid.folder,
    `${stem}: invalid favicon falls back to the folder`
  )
  for (const other of [missing, invalid])
    assert.deepEqual(
      [other.iconX, other.iconWidth, other.iconHeight, other.textGap],
      [favicon.iconX, favicon.iconWidth, favicon.iconHeight, favicon.textGap],
      `${stem}: favicon and folder rows share the slot`
    )
}

/** Shared with the non-GUI negative fixtures so missing visual evidence fails closed.
 *  `hovered` is the hovered row's id, or '' for none. */
export function assertSidebarCapture(
  state: any,
  image: any,
  width: number,
  selected: string,
  hovered: string,
  stem: string,
  rows = 3
) {
  assert.equal(state.foreground, true)
  assert.equal(state.collapsed, false)
  assert.equal(state.rows.length, rows)
  assert.ok(image.width >= width && image.height > 200)
  const ocr = image.text.join(' ').toLowerCase()
  assert.ok(ocr.includes('open project'), `Blank/missing sidebar actions: ${stem}`)
  for (const row of state.rows) {
    assert.ok(
      ocr.includes(row.title.toLowerCase()),
      `Missing visible project ${row.title}: ${stem}`
    )
    assertRowIcon(row, stem)
    assert.equal(row.iconWidth, 16)
    assert.equal(row.iconHeight, 16)
    assert.ok(
      Number.isInteger(row.iconX) && Number.isInteger(row.iconY),
      `Fractional icon origin: ${JSON.stringify(row)}`
    )
    assert.equal(row.textGap, 7)
    assert.equal(
      row.matchesOpenProject,
      true,
      `Row icon/label must align with Open Project: ${row.title}`
    )
    assert.ok(row.textWidth > 30)
    assert.equal(row.selected, row.id === selected)
    assert.equal(row.moreAlpha, row.selected || row.id === hovered ? 1 : 0)
    assert.equal(row.actionsLabel, `Actions for ${row.title}`)
    assert.deepEqual(row.menu, ['Project Memory…', 'Close Project'])
  }
  for (const row of state.rows) assert.equal(row.iconX, state.rows[0].iconX)
}
