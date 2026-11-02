import assert from 'node:assert/strict'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-432: the branch pop-up's busy spinner stays off its truncated text. The real
// BranchPopUpButton is laid out offscreen at a width that fits its title, one that cuts it
// after the CI dot (the 850 pt toolbar) and one that cuts it inside a long branch name. The fit
// check reads the pop-up's drawn ink, so it also refuses a spinner moved over the text by hand.
if (process.platform !== 'darwin') {
  console.log('BRANCH-SPINNER SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('branch-spinner', [
    'test/fixtures/branch-spinner/main.swift',
    'src/native/BranchStatusView.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const dump = JSON.stringify(report)
  for (const [name, mode] of [
    ['wide', 'inline'],
    ['cutAfterDot', 'clipped'],
    ['cutInName', 'trailing']
  ]) {
    assert.equal(report[name].busy, true, `${name} is busy: ${dump}`)
    assert.equal(report[name].mode, mode, `${name} places the spinner ${mode}: ${dump}`)
    assert.equal(
      report[name].fits,
      true,
      `${name}: the spinner is clear of text, chevron, dot: ${dump}`
    )
  }
  // The dot keeps its slot where the text is cut after it (clipped), and gives way to the
  // ellipsis where the name is cut (trailing); the same dot is shown when nothing is cut.
  assert.equal(report.wide.dotVisible && report.wide.dotFits, true, dump)
  assert.equal(report.cutAfterDot.dotVisible && report.cutAfterDot.dotFits, true, dump)
  assert.equal(report.cutInName.dotVisible, false, dump)
  // Idle: no spinner, nothing to reserve.
  assert.equal(report.idle.busy, false, dump)
  assert.equal(report.idle.mode, 'inline', dump)
  // The check can fail: the spinner moved over the ellipsis is not clear of the text.
  assert.equal(report.spinnerOverText.fits, false, `a spinner over the text does not fit: ${dump}`)
  // LKM-440: AppKit's tail truncation dropped the dot's en-space slot as trailing whitespace,
  // so its ellipsis ran into the dot and the chevron sat 18 pt after it. The cell keeps the slot.
  const { cutAfterSlot: cut, fitsWhole: whole } = report
  assert.equal(cut.cut && cut.dotVisible && cut.kept > 0, true, `cut title keeps the dot: ${dump}`)
  const [dotStart, dotEnd] = cut.dotFrame
  const between = cut.runs.slice(0, -1).filter(([start]) => start >= dotEnd - 0.25)
  assert.ok(between.length > 0, `the ellipsis follows the dot: ${dump}`)
  assert.ok(
    !cut.runs.some(([start, end]) => start < dotStart - 0.25 && end > dotStart + 0.25),
    `no glyph runs into the dot: ${dump}`
  )
  const gap = (runs) => runs.at(-1)[0] - runs.at(-2)[1]
  assert.ok(gap(cut.runs) >= 1 && gap(cut.runs) <= 10, `the chevron follows the ellipsis: ${dump}`)
  // Untightened, the cut and the drawing agree: a title that fits is drawn whole.
  assert.equal(whole.cut || whole.kept > 0, false, `the whole title fits at 94.5 pt: ${dump}`)
  assert.ok(gap(whole.runs) >= 1 && gap(whole.runs) <= 6.5, `untruncated chevron gap: ${dump}`)
  console.log('BRANCH-SPINNER PASS')
}
