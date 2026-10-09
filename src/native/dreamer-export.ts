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
/** 'on' asks Agent OS to start a worker on each created task; anything else does not. */
export const DREAMER_START_KEY = 'trezi:dreamer:agent-os-start'
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
  /** Ask Agent OS to start each created task (default off). */
  start?: boolean
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
 * One `POST <url>/proposals` with `{projectId, file, start}` (`start` is false unless
 * the user turned it on). The token, when set, goes only in the Authorization header.
 * Agent OS listens on 127.0.0.1 only, so this reaches it from the same Mac alone.
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
  try {
    const response = await fetchImpl(`${root}/proposals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: project, file: clean, start: target.start === true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    })
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
    return {
      ok: false,
      tasks: [],
      error: `Agent OS could not be reached (${message}). It accepts connections only on this Mac (127.0.0.1), so Send works only here; export the report to import it on the Mac that runs Agent OS.`
    }
  }
}
