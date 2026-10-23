#!/usr/bin/env node
// Bounded subprocess runner. See docs/TESTING.md for isolation and reporting.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePlan, planFromGit, typecheckPlan } from './helpers/test-plan.mjs'
import { acquireRunLock, runCommand, runQueue } from './helpers/test-runner.mjs'
import { TIERS, TYPECHECKS, UNIT_TIMEOUT_MS } from './tiers.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(TEST_DIR)

// Tier membership, timeouts and typechecks live in test/tiers.mjs.
// Durations from the last `--report` run; the slowest tests start first.
const TIMES = join(ROOT, '.local/test-times.json')
const selected = new Set()
const options = {
  // Unit tests are mostly CPU-light processes; swiftc is bounded by its own lane.
  // Two cores stay free, up to 8 workers, never fewer than the old min(4, cores) (a
  // 3-core CI runner keeps 3).
  jobs: Math.max(Math.min(4, availableParallelism()), Math.min(availableParallelism() - 2, 8)),
  'timeout-ms': 120_000,
  'log-tail': 0,
  filter: null,
  changed: null
}
let serial = false
let report = false
let typecheck = false
let list = false
try {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--serial') serial = true
    else if (arg === '--report') report = true
    else if (arg === '--typecheck') typecheck = true
    else if (arg === '--list') list = true
    else if (arg === 'all') for (const t of Object.keys(TIERS)) selected.add(t)
    else if (Object.hasOwn(TIERS, arg)) selected.add(arg)
    else {
      const match = /^--(jobs|timeout-ms|log-tail|filter|changed)=(.+)$/.exec(arg)
      if (!match) throw new Error(`unknown argument: ${arg}`)
      const [, key, value] = match
      if (key === 'filter') options.filter = new Set(value.split(','))
      else if (key === 'changed') options.changed = value
      else {
        const n = Number(value)
        if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647)
          throw new Error(`invalid ${key}: ${value}`)
        options[key] = n
      }
    }
  }
  if (!selected.size) throw new Error('select at least one tier')
  if (options.changed && (options.filter || selected.size !== 1 || !selected.has('unit')))
    throw new Error('--changed selects within the unit tier alone and cannot take --filter')
  if (options.filter) {
    const names = [...selected].flatMap((t) => TIERS[t])
    for (const name of options.filter)
      if (!names.includes(name)) throw new Error(`test not in selected tiers: ${name}`)
  }
} catch (error) {
  console.error(
    `${error.message}\nusage: node test/run.mjs <unit|native|live|all> [--serial] [--jobs=8] [--timeout-ms=120000] [--log-tail=150] [--filter=name,name | --changed=<base-ref>] [--report] [--typecheck] [--list]`
  )
  process.exit(2)
}

// --changed: the changed-file plan (test/helpers/test-plan.mjs). No plan, no run: a ref
// or diff failure exits 2 and never passes by selecting nothing.
let plan = null
if (options.changed) {
  try {
    plan = planFromGit(ROOT, options.changed)
  } catch (error) {
    console.error(`test selection failed, nothing was run: ${error.message}`)
    process.exit(2)
  }
  // With --list stdout stays tier/name pairs; the reasons go to stderr.
  ;(list ? console.error : console.log)(describePlan(plan))
  if (plan.mode === 'selected') options.filter = new Set(plan.unit)
}
const checks = !typecheck
  ? { run: [], notRun: [] }
  : plan?.mode === 'selected'
    ? {
        run: [],
        notRun: Object.keys(TYPECHECKS).map((name) => ({ name, reason: plan.typecheckReason }))
      }
    : typecheckPlan((path) => readFileSync(join(ROOT, path), 'utf8'))

// Resolve and validate the same selection as execution, without locks, artifacts,
// builds, provider calls or desktop access. One tier/name pair per line.
if (list) {
  for (const [tier, members] of Object.entries(TIERS)) {
    if (!selected.has(tier)) continue
    for (const name of members)
      if (!options.filter || options.filter.has(name)) console.log(`${tier}\t${name}`)
  }
  for (const name of checks.run) console.log(`typecheck\t${name}`)
  for (const { name, reason } of checks.notRun)
    console.error(`not run: typecheck ${name} — ${reason}`)
  process.exit(0)
}

const artifacts = join(TEST_DIR, 'artifacts', 'runs')
mkdirSync(artifacts, { recursive: true })
let releaseLock
try {
  releaseLock = acquireRunLock(join(artifacts, '.runner-lock'))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
process.once('exit', releaseLock)
const logs = mkdtempSync(join(artifacts, 'run-'))
const controller = new AbortController()
let interrupted
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    interrupted = signal
    controller.abort()
  })
const start = Date.now()
const results = []
const builds = []
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`
function logTail(path, count, label) {
  let lines
  try {
    lines = readFileSync(path, 'utf8').replace(/\n$/, '').split('\n')
  } catch (error) {
    return `  (log unreadable: ${error.message})`
  }
  const tail = lines.slice(-count)
  return [
    `----- ${label}: last ${tail.length} of ${lines.length} log lines -----`,
    ...tail,
    `----- end ${label} -----`
  ].join('\n')
}
let previous = {}
try {
  previous = JSON.parse(readFileSync(TIMES, 'utf8')).tests ?? {}
} catch {}
console.log(`Test logs: ${logs}`)
if (plan) writeFileSync(join(logs, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
for (const { name, reason } of checks.notRun) console.log(`NOT RUN [typecheck] ${name} — ${reason}`)
const typechecks = checks.run.map(async (name) => {
  console.log(`START [typecheck] ${name}`)
  const result = await runCommand({
    command: 'bun',
    args: TYPECHECKS[name],
    cwd: ROOT,
    name,
    log: join(logs, `typecheck-${name}.log`),
    timeoutMs: 300_000,
    signal: controller.signal
  })
  console.log(`${result.outcome} [typecheck] ${name} ${fmt(result.duration)}`)
  if (result.outcome !== 'PASS') {
    console.log(`  Log: ${result.log}`)
    if (options['log-tail'])
      console.log(logTail(result.log, options['log-tail'], `typecheck-${name}`))
  }
  return { tier: 'typecheck', ...result }
})
for (const [tier, members] of Object.entries(TIERS)) {
  if (!selected.has(tier)) continue
  const tests = members.filter((name) => !options.filter || options.filter.has(name))
  if (!tests.length) continue
  const jobs = serial || tier !== 'unit' ? 1 : options.jobs
  console.log(`\n${tier}: ${tests.length} tests, at most ${jobs} workers`)
  // Longest first, so a slow test never starts last; unknown tests keep their order.
  if (tier === 'unit') tests.sort((a, b) => (previous[b] ?? 0) - (previous[a] ?? 0))
  const items = tests.map((name) => ({ name, exclusive: tier !== 'unit' }))
  const tierResults = await runQueue(
    items,
    jobs,
    async ({ name }) => {
      console.log(`START [${tier}] ${name}`)
      // The per-test budgets are listed for the unit tier; a test moved to another tier keeps its.
      const timeoutMs = UNIT_TIMEOUT_MS[name] ?? options['timeout-ms']
      const result = await runCommand({
        command: tier === 'unit' ? 'bun' : 'node',
        args: [join(TEST_DIR, `${name}.mjs`)],
        cwd: ROOT,
        name,
        log: join(logs, `${tier}-${name}.log`),
        timeoutMs,
        signal: controller.signal
      })
      console.log(
        `${result.outcome} [${tier}] ${name} ${fmt(result.duration)}${result.note ? ` — ${result.note}` : ''}`
      )
      if (!['PASS', 'SKIP'].includes(result.outcome)) {
        console.log(`  Log: ${result.log}`)
        // CI keeps only the job output; one write keeps parallel workers from interleaving the tail.
        if (options['log-tail'])
          console.log(logTail(result.log, options['log-tail'], `${tier}-${name}`))
      }
      return result
    },
    controller.signal
  )
  results.push(...tierResults.map((r) => ({ tier, ...r })))
}
results.push(...(await Promise.all(typechecks)))
const duration = Date.now() - start
const counts = {}
for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1
writeFileSync(
  join(logs, 'summary.json'),
  JSON.stringify(
    {
      duration,
      counts,
      builds,
      selection: plan && { mode: plan.mode, unit: plan.unit ?? null, reasons: plan.reasons },
      notRun: checks.notRun,
      results
    },
    null,
    2
  ) + '\n'
)
if (report) {
  const timed = results.filter((r) => ['PASS', 'SKIP', 'FAIL', 'TIMEOUT'].includes(r.outcome))
  console.log('\nSlowest 20:')
  for (const r of [...timed].sort((a, b) => b.duration - a.duration).slice(0, 20))
    console.log(
      `  ${fmt(r.duration).padStart(7)}  [${r.tier}] ${r.name}${r.outcome === 'PASS' ? '' : ` (${r.outcome})`}`
    )
  // Merged, so a filtered run keeps the other tests' last times; only a full pass is
  // a duration worth ordering by (a fast failure or skip would start it last).
  const tests = { ...previous }
  for (const r of timed) if (r.outcome === 'PASS') tests[r.name] = r.duration
  mkdirSync(dirname(TIMES), { recursive: true })
  writeFileSync(
    TIMES,
    JSON.stringify(
      { updated: new Date().toISOString(), duration, jobs: options.jobs, tests },
      null,
      2
    ) + '\n'
  )
  console.log(`Times: ${TIMES}`)
}
console.log(
  `\nSUMMARY: ${Object.entries(counts)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ')}; wall time ${fmt(duration)}`
)
console.log(`Report: ${join(logs, 'summary.json')}`)
process.exitCode = interrupted
  ? interrupted === 'SIGINT'
    ? 130
    : 143
  : results.some((r) => !['PASS', 'SKIP'].includes(r.outcome))
    ? 1
    : 0
