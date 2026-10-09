import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuestionRequest } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import type { NativeContextController } from './context-controller'
import { inspectUntil } from './smoke-wait'

/** `NSStringFromRect` text, `{{x, y}, {w, h}}`, in the conversation's coordinates. */
const height = (value: string) => Number((value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? [])[3] ?? 0)

const REQUEST =
  'Selected <button> at src/components/Hero.tsx:42:7 (class hero-cta). Make the call to action teal so it matches the brand palette, and keep its hover state readable on the dark hero photo. Use the same color for the focus ring, and check that the label still reads well at every breakpoint.'

type AgentCardState = {
  id: string
  title: string
  status: string
  statusLabel: string
  preview: string
  expanded: boolean
  target: string
  question: string
  options: string[]
  actions: string[]
  frame: string
}

/** LKM-193: a background agent's question shows on its card like a chat question (the
 *  request, its file:line link, the status and the options), captured in light and dark;
 *  the card's answer clears it and the agent runs on. */
export async function checkAgentQuestion(
  host: NativeBridge,
  context: NativeContextController,
  artifacts: string
) {
  const chat = nativeChat.get(nativeChat.active)
  const id = `agent-question-${Date.now()}`
  const question: QuestionRequest = {
    id: `${id}-q`,
    sessionKey: chat.chat,
    questions: [
      {
        header: 'Color',
        question: 'Which teal should the call to action use?',
        multiSelect: false,
        options: [
          { label: 'Brand teal', description: 'The --brand-teal token from the palette' },
          { label: 'Tailwind teal-500', description: 'The framework default' }
        ]
      }
    ]
  }
  const card = (state: any): AgentCardState | undefined =>
    state.agentCards?.find((c: AgentCardState) => c.id === id)
  context.queued(chat.chat, id, REQUEST, false)
  nativeChat.event({
    type: 'spawn-started',
    projectKey: chat.chat,
    sessionId: id,
    branch: 'trezi/agent-question'
  })
  nativeChat.event({
    type: 'question-request',
    projectKey: chat.chat,
    sessionId: id,
    request: question
  })
  try {
    const state = await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => card(s)?.question === question.id
    )
    const shown = card(state)!
    assert.equal(shown.title, 'Background agent needs your answer')
    assert.equal(shown.statusLabel, 'Waiting for your answer')
    assert.equal(shown.target, 'src/components/Hero.tsx:42')
    assert.deepEqual(shown.options, ['Brand teal', 'Tailwind teal-500'])
    assert.deepEqual(shown.actions, ['Cancel'])
    assert.ok(shown.preview.endsWith('…') && REQUEST.startsWith(shown.preview.slice(0, -1)))
    assert.ok(!JSON.stringify(state.agentCards).includes('AskUserQuestion'))
    assert.equal(state.questionCount, 0, 'Shown on the card, not as a second chat question')
    // Focus is required for the window capture; the runner restores it if lost.
    await host.request('chatAcceptance', { prepare: true })
    let collapsed = 0
    for (const mode of ['light', 'dark'] as const) {
      const dark = mode === 'dark'
      const result = await host.request('chatAgentCard', { dark, card: id })
      writeFileSync(
        join(artifacts, `agent-question-${mode}.png`),
        Buffer.from(result.png, 'base64')
      )
      assert.equal(/dark/i.test(result.appearance), dark, `Appearance ${result.appearance}`)
      assert.ok(result.inView, `${mode}: the card is in view ${result.frame}`)
      collapsed = height(result.frame)
    }
    // A click shows the whole request; a second click collapses it again.
    const opened = await host.request('chatAgentCard', { card: id, toggle: [id] })
    assert.ok(height(opened.frame) > collapsed, `Expanded ${opened.frame} vs ${collapsed}`)
    assert.ok(card(await host.request('chatInspect'))?.expanded)
    await host.request('chatAgentCard', { card: id, toggle: [id] })
    // The card's Send answer path: the question clears and the agent shows Running.
    await nativeChat.action({
      chat: chat.chat,
      action: 'question',
      id: question.id,
      answers: { [question.questions[0].question]: 'Brand teal' }
    })
    const answered = card(
      await inspectUntil(
        (m) => host.request(m),
        'chatInspect',
        (s) => card(s)?.question === ''
      )
    )!
    assert.equal(answered.statusLabel, 'Running')
    assert.equal(answered.title, 'Background agent')
    console.log(
      `Agent question: card with options, target link and status captured in light and dark (${collapsed} pt); the answer cleared it.`
    )
  } finally {
    await host.request('chatAgentCard', { restore: true })
    // A text-edit origin posts no result row, so the transcript is left as it was.
    nativeChat.event({
      type: 'spawn-finished',
      projectKey: chat.chat,
      sessionId: id,
      branch: null,
      origin: 'text-edit',
      outcome: 'cancelled'
    })
  }
}
