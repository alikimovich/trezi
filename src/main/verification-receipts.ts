import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * LOCAL-WEBKIT-2: the host's record of one `preview_verify` run. Trezi writes it from
 * what it observed itself: the exact source snapshot of the checkout the server compiled,
 * the private server's generation, the document, the engine, every check with the
 * expected and actual value, and the artifacts it captured (with their SHA-256). An agent
 * can read receipts but never create or edit one. `verified` needs every check to pass
 * AND the source to be the same exact snapshot before and after the run, served by the
 * same server generation, with no navigation during the checks. `receiptStatus` turns a
 * receipt stale as soon as the source, the server or the page moves on.
 *
 * Coverage is stated, never implied: an engine on this Mac with an emulated viewport or
 * color scheme is not a Windows, Android, iOS or real-device result.
 */

export type VerifyEngine = 'webkit' | 'chromium'

export interface ReceiptArtifact {
  kind: 'screenshot'
  path: string
  sha256: string
  bytes: number
  width: number | null
  height: number | null
  mimeType: string
}

export interface ReceiptCheck {
  index: number
  check: string
  pass: boolean
  expected: unknown
  actual: unknown
  detail?: string
  /** When it first held, from the start of the checks (condition waits). */
  ms: number
}

export interface ReceiptStep {
  action: string
  target?: string
  ok: boolean
  detail?: string
}

export interface VerificationReceipt {
  id: string
  createdAt: string
  engine: VerifyEngine
  engineDetail: string
  /** How the page received input: WebKit's synthetic DOM events, or CDP input in Chromium. */
  input: 'synthetic-dom' | 'cdp-trusted'
  coverage: {
    engine: string
    os: string
    emulated: { viewport: string; colorScheme: string }
    notCovered: string[]
  }
  runtime: {
    kind: 'private' | 'live'
    agent: string | null
    root: string
    url: string | null
    generation: number | null
  }
  /** `tree`: the candidate Git tree of `snapshot`, which landing gates on (LOCAL-WEBKIT-3). */
  source: { snapshot: string | null; tree: string | null; head: string | null; dirty: number }
  document: { url: string | null; navigation: number | null; startedAt: string | null }
  /** Requested, and for WebKit what the page itself reported (`measured`). */
  viewport: {
    width: number
    height: number
    theme: string
    measured?: { innerWidth: number; innerHeight: number; dark: boolean | null } | null
  }
  steps: ReceiptStep[]
  checks: ReceiptCheck[]
  artifacts: ReceiptArtifact[]
  checksPassed: boolean
  verified: boolean
  /** Why `verified` is false despite passing checks, or why the run stopped. */
  reason: string | null
  ms: number
  /** The request as given, so Retry can run the same checks on a reconciled source. */
  recipe?: Record<string, unknown>
}

/**
 * LOCAL-WEBKIT-3: the host's record of one `run_checks` command (`command-checks.ts`), for
 * projects without a browser preview and for builds and tests. Like a browser receipt,
 * an agent can read it but never write it; `verified` needs exit 0 and the same exact
 * source before and after the run.
 */
export interface CommandReceipt {
  id: string
  createdAt: string
  kind: 'command'
  /** The check's name (a `package.json` script, `swift-build` or `swift-test`). */
  check: string
  /** What ran, as argv. */
  command: string[]
  root: string
  source: { snapshot: string | null; tree: string | null; head: string | null; dirty: number }
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  /** The last few KB of stdout and stderr, interleaved. */
  output: string
  verified: boolean
  reason: string | null
  ms: number
}

/** What the session's checkout, server and page are now, for `receiptStatus`. */
export interface CurrentState {
  snapshot: string | null
  generation: number | null
  serverRunning: boolean
  /** The WebKit page's navigation and document now; null when the page is closed. */
  navigation: number | null
  documentStartedAt: string | null
}

export const NOT_COVERED = ['Windows', 'Android', 'iOS', 'real devices', 'other browser versions']
const MAX_RECEIPTS = 20
const receipts = new Map<string, VerificationReceipt[]>()
const commands = new Map<string, CommandReceipt[]>()

export const newReceiptId = () => `vr-${randomBytes(6).toString('hex')}`

let macos: string | null = null
/** This Mac's macOS version, for the receipt's coverage (never a device or another OS). */
export function macOSVersion(): string {
  if (macos) return macos
  try {
    macos = `macOS ${execFileSync('/usr/bin/sw_vers', ['-productVersion'], { timeout: 2000 }).toString().trim()}`
  } catch {
    macos = `macOS (Darwin ${release()})`
  }
  return macos
}

/** A check's observed value as the receipt keeps it: long text is clipped. */
export const receiptValue = (value: unknown): unknown =>
  typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value

/** The receipt list of one session: its key and the checkout it works in. */
export const receiptSession = (key: string, root: string) =>
  createHash('sha256').update(`${key}\0${root}`).digest('hex').slice(0, 24)

let artifactsRoot = join(tmpdir(), 'trezi-verification')
/** Test and smoke seam: where artifacts are written (`null` restores the default). */
export function setVerificationArtifactsRoot(dir: string | null): void {
  artifactsRoot = dir ?? join(tmpdir(), 'trezi-verification')
}

/** Writes one captured artifact to the session's private directory and fingerprints it. */
export function writeArtifact(
  session: string,
  name: string,
  bytes: Buffer,
  mimeType: string,
  size: { width: number; height: number } | null
): ReceiptArtifact {
  const dir = join(artifactsRoot, session)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, name)
  writeFileSync(path, bytes, { mode: 0o600 })
  return artifactRecord(path, bytes, mimeType, size)
}

export const artifactRecord = (
  path: string,
  bytes: Buffer,
  mimeType: string,
  size: { width: number; height: number } | null
): ReceiptArtifact => ({
  kind: 'screenshot',
  path,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  width: size?.width ?? null,
  height: size?.height ?? null,
  mimeType
})

/** The directory a session's artifacts go to (created private). */
export function artifactDirectory(session: string): string {
  const dir = join(artifactsRoot, session)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Keeps the session's newest receipts; an evicted receipt's artifacts are deleted. */
export function recordReceipt(session: string, receipt: VerificationReceipt): void {
  const list = receipts.get(session) ?? []
  list.push(receipt)
  while (list.length > MAX_RECEIPTS) {
    const old = list.shift()
    for (const artifact of old?.artifacts ?? []) rmSync(artifact.path, { force: true })
  }
  receipts.set(session, list)
}

/** This session's receipts, newest last. Other sessions' receipts are never listed. */
export function sessionReceipts(session: string): readonly VerificationReceipt[] {
  return receipts.get(session) ?? []
}

/** Keeps the session's newest command receipts. */
export function recordCommandReceipt(session: string, receipt: CommandReceipt): void {
  const list = commands.get(session) ?? []
  list.push(receipt)
  while (list.length > MAX_RECEIPTS) list.shift()
  commands.set(session, list)
}

/** This session's command receipts, newest last. */
export function sessionCommandReceipts(session: string): readonly CommandReceipt[] {
  return commands.get(session) ?? []
}

/** Drops the session's receipts and its whole artifact folder (screenshots of failed runs too). */
export function clearReceipts(session: string): void {
  for (const receipt of receipts.get(session) ?? [])
    for (const artifact of receipt.artifacts) rmSync(artifact.path, { force: true })
  receipts.delete(session)
  commands.delete(session)
  rmSync(join(artifactsRoot, session), { recursive: true, force: true })
}

/**
 * One session closed: only the receipt session it owns, `receiptSession(key, projectKey(root))`
 * with the same `emitKey` and root its `preview_verify` calls used, is cleared (receipts and
 * artifact folder). Chats without a worktree share the live root, so releasing by root would
 * delete a sibling chat's evidence. Receipts live in memory only. The landing gate
 * (`integration-gate.ts`) is their one other reader; a closing session's final landing
 * uses the copy `retainGateEvidence` took just before this ran.
 */
export function releaseSessionReceipts(key: string, root: string): void {
  clearReceipts(receiptSession(key, root))
}

/** Whether a receipt still describes the session's checkout, server and page. */
export function receiptStatus(
  receipt: VerificationReceipt,
  now: CurrentState
): { current: boolean; reason: string | null } {
  if (!receipt.verified) return { current: false, reason: receipt.reason ?? 'not-verified' }
  if (!now.snapshot) return { current: false, reason: 'snapshot-unavailable' }
  if (now.snapshot !== receipt.source.snapshot) return { current: false, reason: 'source-changed' }
  if (!now.serverRunning) return { current: false, reason: 'runtime-stopped' }
  if (now.generation !== receipt.runtime.generation)
    return { current: false, reason: 'runtime-restarted' }
  if (receipt.engine === 'webkit') {
    if (now.navigation === null) return { current: false, reason: 'page-closed' }
    if (now.navigation !== receipt.document.navigation)
      return { current: false, reason: 'navigated' }
    if (now.documentStartedAt !== receipt.document.startedAt)
      return { current: false, reason: 'document-replaced' }
  }
  return { current: true, reason: null }
}

/** A short summary for the agent's answer. */
export function receiptSummary(receipt: VerificationReceipt): string {
  const passed = receipt.checks.filter((c) => c.pass).length
  const verdict = receipt.verified
    ? `VERIFIED: ${passed}/${receipt.checks.length} checks passed on source snapshot ${receipt.source.snapshot?.slice(0, 12)}`
    : receipt.checksPassed
      ? `Checks passed (${passed}/${receipt.checks.length}) but NOT verified: ${receipt.reason}`
      : `NOT verified: ${passed}/${receipt.checks.length} checks passed${receipt.reason ? ` (${receipt.reason})` : ''}`
  return `Receipt ${receipt.id} (${receipt.engine}, ${receipt.coverage.emulated.viewport}, ${receipt.coverage.emulated.colorScheme}). ${verdict}. Coverage: ${receipt.coverage.engine} on ${receipt.coverage.os} only; not ${receipt.coverage.notCovered.join(', ')}.`
}
