import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

/**
 * LKM-376: the native smoke's chat checks share one active chat. A queued message left by
 * an earlier check captures the next send (`submit` queues behind any queue), so that
 * send never reaches its provider stub. These helpers clear and check that shared state.
 */
type Host = Pick<NativeBridge, 'request'>

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
export function sharedChatProblems(composer: any): string[] {
  const problems: string[] = []
  const queued = composer?.queue?.length ?? composer?.queueCount ?? 0
  if (queued) problems.push(`${queued} queued message(s)`)
  if (composer?.queuePaused) problems.push('a paused queue')
  if (composer?.text) problems.push(`the draft ${JSON.stringify(composer.text)}`)
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

/** Fails at once, naming what was left, instead of a later wait for a send that queued. */
export async function requireCleanSharedChat(host: Host, check: string) {
  const problems = sharedChatProblems(await host.request('composerInspect'))
  if (problems.length)
    throw new Error(
      `${check}: an earlier check left ${problems.join(', ')} in the shared chat; a send would queue instead of reaching the provider`
    )
}
