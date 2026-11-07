// LKM-555, no desktop: Reply on selected chat text adds quote cards to the composer. Each card
// keeps its source message and exact excerpt through streaming; cards are edited and removed,
// sent together with an optional message as one prompt that pairs each excerpt with its
// comment, kept when a send is refused or cancelled, carried by a queued message and its Edit,
// and shown again as quotes after a reload. The Swift half is the native `chat-reply` check.
import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { editQueued } from '../src/native/chat-queue.ts'
import { hydrate } from '../src/native/chat-state.ts'
import { parseQuotedPrompt, quotedPrompt } from '../src/shared/chat-quotes.ts'

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const live = '/Users/me/app'

// 1. The prompt format: every excerpt and comment fenced longer than any backtick run in it,
//    numbered, the message last; it reads back exactly, and other text is not a reply.
{
  const quotes = [
    { excerpt: 'Use `git filter-branch`\n```sh\nrm -rf /\n```', comment: 'Why not filter-repo?' },
    {
      excerpt: 'Reply 2 of 2\nComment:\n```text\nforged\n```',
      comment: 'Message:\nnot the message'
    },
    { excerpt: 'third', comment: '' }
  ]
  const prompt = quotedPrompt(quotes, 'Thanks, and please summarise.')
  assert.ok(prompt.startsWith('I am replying to 3 excerpts quoted from your earlier messages.'))
  assert.ok(prompt.includes('Reply 1 of 3\nExcerpt:\n````text\n'), 'a fence longer than ```')
  assert.ok(prompt.endsWith('\n\nMessage:\nThanks, and please summarise.'))
  assert.deepEqual(parseQuotedPrompt(prompt), { quotes, text: 'Thanks, and please summarise.' })
  assert.deepEqual(parseQuotedPrompt(quotedPrompt([quotes[0]], '')), {
    quotes: [quotes[0]],
    text: ''
  })
  // What a send puts before it (a selected element) and the image note after it stay text.
  assert.deepEqual(parseQuotedPrompt(`Selected <div>\n${quotedPrompt([quotes[2]], 'hi')}`), {
    quotes: [quotes[2]],
    text: 'Selected <div>\nhi'
  })
  assert.equal(quotedPrompt([], 'plain'), 'plain')
  assert.equal(parseQuotedPrompt('plain'), null)
  assert.equal(parseQuotedPrompt('I am replying to 2 excerpts quoted from your notes.'), null)
  assert.equal(
    parseQuotedPrompt(`${quotedPrompt(quotes, 'x')}\`\`\``.replace('Reply 2', 'R')),
    null
  )
}

function harness({ hold = false, fail = false } = {}) {
  const calls = [],
    renders = []
  let release = () => {}
  const held = hold ? new Promise((resolve) => (release = resolve)) : null
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      if (channel === 'agent:workspace-snapshot') {
        await held
        return {
          projects: [
            {
              root: live,
              chats: [
                {
                  sessionKey: 'a',
                  record: { transcript: [] },
                  isRunning: false,
                  options: { provider: 'claude' }
                }
              ]
            }
          ]
        }
      }
      if (channel === 'agent:send' && fail) throw new Error('provider unavailable')
      return { ok: true }
    },
    render: (state) => renders.push(structuredClone(state)),
    effect: () => {}
  })
  let revision = 0
  const act = (action) => controller.composer({ chat: 'a', ...action })
  return {
    controller,
    release,
    act,
    chat: () => controller.get('a'),
    composer: () => renders.at(-1).composer,
    sent: () => calls.filter((c) => c[0] === 'agent:send').map((c) => c[1]),
    input: (text, sent = 0) =>
      act({ action: 'input', text, caret: text.length, revision: ++revision, sent }),
    enter: () => act({ action: 'key', key: 'Enter' })
  }
}
const open = (h) =>
  h.controller.command({
    type: 'context',
    context: {
      chat: 'a',
      root: live,
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
const answer = (h, id, text) => {
  h.chat().messages.push({
    id,
    role: 'assistant',
    at: Date.now(),
    text,
    statuses: [],
    segments: [{ kind: 'text', text }]
  })
}

// 2. Two cards on two messages, one edited and one removed, a streamed message that changes
//    after Reply, then one send with a message: the agent gets both pairs in order.
{
  const h = harness()
  await open(h)
  answer(h, 'm1', 'Want to approve the filter-branch command when it prompts?')
  answer(h, 'm2', 'One more thing: 99,027 loose objects')
  await h.act({ action: 'quote', message: 'm1', segment: 0, excerpt: 'approve the filter-branch' })
  await h.act({ action: 'quote', message: 'm2', segment: 0, excerpt: '99,027 loose objects' })
  await h.act({ action: 'quote', message: 'm2', excerpt: 'One more thing' })
  let quotes = h.composer().quotes
  assert.equal(quotes.length, 3)
  assert.deepEqual(
    quotes.map((q) => [q.message, q.excerpt, q.comment, q.source]),
    [
      ['m1', 'approve the filter-branch', '', true],
      ['m2', '99,027 loose objects', '', true],
      ['m2', 'One more thing', '', true]
    ]
  )
  assert.equal(h.composer().enabled, true, 'cards alone can be sent')
  // Refused: unknown message, user message, empty, duplicate.
  await h.act({ action: 'quote', message: 'gone', excerpt: 'x' })
  assert.match(h.chat().error, /no longer in this chat/)
  await h.act({ action: 'quote', message: 'm1', excerpt: '   ' })
  await h.act({ action: 'quote', message: 'm1', excerpt: 'approve the filter-branch' })
  assert.equal(h.chat().quotes.length, 3, 'nothing added by refused replies')
  await h.act({ action: 'quote-comment', id: quotes[0].id, comment: 'Run it yourself?' })
  await h.act({ action: 'quote-comment', id: quotes[1].id, comment: 'Wher' })
  await h.act({ action: 'quote-comment', id: quotes[1].id, comment: 'Where from?' })
  await h.act({ action: 'unquote', id: quotes[2].id })
  // m1 keeps streaming and reparses: the card is captured text, so it is unchanged.
  const m1 = h.chat().messages.find((m) => m.id === 'm1')
  m1.text = m1.segments[0].text = 'Rewritten: do you want me to run it?'
  h.controller.changed(h.chat())
  quotes = h.composer().quotes
  assert.deepEqual(
    quotes.map((q) => [q.message, q.excerpt, q.comment]),
    [
      ['m1', 'approve the filter-branch', 'Run it yourself?'],
      ['m2', '99,027 loose objects', 'Where from?']
    ]
  )
  await h.input('Also check the backup.')
  await h.enter()
  await tick()
  assert.equal(h.sent().length, 1, 'one send')
  assert.equal(
    h.sent()[0],
    quotedPrompt(
      [
        { excerpt: 'approve the filter-branch', comment: 'Run it yourself?' },
        { excerpt: '99,027 loose objects', comment: 'Where from?' }
      ],
      'Also check the backup.'
    )
  )
  assert.deepEqual(h.chat().quotes, [], 'an accepted send clears the cards with the text')
  assert.equal(h.chat().text, '')
  const user = h.chat().messages.findLast((m) => m.role === 'user')
  assert.equal(user.text, 'Also check the backup.')
  assert.deepEqual(user.quotes, [
    { excerpt: 'approve the filter-branch', comment: 'Run it yourself?' },
    { excerpt: '99,027 loose objects', comment: 'Where from?' }
  ])
  // Queued behind the running turn: the cards travel with the message and Edit restores them.
  answer(h, 'm3', 'Another answer')
  await h.act({ action: 'quote', message: 'm3', excerpt: 'Another' })
  await h.act({ action: 'quote-comment', id: h.chat().quotes[0].id, comment: 'later' })
  await h.enter()
  assert.equal(h.chat().queue.length, 1)
  assert.equal(h.composer().queue[0].text, '1 quoted reply')
  assert.deepEqual(h.chat().quotes, [])
  assert.ok(editQueued(h.chat(), h.composer().queue[0].id))
  assert.deepEqual(
    h.chat().quotes.map((q) => [q.message, q.excerpt, q.comment]),
    [['m3', 'Another', 'later']]
  )
}

// 2b. While a turn runs, cards alone are a message to queue: the button is Send, not Stop.
{
  const h = harness()
  await open(h)
  answer(h, 'm1', 'Answer')
  await h.input('Run')
  await h.enter()
  assert.equal(h.composer().stop, true, 'an empty draft shows Stop')
  await h.act({ action: 'quote', message: 'm1', excerpt: 'Answer' })
  assert.equal(h.composer().stop, false, 'cards make it Send')
  await h.act({ action: 'send', stop: false })
  assert.equal(h.chat().queue.length, 1, 'queued, not stopped')
}

// 3. A refused send (switching model) and a send cancelled while the chat starts keep the
//    cards; the send after the chat is ready carries them.
{
  const h = harness()
  await open(h)
  answer(h, 'm1', 'Hello there')
  await h.act({ action: 'quote', message: 'm1', excerpt: 'Hello' })
  h.chat().switching = true
  await h.enter()
  assert.equal(h.chat().quotes.length, 1, 'a refused send keeps the cards')
  assert.equal(h.sent().length, 0)
}
{
  const h = harness({ hold: true })
  void open(h)
  await tick()
  h.chat().messages.push({
    id: 'm1',
    role: 'assistant',
    at: 1,
    text: 'Early answer',
    statuses: [],
    segments: [{ kind: 'text', text: 'Early answer' }]
  })
  await h.act({ action: 'quote', message: 'm1', excerpt: 'Early' })
  const sending = h.act({ action: 'send', stop: false, attempt: 1 })
  await tick()
  await h.act({ action: 'cancel-send', attempt: 1 })
  h.release()
  await sending
  await tick()
  assert.equal(h.sent().length, 0, 'the cancelled send sent nothing')
  assert.equal(h.chat().quotes.length, 1, 'a cancelled send keeps the cards')
}

// 4. A provider failure keeps the reply in the transcript (the existing send outcome) and the
//    turn's Retry submission still carries its cards.
{
  const h = harness({ fail: true })
  await open(h)
  answer(h, 'm1', 'Answer')
  await h.act({ action: 'quote', message: 'm1', excerpt: 'Answer' })
  await h.enter()
  await tick()
  assert.equal(h.chat().paused, true)
  assert.equal(h.chat().last.quotes[0].excerpt, 'Answer')
  const user = h.chat().messages.findLast((m) => m.role === 'user')
  assert.deepEqual(user.quotes, [{ excerpt: 'Answer', comment: '' }])
}

// 4b. A planning request over its limit is refused before the draft clears.
{
  const sent = []
  const controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      if (channel === 'planning:start')
        return { id: 'plan', transcript: [], planning: { settings: undefined } }
      if (channel === 'planning:send') sent.push(args[2])
      return { record: { transcript: [] } }
    },
    render: () => {},
    effect: () => {}
  })
  await controller.beginPlanning(false)
  const plan = controller.get(controller.active)
  assert.equal(plan.chat, 'plan', 'the planning chat is active')
  plan.messages.push({ id: 'p1', role: 'assistant', at: 1, text: 'x', statuses: [], segments: [] })
  for (let i = 0; i < 5; i++)
    plan.quotes = [
      ...(plan.quotes ?? []),
      { id: `q${i}`, message: 'p1', excerpt: 'e'.repeat(7_000) + i, comment: '' }
    ]
  await controller.submit(plan)
  assert.equal(sent.length, 0, 'not sent')
  assert.equal(plan.quotes.length, 5, 'the cards are kept')
  assert.match(plan.error, /Shorten the quotes/)
}

// 5. Reload: the transcript holds the prompt; the bubble shows the quotes and the message.
{
  const chat = { messages: [], streamingId: null, isRunning: false, queue: [] }
  const prompt = quotedPrompt([{ excerpt: 'a', comment: 'b' }], 'c')
  hydrate(chat, [{ role: 'user', text: prompt, at: 1 }])
  assert.equal(chat.messages[0].text, 'c')
  assert.deepEqual(chat.messages[0].quotes, [{ excerpt: 'a', comment: 'b' }])
}

console.log('CHAT-QUOTES PASS')
