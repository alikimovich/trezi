import assert from 'node:assert/strict'
import { availableParallelism, loadavg } from 'node:os'

/**
 * LKM-211: wall-clock timing checks (unit tests and the native smoke) gate on the median
 * of several runs after one warm-up, so a single noisy sample on a shared runner cannot
 * fail them. Locally the median must meet the product target; with `CI` set it gets twice
 * the target, which still fails a real 2× regression.
 */
export const TIMING_RUNS = 5

/** The limit a median is held to: the product target, or twice it on CI. */
export function timingBudget(
  target: number,
  env: Record<string, string | undefined> = process.env
) {
  return env.CI ? target * 2 : target
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface Timing {
  label: string
  target: number
  budget: number
  median: number
  runs: number[]
}

const ms = (value: number) => `${Math.round(value * 10) / 10}`

/** One line for a test's output: median, every run, target and budget. */
export function formatTiming(timing: Timing): string {
  const ci = timing.budget === timing.target ? '' : ', CI'
  return `${timing.label}: median ${ms(timing.median)} ms of ${timing.runs.map(ms).join('/')} (target ${timing.target}, budget ${timing.budget}${ci})`
}

/** Assert the median of measured `runs` (warm-up excluded) is under the budget. */
export function assertTiming(
  label: string,
  target: number,
  runs: number[],
  env: Record<string, string | undefined> = process.env
): Timing {
  assert.ok(runs.length > 0, `${label}: no measured runs`)
  const timing = { label, target, budget: timingBudget(target, env), median: median(runs), runs }
  assert.ok(timing.median < timing.budget, `${formatTiming(timing)} is over budget`)
  return timing
}

/**
 * LKM-222: the machine's 1-minute load average with its core count. Other workers that
 * build and test on the same Mac push it past one runnable thread per core; then even
 * CPU time is unreliable (the main thread may run on efficiency cores).
 */
export interface SystemLoad {
  load1: number
  cpus: number
  perCore: number
  overloaded: boolean
}

export function systemLoad(load1 = loadavg()[0], cpus = availableParallelism()): SystemLoad {
  const perCore = load1 / Math.max(1, cpus)
  return { load1, cpus, perCore, overloaded: perCore >= 1 }
}

export interface LoadAwareTiming extends Timing {
  /** Twice the target: the median fails above it while the machine is not overloaded. */
  ceiling: number
  load: SystemLoad
  overTarget: boolean
  gated: boolean
}

const loadText = (load: SystemLoad) =>
  `load ${load.load1.toFixed(2)} on ${load.cpus} cores = ${load.perCore.toFixed(2)}/core${load.overloaded ? ', overloaded' : ''}`

export function formatLoadAwareTiming(timing: LoadAwareTiming): string {
  const state = !timing.gated
    ? 'not gated: machine overloaded'
    : timing.overTarget
      ? 'over the product target'
      : 'within target'
  return `${timing.label}: median ${ms(timing.median)} ms of ${timing.runs.map(ms).join('/')} (target ${timing.target}, ceiling ${timing.ceiling}; ${loadText(timing.load)}; ${state})`
}

/**
 * For CPU-time measurements of main-thread work (LKM-222): the median of the measured
 * runs (warm-up excluded) is reported against the product target, and fails only above
 * twice the target while the machine is not overloaded. The load is part of the result.
 */
export function assertLoadAwareTiming(
  label: string,
  target: number,
  runs: number[],
  load: SystemLoad
): LoadAwareTiming {
  assert.ok(runs.length > 0, `${label}: no measured runs`)
  const value = median(runs),
    ceiling = target * 2
  const timing = {
    label,
    target,
    budget: ceiling,
    median: value,
    runs,
    ceiling,
    load,
    overTarget: value >= target,
    gated: !load.overloaded
  }
  assert.ok(
    !timing.gated || value <= ceiling,
    `${formatLoadAwareTiming(timing)} is over the ceiling`
  )
  return timing
}

/** Run `sample` once as a warm-up, then `runs` times; each call returns its duration in ms. */
export async function sampleTiming(
  sample: (run: number) => number | Promise<number>,
  runs = TIMING_RUNS
): Promise<number[]> {
  await sample(-1)
  const times: number[] = []
  for (let run = 0; run < runs; run++) times.push(await sample(run))
  return times
}

/** Warm up, measure `runs` samples and assert their median against `target`. */
export async function measureTiming(
  label: string,
  target: number,
  sample: (run: number) => number | Promise<number>,
  runs = TIMING_RUNS
): Promise<Timing> {
  return assertTiming(label, target, await sampleTiming(sample, runs))
}
