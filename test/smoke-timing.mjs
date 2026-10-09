// LKM-211: the shared timing gate. The median of the measured runs (warm-up excluded) meets
// the product target locally; with CI set it gets twice the target, so a real 2× regression
// still fails.
import assert from 'node:assert/strict'
import {
  assertLoadAwareTiming,
  assertTiming,
  formatLoadAwareTiming,
  formatTiming,
  measureTiming,
  median,
  sampleTiming,
  systemLoad,
  TIMING_RUNS,
  timingBudget
} from '../src/native/smoke-timing.ts'

const local = {},
  ci = { CI: 'true' }

assert.equal(timingBudget(100, local), 100, 'local: the product target')
assert.equal(timingBudget(100, ci), 200, 'CI: twice the target, never more')
assert.equal(timingBudget(16, ci), 32)
assert.equal(median([5, 1, 3]), 3)
assert.equal(median([4, 1, 3, 2]), 2.5)

// One slow sample does not decide it; the median does.
const noisy = [20, 25, 103, 22, 21]
assert.equal(assertTiming('noisy', 100, noisy, local).median, 22)

// Locally the strict target holds.
assert.throws(() => assertTiming('slow', 100, [101, 120, 99, 130, 110], local), /over budget/)
assert.throws(() => assertTiming('at target', 100, [100, 100, 100], local), /over budget/)

// CI tolerates runner noise up to the 2× budget, and fails a real regression.
const noisyCi = [150, 160, 170, 140, 180]
assert.throws(() => assertTiming('noisy CI', 100, noisyCi, local), /over budget/)
assert.equal(assertTiming('noisy CI', 100, noisyCi, ci).budget, 200)
assert.throws(
  () => assertTiming('2× regression', 100, [205, 210, 220, 201, 230], ci),
  /median 210 ms .*target 100, budget 200, CI\) is over budget/
)
assert.throws(() => assertTiming('exactly 2×', 100, [200, 200, 200], ci), /over budget/)
assert.throws(() => assertTiming('no runs', 100, [], local), /no measured runs/)

// A warm-up run, then TIMING_RUNS measured ones; the warm-up is never counted.
const seen = []
const runs = await sampleTiming((run) => {
  seen.push(run)
  return run < 0 ? 1_000 : run
})
assert.deepEqual(seen, [-1, 0, 1, 2, 3, 4])
assert.equal(TIMING_RUNS, 5)
assert.deepEqual(runs, [0, 1, 2, 3, 4], 'the slow warm-up is not measured')
const timing = await measureTiming('async', 100, async (run) => (run < 0 ? 5_000 : 10 + run))
assert.equal(timing.median, 12)
assert.match(
  formatTiming(timing),
  /^async: median 12 ms of 10\/11\/12\/13\/14 \(target 100, budget/
)

// LKM-222: CPU-time gate. The median is held to the target in the report and fails only
// above twice the target while the machine is not overloaded; the load is recorded.
assert.deepEqual(systemLoad(5, 10), { load1: 5, cpus: 10, perCore: 0.5, overloaded: false })
assert.equal(systemLoad(10, 10).overloaded, true, 'one runnable thread per core is overloaded')
assert.equal(systemLoad(3, 0).perCore, 3, 'no core count reads as one core')
const live = systemLoad()
assert.ok(live.cpus >= 1 && live.load1 >= 0, `this machine's load: ${JSON.stringify(live)}`)
const idle = systemLoad(2, 10),
  busy = systemLoad(24, 10)
const fast = assertLoadAwareTiming('typing', 16, [11, 40, 10, 12, 11], idle)
assert.deepEqual([fast.median, fast.overTarget, fast.gated, fast.ceiling], [11, false, true, 32])
assert.match(
  formatLoadAwareTiming(fast),
  /^typing: median 11 ms of 11\/40\/10\/12\/11 \(target 16, ceiling 32; load 2\.00 on 10 cores = 0\.20\/core; within target\)$/
)
const over = assertLoadAwareTiming('typing', 16, [20, 21, 19], idle)
assert.ok(over.overTarget, 'over the target, under the ceiling: reported, not failed')
assert.match(formatLoadAwareTiming(over), /over the product target/)
assert.equal(assertLoadAwareTiming('typing', 16, [32, 32, 32], idle).median, 32, 'at 2×')
assert.throws(
  () => assertLoadAwareTiming('typing', 16, [33, 40, 35], idle),
  /median 35 ms .*ceiling 32; load 2\.00 .*is over the ceiling/
)
const loaded = assertLoadAwareTiming('typing', 16, [57, 110, 80], busy)
assert.equal(loaded.gated, false, 'an overloaded machine records, never fails')
assert.match(formatLoadAwareTiming(loaded), /2\.40\/core, overloaded; not gated/)
assert.throws(() => assertLoadAwareTiming('typing', 16, [], idle), /no measured runs/)

console.log('SMOKE-TIMING OK — median after a warm-up, strict target locally, 2× budget on CI')
