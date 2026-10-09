/**
 * Unit test for the hover distances to guides and grid lines (LKM-205), and the
 * overlay settings main stores per project and viewport. No DOM needed.
 * Run via bun so the .ts imports transpile: bun run test:guide-distance
 */
import assert from 'node:assert/strict'
import { guideDistances } from '../src/preview/guide-distance.ts'
import {
  MAX_OVERLAY_PROJECTS,
  normalizeLines,
  normalizeOverlay,
  overlayFor,
  storeOverlay
} from '../src/shared/preview-overlay.ts'

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height
})
const lines = (patch) => ({ report: true, fixed: false, x: [], y: [], periods: [], ...patch })
const viewport = { width: 1000, height: 800 }
const bag = (segments) =>
  segments.map((s) => `${s.axis}:${Math.round(s.distance * 10) / 10}`).sort()

// Guides on both sides: each edge measures outwards to the nearest line on its side.
{
  const segments = guideDistances(
    rect(100, 50, 200, 40),
    lines({ x: [40, 80, 320, 500], y: [10] }),
    { x: 0, y: 0 },
    viewport
  )
  assert.deepEqual(bag(segments), ['x:20', 'x:20', 'y:40'])
  const left = segments.find((s) => s.axis === 'x' && s.x1 === 80)
  assert.ok(left, 'left distance starts at the guide')
  assert.equal(left.x2, 100, 'and ends at the element edge')
  assert.equal(left.y1, 70, 'drawn through the middle of the element')
}

// Page-anchored lines follow scroll; viewport-fixed ones do not.
{
  const anchored = guideDistances(
    rect(0, 20, 50, 50),
    lines({ y: [300] }),
    { x: 0, y: 180 },
    viewport
  )
  assert.deepEqual(bag(anchored), ['y:50'], 'line 300 at scroll 180 is 120 in view')
  assert.equal(anchored[0].y2, 120)
  const fixed = guideDistances(
    rect(0, 20, 50, 50),
    lines({ y: [300], fixed: true }),
    { x: 0, y: 180 },
    viewport
  )
  assert.equal(fixed[0].y2, 300, 'fixed line stays at 300')
}

// Periodic baseline rows: the nearest row above the top and below the bottom.
{
  const segments = guideDistances(
    rect(0, 13, 10, 10),
    lines({ periods: [{ axis: 'y', step: 8, offset: 0 }] }),
    { x: 0, y: 0 },
    viewport
  )
  assert.deepEqual(bag(segments), ['y:1', 'y:5'], 'top 13 → row 8, bottom 23 → row 24')
  const aligned = guideDistances(
    rect(0, 16, 10, 16),
    lines({ periods: [{ axis: 'y', step: 8, offset: 0 }] }),
    { x: 0, y: 0 },
    viewport
  )
  assert.deepEqual(bag(aligned), ['y:0', 'y:0'], 'edges on rows measure 0')
}

// Lines outside the viewport draw nothing; no lines draws nothing.
assert.deepEqual(
  guideDistances(rect(10, 10, 10, 10), lines({ x: [-40, 2000] }), { x: 0, y: 0 }, viewport),
  []
)
assert.deepEqual(guideDistances(rect(10, 10, 10, 10), lines({}), { x: 0, y: 0 }, viewport), [])

// Lines from the host are validated.
{
  const parsed = normalizeLines({
    report: 1,
    x: [1, 'a', Number.NaN, 3],
    periods: [
      { axis: 'q', step: 8 },
      { axis: 'y', step: 1 },
      { axis: 'x', step: 8 }
    ]
  })
  assert.deepEqual(parsed, {
    report: false,
    fixed: false,
    x: [1, 3],
    y: [],
    periods: [{ axis: 'x', step: 8, offset: 0 }]
  })
}

// Settings are clamped like the Swift owner's.
{
  const state = normalizeOverlay({
    rulers: true,
    guides: [
      { id: 'a', axis: 'x', position: 12.5 },
      { axis: 'z', position: 1 },
      { axis: 'y', position: 'x' }
    ],
    grids: [
      {
        kind: 'columns',
        count: 99,
        gutter: -1,
        align: 'odd',
        color: '#ABCDEF',
        opacity: 9,
        width: 50
      },
      { kind: 'nope' }
    ]
  })
  assert.equal(state.rulers, true)
  assert.deepEqual(state.guides, [{ id: 'a', axis: 'x', position: 12.5 }])
  assert.equal(state.grids.length, 1)
  assert.deepEqual(
    [
      state.grids[0].count,
      state.grids[0].gutter,
      state.grids[0].align,
      state.grids[0].color,
      state.grids[0].opacity,
      state.grids[0].width
    ],
    [48, 0, 'stretch', '#abcdef', 1, 50]
  )
  assert.deepEqual(normalizeOverlay(null).guides, [])
}

// Per project and per viewport: rulers follow the project, guides and grids the viewport.
{
  const guide = { id: 'g', axis: 'x', position: 40 }
  let store = storeOverlay(
    {},
    '/a',
    'desktop',
    { ...normalizeOverlay({}), rulers: true, guides: [guide] },
    1
  )
  store = storeOverlay(
    store,
    '/a',
    'mobile',
    { ...normalizeOverlay({}), rulers: true, gridVisible: true },
    2
  )
  assert.deepEqual(overlayFor(store, '/a', 'desktop').guides, [guide])
  assert.equal(overlayFor(store, '/a', 'mobile').guides.length, 0)
  assert.equal(overlayFor(store, '/a', 'mobile').gridVisible, true)
  assert.equal(overlayFor(store, '/a', 'desktop').rulers, true)
  assert.equal(overlayFor(store, '/b', 'desktop').rulers, false, 'another project starts empty')
  assert.equal(
    overlayFor(JSON.parse(JSON.stringify(store)), '/a', 'desktop').guides[0].position,
    40
  )
  for (let i = 0; i < MAX_OVERLAY_PROJECTS + 5; i++)
    store = storeOverlay(store, `/p${i}`, 'desktop', normalizeOverlay({}), 10 + i)
  assert.equal(Object.keys(store).length, MAX_OVERLAY_PROJECTS, 'old projects are dropped')
  assert.equal(store['/a'], undefined, 'the least recently changed first')
}

console.log(
  'GUIDE-DISTANCE PASS — hover distances to guides, grid rows, scroll/fixed, and per-project settings'
)
