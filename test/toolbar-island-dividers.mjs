import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-319: no divider between the buttons of a toolbar island on macOS 27. The islands'
// segmented controls (preview interaction, preview tools) render
// offscreen next to a stock NSSegmentedControl, which proves the probe sees a system divider.
const binary = swiftBuild('toolbar-island-dividers', [
  'test/fixtures/toolbar-island-dividers/main.swift',
  'src/native/ToolbarLayout.swift'
])
const result = JSON.parse(runFixture(binary))
const ISLANDS = ['interaction', 'tools']
// The boundary is darker than the bezel beside it by this much where a divider draws.
const VISIBLE = 0.05

assert.equal(result.hidesDividers, result.osMajor >= 27, 'islands hide dividers from macOS 27 on')
for (const stage of ['initial', 'narrow', 'restored', 'disabled']) {
  const state = result[stage]
  const detail = `${stage}: ${JSON.stringify(state)}`
  assert.ok(
    state.stock.thinLayers > 0 && state.stock.contrast.every((c) => c > VISIBLE),
    `a stock segmented control draws its dividers (the probe works): ${detail}`
  )
  assert.equal(state.interaction.segments, stage === 'narrow' ? 3 : 4, detail)
  assert.equal(state.tools.segments, 4, detail)
  for (const island of ISLANDS) {
    const { thinLayers, visibleDividers, contrast } = state[island]
    if (result.hidesDividers) {
      assert.equal(thinLayers, 0, `${island} draws no divider layer: ${detail}`)
      assert.equal(visibleDividers, 0, `${island} reports no divider: ${detail}`)
      assert.ok(
        contrast.every((c) => c < VISIBLE / 2),
        `${island} shows no line between its buttons: ${detail}`
      )
    } else {
      // macOS 26 and earlier keep the system look.
      assert.equal(visibleDividers, thinLayers, `${island} keeps its dividers: ${detail}`)
    }
  }
}
// AppKit changes the inner layers without laying out the control: read straight after a press,
// a click, a divider shown again by the system and a divider layer added to the hosted view.
for (const [stage, counts] of Object.entries(result.interactive)) {
  for (const island of ISLANDS)
    if (result.hidesDividers)
      assert.equal(
        counts[island],
        0,
        `${island} shows no divider after ${stage}: ${JSON.stringify(counts)}`
      )
}
// Offscreen dark captures are blank; the layers alone show the dividers stay hidden.
if (result.hidesDividers)
  for (const island of ISLANDS) assert.equal(result.dark[island].thinLayers, 0, `dark: ${island}`)

// LKM-430: the device switch is one button of the tools island; it left the interaction island.
const { device, markup } = result
const at = JSON.stringify({ device, markup })
assert.equal(device.tools, true, `the tools island clicks device: ${at}`)
assert.equal(device.interaction, false, `the interaction island no longer has it: ${at}`)
assert.deepEqual(device.clicks, ['device'], `one click, one action: ${at}`)

// The pen: a real SF Symbol, drawn at the toolbar's size, with its label and states.
assert.equal(markup.systemSymbol, true, `pencil.tip exists on this macOS: ${at}`)
assert.equal(markup.label, 'Mark up')
assert.equal(markup.tooltip, 'Mark up', `the segment's tooltip: ${at}`)
for (const state of ['plain', 'active']) {
  assert.equal(markup[state].present, true, `${state} image is non-nil: ${at}`)
  assert.ok(markup[state].ink > 40, `${state} image draws the glyph: ${at}`)
}
// LKM-448: while on, a click cancels, and VoiceOver says so.
assert.equal(markup.plain.accessibility, 'Mark up', `the idle image is labelled: ${at}`)
assert.equal(
  markup.active.accessibility,
  'Cancel Mark up',
  `the active image says what a click does: ${at}`
)
assert.equal(markup.cancelLabel, 'Cancel Mark up')
assert.equal(markup.plain.ink, markup.active.ink, `the same glyph in both states: ${at}`)
assert.equal(markup.plain.template, true, `at rest it tints like its neighbours: ${at}`)
assert.equal(markup.active.template, false, `active it keeps the accent colour: ${at}`)
assert.deepEqual(markup.clicks, ['markup'], `enabled, one click sends one action: ${at}`)
assert.equal(markup.clicked, true)
assert.equal(markup.disabledSegment, true, `disabled reaches the segment: ${at}`)
assert.equal(markup.disabledClicked, false, `a disabled segment refuses the click: ${at}`)
assert.deepEqual(markup.disabledClicks, ['markup'], `no action while disabled: ${at}`)
assert.equal(markup.activeSegmentAccent, true, `active shows on the segment: ${at}`)
assert.equal(markup.activeEnabled, true, `active stays clickable (begin refuses a second): ${at}`)
assert.equal(markup.restoredTemplate, true, `closing restores the glyph: ${at}`)
assert.deepEqual(
  markup.narrowSegments,
  ['select-object', 'overlay', 'markup'],
  `a narrow window keeps the pen: ${at}`
)
assert.equal(markup.narrowClicked, true)
assert.deepEqual(markup.narrowClicks, ['markup'], `after a hidden segment it still hits: ${at}`)

// LKM-448: Select, Slow Motion and Mark up share one on-state look, in light and dark: the same
// glyph, size and weight as at rest (same ink, same bounds), template at rest, accent while on.
const { states } = result
const STATEFUL = ['select-object', 'speed', 'markup']
const st = JSON.stringify(states)
assert.deepEqual(
  Object.keys(states)
    .filter((k) => STATEFUL.includes(k))
    .sort(),
  [...STATEFUL].sort()
)
for (const key of STATEFUL) {
  const s = states[key]
  assert.equal(s.idleTemplate, true, `${key} at rest tints like its neighbours: ${st}`)
  assert.equal(s.activeTemplate, false, `${key} on keeps the accent: ${st}`)
  assert.deepEqual(s.idleSize, states.neighbourSize, `${key} at the toolbar's optical size: ${st}`)
  assert.deepEqual(s.activeSize, s.idleSize, `${key} does not change size when on: ${st}`)
  for (const appearance of ['light', 'dark']) {
    const { idle, active } = s[appearance]
    assert.ok(idle.ink > 40, `${key} ${appearance} draws the glyph: ${st}`)
    assert.equal(
      active.ink,
      idle.ink,
      `${key} ${appearance}: the same glyph and weight when on: ${st}`
    )
    assert.deepEqual(active.bounds, idle.bounds, `${key} ${appearance}: in the same place: ${st}`)
    assert.ok(active.accentDistance < 0.08, `${key} ${appearance}: on is the accent colour: ${st}`)
    assert.ok(
      idle.accentDistance > 0.08 || active.accentDistance < idle.accentDistance,
      `${key} ${appearance}: idle is not: ${st}`
    )
  }
  // Active is the glyph, not the control's pressed highlight, and nothing stays after it ends.
  assert.equal(states[`${key}ActiveHighlight`], false, `${key} on is not drawn as pressed: ${st}`)
  assert.equal(states[`${key}ActiveAccent`], true, `${key} on shows on its segment: ${st}`)
  assert.equal(
    states[`${key}AfterClickHighlight`],
    false,
    `${key} keeps no pressed fill after a click: ${st}`
  )
  assert.equal(
    states[`${key}DisabledTemplate`],
    true,
    `${key} disabled draws like any disabled segment: ${st}`
  )
  assert.equal(states[`${key}ReenabledAccent`], true, `${key} enabled again shows its state: ${st}`)
  assert.equal(states[`${key}EndedTemplate`], true, `${key} leaves no accent once off: ${st}`)
  assert.equal(states[`${key}EndedHighlight`], false, `${key} leaves no fill once off: ${st}`)
}
assert.equal(states.momentary, true, `pressed is the control's transient highlight: ${st}`)
assert.equal(states.pressedGlyphTemplate, true, `and leaves the glyph alone: ${st}`)

// Wiring the fixture cannot reach. One control per action: the lists are the only source of
// the groups, the segment's shell-action toggles (LKM-448) while the Actions entry only opens,
// and the segment follows the overlay.
const source = (name) => readFileSync(`src/native/${name}`, 'utf8')
const layout = source('ToolbarLayout.swift')
assert.match(layout, /interaction = \["select-object", "overlay", "speed", "markup"\]/)
assert.match(layout, /tools = \["code", "layers", "device", "expand"\]/)
const shell = source('Shell.swift')
assert.match(shell, /key == "tools" \? ToolbarIslands\.tools : ToolbarIslands\.interaction/)
assert.ok(!/"expand"\]\s*:\s*\[/.test(shell), 'no second copy of the group lists')
assert.equal(
  (shell.match(/"device", "overlay"/g) ?? []).length,
  0,
  'the device id is listed once, in its island'
)
assert.match(
  source('PreviewMarkupHost.swift'),
  /changed: \{[^\n]*updateMarkup\(active: self\?\.markup\?\.overlay != nil\)/
)
const controller = readFileSync('src/native/index.ts', 'utf8')
assert.match(controller, /action\.action === 'markup'\) markup\.toggle\(\)/)
// Every on state is drawn by the one helper: no filled or rayed variant swapped in, no animation
// (Reduce Motion has nothing to reduce), and the tooltip follows the toggle.
assert.match(shell, /ToolbarIslands\.stateImage\("select-object"/)
assert.ok(!/cursorarrow\.rays/.test(shell), 'Select keeps its glyph when on')
const speed = source('ToolbarSpeed.swift')
assert.match(speed, /ToolbarIslands\.stateImage\("speed"/)
assert.ok(!/tortoise\.fill/.test(speed), 'Slow Motion keeps its glyph when on')
const more = source('ToolbarMore.swift')
assert.match(more, /toolTip = ToolbarIslands\.markupToolTip\(active: active\)/)
for (const [name, text] of [
  ['ToolbarSpeed.swift', speed],
  ['ToolbarMore.swift', more]
])
  assert.ok(!/animator\(\)|NSAnimationContext/.test(text), `${name} swaps states without motion`)
console.log('toolbar island dividers: OK')
