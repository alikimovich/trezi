import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Bun audits the resolved packages in bun.lock, including transitive dependencies.
// Compare advisory identities against the PR base so pre-existing findings remain visible.
function lockCount(directory) {
  const lock = Bun.JSONC.parse(readFileSync(join(directory, 'bun.lock'), 'utf8'))
  const count = Object.keys(lock.packages ?? {}).length
  if (!count) throw new Error('bun.lock has no resolved packages; refusing an empty audit')
  return count
}

function audit(directory) {
  const packages = lockCount(directory)
  const result = spawnSync('bun', ['audit', '--json'], { cwd: directory, encoding: 'utf8' })
  if (result.error || ![0, 1].includes(result.status))
    throw new Error(`bun audit failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`)
  let report
  try { report = JSON.parse(result.stdout) }
  catch { throw new Error(`bun audit returned no JSON: ${result.stderr?.trim() || result.stdout?.slice(0, 200)}`) }
  if (!report || Array.isArray(report) || typeof report !== 'object')
    throw new Error('bun audit returned an unexpected report shape')
  const findings = []
  for (const [name, advisories] of Object.entries(report)) {
    if (!Array.isArray(advisories)) throw new Error(`unexpected advisories for ${name}`)
    for (const advisory of advisories) {
      if (!advisory || !['info', 'low', 'moderate', 'high', 'critical'].includes(advisory.severity))
        throw new Error(`unexpected advisory severity for ${name}`)
      const id = String(advisory.github_advisory_id ?? advisory.id ?? advisory.url ?? '')
      if (!id) throw new Error(`advisory for ${name} has no identity`)
      findings.push({ name, id, severity: advisory.severity, url: advisory.url ?? '' })
    }
  }
  if (result.status === 1 && !findings.length)
    throw new Error(`bun audit exited 1 without findings: ${result.stderr?.trim() || 'unknown error'}`)
  return { packages, findings }
}

export function classifyFindings(current, previous) {
  if (!previous) return { old: new Set(), added: [], blocking: [] }
  const old = new Set(previous.map(item => `${item.name}\0${item.id}`))
  const added = current.filter(item => !old.has(`${item.name}\0${item.id}`))
  const blocking = added.filter(item => ['high', 'critical'].includes(item.severity))
  return { old, added, blocking }
}

if (import.meta.main) {
  const base = process.env.TREZI_AUDIT_BASE_SHA
  const temporary = mkdtempSync(join(tmpdir(), 'trezi-audit-'))
  try {
    const current = audit(process.cwd())
    let previous
    if (base) {
      if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('invalid PR base SHA')
      for (const file of ['bun.lock', 'package.json']) {
        const result = spawnSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' })
        if (result.status !== 0) throw new Error(`cannot read ${file} from PR base: ${result.stderr?.trim()}`)
        writeFileSync(join(temporary, file), result.stdout)
      }
      previous = audit(temporary)
    }
    // A push to main has no PR base. Report its baseline without inventing new findings.
    const { old, added, blocking } = classifyFindings(current.findings, previous?.findings)
    console.log(base
      ? `Bun lockfile audit: current ${current.packages} resolved packages, ${current.findings.length} advisories; base ${previous.packages} packages, ${previous.findings.length} advisories; ${added.length} new.`
      : `Bun lockfile audit baseline: ${current.packages} resolved packages, ${current.findings.length} advisories.`)
    for (const item of current.findings) {
      const label = !base ? 'baseline' : old.has(`${item.name}\0${item.id}`) ? 'existing' : 'new'
      console.log(`${label} ${item.severity} ${item.name} ${item.id} ${item.url}`)
    }
    if (blocking.length) {
      console.error(`${blocking.length} newly introduced high/critical advisories block this PR.`)
      process.exitCode = 1
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
