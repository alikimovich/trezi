import { execFile } from 'node:child_process'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { conflictMarkerFiles, type ResolveStage, readBlobAt } from './chat-worktrees'
import { type GateScope, passedCheckNames } from './integration-gate'
import { peerGateRefresh } from './peer-freshness'
import { secretPath } from './peer-signals'
import { peerRow } from './peer-work'
import { productLog, redact } from './product-log'
import {
  decisionFrom,
  fallbackDecision,
  type PendingResolution,
  type ResolutionContext
} from './resolution-evidence'
import type { Worktree } from './worktrees'

/**
 * The Git side of a reconciliation (LKM-403): gathers both goals and the exact diffs for
 * the agent's prompt when staging leaves conflict markers, and reads the result when its
 * turn ends. Trezi cannot judge whether two goals fit, so this only refuses what it can
 * see: markers left behind, an agent saying it needs a decision, and a conflicted file
 * byte-identical to one side, which is a silent choice of ours or theirs. The project's
 * checks decide everything else, on the exact combined tree.
 */

const LIMITS = { goal: 512, peerGoal: 160, peers: 6, diff: 4096, read: 64 * 1024 } as const
const MAX_ACCEPTANCE = 8
const git = promisify(execFile)

async function diffOf(cwd: string, from: string, to: string, files: string[]) {
  const shared = files.filter((file) => !secretPath(file))
  if (!shared.length) return { text: '', cut: false }
  const args = ['diff', '--no-ext-diff', '--no-color', '--no-textconv', from, to, '--', ...shared]
  const read = await git('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: LIMITS.read
  }).catch((error: { code?: string; stdout?: string }) => ({
    stdout: error.stdout ?? '',
    cut: true
  }))
  const text = redact(read.stdout)
  const bytes = Buffer.from(text)
  return bytes.length > LIMITS.diff
    ? { text: bytes.subarray(0, LIMITS.diff).toString('utf8').replace(/�+$/, ''), cut: true }
    : { text, cut: 'cut' in read }
}

/** Both goals, the three revisions, both diffs and what must pass. Bounded; never throws. */
export async function resolutionFor(
  stage: ResolveStage,
  files: string[],
  input: { scope: GateScope; self: string; goal: string }
): Promise<PendingResolution> {
  const { base, own, current } = stage
  const root = input.scope.root
  const [ownDiff, currentDiff, gate] = await Promise.all([
    diffOf(root, base, own, files),
    diffOf(root, base, current, files),
    peerGateRefresh(input.scope.liveRoot, input.self, base)
  ])
  const peerGoals: ResolutionContext['peerGoals'] = gate.landed.map((peer) => ({
    goal: peer.goal.slice(0, LIMITS.peerGoal),
    origin: peer.origin,
    revision: peer.revision,
    ...(peer.task ? { task: peer.task } : {})
  }))
  const row = peerRow(input.scope.liveRoot, input.self)
  const context: ResolutionContext = {
    ownGoal: redact(input.goal || row?.goal || '').slice(0, LIMITS.goal),
    peerGoals: peerGoals.slice(0, LIMITS.peers),
    revisions: { base, own, current },
    files,
    ownDiff: ownDiff.text,
    currentDiff: currentDiff.text,
    acceptance: passedCheckNames(input.scope).slice(0, MAX_ACCEPTANCE),
    truncated: ownDiff.cut || currentDiff.cut
  }
  return { revisions: stage, files, context }
}

export interface HeldResolution {
  /** The one question for the user. */
  question: string
  files: string[]
  /** Files the agent replaced with the other side: its own version comes back. */
  restore: string[]
}

/** A conflicted file that is exactly one side. Deletions are the prompt's to allow. */
async function selected(
  root: string,
  r: PendingResolution
): Promise<Map<string, 'ours' | 'theirs'>> {
  const sides = new Map<string, 'ours' | 'theirs'>()
  for (const file of r.files) {
    const path = join(root, file)
    if (!(await lstat(path).catch(() => null))?.isFile()) continue
    const [now, own, current] = await Promise.all([
      readFile(path),
      readBlobAt(root, r.revisions.own, file),
      readBlobAt(root, r.revisions.current, file)
    ])
    if (!own || !current || own.equals(current)) continue
    if (now.equals(own)) sides.set(file, 'ours')
    else if (now.equals(current)) sides.set(file, 'theirs')
  }
  return sides
}

/**
 * Why this resolution must not land, or null. `reply` is the agent's closing text, null
 * while its turn still runs (`land_now`): markers then only mean it is not done.
 */
export async function heldResolution(
  wt: Worktree,
  r: PendingResolution,
  reply: string | null
): Promise<HeldResolution | null> {
  const sides = await selected(wt.path, r)
  const markers = reply === null ? [] : await conflictMarkerFiles(wt, r.files)
  const stated = reply ? decisionFrom(reply) : null
  if (!sides.size && !markers.length && !stated) return null
  const files = [...new Set([...markers, ...sides.keys()])]
  productLog.info('resolve', 'Resolution held for a decision', {
    worktree: wt.id,
    markers: markers.length,
    selected: sides.size,
    stated: !!stated
  })
  return {
    question: stated ?? fallbackDecision(r.context, files.length ? files : r.files),
    files: files.length ? files : r.files,
    restore: [...sides].filter(([, side]) => side === 'theirs').map(([file]) => file)
  }
}

/**
 * Put the agent's own version back in its private worktree. Taking the other side
 * leaves no diff, so the work would otherwise end with nothing on the branch to review
 * or land. `selected` read these as regular files, so this never writes through a link.
 */
export async function restoreOwnFiles(wt: Worktree, r: PendingResolution, files: string[]) {
  for (const file of files) {
    const own = await readBlobAt(wt.path, r.revisions.own, file)
    if (own) await writeFile(join(wt.path, file), own)
  }
}
