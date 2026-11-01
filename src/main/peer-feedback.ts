import type { AgentEvent, PeerFeedbackLine } from '../shared/api'
import type { PeerWorkRow, PeerWorkView } from './conversation-owner'
import { swiftConversationOwner } from './conversation-owner'
import { PEER_WAIT_LIMITS } from './peer-wait'
import { onPeerChange, peerRows } from './peer-work'
import { redact } from './product-log'

/**
 * What the native rail and cards show of the peer feed (LKM-406): the owner's advisories
 * and wait edges, turned into one `peer-state` event per task and per state change. Every
 * feed movement arrives here; only a different answer leaves. A read that fails keeps
 * what is shown, and a task that left the feed clears its card once. These are lines for
 * the user, never instructions to an agent, and an uncertain one stays uncertain.
 */

export const PEER_FEEDBACK_LIMITS = { event: 1536, lines: 4, goal: 80, files: 2 } as const
const DEBOUNCE_MS = 25

interface Route {
  projectKey: string
  sessionId?: string
  digest: string
}
const shown = new Map<string, Map<string, Route>>()
const flights = new Map<string, { timer?: ReturnType<typeof setTimeout>; running?: boolean }>()
let sink: (event: AgentEvent) => void = () => {}

export function setPeerFeedbackSink(send: (event: AgentEvent) => void): void {
  sink = send
}

const brief = (row: { origin: PeerWorkRow['origin']; goal: string }) => ({
  origin: row.origin,
  goal: redact(row.goal).slice(0, PEER_FEEDBACK_LIMITS.goal)
})

const CERTAIN = { waiting: 0, reconciling: 1, overlap: 2 } as const
const rank = (line: PeerFeedbackLine): number =>
  CERTAIN[line.kind] * 2 + (line.certainty === 'uncertain' ? 1 : 0)
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Urgency first, then the peer and the kind. The owner lists advisories newest peer
 *  version first, and every heartbeat or unrelated file bumps a version: ordering by
 *  anything but content would re-send an unchanged state (and could swap which peers fit
 *  the bound). */
const order = (a: PeerFeedbackLine, b: PeerFeedbackLine): number =>
  rank(a) - rank(b) || compare(a.peer, b.peer) || compare(a.kind, b.kind)

function linesFor(row: PeerWorkRow, view: PeerWorkView): PeerFeedbackLine[] {
  const peers = new Map(view.rows.map((peer) => [peer.id, peer]))
  const lines: PeerFeedbackLine[] = []
  if (view.wait) {
    const peer = peers.get(view.wait.peer)
    lines.push({
      kind: 'waiting',
      peer: view.wait.peer,
      origin: peer?.origin ?? 'chat',
      goal: peer ? brief(peer).goal : '',
      // The bound as asked: unlike time left, it holds still, so the wait renders once.
      seconds: Math.round((view.wait.ms - PEER_WAIT_LIMITS.graceMs) / 1000)
    })
  }
  if (row.phase === 'reconciling')
    lines.push({ kind: 'reconciling', peer: row.id, ...brief(row), self: true })
  for (const advisory of view.advisories) {
    const peer = peers.get(advisory.peer)
    if (!peer) continue
    if (peer.phase === 'reconciling') {
      lines.push({ kind: 'reconciling', peer: peer.id, ...brief(peer) })
      continue
    }
    lines.push({
      kind: 'overlap',
      peer: peer.id,
      ...brief(peer),
      certainty: advisory.certainty,
      files: [...advisory.files].sort(compare).slice(0, PEER_FEEDBACK_LIMITS.files)
    })
  }
  return lines.sort(order).slice(0, PEER_FEEDBACK_LIMITS.lines)
}

const routeOf = (row: PeerWorkRow): Omit<Route, 'digest'> =>
  row.origin === 'chat' ? { projectKey: row.parent } : { projectKey: row.parent, sessionId: row.id }

/** One task's event; the least urgent lines go first if it would outgrow its bound. */
function event(route: Omit<Route, 'digest'>, lines: PeerFeedbackLine[]): AgentEvent {
  const state = { type: 'peer-state' as const, lines: [...lines], ...route }
  while (Buffer.byteLength(JSON.stringify(state)) > PEER_FEEDBACK_LIMITS.event) state.lines.pop()
  return state
}

async function flush(project: string): Promise<void> {
  const owner = swiftConversationOwner()
  if (!owner) return
  const next = new Map<string, Omit<Route, 'digest'> & { lines: PeerFeedbackLine[] }>()
  for (const row of peerRows(project)) {
    if (row.origin === 'text-edit') continue
    const route = routeOf(row)
    const view = await owner.peers(row.project, row.id)
    next.set(`${route.projectKey}\0${route.sessionId ?? ''}`, {
      ...route,
      lines: linesFor(row, view)
    })
  }
  const before = shown.get(project) ?? new Map<string, Route>()
  for (const [key, route] of before) if (!next.has(key)) next.set(key, { ...route, lines: [] })
  const after = new Map<string, Route>()
  for (const [key, { lines, ...route }] of next) {
    const digest = lines.length ? JSON.stringify(lines) : ''
    if (digest !== (before.get(key)?.digest ?? '')) sink(event(route, lines))
    if (digest) after.set(key, { ...route, digest })
  }
  if (after.size) shown.set(project, after)
  else shown.delete(project)
}

function schedule(project: string): void {
  const flight = flights.get(project) ?? {}
  flights.set(project, flight)
  if (flight.timer) return
  flight.timer = setTimeout(() => {
    flight.timer = undefined
    if (flight.running) return schedule(project)
    flight.running = true
    void flush(project)
      .catch(() => {})
      .finally(() => {
        flight.running = false
        if (!flight.timer) flights.delete(project)
      })
  }, DEBOUNCE_MS)
  flight.timer.unref?.()
}

onPeerChange((project) => schedule(project))
