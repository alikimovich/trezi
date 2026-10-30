import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

/**
 * LKM-376: the native smoke's chat checks share one active chat. A queued message left by
 * an earlier check captures the next send (`submit` queues behind any queue), so that
 * send never reaches its provider stub. These helpers clear and check that shared state.
 *
 * LKM-377: the composer is not the whole state. A backend turn that never ended (Bun's
 * conversation owner still running it) refuses the next send with CHAT_BUSY, and the
 * controller queues it, even with an empty queue and draft.
 */
type Host = Pick<NativeBridge, 'request'>

type TurnState = { turn?: string | null; running?: boolean }
type ControllerChat = { isRunning: boolean; sending: boolean; stopping: boolean }

/** The shared chat's turn as the backend and the chat controller see it. */
export interface SharedTurn {
  /** Bun's real `agent:turn-state` for the chat, never a check's override of it. */
  state: () => Promise<TurnState>
  /** The Bun chat controller's state for the same chat. */
  controller: () => ControllerChat
}

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
export function sharedChatProblems(composer: any): string[] {
  const problems: string[] = []
  const queued = composer?.queue?.length ?? composer?.queueCount ?? 0
  if (queued) problems.push(`${queued} queued message(s)`)
  if (composer?.queuePaused) problems.push('a paused queue')
  if (composer?.text) problems.push(`the draft ${JSON.stringify(composer.text)}`)
  return problems
}

/** What still runs: the backend's turn (CHAT_BUSY for the next send) or the controller's. */
export async function sharedTurnProblems(turn: SharedTurn): Promise<string[]> {
  const problems: string[] = []
  const state = await turn.state()
  if (state?.running)
    problems.push(`a running backend turn ${JSON.stringify(state.turn ?? null)} (agent:turn-state)`)
  const { isRunning, sending, stopping } = turn.controller()
  if (isRunning || sending || stopping)
    problems.push(`a busy chat controller ${JSON.stringify({ isRunning, sending, stopping })}`)
  return problems
}

/** Removes every queued message, lifts the pause and empties the draft. The queue is
 *  empty before the pause lifts, so resuming never sends a leftover message. */
export async function resetSharedChat(host: Host) {
  const composer = await host.request('composerInspect')
  for (const { id } of composer.queue ?? [])
    await host.request('chatPerform', { action: 'queue-remove', card: id })
  await waitFor(
    async () => !(await host.request('composerInspect')).queueCount,
    'shared chat queue removed'
  )
  if ((await host.request('composerInspect')).queuePaused)
    await host.request('chatPerform', { action: 'queue-resume' })
  await host.request('composerPerform', { text: '' })
  return waitFor(async () => {
    const current = await host.request('composerInspect')
    return !sharedChatProblems(current).length && current
  }, 'shared chat reset (no queue, unpaused, empty draft)')
}

/** Ends a backend turn the way a provider run ends: `finish` must deliver the provider's
 *  UNTAGGED terminal, which the turn tracker attributes to the running turn so the owner
 *  claims it. A terminal already tagged with a turn is treated as stale and ends nothing.
 *  Then waits for the real turn state and the controller to be idle. */
export async function endSharedTurn(turn: SharedTurn, finish: () => void, timeout = 15000) {
  if ((await turn.state())?.running) finish()
  const diagnostics = async () => ({
    backend: await turn.state().catch((error: unknown) => String(error)),
    controller: turn.controller()
  })
  await waitFor(
    async () => !(await turn.state())?.running,
    'shared chat backend turn ended (agent:turn-state not running)',
    timeout,
    diagnostics
  )
  await waitFor(
    async () => !(await sharedTurnProblems(turn)).length,
    'shared chat controller idle after its backend turn ended',
    timeout,
    diagnostics
  )
}

/** Cleanup after a check that left the shared chat stopped: the composer reset first (so
 *  the ending turn cannot drain a leftover), then the backend turn ended. Both steps run
 *  even if one fails; the first failure is returned, never thrown. */
export async function cleanSharedChat(
  host: Host,
  turn: SharedTurn,
  finish: () => void,
  timeout?: number
): Promise<unknown> {
  let failure: unknown
  for (const step of [() => resetSharedChat(host), () => endSharedTurn(turn, finish, timeout)])
    await step().catch((error: unknown) => {
      failure ??= error
    })
  return failure
}

/** Fails at once, naming what was left, instead of a later wait for a send that queued. */
export async function requireCleanSharedChat(host: Host, check: string, turn?: SharedTurn) {
  const problems = [
    ...sharedChatProblems(await host.request('composerInspect')),
    ...(turn ? await sharedTurnProblems(turn) : [])
  ]
  if (problems.length)
    throw new Error(
      `${check}: an earlier check left ${problems.join(', ')} in the shared chat; a send would queue instead of reaching the provider`
    )
}
