import { projectKey } from '../shared/projectKey'
import { agentRuntime, privateRuntimeKind } from './agent-runtime'
import { checksRunning } from './command-checks'
import type { LandingHold } from './repository-owner'
import { sourceSnapshot } from './source-snapshot'
import {
  type CommandReceipt,
  receiptSession,
  sessionCommandReceipts,
  sessionReceipts,
  type VerificationReceipt
} from './verification-receipts'

/**
 * LOCAL-WEBKIT-3: finished agent work lands only when checks the host ran passed on the
 * exact source being landed. Every integration entrypoint (turn end, land_now, Keep of a
 * stopped turn, Retry, Resolve, release salvage, parked Apply, a background agent's
 * finish) asks `integrationGate` for the candidate, and the repository owner lands
 * nothing but that candidate tree, under the repository lease, onto a live checkout
 * still at the fork point (`src/service/RepositoryGate.swift`). A missing, failed,
 * cancelled, running or stale check means no candidate, so the owner holds the work.
 *
 * The candidate is the Git tree of the worktree's source snapshot. It does not change
 * when the same bytes are committed, so the check-then-commit order needs no waiver;
 * any other change (an edit, a sync onto a new base, a clean Resolve) is a new tree
 * that has no checks yet. Evidence is this session's receipts on that tree:
 *  - for each check (engine and route, or command), the newest receipt counts, and it
 *    must be verified: a later failure or cancel on the same source blocks;
 *  - a browser receipt counts only while its private server runs at the generation it
 *    was checked on (a restarted or stopped server is a server change);
 *  - a web project needs a verified browser receipt; any other project a host check
 *    (`run_checks`); when the kind cannot be detected, either kind.
 * A check still running blocks too.
 */

export interface GateScope {
  /** The session key its tools ran under (a chat's key, a spawn's parent key). */
  emitKey: string
  /** The worktree being landed. */
  root: string
  liveRoot: string
}

export type GateReason =
  | 'no-source'
  | 'unchecked'
  | 'check-failed'
  | 'check-running'
  | 'runtime-changed'

export interface GateVerdict {
  ok: boolean
  /** The tree the owner may land (null unless `ok`). */
  candidate: string | null
  /** The tree the worktree holds now, checked or not. */
  tree: string | null
  need: 'browser' | 'command' | 'any'
  reason: GateReason | null
  message: string | null
  /** The receipts the verdict rests on. */
  evidence: Array<{ id: string; check: string; verified: boolean; reason: string | null }>
}

interface Evidence {
  receipts: readonly VerificationReceipt[]
  commands: readonly CommandReceipt[]
  /** A browser receipt's server generation now, by agent; null when stopped. */
  generation: (agent: string) => number | null
  running: boolean
}

/** A closed session's evidence, taken just before its receipts were released. */
const retained = new Map<string, { evidence: Evidence; timer: ReturnType<typeof setTimeout> }>()
const RETAIN_MS = 10 * 60_000

const sessionOf = (scope: { emitKey: string; root: string }) =>
  receiptSession(scope.emitKey, projectKey(scope.root))

/**
 * A session is closing: keep what its receipts proved for its final landing (release
 * salvage, a background agent's finish), with each server's generation as it was while
 * the session still ran. Dropped by `dropGateEvidence` or after ten minutes.
 */
export function retainGateEvidence(emitKey: string, root: string): void {
  const session = sessionOf({ emitKey, root })
  const receipts = [...sessionReceipts(session)]
  const generations = new Map<string, number | null>()
  for (const receipt of receipts)
    if (receipt.runtime.agent)
      generations.set(
        receipt.runtime.agent,
        agentRuntime(receipt.runtime.agent)?.generation ?? null
      )
  const previous = retained.get(session)
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => retained.delete(session), RETAIN_MS)
  timer.unref?.()
  retained.set(session, {
    evidence: {
      receipts,
      commands: [...sessionCommandReceipts(session)],
      generation: (agent) => generations.get(agent) ?? null,
      running: checksRunning(session)
    },
    timer
  })
}

export function dropGateEvidence(emitKey: string, root: string): void {
  const session = sessionOf({ emitKey, root })
  const kept = retained.get(session)
  if (kept) clearTimeout(kept.timer)
  retained.delete(session)
}

function evidenceOf(session: string): Evidence {
  const kept = retained.get(session)
  if (kept) return kept.evidence
  return {
    receipts: sessionReceipts(session),
    commands: sessionCommandReceipts(session),
    generation: (agent) => agentRuntime(agent)?.generation ?? null,
    running: checksRunning(session)
  }
}

const route = (url: string | null) => {
  try {
    return url ? new URL(url).pathname : '/'
  } catch {
    return url ?? '/'
  }
}
/** One check: what the newest receipt for it replaces. */
const browserKey = (r: VerificationReceipt) =>
  `${r.engine} ${typeof r.recipe?.path === 'string' ? r.recipe.path : route(r.document.url)}`

interface Item {
  key: string
  id: string
  at: string
  kind: 'browser' | 'command'
  verified: boolean
  reason: string | null
  recipe:
    | { kind: 'browser'; args: Record<string, unknown> }
    | { kind: 'command'; check: string }
    | null
  tree: string | null
}

function items(evidence: Evidence): Item[] {
  const browser = evidence.receipts.map((r): Item => {
    let reason = r.reason
    let verified = r.verified
    // The server it was checked on has since restarted or stopped: a server change.
    if (
      verified &&
      r.runtime.agent &&
      evidence.generation(r.runtime.agent) !== r.runtime.generation
    ) {
      verified = false
      reason = 'runtime-changed'
    }
    return {
      key: browserKey(r),
      id: r.id,
      at: r.createdAt,
      kind: 'browser',
      verified,
      reason,
      recipe: r.recipe ? { kind: 'browser', args: r.recipe } : null,
      tree: r.source.tree
    }
  })
  const commands = evidence.commands.map(
    (r): Item => ({
      key: `command ${r.check}`,
      id: r.id,
      at: r.createdAt,
      kind: 'command',
      verified: r.verified,
      reason: r.reason,
      recipe: { kind: 'command', check: r.check },
      tree: r.source.tree
    })
  )
  return [...browser, ...commands].sort((a, b) => a.at.localeCompare(b.at))
}

/** The newest item per check key, in order. */
const newest = (list: Item[]) => [...new Map(list.map((item) => [item.key, item])).values()]

const NEED_TEXT = {
  browser: 'a passing preview_verify in its private browser',
  command: 'a passing run_checks check',
  any: 'a passing preview_verify or run_checks check'
} as const

/** Whether `scope`'s worktree, as it is now, may land, and the candidate tree if so. */
export async function integrationGate(scope: GateScope): Promise<GateVerdict> {
  const kind = await privateRuntimeKind(scope.root)
  const need = kind === 'web' ? 'browser' : kind === 'none' ? 'command' : 'any'
  const snapshot = await sourceSnapshot(scope.root).catch(() => null)
  const tree = snapshot?.tree ?? null
  const refuse = (reason: GateReason, message: string, evidence: GateVerdict['evidence'] = []) =>
    ({ ok: false, candidate: null, tree, need, reason, message, evidence }) satisfies GateVerdict
  if (!tree)
    return refuse(
      'no-source',
      `Trezi could not read the chat's exact source (${snapshot?.reason ?? 'unreadable'}), so it cannot tell what was checked.`
    )
  const session = sessionOf(scope)
  const evidence = evidenceOf(session)
  if (evidence.running)
    return refuse(
      'check-running',
      'a check is still running on this work; wait for it, then Retry.'
    )
  const current = newest(items(evidence).filter((item) => item.tree === tree))
  const used = current.map((item) => ({
    id: item.id,
    check: item.key,
    verified: item.verified,
    reason: item.reason
  }))
  const failed = current.find((item) => !item.verified)
  if (failed)
    return refuse(
      failed.reason === 'runtime-changed' ? 'runtime-changed' : 'check-failed',
      failed.reason === 'runtime-changed'
        ? `the private dev server restarted or stopped after the check "${failed.key}" passed, so it no longer proves this work. Check again, then Retry.`
        : `the check "${failed.key}" did not pass on this exact source (${failed.reason ?? 'failed'}). Fix it and check again, then Retry.`,
      used
    )
  const passing = current.filter((item) => need === 'any' || item.kind === need)
  if (!passing.length)
    return refuse(
      'unchecked',
      `no check passed on this exact source yet. It needs ${NEED_TEXT[need]} on the current work; ask the agent to run one, then Retry.`,
      used
    )
  return { ok: true, candidate: tree, tree, need, reason: null, message: null, evidence: used }
}

/** `workspace_state`'s view of the gate: what this work needs before it may land. */
export async function landingChecks(scope: GateScope) {
  // A project that is not a Git repository root has no private worktree: edits are
  // live as they are made, so there is nothing to check before integration.
  if (scope.root === scope.liveRoot)
    return {
      gated: false,
      isolation: 'unavailable',
      note: 'This project is not a Git repository root, so your edits change the live checkout and the user preview as you make them. Private checks before integration are unavailable; tell the user before risky edits. Opening the repository root (or running git init there) gives each chat a private worktree.'
    }
  const verdict = await integrationGate(scope)
  return {
    gated: true,
    ready: verdict.ok,
    need: NEED_TEXT[verdict.need],
    sourceTree: verdict.tree,
    reason: verdict.reason,
    message: verdict.message,
    evidence: verdict.evidence
  }
}

/** The owner's refusal, in the same words as the gate's. */
export function holdMessage(hold: LandingHold | undefined, verdict: GateVerdict | null): string {
  if (verdict && !verdict.ok && verdict.message) return verdict.message
  if (hold?.reason === 'live-changed')
    return `the project changed since this chat started its work${hold.files.length ? ` (${hold.files.slice(0, 5).join(', ')})` : ''}. Retry brings the chat up to date and checks it again before anything lands.`
  if (hold?.reason === 'source-changed')
    return 'the chat changed after its checks ran, so the checked source is not what would land. Check again, then Retry.'
  return 'no check passed on the exact source that would land. Ask the agent to check its work, then Retry.'
}

/** Runs one recorded check again (registered by `session-tools.ts`, which owns the tools). */
export type CheckReplayer = (
  recipe: NonNullable<Item['recipe']>,
  scope: GateScope
) => Promise<boolean>
let replayer: CheckReplayer | null = null
export function setCheckReplayer(next: CheckReplayer | null): void {
  replayer = next
}

/**
 * Retry after the source changed under Trezi's own hand (a clean reconcile onto the
 * live tree): run the checks that last passed in this session again, on the current
 * source. Answers how many ran; the gate then judges their receipts like any other.
 */
export async function replayChecks(scope: GateScope): Promise<number> {
  if (!replayer) return 0
  const passed = newest(
    items(evidenceOf(sessionOf(scope))).filter(
      (item) => item.verified || item.reason === 'runtime-changed'
    )
  )
  let ran = 0
  for (const item of passed) {
    if (!item.recipe) continue
    await replayer(item.recipe, scope).catch(() => false)
    ran++
  }
  return ran
}
