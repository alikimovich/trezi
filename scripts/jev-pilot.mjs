#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { MODEL, INPUT_USD_PER_MILLION, QUESTION, requestFor, validateDataset, evaluate, baseline, metrics } from './jev/core.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const options = { live: false, split: 'holdout', maxUsd: 0.01 }
try {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--live') options.live = true
    else if (arg === '--dry-run') options.live = false
    else if (/^--split=(development|holdout)$/.test(arg)) options.split = arg.split('=')[1]
    else if (/^--max-usd=/.test(arg)) {
      options.maxUsd = Number(arg.slice('--max-usd='.length))
      if (!Number.isFinite(options.maxUsd) || options.maxUsd <= 0 || options.maxUsd > 1) throw new Error('invalid_budget')
    } else throw new Error('invalid_argument')
  }
  const datasetPath = join(root, 'test/fixtures/jev/failure-cases.json')
  const source = readFileSync(datasetPath, 'utf8')
  const dataset = validateDataset(JSON.parse(source))
  const selected = dataset.filter(r => r.split === options.split)
  const localEnv = join(root, '.env.local')
  let key = process.env.TYPESAFE_API_KEY?.trim()
  if (options.live && existsSync(localEnv)) {
    // Refuse tracked or no-longer-ignored local credential files.
    execFileSync('git', ['check-ignore', '-q', '--', '.env.local'], { cwd: root, stdio: 'ignore' })
    if (process.platform !== 'win32' && (statSync(localEnv).mode & 0o077)) throw new Error('credential_file_permissions_use_chmod_600')
    key ||= parseEnv(readFileSync(localEnv, 'utf8')).TYPESAFE_API_KEY?.trim()
  }
  if (options.live && !key) throw new Error('missing_typesafe_key_add_to_ignored_env_local')
  // Byte count is a deliberately conservative planning estimate, not a billing guarantee.
  const plannedInputBytes = selected.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(requestFor(r, [key]))), 0)
  const plannedCostUsd = plannedInputBytes * INPUT_USD_PER_MILLION / 1e6
  if (plannedCostUsd > options.maxUsd) throw new Error('planned_requests_exceed_budget')
  const parent = join(root, 'test/artifacts/jev')
  mkdirSync(parent, { recursive: true })
  const folder = mkdtempSync(join(parent, options.live ? 'live-' : 'dry-'))
  const report = { version: 1, status: options.live ? 'running' : 'dry-run', advisoryOnly: true,
    createdAt: new Date().toISOString(), model: MODEL, split: options.split,
    datasetSha256: createHash('sha256').update(source).digest('hex'),
    rubricSha256: createHash('sha256').update(JSON.stringify(QUESTION)).digest('hex'),
    labelProvenance: 'Agent-authored labels, not independently human-reviewed.',
    datasetComposition: Object.fromEntries(['synthetic', 'observed'].map(s => [s, dataset.filter(r => r.source === s).length])),
    pricing: { inputUsdPerMillion: INPUT_USD_PER_MILLION, outputUsdPerMillion: 0, checked: '2026-09-18', source: 'https://docs.typesafe.ai/models' },
    maxUsd: options.maxUsd, plannedCostUsd, rows: [] }
  const save = () => writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  save()
  if (!options.live) {
    // Reviewed payloads are inspectable, with labels/rationales strictly excluded.
    writeFileSync(join(folder, 'requests.json'), JSON.stringify(selected.map(r => requestFor(r, [key])), null, 2) + '\n', { mode: 0o600 })
    console.log(`DRY RUN: ${selected.length} ${options.split} cases. No network calls. Planned cost estimate $${plannedCostUsd.toFixed(6)}.`)
  } else {
    console.log(`Evaluating ${selected.length} ${options.split} cases sequentially; no automatic retries.`)
    let spent = 0
    for (const entry of selected) {
      const row = { id: entry.id, label: entry.label, source: entry.source, baseline: baseline(entry.evidence) }
      try {
        Object.assign(row, await evaluate(entry, key))
        spent += row.inputTokens * INPUT_USD_PER_MILLION / 1e6
      } catch (error) {
        // Only closed, locally generated codes can escape the transport boundary.
        row.error = /^(provider_http_\d{3}|provider_network_or_timeout|invalid_provider_(json|response))$/.test(error.message)
          ? error.message : 'evaluation_failed'
      }
      report.rows.push(row)
      report.metrics = metrics(report.rows)
      save()
      console.log(`${entry.id}: ${row.error || row.choice}`)
      // Stop on an error rather than turn missing auth or rate limits into 20 requests.
      if (row.error || spent >= options.maxUsd) break
    }
    report.status = report.rows.length === selected.length && !report.rows.some(r => r.error) ? 'complete' : 'incomplete'
    report.plannedCases = selected.length
    report.notAttempted = selected.length - report.rows.length
    report.metrics = metrics(report.rows)
    const m = report.metrics
    report.bySource = Object.fromEntries(['synthetic', 'observed'].map(s => [s, metrics(report.rows.filter(r => r.source === s))]))
    save()
    console.log(`Status: ${report.status}. Completed ${m.completed}/${selected.length}; accuracy ${m.accuracy === null ? 'unavailable' : (m.accuracy * 100).toFixed(1) + '%'}.`)
    if (report.status !== 'complete') process.exitCode = 1
  }
  console.log(`Report: ${join(folder, 'report.json')}`)
} catch (error) {
  const known = new Set(['invalid_budget', 'invalid_argument', 'credential_file_permissions_use_chmod_600',
    'missing_typesafe_key_add_to_ignored_env_local', 'planned_requests_exceed_budget', 'invalid_dataset', 'invalid_dataset_entry', 'invalid_evidence_length'])
  console.error(`Jev pilot: ${known.has(error.message) ? error.message : 'local_setup_failed'}`)
  process.exitCode = 1
}
