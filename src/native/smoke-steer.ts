import type { NativeBridge } from './bridge'
import { inspectUntil, waitFor } from './smoke-wait'

type Item = { label: string; action: string | null; enabled: boolean; help: string | null }
const menu = (composer: any, row: number): Item[] => composer.queueGeometry?.rows?.[row]?.menu ?? []
const item = (composer: any, row: number, label: string) =>
  menu(composer, row).find((entry) => entry.label === label)

/**
 * LKM-709: "Steer now" in the native chat smoke, on a queue of rows behind a running
 * turn. The first row's overflow menu (the host's one list for what it draws) offers it
 * enabled with its tooltip; the host's queue action reaches `agent:steer`, whose checks
 * (this chat, its running turn) run for real, and the stubbed provider gets exactly the
 * row's text. While on its way the row stays put and the other rows say why they cannot
 * be steered. The provider's admission takes it out of the queue and into the transcript,
 * marked as steered; the other rows stay queued.
 */
export async function checkSteer(
  host: NativeBridge,
  send: (event: any) => void,
  steered: [string, string][]
) {
  const request = (method: string) => host.request(method)
  const before = await request('composerInspect')
  const rows = before.queue as { id: string; text: string; steer: string | null }[]
  if (rows.length < 2) throw new Error('Steer smoke needs two queued rows')
  const offer = item(before, 0, 'Steer now')
  if (!offer?.enabled || offer.action !== 'queue-steer' || !offer.help)
    throw new Error(`Steer now is not offered on a queued row: ${JSON.stringify(menu(before, 0))}`)
  for (const label of ['Edit message', 'Copy message', 'Remove from queue'])
    if (!item(before, 0, label)) throw new Error(`The queue menu lost ${label}`)
  await host.request('chatPerform', { action: offer.action, card: rows[0].id })
  await waitFor(() => steered.length === 1, 'the steer reached the provider')
  const [id, text] = steered[0]
  if (text !== rows[0].text)
    throw new Error(`The provider got ${JSON.stringify(text)}, not the queued row`)
  const on = await inspectUntil(request, 'composerInspect', (c) => c.queue[0]?.steering === true)
  if (item(on, 0, 'Steer now')?.enabled || item(on, 0, 'Remove from queue')?.enabled)
    throw new Error('A row on its way can still be steered or removed')
  if (!item(on, 0, 'Steering into the running turn…'))
    throw new Error('The row on its way does not say so')
  if (
    item(on, 1, 'Steer now')?.enabled ||
    !item(on, 1, 'Another queued message is being steered in.')
  )
    throw new Error(`Another row is offered a second steer: ${JSON.stringify(menu(on, 1))}`)
  if (on.queue.length !== rows.length) throw new Error('A row moved while on its way')
  send({ type: 'steer', id, state: 'admitted' })
  const after = await inspectUntil(
    request,
    'composerInspect',
    (c) => c.queueCount === rows.length - 1
  )
  if (after.queue.some((row: { id: string }) => row.id === rows[0].id))
    throw new Error('The steered row is still queued')
  await inspectUntil(request, 'chatInspect', (c) =>
    c.messages.some(
      (m: any) => m.role === 'user' && m.text === rows[0].text && m.steered === 'turn'
    )
  )
  if (steered.length !== 1) throw new Error('The steer was sent more than once')
  console.log('Native steer: menu offer, host action, admission and transcript passed.')
}
