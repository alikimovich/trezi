import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { markupToggleChecks } from './smoke-markup-toggle'
import { decodePng } from './smoke-png'
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
export const NEW_CHAT_INTERACTION_STAGES = [
  'hover',
  'pressed',
  'focus-new',
  'focus-more',
  'focus-sidebar'
] as const

/** Read painted glass from the foreground PNG, using the capture's crop and native frames.
 * The left interior avoids each glyph; the point just left is bare toolbar.
 * Compare with adjacent controls in the same image so appearance and wallpaper cancel out. */
function glassInk(image: State, frame: string) {
  const pixels = decodePng(Buffer.from(image.png, 'base64'))
  const numbers = (value: string) => (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const [x, y, width, height] = numbers(frame)
  const [, , windowWidth, windowHeight] = numbers(image.geometry.window)
  const [cropX, cropY] = numbers(image.geometry.crop)
  const scale = Number(image.geometry.image.match(/^(\d+)x/)?.[1]) / windowWidth
  const offsetX = image.captureOffsetX ?? 0
  assert.ok(
    width >= 24 && height >= 24 && Number.isFinite(scale),
    'glass pixels have measured native geometry'
  )
  const px = (offset: number) => Math.round((x + offset) * scale - cropX + offsetX)
  const py = (offset: number) => Math.round((windowHeight - y - offset) * scale - cropY)
  const sample = (offset: number) => {
    const sx = px(offset),
      sy = py(height / 2)
    assert.ok(
      sx >= 0 && sx < pixels.width && sy >= 0 && sy < pixels.height,
      'glass sample lies inside foreground PNG'
    )
    return pixels.rgb(sx, sy)
  }
  const inside = sample(5),
    outside = sample(-5),
    border = sample(0)
  const brightness = (rgb: number[]) => rgb.reduce((sum, value) => sum + value, 0) / 3
  return {
    inside,
    outside,
    border,
    lift: brightness(inside) - brightness(outside),
    borderLift: brightness(border) - brightness(outside)
  }
}

/** Compare the same native button's painted pixels in two foreground captures. The
 * margin includes a keyboard focus ring; the interior includes hover and press fill. */
function buttonPaintChange(before: State, after: State, frame: string) {
  const first = decodePng(Buffer.from(before.png, 'base64'))
  const second = decodePng(Buffer.from(after.png, 'base64'))
  assert.equal(before.geometry.window, after.geometry.window, 'interaction captures share geometry')
  return paintedButtonDifference(
    first,
    second,
    {
      ...before.geometry,
      captureOffsetX: before.captureOffsetX,
      secondCaptureOffsetX: after.captureOffsetX
    },
    frame
  )
}

function toolbarButtonMeasure(frame: string) {
  const [x, y, width, height] = (frame.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  assert.ok(
    [x, y, width, height].every(Number.isFinite) && width >= 24 && height >= 24,
    `toolbar button has measured native frame: ${frame}`
  )
  return { height, centerY: y + height / 2 }
}

/** The foreground fixture and its unit check use the same pixel test. */
export function paintedButtonDifference(
  first: { width: number; height: number; rgb: (x: number, y: number) => number[] },
  second: { width: number; height: number; rgb: (x: number, y: number) => number[] },
  geometry: {
    window: string
    crop: string
    captureOffsetX?: number
    secondCaptureOffsetX?: number
  },
  frame: string
) {
  const numbers = (value: string) => (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const [x, y, width, height] = numbers(frame)
  const [, , windowWidth, windowHeight] = numbers(geometry.window)
  const [cropX, cropY] = numbers(geometry.crop)
  const scale = first.width / windowWidth
  assert.equal(first.width, second.width, 'interaction captures share one window width')
  assert.equal(first.height, second.height, 'interaction captures share one window height')
  assert.ok(
    width >= 24 && height >= 24 && Number.isFinite(scale),
    'native button has measured frame'
  )
  let changed = 0,
    peak = 0,
    samples = 0
  for (let yy = -4; yy <= height + 4; yy += 2)
    for (let xx = -4; xx <= width + 4; xx += 2) {
      const px = Math.round((x + xx) * scale - cropX + (geometry.captureOffsetX ?? 0))
      const secondX = Math.round(
        (x + xx) * scale - cropX + (geometry.secondCaptureOffsetX ?? geometry.captureOffsetX ?? 0)
      )
      const py = Math.round((windowHeight - y - yy) * scale - cropY)
      if (
        px < 0 ||
        px >= first.width ||
        secondX < 0 ||
        secondX >= second.width ||
        py < 0 ||
        py >= first.height
      )
        continue
      const a = first.rgb(px, py),
        b = second.rgb(secondX, py)
      const difference = Math.max(...a.map((value, index) => Math.abs(value - b[index])))
      if (difference >= 3) changed++
      peak = Math.max(peak, difference)
      samples++
    }
  return { changed, peak, samples }
}

/**
 * LKM-430: the three toolbar and menu changes on the running app.
 *
 * ⌥⌘F takes the real key dispatch (`toggleUIKey`) from the preview, the composer and the docked
 * code editor, windowed and full screen, and reaches the one existing form; a second press with
 * the form up leaves it. The disposable profile has no invite code, so the form is the invite
 * question and nothing can be sent: this check never fills a field or presses a default button.
 * The real Mark up segment takes a posted click, draws a generated stroke and cancels; LKM-448:
 * a second click on it cancels, a third enters again (`smoke-markup-toggle.ts`). The
 * device segment takes posted clicks in the viewport island left of the address and
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

    // Capture each interaction beside More and the sidebar toggle at normal and narrower
    // widths. The narrower case collapses the sidebar so all three items stay visible.
    const originalWidth = (await host.request('shellInspect')).windowWidth
    const originalSidebarCollapsed = (await shell()).sidebarCollapsed
    for (const { layout, appearance } of [
      { layout: 'normal', appearance: 'light' },
      { layout: 'normal', appearance: 'dark' },
      { layout: 'narrow', appearance: 'light' },
      { layout: 'narrow', appearance: 'dark' }
    ]) {
      try {
        if (layout === 'narrow' && !(await shell()).sidebarCollapsed)
          await host.request('shellPerform', { action: 'toggle-sidebar' })
        await host.request('shellPerform', {
          action: 'window-width',
          row: layout === 'normal' ? '1320' : '1120'
        })
        await waitFor(async () => {
          const state = await shell()
          return (
            state.chatNewVisible && state.moreVisible && state.chatNewFrame !== '{{0, 0}, {0, 0}}'
          )
        }, `${layout}: New Chat and More are visible in the toolbar`)
        await host.request('shellPerform', { action: 'window-appearance', row: appearance })
        await pause(250)
        let idle: State | undefined
        let disabled: State | undefined
        let idleFrame = ''
        for (const enabled of [true, false]) {
          await host.request('chatNewAppearanceTest', { enabled })
          const state = await shell()
          const name = `toolbar-actions-chat-new-${layout}-${appearance}-${enabled ? 'idle' : 'disabled'}`
          // ScreenCaptureKit can pad a narrowed window with black pixels on its
          // left. Find the first painted column and use the measured translation
          // for every frame-based sample; reject a crop with no visible window.
          const image: State = await host.request('captureVisibleWindow')
          const pixels = decodePng(Buffer.from(image.png, 'base64'))
          const centerY = Math.floor(pixels.height / 2)
          let captureOffsetX = 0
          while (
            captureOffsetX < pixels.width / 4 &&
            pixels.rgb(captureOffsetX, centerY).every((channel) => channel === 0)
          )
            captureOffsetX++
          assert.ok(
            captureOffsetX < pixels.width / 4,
            `${name}: foreground window occupies capture`
          )
          image.captureOffsetX = captureOffsetX
          assert.equal(
            state.chatNewStandalone,
            true,
            `${name}: AppKit owns the standalone toolbar item`
          )
          assert.equal(state.chatNewBordered, true, `${name}: AppKit draws the button border`)
          writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.png, 'base64'))
          if (enabled) {
            idle = image
            idleFrame = state.chatNewFrame
          } else disabled = image
          const chat = glassInk(image, state.chatNewFrame)
          const neighbor = glassInk(image, state.chatNewNeighborFrame)
          const more = glassInk(image, state.chatNewMoreFrame)
          const sidebar = glassInk(image, state.chatNewSidebarFrame)
          const alignment = {
            new: toolbarButtonMeasure(state.chatNewRenderedFrame),
            more: toolbarButtonMeasure(state.chatNewMoreRenderedFrame),
            sidebar: toolbarButtonMeasure(state.chatNewSidebarRenderedFrame)
          }
          results[name] = {
            capture: join(artifacts, `${name}.png`),
            captureOffsetX,
            state,
            geometry: image.geometry,
            chat,
            neighbor,
            more,
            sidebar,
            alignment
          }
          save()
          assert.equal(state.chatNewEnabled, enabled, `${name}: enabled state`)
          for (const peer of ['more', 'sidebar'] as const) {
            assert.ok(
              Math.abs(alignment.new.height - alignment[peer].height) <= 2 &&
                Math.abs(alignment.new.centerY - alignment[peer].centerY) <= 2,
              `${name}: New Chat height and vertical center align with ${peer}: ${JSON.stringify(alignment)}`
            )
          }
          assert.ok(
            Math.max(Math.abs(neighbor.lift), Math.abs(neighbor.borderLift)) >= 5,
            `${name}: neighboring glass has visible interior or border: ${JSON.stringify(neighbor)}`
          )
          // These controls sit over different surfaces: New Chat is on the dark chat
          // header while the neighboring island is on the light preview toolbar.
          // The same-image outside sample proves the New Chat glass independently.
          assert.ok(
            Math.abs(chat.lift) >= 3,
            `${name}: New Chat paints glass against its header: ${JSON.stringify({ chat, neighbor })}`
          )
          if (!enabled)
            assert.equal(
              await host.request('shellPerform', { action: 'header-new-chat' }),
              false,
              `${name}: disabled New Chat rejects input`
            )
        }
        assert.ok(idle, `${layout} ${appearance}: idle foreground capture exists`)
        assert.ok(disabled, `${layout} ${appearance}: disabled foreground capture exists`)
        const enabledDisabledPaint = buttonPaintChange(idle, disabled, idleFrame)
        const disabledName = `toolbar-actions-chat-new-${layout}-${appearance}-disabled`
        results[disabledName].enabledDisabledPaint = enabledDisabledPaint
        save()
        assert.ok(
          enabledDisabledPaint.changed >= 8 && enabledDisabledPaint.peak >= 5,
          `${disabledName}: enabled and disabled New Chat visibly differ: ${JSON.stringify(enabledDisabledPaint)}`
        )
        await host.request('chatNewAppearanceTest', { enabled: true })
        for (const stage of NEW_CHAT_INTERACTION_STAGES) {
          const probe: State = await host.request('toolbarInteractionProbe', { stage })
          assert.equal(
            probe.error,
            undefined,
            `${layout} ${appearance} ${stage}: ${JSON.stringify(probe)}`
          )
          if (stage === 'hover')
            assert.ok(
              probe.buttons.every((button: State) => button.enterDeliveries > 0),
              `hover reaches each installed native tracking owner: ${JSON.stringify(probe)}`
            )
          await pause(120)
          const state = await shell()
          const image: State = await host.request('captureVisibleWindow')
          const name = `toolbar-actions-chat-new-${layout}-${appearance}-${stage}`
          const capturePath = join(artifacts, `${name}.png`)
          writeFileSync(capturePath, Buffer.from(image.png, 'base64'))
          const frames = {
            new: state.chatNewFrame,
            more: state.chatNewMoreFrame,
            sidebar: state.chatNewSidebarFrame
          }
          const controls = stage.startsWith('focus-')
            ? [stage.slice(6)]
            : ['new', 'more', 'sidebar']
          const paint: State = {}
          for (const control of controls) {
            const frame = frames[control as keyof typeof frames]
            const change = buttonPaintChange(idle, image, frame)
            paint[control] = change
          }
          results[name] = { capture: capturePath, state, geometry: image.geometry, probe, paint }
          save()
          for (const control of controls) {
            const change = paint[control]
            assert.ok(
              change.changed >= 8 && change.peak >= 5,
              `${name}: ${control} paints ${stage} beside the other native toolbar buttons: ${JSON.stringify(change)}`
            )
          }
          if (stage.startsWith('focus-')) {
            const id =
              stage === 'focus-new'
                ? 'chat-new'
                : stage === 'focus-more'
                  ? 'more'
                  : state.toolbar.find((value: string) => value.includes('ToggleSidebar'))
            assert.ok(
              probe.buttons.some((button: State) => button.id === id && button.focused),
              `${name}: the native toolbar button owns keyboard focus`
            )
          }
          const reset: State = await host.request('toolbarInteractionProbe', { stage: 'reset' })
          assert.equal(reset.error, undefined, `${name}: interaction reset`)
          if (stage === 'hover')
            assert.ok(
              reset.buttons.every((button: State) => button.exitDeliveries > 0),
              `hover exit reaches each native tracking owner: ${JSON.stringify(reset)}`
            )
        }
      } finally {
        await host.request('toolbarInteractionProbe', { stage: 'reset' })
        await host.request('chatNewAppearanceTest', { enabled: true })
        await host.request('shellPerform', { action: 'window-appearance', row: '' })
        await host.request('shellPerform', { action: 'window-width', row: String(originalWidth) })
        if ((await shell()).sidebarCollapsed !== originalSidebarCollapsed)
          await host.request('shellPerform', { action: 'toggle-sidebar' })
      }
    }

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
    assert.equal(rest.moreEnabled, true, 'the neighboring More menu stays enabled')
    assert.deepEqual(
      rest.moreMenu,
      ['Reload Without Cache', 'Restart Dev Server (clean cache)', 'Switch JS / Native Preview'],
      'the neighboring More menu keeps its actions'
    )
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
      // Well clear of the floating island at the bottom of the snapshot (LKM-647).
      points: [
        [60, 200],
        [140, 240],
        [220, 200]
      ]
    })
    assert.equal((await markup()).undoEnabled, true, 'the generated stroke is a mark')
    await test({ action: 'button', label: 'Close annotation tools' })
    await waitFor(async () => !(await markup()).open, 'Close closes Mark up')
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
