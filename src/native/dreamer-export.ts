import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DreamerDigest } from '../main/dreamer-digest'
import { dreamerRedact } from '../main/dreamer-digest'
import {
  type DreamerFile,
  type DreamerSendResult,
  dreamerMarkdown,
  dreamerTaskIds
} from '../shared/dreamer'

/**
 * LKM-202: Export Dreamer Report… and Send to Agent OS. Both run only on the user's
 * explicit action, and both redact again: the user may have edited the proposals.
 */

export const DREAMER_URL_KEY = 'trezi:dreamer:agent-os-url'
export const DREAMER_PROJECT_KEY = 'trezi:dreamer:agent-os-project'
export const DREAMER_TOKEN_KEY = 'trezi:dreamer:agent-os-token'
export const DEFAULT_AGENT_OS_URL = 'http://127.0.0.1:4317'
const SEND_TIMEOUT_MS = 30_000

/** Every string in `value` redacted (secrets, tokens, emails, home folders). */
export function redactDeep<T>(value: T, home = homedir()): T {
  if (typeof value === 'string') return dreamerRedact(value, home) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, home)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, home)])
    ) as T
  return value
}

const ditto = (folder: string, dest: string) =>
  new Promise<void>((resolve, reject) =>
    execFile(
      '/usr/bin/ditto',
      ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, dest],
      { timeout: 30_000 },
      (error) => (error ? reject(error) : resolve())
    )
  )

/**
 * Zips `report.md`, `proposals.json` and `evidence.json` (the digest's redacted
 * statistics and short quotes; never a transcript or a file's contents) to `dest`.
 */
export async function exportDreamerReport(
  dest: string,
  file: DreamerFile,
  digest: DreamerDigest | null,
  home = homedir()
) {
  const clean = redactDeep(file, home)
  const stage = mkdtempSync(join(tmpdir(), 'trezi-dreamer-'))
  try {
    const folder = join(stage, 'Dreamer Report')
    mkdirSync(folder)
    writeFileSync(join(folder, 'report.md'), dreamerMarkdown(clean))
    writeFileSync(join(folder, 'proposals.json'), `${JSON.stringify(clean, null, 2)}\n`)
    writeFileSync(
      join(folder, 'evidence.json'),
      `${JSON.stringify(digest ? redactDeep(digest, home) : {}, null, 2)}\n`
    )
    rmSync(dest, { force: true })
    await ditto(folder, dest)
    return { proposals: clean.proposals.length }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export interface AgentOsTarget {
  url: string
  project: string
  token?: string
}
type Fetch = (url: string, init: RequestInit) => Promise<Response>

const reason = async (response: Response) => {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body?.error === 'string') return `: ${body.error.slice(0, 200)}`
  } catch {}
  return ''
}

/**
 * POSTs the selected proposals to `<url>/api/projects/<project>/proposals`. An Agent
 * OS without that route (404) gets its `POST /proposals` import instead. The token,
 * when set, goes only in the Authorization header.
 */
export async function sendToAgentOs(
  target: AgentOsTarget,
  file: DreamerFile,
  fetchImpl: Fetch = fetch,
  home = homedir()
): Promise<DreamerSendResult> {
  let base: URL
  try {
    base = new URL(target.url.trim() || DEFAULT_AGENT_OS_URL)
  } catch {
    return { ok: false, tasks: [], error: 'The Agent OS URL in Settings → Dreamer is not valid.' }
  }
  if (!['http:', 'https:'].includes(base.protocol))
    return { ok: false, tasks: [], error: 'The Agent OS URL must start with http:// or https://.' }
  const project = target.project.trim()
  if (!project)
    return { ok: false, tasks: [], error: 'Set the Agent OS project ID in Settings → Dreamer.' }
  const root = base.href.replace(/\/+$/, '')
  const clean = redactDeep(file, home)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (target.token?.trim()) headers.authorization = `Bearer ${target.token.trim()}`
  const post = (path: string, body: unknown) =>
    fetchImpl(`${root}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    })
  try {
    let response = await post(`/api/projects/${encodeURIComponent(project)}/proposals`, clean)
    if (response.status === 404)
      response = await post('/proposals', { projectId: project, file: clean })
    if (!response.ok)
      return {
        ok: false,
        tasks: [],
        error: `Agent OS answered ${response.status}${await reason(response)}`
      }
    let body: unknown = null
    try {
      body = await response.json()
    } catch {}
    return { ok: true, tasks: dreamerTaskIds(body) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, tasks: [], error: `Agent OS could not be reached (${message}).` }
  }
}
