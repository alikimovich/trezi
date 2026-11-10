import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import { quotedPrompt } from '../shared/chat-quotes'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { inspectUntil } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const SOURCE = [
  'I already took a full backup before attempting this, so nothing is at risk.',
  '',
  'Want to approve the `filter-branch` command when it prompts, or would you rather run these steps yourself?'
].join('\n')
const FIRST = 'took a full backup before attempting this'
const SECOND = 'approve the filter-branch command when it prompts'
const SHORT = 'Done, the backup is safe.'
const SHORT_PART = 'the backup is safe'
const MESSAGE = 'Also keep the backup until I confirm.'
// LKM-627: the reported shape, a short message that wraps onto two lines (synthetic text).
const TIGHT = 'Merged PR #182. The footer version is now **3.10.15** on `main`.'
const TIGHT_TEXT = 'Merged PR #182. The footer version is now 3.10.15 on main.'

/** Offscreen windows cannot be captured: the logic still runs, the captures are skipped. */
const background = () => process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'

type Card = { id: string; excerpt: string; comment: string; editing: boolean; editable: boolean }

/** LKM-555: in the real conversation and composer, select two excerpts of an assistant
 *  message and press Reply on each, comment on both (through the card fields), remove a third,
 *  keep the cards through a streamed rewrite of the message and a chat switch, then send them
 *  with a message in one native send. Selection, Copy and the menu stay the text view's own.
 *  Provider calls are stubbed; the prompt the agent receives is asserted exactly. */
export async function checkChatReply(host: NativeBridge, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const kept = chat.messages.length
  const id = 'chat-reply-source'
  const invoke = nativeChat.services.invoke
  const sends: string[] = []
  let providerSends = 0
  const provider = stubAgentSendForSmoke(chat.chat, () => {
    providerSends++
  })
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'agent:send') sends.push(String(args[0]))
    return invoke(channel, ...args)
  }
  const wait = async (check: () => Promise<boolean> | boolean, what: string, attempts = 100) => {
    for (let i = 0; i < attempts; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Chat reply: timed out waiting for ${what}`)
  }
  const cards = async (): Promise<Card[]> => (await host.request('composerInspect')).quotes.cards
  const reply = async (
    select: string,
    capture: string | false = false,
    message = id,
    menu = false,
    strict = false
  ) => {
    const result = await host.request('chatReply', {
      message,
      select,
      click: !menu,
      menuReply: menu,
      capture: capture !== false && !background()
    })
    assert.equal(result.identity, `${message}#0`)
    assert.ok(result.buttonVisible, `Reply shows next to "${select}"`)
    // LKM-627: a floating action over the transcript, clear of every line of text, and the
    // first thing the window hit-tests at its centre (the click below goes through that).
    assert.equal(
      result.buttonHost,
      'chat-overlay',
      'Reply floats over the chat, not in the text view'
    )
    assert.ok(
      result.buttonInside,
      `Reply ${result.buttonFrame} is inside the reading area ${result.readingArea}`
    )
    assert.deepEqual(
      result.coversSelection,
      [],
      `Reply ${result.buttonFrame} is not on the selected glyphs ${result.selectionLines}`
    )
    // Clear of every line where the transcript leaves room (the reported two-line message);
    // a dense paragraph filling the view may leave none, so that is only asserted there.
    if (strict)
      assert.deepEqual(
        result.coversText,
        [],
        `Reply ${result.buttonFrame} covers no line of text (selection ${result.selectionLines})`
      )
    assert.ok(result.hitIsButton, `Reply is foremost at its centre, not ${result.hit}`)
    assert.equal(result.buttonTitle, 'Reply')
    assert.equal(result.menu[0], 'Reply', `the menu leads with Reply: ${result.menu}`)
    assert.ok(result.menu.includes('Copy'), `the text view's own menu keeps Copy: ${result.menu}`)
    assert.equal(result.copied, result.excerpt, 'Copy still copies the selection')
    assert.equal(result.selectionAfter, 0, 'Reply clears the selection')
    if (capture && result.png)
      writeFileSync(join(artifacts, capture), Buffer.from(result.png, 'base64'))
    return result.excerpt as string
  }
  const short = 'chat-reply-short'
  const tight = 'chat-reply-tight'
  chat.messages.push(
    {
      id,
      role: 'assistant',
      at: Date.now(),
      text: SOURCE,
      statuses: [],
      segments: [{ kind: 'text', text: SOURCE }]
    },
    {
      id: short,
      role: 'assistant',
      at: Date.now(),
      text: SHORT,
      statuses: [],
      segments: [{ kind: 'text', text: SHORT }]
    },
    {
      id: tight,
      role: 'assistant',
      at: Date.now(),
      text: TIGHT,
      statuses: [],
      segments: [{ kind: 'text', text: TIGHT }]
    }
  )
  nativeChat.changed(chat)
  try {
    assert.ok(!chat.isRunning, 'Chat reply starts with no turn running')
    await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => s.messages.some((m: { id: string }) => m.id === id)
    )
    if (background())
      console.log('SKIP chat reply captures: TREZI_NATIVE_BACKGROUND_TEST (reduced coverage)')
    else await host.request('chatAcceptance', { prepare: true })
    // 1. Reply on the first excerpt: a card whose comment field takes focus.
    const first = await reply(FIRST, 'chat-reply-button.png')
    assert.equal(first, FIRST)
    await wait(async () => (await cards()).length === 1, 'the first card')
    let shown = await cards()
    assert.equal(shown[0].excerpt, FIRST)
    assert.ok(shown[0].editing, 'the new card’s comment field has focus')
    await host.request('composerPerform', {
      quoteComment: { index: 0, text: 'Where is it?', done: true }
    })
    await wait(() => chat.quotes?.[0]?.comment === 'Where is it?', 'the first comment')
    assert.equal(
      (await host.request('composerInspect')).inputIsFirstResponder,
      true,
      'Return goes back to the message'
    )
    // 2. The second excerpt (rendered code text, no backticks), then a third that is removed.
    const second = await reply(SECOND)
    assert.equal(second, SECOND)
    await wait(async () => (await cards()).length === 2, 'the second card')
    await host.request('composerPerform', { quoteComment: { index: 1, text: 'Run it for me.' } })
    await wait(() => chat.quotes?.[1]?.comment === 'Run it for me.', 'the second comment')
    // A one-line message: Reply floats clear of it; this one is chosen from the menu.
    await reply(SHORT_PART, false, short, true)
    await wait(async () => (await cards()).length === 3, 'the third card')
    assert.equal((await cards())[2].excerpt, SHORT_PART)
    await host.request('composerPerform', { quoteRemove: 2 })
    await wait(async () => (await cards()).length === 2, 'the third card removed')
    // LKM-627: the reported tight message, all of it: Reply floats clear of both lines and a
    // real click quotes it exactly once; that card is removed again.
    const whole = await reply(TIGHT_TEXT, 'chat-reply-tight.png', tight, false, true)
    assert.equal(whole, TIGHT_TEXT)
    await wait(async () => (await cards()).length === 3, 'the tight card')
    assert.deepEqual(
      (chat.quotes ?? []).filter((q) => q.message === tight).map((q) => q.excerpt),
      [TIGHT_TEXT],
      'one quote of the tight message, its exact text'
    )
    await host.request('composerPerform', { quoteRemove: 2 })
    await wait(async () => (await cards()).length === 2, 'the tight card removed')
    // 3. The first message streams on and reparses: the cards keep their message and excerpt.
    const source = chat.messages.find((m) => m.id === id)!
    source.text = `${SOURCE}\n\n**Update:** the backup is ~/.git-backup.`
    source.segments = [{ kind: 'text', text: source.text }]
    nativeChat.changed(chat)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(
      (chat.quotes ?? []).map((q) => [q.message, q.excerpt, q.comment]),
      [
        [id, FIRST, 'Where is it?'],
        [id, SECOND, 'Run it for me.']
      ]
    )
    shown = await cards()
    assert.deepEqual(
      shown.map((c) => [c.excerpt, c.comment]),
      [
        [FIRST, 'Where is it?'],
        [SECOND, 'Run it for me.']
      ]
    )
    // 4. Drafts: another chat has none; coming back restores both cards.
    const firstChat = nativeChat.active
    host.emit('shell-action', { action: 'new-chat', project: nativeWorkspace.state.activeKey })
    await wait(() => nativeChat.active !== firstChat, 'a new chat')
    await wait(async () => (await cards()).length === 0, 'no cards in the new chat')
    await nativeWorkspace.command({
      type: 'chat',
      key: nativeWorkspace.state.activeKey!,
      session: firstChat
    })
    await wait(async () => (await cards()).length === 2, 'the cards back with their chat')
    // 5. One native send with a message.
    await host.request('composerPerform', { text: MESSAGE })
    await wait(async () => (await host.request('composerInspect')).enabled === true, 'Send enabled')
    if (!background()) {
      const composer = await host.request('captureVisibleComposer')
      writeFileSync(join(artifacts, 'chat-reply-cards.png'), Buffer.from(composer.png, 'base64'))
    }
    await host.request('composerPerform', { action: 'send' })
    await wait(() => providerSends > 0, 'the send to reach the provider', 400)
    assert.equal(sends.length, 1, 'one send')
    assert.equal(
      sends[0].endsWith(
        quotedPrompt(
          [
            { excerpt: FIRST, comment: 'Where is it?' },
            { excerpt: SECOND, comment: 'Run it for me.' }
          ],
          MESSAGE
        )
      ),
      true,
      `the agent receives each excerpt with its comment: ${JSON.stringify(sends[0])}`
    )
    await wait(async () => (await cards()).length === 0, 'the cards cleared by the accepted send')
    const state = await host.request('chatInspect')
    const bubble = state.messages.findLast((m: { role: string }) => m.role === 'user')
    assert.equal(bubble.text, MESSAGE)
    provider.emit({ type: 'done', projectKey: chat.chat, landingPending: false })
    await wait(() => !chat.isRunning, 'the turn to finish')
    // The bubble shows each excerpt with its comment, decoded from the user message.
    const sent = await host.request('chatReply', { sent: true, capture: !background() })
    if (sent.png)
      writeFileSync(join(artifacts, 'chat-reply-sent.png'), Buffer.from(sent.png, 'base64'))
    assert.equal(sent.text, MESSAGE)
    assert.deepEqual(sent.quotes, [
      { excerpt: FIRST, comment: 'Where is it?' },
      { excerpt: SECOND, comment: 'Run it for me.' }
    ])
    console.log(
      'Chat reply: two selections replied to, commented, kept through streaming and a chat switch, and sent in one native send.'
    )
  } finally {
    nativeChat.services.invoke = invoke
    try {
      if (chat.isRunning) {
        provider.emit({ type: 'done', projectKey: chat.chat, landingPending: false })
        await wait(() => !chat.isRunning, 'the turn to finish').catch(() => {})
      }
    } finally {
      provider.restore()
    }
    chat.quotes = []
    chat.messages.splice(kept)
    nativeChat.changed(chat)
    await host.request('composerPerform', { text: '' }).catch(() => {})
    await host.request('chatText', { restore: true }).catch(() => {})
  }
}
