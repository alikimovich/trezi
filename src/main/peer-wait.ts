import { swiftConversationOwner } from './conversation-owner'
import {
  landedPeers,
  onPeerChange,
  peerChanged,
  peerRow,
  peerTurn,
  peerView,
  peerWorkRoot
} from './peer-work'

/**
 * `peer_wait` (LKM-406): one bounded wait on one named peer, for high-contention work on
 * the same scope. The Swift owner records the edge and refuses a cycle; this process holds
 * only the tool call open. A waiter holds no lease, lock or admission, so nothing else is
 * ever made to wait, and disjoint work is refused before any wait starts. The peer's
 * landing, a Stop or crash of either side, the owner losing the edge and the timeout all
 * end it. Peers come only from the feed, and everything here is advice: the source gate
 * alone decides landing.
 */

export const PEER_WAIT_LIMITS = {
  defaultMs: 60_000,
  minMs: 1000,
  maxMs: 120_000,
  /** The owner's backstop outlives this timer, so a live wait always ends here first. */
  graceMs: 5000,
  /** How soon a lost edge (a service restart) is noticed. */
  pollMs: 1000
} as const

type Outcome = 'landed' | 'ended' | 'stopped' | 'timeout' | 'restart'
const OUTCOME_GUIDANCE: Record<Outcome, string> = {
  landed:
    'The peer landed. Read its change with peer_lookup if it matters to yours, then carry on; the source gate combines the two at landing.',
  ended:
    'The peer ended without landing. Carry on; the project does not have its work. Nothing about it is safe to assume.',
  stopped: 'This task was stopped. Do not start anything new.',
  timeout:
    'The bound passed and the peer is still running. Carry on with your task: do not wait on this peer again.',
  restart:
    'The wait was lost, for example to a service restart, so its state is unknown. Carry on with your task.'
}
const REFUSAL_GUIDANCE = {
  unknown: 'No running peer of this project has that id. Carry on with your task.',
  'different-scope':
    'No shared file or target is known with this peer, so there is nothing to wait for. That does not make the work compatible: carry on, the source gate still decides.',
  busy: 'This task is already waiting on a peer; it can wait on only one at a time.',
  cycle:
    'That peer is already waiting on this task, directly or through another peer, so do not wait: carry on with your task. The source gate reconciles the two at landing.',
  unavailable: 'The peer feed is not available. Carry on with your task.',
  stopped: 'This task was stopped. Do not start anything new.'
} as const
type Refusal = keyof typeof REFUSAL_GUIDANCE

const refuse = (refused: Refusal) => ({
  waited: false,
  refused,
  guidance: REFUSAL_GUIDANCE[refused]
})

interface Held {
  peer: string
  settle: (outcome: Outcome) => void
}
const held = new Map<string, Held>()
const stopped = new Set<string>()

/** A Stop outranks the provider's last tool calls: this ends a wait and refuses a new one. */
export function stopPeerWait(waiter: string | undefined): void {
  if (!waiter) return
  held.get(waiter)?.settle('stopped')
  if (peerWorkRoot(waiter)) stopped.add(waiter)
}

onPeerChange((project, ended) => {
  if (!ended) return
  stopped.delete(ended)
  held.get(ended)?.settle('stopped')
  for (const wait of held.values())
    if (wait.peer === ended) {
      const landed = landedPeers(project, '').some((peer) => peer.id === ended)
      wait.settle(landed ? 'landed' : 'ended')
    }
})

/** A shared file or target, or a file both named. A shared word or unknown files never wait. */
const contended = (kind: string, files: string[]): boolean =>
  kind === 'exact-file' || kind === 'same-target' || (kind === 'possible-overlap' && !!files.length)

const seconds = (raw: unknown): number => {
  const asked = typeof raw === 'number' && Number.isFinite(raw) ? raw * 1000 : NaN
  const ms = Number.isNaN(asked) ? PEER_WAIT_LIMITS.defaultMs : asked
  return Math.ceil(Math.min(PEER_WAIT_LIMITS.maxMs, Math.max(PEER_WAIT_LIMITS.minMs, ms)) / 1000)
}

export async function peerWait(
  raw: unknown,
  s: { liveRoot: string; emitKey: string; peerId?: string }
): Promise<unknown> {
  const args = (raw && typeof raw === 'object' ? raw : {}) as { peer?: unknown; seconds?: unknown }
  const self = s.peerId ?? peerTurn(s.emitKey)
  const id = typeof args.peer === 'string' ? args.peer : ''
  const owner = swiftConversationOwner()
  if (!owner) return refuse('unavailable')
  if (self && stopped.has(self)) return refuse('stopped')
  if (!id || id === self) return refuse('unknown')
  const view = await peerView(s.liveRoot, self)
  const row = peerRow(s.liveRoot, id)
  const landed = view.landed?.find((peer) => peer.id === id)
  if (landed && (!row || row.phase === 'landing'))
    return {
      waited: false,
      outcome: 'landed',
      revision: landed.revision,
      guidance: OUTCOME_GUIDANCE.landed
    }
  if (!row || !self) return refuse('unknown')
  if (held.has(self)) return refuse('busy')
  const advisory = view.advisories.find((item) => item.peer === id)
  if (!advisory || !contended(advisory.kind, advisory.files)) return refuse('different-scope')
  const bound = seconds(args.seconds)
  const begun = await owner.peerWaitBegin(
    self,
    id,
    s.liveRoot,
    bound * 1000 + PEER_WAIT_LIMITS.graceMs
  )
  if (!begun.started) return refuse(begun.reason ?? 'unknown')
  const started = Date.now()
  const outcome = await new Promise<Outcome>((resolve) => {
    let polling = false
    const timer = setTimeout(() => settle('timeout'), bound * 1000)
    const poll = setInterval(() => {
      if (polling) return
      polling = true
      // Asked afresh each time: a restarted service answers through a new owner.
      Promise.resolve(swiftConversationOwner()?.peers(s.liveRoot, self))
        .then((current) => current?.wait?.peer === id)
        .catch(() => false)
        .then((kept) => {
          polling = false
          if (!kept) settle('restart')
        })
    }, PEER_WAIT_LIMITS.pollMs)
    const settle = (ended: Outcome): void => {
      if (held.get(self)?.settle !== settle) return
      held.delete(self)
      clearTimeout(timer)
      clearInterval(poll)
      resolve(ended)
    }
    held.set(self, { peer: id, settle })
    // Either side can end during the owner's answer, before `held` could hear of it.
    if (!peerRow(s.liveRoot, self)) settle('stopped')
    else if (stopped.has(self)) settle('stopped')
    else if (!peerRow(s.liveRoot, id))
      settle(landedPeers(s.liveRoot, self).some((peer) => peer.id === id) ? 'landed' : 'ended')
    else peerChanged(s.liveRoot)
  })
  await swiftConversationOwner()
    ?.peerWaitEnd(self)
    .catch(() => {})
  peerChanged(s.liveRoot)
  const revision =
    outcome === 'landed'
      ? landedPeers(s.liveRoot, self).find((peer) => peer.id === id)?.revision
      : undefined
  return {
    waited: true,
    peer: id,
    outcome,
    waitedMs: Date.now() - started,
    ...(revision ? { revision } : {}),
    guidance: OUTCOME_GUIDANCE[outcome]
  }
}
