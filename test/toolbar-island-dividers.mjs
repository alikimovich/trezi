import assert from 'node:assert/strict'
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
  assert.equal(state.tools.segments, 3, detail)
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
console.log('toolbar island dividers: OK')
