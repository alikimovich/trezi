import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { markupToggleChecks } from './smoke-markup-toggle'
import { assertIslandDividers, capture } from './smoke-toolbar'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Focus = 'composer' | 'preview' | 'source'
const INTERACTION = ['select-object', 'overlay', 'speed', 'markup']
const TOOLS = ['code', 'layers']
const MINIMUM_WINDOW = 850

/**
 * LKM-430: the three toolbar and menu changes on the running app.
 *
 * ⌥⌘F takes the real key dispatch (`toggleUIKey`) from the preview, the composer and the docked
 * code editor, windowed and full screen, and reaches the one existing form; a second press with
 * the form up leaves it. The disposable profile has no invite code, so the form is the invite
 * question and nothing can be sent: this check never fills a field or presses a default button.
 * The real Mark up segment takes a posted click, draws a generated stroke and cancels; LKM-448:
 * a second click on it cancels, a third enters again (`smoke-markup-toggle.ts`). The
 * device segment takes posted clicks in the viewport island beside the address and
 * off and in full screen, and the viewport survives each of them, a resize and a project
 * switch.
 */
export async function checkToolbarActions(host: NativeBridge, artifacts: string) {
  const results: State = { feedback: [], device: [] }
  const save = () =>
    writeFileSync(join(artifacts, 'toolbar-actions.json'), JSON.stringify(results, null, 2))
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
    results.skipped = {
      reason: 'background test: key dispatch, clicks and full screen need a foreground window'
    }
    console.log('SKIP toolbar-actions: TREZI_NATIVE_BACKGROUND_TEST')
    return save()
  }
  const shell = (): Promise<State> => host.request('shellInspect')
  const sheet = (): Promise<State> => host.request('sheetInspect')
  const keys = (): Promise<State> => host.request('toggleUIKey', { inspect: true })
  const markup = (): Promise<State> => host.request('previewMarkupInspect')
  const shots: Record<string, string> = {}
  let second: { first: string; key?: string } | undefined
  const shot = async (name: string) => {
    shots[name] = await capture(host, artifacts, `toolbar-actions-${name}`)
  }
  /** The window in light and dark, then back on the system appearance. */
  const appearances = async (name: string) => {
    for (const appearance of ['light', 'dark'] as const) {
      await host.request('shellPerform', { action: 'window-appearance', row: appearance })
      await pause(250)
      await shot(`${name}-${appearance}`)
    }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
  }
  const fullScreen = async (value: boolean) => {
    await host.request('previewOverlayTest', { action: 'fullscreen', value })
    await waitFor(async () => (await keys()).fullScreen === value, `full screen ${value}`)
  }
  const code = async (open: boolean) => {
    if ((await host.request('sourceInspect')).visible === open) return
    await host.request('shellPerform', { action: 'code' })
    await waitFor(
      async () => (await host.request('sourceInspect')).visible === open,
      `Code ${open}`
    )
  }
  const layers = async (open: boolean) => {
    if ((await host.request('layersInspect')).visible === open) return
    await host.request('shellPerform', { action: 'layers' })
    await waitFor(
      async () => (await host.request('layersInspect')).visible === open,
      `Layers ${open}`
    )
  }
  const expanded = async (open: boolean) => {
    if (((await host.request('layoutInspect')).fraction === 0) === open) return
    await click('expand')
    await waitFor(
      async () => ((await host.request('layoutInspect')).fraction === 0) === open,
      `Expand ${open}`
    )
    results[`expand-${open}`] = {
      route: 'posted toolbar segment',
      fraction: (await host.request('layoutInspect')).fraction
    }
  }
  const viewport = () => nativeWorkspace.active?.viewport
  /** A posted click on the segment itself, in whichever window holds the toolbar. */
  const click = async (segment: string) => {
    const reply: State = await host.request('previewMarkupTest', {
      action: 'toolbarSegment',
      segment
    })
    assert.equal(reply.error, undefined, `${segment} segment: ${reply.error}`)
    assert.equal(reply.route, 'real event route', `${segment} crossed AppKit`)
    return reply
  }
  /** Each island holds its own buttons, once, and neither holds the other's. */
  const islands = async (stage: string) => {
    const state = await shell()
    // Slow motion leaves narrow windows together with "…" (LKM-213).
    const interaction = INTERACTION.filter((id) => id !== 'speed' || state.moreVisible)
    assert.deepEqual(state.toolSegments, TOOLS, `${stage}: code | layers`)
    assert.deepEqual(state.viewportSegments, ['device', 'expand'], `${stage}: viewport island`)
    assert.deepEqual(state.interactionSegments, interaction, `${stage}: interaction island`)
    const all = [...state.toolSegments, ...state.viewportSegments, ...state.interactionSegments]
    assert.equal(all.filter((id) => id === 'device').length, 1, `${stage}: one device button`)
    assert.equal(all.filter((id) => id === 'markup').length, 1, `${stage}: one Mark up button`)
    await assertIslandDividers(host, stage, state)
    return state
  }
  const cancelSheet = async () => {
    await host.request('sheetPerform', { action: 'cancel' })
    await waitFor(async () => !(await sheet()).visible, 'the form closes')
  }
  const formOpen = async (label: string) =>
    waitFor(
      async () => {
        const state = await sheet()
        return state.visible && state.title === 'Enter your invite code' && state
      },
      `${label}: ⌥⌘F opens the existing form`,
      8000,
      sheet
    )
  /** One press from `focus`: the form opens once, a second press leaves it, Cancel closes it. */
  const feedback = async (focus: Focus, full: boolean) => {
    const label = `${full ? 'full screen' : 'windowed'} ${focus}`
    const sent: State = await host.request('toggleUIKey', { focus, key: 'feedback' })
    assert.equal(
      sent.firstResponder,
      focus,
      `${label}: the focus is there: ${JSON.stringify(sent)}`
    )
    const first = await formOpen(label)
    await host.request('toggleUIKey', { focus: 'none', key: 'feedback' })
    await pause(500)
    const second = await sheet()
    const after = await keys()
    results.feedback.push({ label, sent: sent.posted, id: first.id, again: second.id })
    save()
    assert.equal(second.id, first.id, `${label}: a second press keeps the form`)
    assert.equal(second.visible, true, `${label}: the form stays up`)
    assert.equal(second.busy, false, `${label}: nothing is submitted`)
    assert.equal(after.fullScreen, full, `${label}: full screen stays ${full}`)
    assert.equal(after.transition, false, `${label}: no full-screen transition`)
    await cancelSheet()
  }

  try {
    await fullScreen(false)
    await expanded(false)
    await code(false)
    await layers(false)

    // The registry: one menu item per binding, Find untouched, ⌥⌘F on Send Feedback….
    const { shortcuts } = (await keys()) as { shortcuts: State[] }
    results.shortcuts = shortcuts
    const bound = (key: string, modifiers: string[]) =>
      shortcuts.filter((entry) => entry.key === key && entry.modifiers.join() === modifiers.join())
    assert.deepEqual(
      bound('f', ['option', 'command']).map((entry) => [entry.menu, entry.title]),
      [['Actions', 'Send Feedback…']],
      'Send Feedback… is the only ⌥⌘F'
    )
    assert.equal(bound('f', ['command']).length, 1, 'Find keeps ⌘F')
    assert.equal(bound('f', ['command'])[0].title.startsWith('Find'), true, 'Find keeps ⌘F')
    const seen = new Map<string, string>()
    for (const entry of shortcuts) {
      const id = `${entry.modifiers.join('+')}+${entry.key}`
      assert.equal(seen.get(id), undefined, `${id} is bound once: ${entry.title}`)
      seen.set(id, entry.title)
    }

    await islands('at rest')

    // Send Feedback: the menu entry, then the keyboard from each input, closed and reopened.
    host.emit('menu', { action: 'feedback' })
    const menu = await formOpen('Actions → Send Feedback…')
    await cancelSheet()
    host.emit('menu', { action: 'feedback' })
    assert.notEqual((await formOpen('reopened')).id, menu.id, 'a closed form opens as a new one')
    await cancelSheet()
    await code(true)
    await feedback('source', false)
    await code(false)
    await feedback('composer', false)
    await feedback('preview', false)
    await fullScreen(true)
    await feedback('preview', true)
    await code(true)
    await feedback('source', true)
    await code(false)
    await fullScreen(false)

    // Mark up: one click opens it, a generated stroke, the overlay's Cancel. LKM-448: then the
    // segment toggles, enter → cancel → enter, with the preview's geometry unchanged throughout.
    const rest = await shell()
    assert.deepEqual(
      [rest.markupEnabled, rest.markupLabel, rest.markupToolTip, rest.markupHasImage],
      [true, 'Mark up', 'Mark up', true],
      'the Mark up button is ready'
    )
    assert.equal(rest.markupActive, false, 'the button rests while no overlay is open')
    assert.ok(!rest.moreMenu.includes('Mark up'), 'the … menu has no Mark up entry')
    const cover = (await markup()).cover
    await click('markup')
    const opened = await waitFor(async () => {
      const state = await markup()
      return state.open && state
    }, 'the Mark up button opens the overlay')
    assert.ok(opened.cover > cover, 'the page is told the overlay covers it')
    const open = await shell()
    results.markupOpen = { active: open.markupActive, prominent: open.markupProminent }
    assert.equal(open.markupActive, true, 'the button shows the open overlay')
    assert.equal(open.markupProminent, true, 'the glyph takes the accent colour')
    await shot('markup-open')
    const test = async (params: State) => {
      const reply = await host.request('previewMarkupTest', params)
      assert.equal(reply.error, undefined, `${params.action}: ${reply.error}`)
    }
    await test({ action: 'button', label: 'Pen' })
    await test({
      action: 'pointer',
      // Below the floating island at the top of the snapshot (LKM-448).
      points: [
        [60, 200],
        [140, 240],
        [220, 200]
      ]
    })
    assert.equal((await markup()).undoEnabled, true, 'the generated stroke is a mark')
    await test({ action: 'button', label: 'Cancel' })
    await waitFor(async () => !(await markup()).open, 'Cancel closes Mark up')
    await waitFor(async () => !(await shell()).markupActive, 'the button returns to rest')
    assert.equal((await shell()).markupProminent, false, 'the glyph returns to rest')
    assert.equal((await markup()).cover, cover, 'the page is uncovered again')
    const toggle = markupToggleChecks(host, click, shot, results)
    await toggle.cycle('default', 3)
    await toggle.states()

    // Device: each state of the other tools, then full screen, in both directions.
    const flip = async (stage: string) => {
      const was = viewport()
      await click('device')
      await waitFor(async () => viewport() !== was, `${stage}: the device button switches`)
      await islands(stage)
      results.device.push({ stage, was, now: viewport() })
      save()
      return viewport()
    }
    await flip('mobile')
    const mobile = viewport()
    assert.equal(mobile, 'mobile', 'one click reaches the mobile preview')
    await code(true)
    assert.equal(viewport(), mobile, 'Code keeps the viewport')
    await shot('device-mobile-code')
    await layers(true)
    assert.equal(viewport(), mobile, 'Layers keeps the viewport')
    await flip('desktop, Code and Layers open')
    await flip('mobile, Code and Layers open')
    await code(false)
    await layers(false)
    await expanded(true)
    assert.equal(viewport(), mobile, 'Expand keeps the viewport')
    await flip('desktop, expanded')
    await flip('mobile, expanded')
    await expanded(false)
    await fullScreen(true)
    assert.equal(viewport(), mobile, 'full screen keeps the viewport')
    await appearances('fullscreen-mobile')
    await flip('desktop, full screen')
    await appearances('fullscreen-desktop')
    await flip('mobile, full screen')
    await fullScreen(false)
    assert.equal(viewport(), mobile, 'leaving full screen keeps the viewport')

    // A project keeps its own viewport: another one is not mobile, and coming back still is.
    const first = nativeWorkspace.state.activeKey
    assert.ok(first, 'the first project is active')
    const root = join(artifacts, 'toolbar-actions-project')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'index.html'), '<h1>Other project</h1>')
    await nativeWorkspace.command({ type: 'open', root })
    second = { first, key: nativeWorkspace.active?.key }
    assert.ok(second.key && second.key !== first, 'the second project is active')
    assert.notEqual(viewport(), 'mobile', 'the other project has its own viewport')
    await islands('second project')
    await nativeWorkspace.command({ type: 'select', key: first })
    assert.equal(viewport(), mobile, 'the project switch keeps the viewport')
    await islands('back on the first project')
    await nativeWorkspace.command({ type: 'close', key: second.key })
    second = undefined

    // The top bar and both islands in each appearance, at the minimum and default widths.
    const width = Math.round((await shell()).windowWidth)
    for (const [name, size] of [
      ['default', width],
      ['minimum', MINIMUM_WINDOW]
    ] as const) {
      await host.request('shellPerform', { action: 'window-width', row: String(size) })
      await waitFor(
        async () => Math.abs((await shell()).windowWidth - size) < 1,
        `${name} window width`
      )
      assert.equal(viewport(), mobile, `${name}: a resize keeps the viewport`)
      const state = await islands(name)
      results[name] = {
        addressWidth: state.addressWidth,
        addressLeading: state.addressLeading,
        rightGroupLeading: state.rightGroupLeading,
        gap: state.rightGroupLeading - state.addressTrailing
      }
      assert.ok(results[name].gap > 0, `${name}: the address block ends before the islands`)
      await appearances(name)
    }
    // The narrowest toolbar still answers on its last island button, as a toggle, with the
    // preview unchanged; a resize while it is on keeps the island on the page (LKM-448).
    await toggle.cycle('minimum', 2)
    await toggle.resize(MINIMUM_WINDOW, MINIMUM_WINDOW + 150)
    for (const appearance of ['light', 'dark'] as const) {
      await host.request('shellPerform', { action: 'window-appearance', row: appearance })
      await toggle.cycle(`minimum-${appearance}`, 1)
    }
    await host.request('shellPerform', { action: 'window-appearance', row: '' })
    await flip('desktop, minimum width')
    await host.request('shellPerform', { action: 'window-width', row: String(width) })
    await waitFor(async () => Math.abs((await shell()).windowWidth - width) < 1, 'default width')
  } finally {
    results.captures = shots
    if (second?.key) {
      await nativeWorkspace.command({ type: 'select', key: second.first }).catch(() => {})
      await nativeWorkspace.command({ type: 'close', key: second.key }).catch(() => {})
    }
    await restoreToolbarActions(host).catch(() => {})
    save()
  }
}

/** Runs when the check ends and after a failure: nothing here leaves a sheet, an overlay, a
 *  full-screen window or a mobile viewport for the next check. */
export async function restoreToolbarActions(host: NativeBridge) {
  await host.request('previewMarkupTest', { action: 'cancel' }).catch(() => {})
  if ((await host.request('sheetInspect')).visible)
    await host.request('sheetPerform', { action: 'cancel' }).catch(() => {})
  await host.request('previewOverlayTest', { action: 'fullscreen', value: false })
  await host.request('shellPerform', { action: 'window-appearance', row: '' })
  if ((await host.request('sourceInspect')).visible)
    await host.request('shellPerform', { action: 'code' })
  if ((await host.request('layersInspect')).visible)
    await host.request('shellPerform', { action: 'layers' })
  if ((await host.request('layoutInspect')).fraction === 0)
    await host.request('shellPerform', { action: 'expand' })
  if (nativeWorkspace.active?.viewport === 'mobile')
    await host.request('shellPerform', { action: 'device' })
}
