/**
 * LKM-406: the peer feed's one card and the held decision in the real Swift chat. The
 * events come from the stubbed provider; test/peer-feedback.mjs proves the lifecycle
 * that sends them. Each state shows once, replaces the last and clears.
 */
export async function checkPeerCards(
  send: (event: object) => void,
  wait: (check: (state: any) => boolean) => Promise<any>
): Promise<void> {
  const peerCards = (state: any) =>
    state.cardStates.filter((value: any) => value.id === 'peer-work')
  const line = { peer: 'peer-1', origin: 'chat', goal: 'Update the hero' }
  const uncertain = { ...line, kind: 'overlap', certainty: 'uncertain', files: ['src/Hero.tsx'] }
  const steps: [object[], string, string][] = [
    [[uncertain], 'Possible overlap', 'Not confirmed either way.'],
    [[{ ...line, kind: 'waiting', seconds: 60 }, uncertain], 'Waiting for other work', 'up to 60'],
    [[{ ...line, kind: 'reconciling', self: true }], 'Combining with other work', 'Combining']
  ]
  for (const [lines, title, words] of steps) {
    send({ type: 'peer-state', lines })
    const state = await wait((value) => peerCards(value)[0]?.title === title)
    const shown = peerCards(state)
    if (shown.length !== 1 || !shown[0].detail?.includes(words) || shown[0].actions.length)
      throw new Error(`Peer card is wrong: ${JSON.stringify(shown)}`)
  }
  send({ type: 'peer-state', lines: [] })
  await wait((value) => peerCards(value).length === 0)
  const question = 'Should the site be dark or light?'
  // No `reason`: a failed park pauses the queue, which the next check reads.
  send({
    type: 'isolation',
    state: 'parked',
    branch: 'trezi/chat-fixture',
    files: ['src/native/fixture.ts'],
    decision: question
  })
  const held = await wait((value) =>
    value.cardStates.some((card: any) => card.title === 'Decision needed')
  )
  const cards = held.cardStates.filter((value: any) => value.id === 'conflict')
  if (
    cards.length !== 1 ||
    !cards[0].detail?.includes(question) ||
    !cards[0].detail.includes('trezi/chat-fixture') ||
    cards[0].actions.join() !== 'Discard'
  )
    throw new Error(`Decision card is wrong: ${JSON.stringify(cards)}`)
  send({ type: 'isolation', state: 'isolated' })
  await wait((value) => !value.cards.includes('conflict'))
}
