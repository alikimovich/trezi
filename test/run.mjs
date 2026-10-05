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
  'platform-owner',
  'native-visible-capture',
  'native-smoke-runner',
  'rename-compat',
  'source-stamp',
  'native-boundary',
  'trezi-agent-tools',
  'preview-agent-tools',
  'codex-mcp',
  'codex-mcp-approvals',
  'codex-model',
  'native-bridge-close',
  'native-service-launch',
  'native-supervised-bridge',
  'native-preview-recovery',
  'native-workspace-controller',
  'preview-supervisor',
  'native-support',
  'activity-attention',
  'display-path',
  'native-sheets',
  'native-settings',
  'native-settings-layout',
  'native-settings-evidence',
  'native-chat-controller',
  'native-long-chat-perf',
  'stop-recovery-ui',
  'live-write-guard',
  'agent-file-access',
  'project-path',
  'network-volume-note',
  'native-composer-layout',
  'native-chat-latest-settle',
  'native-smoke-wait',
  'native-chat-reveal',
  'native-island-editing',
  'no-system-preferences',
  'chat-islands',
  'island-flicker',
  'island-override',
  'island-flicker-frameworks',
  'native-context',
  'native-updates',
  'native-inspector',
  'native-slider-ticks',
  'native-layers',
  'native-editor',
  'native-shell-controller',
  'sidebar-evidence',
  'sidebar-sizing',
  'sidebar-icon',
  'sidebar-focus',
  'native-git',
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
  'conversation-handoff',
  'pr-body',
  'feedback-body',
  'feedback-diagnostics',
  'publish-message',
  'publish-description',
  'slash-token',
  'skills-discovery',
  'provider-skills',
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
  'run-stats',
  'codex-usage',
  'file-tree',
  'media-types',
  'rules',
  'tw-classes',
  'tw-styles',
  'token-match',
  'style-tokens',
  'layers-move',
  'layers-labels',
  'measure-distance',
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
// Builds the full Swift service and runs real XPC; must not share workers with other
// swiftc-heavy unit tests or the default 120 s budget is eaten by parallel compiles.
// keychain-rebuild compiles the Keychain helper three times (LKM-144).
const UNIT_EXCLUSIVE = new Set(['service-process', 'keychain-rebuild'])
const UNIT_TIMEOUT_MS = {
  'service-process': 240_000,
  'keychain-rebuild': 300_000,
  'setup-vite-real': 300_000
}
const selected = new Set()
const options = {
  jobs: Math.min(4, availableParallelism()),
  'timeout-ms': 120_000,
  'log-tail': 0,
  filter: null
}
let serial = false
try {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--serial') serial = true
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
    `${error.message}\nusage: node test/run.mjs <unit|native|live|all> [--serial] [--jobs=4] [--timeout-ms=120000] [--log-tail=150] [--filter=name,name]`
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
console.log(`Test logs: ${logs}`)
for (const [tier, members] of Object.entries(TIERS)) {
  if (!selected.has(tier)) continue
  const tests = members.filter((name) => !options.filter || options.filter.has(name))
  if (!tests.length) continue
  const jobs = serial || tier !== 'unit' ? 1 : options.jobs
  console.log(`\n${tier}: ${tests.length} tests, at most ${jobs} workers`)
  const items = tests.map((name) => ({
    name,
    exclusive: tier !== 'unit' || UNIT_EXCLUSIVE.has(name)
  }))
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
const duration = Date.now() - start
const counts = {}
for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1
writeFileSync(
  join(logs, 'summary.json'),
  JSON.stringify({ duration, counts, builds, results }, null, 2) + '\n'
)
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
