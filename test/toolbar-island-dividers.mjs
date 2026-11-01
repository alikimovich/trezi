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
  assert.equal(markup[state].accessibility, 'Mark up', `${state} image is labelled: ${at}`)
  assert.ok(markup[state].ink > 40, `${state} image draws the glyph: ${at}`)
}
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

// Wiring the fixture cannot reach. One control per action: the lists are the only source of
// the groups, the action goes through the same shell-action as the "…" and Actions entries,
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
assert.match(controller, /action\.action === 'markup'[\s\S]{0,80}markup\.begin\(\)/)
console.log('toolbar island dividers: OK')
