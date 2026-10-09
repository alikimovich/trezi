#!/usr/bin/env node
// Bounded subprocess runner. See docs/TESTING.md for isolation and reporting.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireRunLock, runCommand, runQueue } from './helpers/test-runner.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(TEST_DIR)

// --- Tier membership (derived from package.json `test` and `verify` scripts) ---

// Backend logic checks run independently of the native desktop.
const UNIT = [
  'service-contract',
  'service-process',
  'operation-ledger',
  'preferences-owner',
  'workspace-owner',
  'memory-owner',
  'runtime-owner',
  'repository-owner',
  'agent-git',
  'git-messages',
  'repository-recovery',
  'source-owner',
  'conversation-owner',
  'provider-owner',
  'provider-data',
  'provider-login',
  'provider-cold-start',
  'turn-progress',
  'provider-helper-tools',
  'service-session',
  'native-settings-claude',
  'editing-owner',
  'workflow-owner',
  'workflow-durability',
  'branch-safety',
  'platform-owner',
  'native-visible-capture',
  'native-smoke-runner',
  'native-smoke-report',
  'rename-compat',
  'source-stamp',
  'native-boundary',
  'trezi-agent-tools',
  'preview-agent-tools',
  'agent-browser',
  'preview-slow-motion',
  'codex-mcp',
  'codex-mcp-approvals',
  'claude-resume',
  'claude-cwd',
  'codex-model',
  'native-bridge-close',
  'native-service-launch',
  'native-supervised-bridge',
  'native-preview-recovery',
  'native-workspace-controller',
  'chat-new-instant',
  'smoke-timing',
  'preview-supervisor',
  'native-support',
  'activity-attention',
  'quit-guard',
  'display-path',
  'native-sheets',
  'native-settings',
  'native-settings-layout',
  'native-settings-evidence',
  'native-chat-controller',
  'native-long-chat-perf',
  'preview-hover-coalesce',
  'chat-attachments',
  'stop-recovery-ui',
  'chat-stuck-turn',
  'chat-send-queue',
  'live-write-guard',
  'agent-file-access',
  'live-change-watch',
  'project-path',
  'network-volume-note',
  'native-composer-layout',
  'native-chat-latest-settle',
  'native-smoke-wait',
  'native-chat-reveal',
  'native-chat-text',
  'native-island-editing',
  'no-system-preferences',
  'chat-islands',
  'chat-island-status',
  'chat-island-new-chat',
  'chat-island-pending',
  'island-flicker',
  'island-override',
  'island-flicker-frameworks',
  'dependency-refresh-vite',
  'native-context',
  'native-updates',
  'native-inspector',
  'style-class-rule',
  'native-slider-ticks',
  'native-layers',
  'native-editor',
  'native-shell-controller',
  'sidebar-evidence',
  'sidebar-sizing',
  'preview-overlay',
  'sidebar-icon',
  'sidebar-focus',
  'native-git',
  'publish-progress',
  'dependency-issue',
  'native-support-sheets',
  'native-cat-assets',
  'project-ui',
  'project-ui-svelte',
  'project-ui-jev',
  'jev-pilot',
  'test-runner',
  'setup-stamps',
  'setup-vite',
  'setup-vite-real',
  'code-reveal',
  'preview-open',
  'preview-refresh',
  'editor-freshness',
  'preview-page',
  'preview-identity',
  'turn-timing',
  'syntax-highlight',
  'syntax-bundle',
  'conversation-handoff',
  'pr-body',
  'feedback-body',
  'feedback-diagnostics',
  'product-log',
  'dreamer-digest',
  'dreamer-export',
  'publish-message',
  'publish-description',
  'commit-message',
  'slash-token',
  'skills-discovery',
  'provider-skills',
  'states-workbench',
  'three-d-contract',
  'github-connect',
  'html-source',
  'project-key',
  'project-create',
  'environment-changes',
  'project-icon',
  'devserver-net',
  'sidecar-migrate',
  'legacy-names-migrate',
  'legacy-names-audit',
  'diag-cache',
  'diag-rules',
  'sessions-store',
  'preferred-model',
  'project-memory',
  'annotation-store',
  'setup-next',
  'shadow-controls',
  'retirement-census',
  'distribution',
  'signing-identity',
  'native-build-cache',
  'keychain-migration',
  'keychain-rebuild',
  'install-update',
  'project-memory-evaluation',
  'providers-store',
  'model-catalog',
  'model-label',
  'codex-retry-cause',
  'codex-stream',
  'interrupt-escalation',
  'turn-terminal',
  'chat-title',
  'chat-settings',
  'background-model',
  'comment-agents',
  'chat-agent-card',
  'landing-check',
  'run-stats',
  'codex-usage',
  'file-tree',
  'media-types',
  'rules',
  'ask-user',
  'chat-ui',
  'chat-ui-model',
  'device-frame',
  'tw-classes',
  'tw-styles',
  'token-match',
  'style-tokens',
  'layers-move',
  'layers-labels',
  'measure-distance',
  'guide-distance',
  'sibling-drop',
  'inline-style',
  'css-values',
  'control-panels',
  'svelte-instance',
  'docs-links',
  'spring',
  'apca',
  'fluid',
  'oklch',
  'shadows',
  'type-metrics',
  'skills-install',
  'trezi-cli',
  'native-smoke-groups',
  'docs-merge-union',
  'versioning',
  'lint'
]

const NATIVE = ['native-runtime', 'native-source-window', 'native-chat-scroll', 'native-next-hmr']
const LIVE = ['native-runtime-live', 'provider-live-parity']
const TIERS = { unit: UNIT, native: NATIVE, live: LIVE }
// Unit tests share workers: every swiftc compile goes through the 2-wide swiftc lane in
// test/helpers/swift-build.mjs (LKM-167), so no unit test needs to run alone. These
// still get a longer budget for a cold Swift cache.
const UNIT_TIMEOUT_MS = {
  'service-process': 240_000,
  // Its Swift fixture queues behind other tests' swiftc runs; it takes 110 s+ under load.
  'repository-owner': 240_000,
  // Same: 17 s warm, but over 120 s in a cold 8-worker run while the swiftc lane is saturated.
  'runtime-owner': 240_000,
  // Same (LKM-209): the checks take ~10 s, but the workflow fixture is a cold compile of
  // most service sources after nearly every service change, queued behind other swiftc runs.
  'workflow-durability': 240_000,
  'workflow-owner': 240_000,
  // Same (LKM-217): Swift fixtures that compile the shared service or host sources. A cold
  // 8-worker run took 120 s+ for the first two and 106–120 s for the last two, against
  // 22–40 s on a warm tree; a longer budget separates queueing from a real hang.
  'platform-owner': 240_000,
  'native-settings-layout': 240_000,
  'native-composer-layout': 240_000,
  'native-chat-latest-settle': 240_000,
  'keychain-rebuild': 300_000,
  // Real Vite install, Swift runtime fixture and a WebKit load.
  'dependency-refresh-vite': 300_000,
  'setup-vite-real': 300_000
}
// `--typecheck` runs these next to the tests (quick verification in one command).
const TYPECHECKS = {
  typecheck: ['run', 'typecheck'],
  'typecheck-native': ['run', 'typecheck:native']
}
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
  filter: null
}
let serial = false
let report = false
let typecheck = false
try {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--serial') serial = true
    else if (arg === '--report') report = true
    else if (arg === '--typecheck') typecheck = true
    else if (arg === 'all') for (const t of Object.keys(TIERS)) selected.add(t)
    else if (Object.hasOwn(TIERS, arg)) selected.add(arg)
    else {
      const match = /^--(jobs|timeout-ms|log-tail|filter)=(.+)$/.exec(arg)
      if (!match) throw new Error(`unknown argument: ${arg}`)
      const [, key, value] = match
      if (key === 'filter') options.filter = new Set(value.split(','))
      else {
        const n = Number(value)
        if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647)
          throw new Error(`invalid ${key}: ${value}`)
        options[key] = n
      }
    }
  }
  if (!selected.size) throw new Error('select at least one tier')
  if (options.filter) {
    const names = [...selected].flatMap((t) => TIERS[t])
    for (const name of options.filter)
      if (!names.includes(name)) throw new Error(`test not in selected tiers: ${name}`)
  }
} catch (error) {
  console.error(
    `${error.message}\nusage: node test/run.mjs <unit|native|live|all> [--serial] [--jobs=8] [--timeout-ms=120000] [--log-tail=150] [--filter=name,name] [--report] [--typecheck]`
  )
  process.exit(2)
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
const checks = typecheck
  ? Object.entries(TYPECHECKS).map(async ([name, args]) => {
      console.log(`START [typecheck] ${name}`)
      const result = await runCommand({
        command: 'bun',
        args,
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
  : []
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
      const timeoutMs =
        tier === 'unit' && UNIT_TIMEOUT_MS[name] ? UNIT_TIMEOUT_MS[name] : options['timeout-ms']
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
results.push(...(await Promise.all(checks)))
const duration = Date.now() - start
const counts = {}
for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1
writeFileSync(
  join(logs, 'summary.json'),
  JSON.stringify({ duration, counts, builds, results }, null, 2) + '\n'
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
