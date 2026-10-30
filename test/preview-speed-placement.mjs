import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-385: the preview speed badge hangs under its toolbar control. The fixture runs the
// production placement through the host's conversions; the source pins cover what only the
// native `preview-speed` smoke runs: who places the badge, and that it stays over the islands.
if (process.platform !== 'darwin') {
  console.log('PREVIEW-SPEED-PLACEMENT SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('preview-speed-placement', [
    'test/fixtures/preview-speed-placement/main.swift',
    'src/native/PreviewSpeedPlacement.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const { anchor, under, slidAnchor, slid, none, page } = report
  const gap = report.gap.value
  const centerOff = (a, b) => Math.abs(a.x + a.width / 2 - (b.x + b.width / 2))

  // At rest the control ends above the canvas: the badge is under the toolbar, not over it.
  assert.ok(
    anchor.y + anchor.height < 0,
    `the control is in the toolbar: ${JSON.stringify(anchor)}`
  )
  assert.equal(under.y, gap, 'a small gap under the toolbar')
  assert.ok(centerOff(under, anchor) <= 0.5, `centered: ${JSON.stringify({ under, anchor })}`)
  assert.equal(under.x, Math.round(under.x), 'on a whole point')

  // A toolbar window sliding over the canvas pushes the badge down with it.
  assert.equal(slid.y, slidAnchor.y + slidAnchor.height + gap, 'below the slid toolbar')
  assert.ok(centerOff(slid, slidAnchor) <= 0.5, 'still centered')

  // No control in a window: still on screen, in the page's top trailing corner.
  assert.equal(none.x + none.width, page.x + page.width - 10)
  assert.equal(none.y, page.y + 10)

  // The smoke's assertion fails the old corner and an off-centre badge.
  const { badgeProblem } = await import('../src/native/smoke-preview-speed.ts')
  const state = (frame) => ({ visible: true, frame, anchor: 'speed', anchorFrame: anchor, page })
  assert.equal(badgeProblem(state(under), 'speed'), undefined)
  const corner = { ...under, x: page.x + 10, y: page.y + page.height - under.height - 10 }
  assert.match(badgeProblem(state(corner), 'speed'), /far below/)
  assert.match(badgeProblem(state({ ...under, x: under.x + 5 }), 'speed'), /centered/)
  assert.match(badgeProblem(state(under), 'overlay'), /anchored to/)
  assert.match(badgeProblem({ ...state(under), visible: false }, 'speed'), /hidden/)
  // Hung correctly from a control that is itself down there: the corner alone fails it.
  const low = { x: corner.x, y: corner.y - gap - 36, width: corner.width, height: 36 }
  assert.match(badgeProblem({ ...state(corner), anchorFrame: low }, 'speed'), /corner/)

  // Every layout and every toolbar measure place it; the label and input stay as they were.
  const speed = readFileSync('src/native/PreviewSpeed.swift', 'utf8')
  const layout = readFileSync('src/native/WorkspaceLayout.swift', 'utf8')
  const toolbar = readFileSync('src/native/ToolbarAddress.swift', 'utf8')
  const host = readFileSync('src/native/Host.swift', 'utf8')
  assert.match(layout, /host\.placeSpeedBadge\(\)/)
  assert.match(toolbar, /func measureToolbar\(\) \{\n\s+defer \{ toolbarLaidOut\?\(\) \}/)
  assert.match(host, /shell\.toolbarLaidOut = \{ \[weak self\] in self\?\.placeSpeedBadge\(\) \}/)
  assert.match(speed, /override func hitTest\(_ point: NSPoint\) -> NSView\? \{ nil \}/)
  assert.ok(
    host.indexOf('canvas.addSubview(layers)') < host.indexOf('canvas.addSubview(speedBadge)'),
    'the badge is over the islands'
  )
  assert.match(layout, /addSubview\(host\.speedBadge, positioned: \.above, relativeTo: nil\)/)
  console.log(
    'PREVIEW-SPEED-PLACEMENT PASS — under the toolbar, centered, follows a sliding toolbar'
  )
}
