import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import { chatUiTool } from '../main/chat-ui'
import type { AgentEvent } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { inspectUntil, waitFor } from './smoke-wait'

type ChatUiState = {
  message: string
  id: string
  kind: string
  problems: string[]
  images: string[]
  missing: string[]
  answered: boolean
  frame: string
}

const height = (value: string) => Number((value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? [])[3] ?? 0)
const rect = (value: string | undefined) => {
  assert.ok(value, 'missing rendered line frame')
  const numbers = (value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)
  assert.equal(numbers.length, 4, `expected a frame: ${value}`)
  const [x, y, width, height] = numbers
  return { x, y, width, height, right: x + width, bottom: y + height }
}

const OPTIONS = {
  kind: 'options',
  title: 'Hero direction',
  prompt: 'Three takes on the landing hero.',
  options: [
    { id: 'split', title: 'Split hero', note: 'Copy left, product shot right.', tags: ['calm'] },
    { id: 'stacked', title: 'Stacked hero', note: 'Large headline over a full-width shot.' },
    { id: 'minimal', title: 'Minimal', note: 'Type only, generous whitespace.', tags: ['bold'] }
  ]
}
const FORM = {
  kind: 'form',
  title: 'Card details',
  submitLabel: 'Apply',
  fields: [
    {
      id: 'density',
      type: 'choice',
      label: 'Density',
      options: [
        { value: 'tight', label: 'Tight' },
        { value: 'airy', label: 'Airy' }
      ]
    },
    { id: 'radius', type: 'number', label: 'Corner radius', min: 0, max: 32, unit: 'px' },
    { id: 'gap', type: 'slider', label: 'Gap', min: 4, max: 24, step: 4, default: 12 },
    {
      id: 'accent',
      type: 'color',
      label: 'Accent',
      required: false,
      suggestions: [
        { name: '--brand-teal', value: '#0f766e' },
        { name: '--brand-coral', value: '#f97362' }
      ]
    },
    { id: 'shadow', type: 'toggle', label: 'Drop shadow', default: true },
    { id: 'note', type: 'text', label: 'Anything else', required: false, placeholder: 'Optional' }
  ]
}

/** LKM-208: answer components in a stubbed turn. Options appear mid-turn with skeletons
 *  and fill in as option images arrive; options and form are captured in light and dark;
 *  the pick and the submit each send one structured user turn whose prompt carries the
 *  component summary. No provider is called. */
export async function checkChatUi(host: NativeBridge, artifacts: string) {
  const request = (method: string) => host.request(method)
  const chat = nativeChat.get(nativeChat.active).chat
  const component = (state: any, id: string): ChatUiState | undefined =>
    state.chatUi?.find((c: ChatUiState) => c.id === id)
  const sent: string[] = []
  const provider = stubAgentSendForSmoke(chat, (text) => {
    sent.push(text)
  })
  const emit = (event: object) => provider.emit(event as AgentEvent)
  const scope = {
    emitKey: chat,
    background: false,
    notify: (_channel: string, payload: unknown) => nativeChat.event(payload as AgentEvent)
  }
  const capture = async (
    name: string,
    id: string,
    dark?: boolean,
    acceptedLayout = false,
    expectedChatWidth?: number
  ) => {
    const result = await host.request('chatUi', {
      component: id,
      acceptedLayout,
      expectedChatWidth,
      ...(dark === undefined ? {} : { dark })
    })
    writeFileSync(join(artifacts, `chat-ui-${name}.png`), Buffer.from(result.png, 'base64'))
    if (dark !== undefined) assert.equal(/dark/i.test(result.appearance), dark, result.appearance)
    assert.ok(height(result.frame) > 0, `${name}: the component is laid out ${result.frame}`)
    return result
  }
  let originalChatWidth: number | undefined
  try {
    await inspectUntil(request, 'composerInspect', (s) => s.queueCount === 0)
    await inspectUntil(request, 'chatInspect', (s) => !s.activity)
    await host.request('composerPerform', { text: 'Show me hero directions.' })
    await inspectUntil(request, 'composerInspect', (s) => s.enabled)
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.length === 1, 'the first turn reached the provider stub')
    originalChatWidth = (await host.request('chatAcceptance', { prepare: true })).chatWidth

    // Mid-turn: text, then the component with every image still a skeleton.
    emit({ type: 'delta', text: 'Here are three directions for the hero.' })
    const shown: any = await chatUiTool({ action: 'show', component: OPTIONS }, scope)
    assert.ok(shown.shown, JSON.stringify(shown))
    const skeleton = component(
      await inspectUntil(request, 'chatInspect', (s) => component(s, shown.id)?.kind === 'options'),
      shown.id
    )!
    assert.deepEqual([skeleton.images, skeleton.missing, skeleton.answered], [[], [], false])
    await capture('options-skeleton', shown.id, false)
    // Option images come from the preview as the agent shows each variant.
    for (const option of ['split', 'stacked'])
      await chatUiTool({ action: 'update', id: shown.id, option, capture: true }, scope)
    const filled = component(
      await inspectUntil(
        request,
        'chatInspect',
        (s) =>
          (component(s, shown.id)?.images.length ?? 0) +
            (component(s, shown.id)?.missing.length ?? 0) ===
          2
      ),
      shown.id
    )!
    for (const mode of ['light', 'dark'] as const)
      await capture(`options-${mode}`, shown.id, mode === 'dark')
    emit({ type: 'done' })
    await inspectUntil(request, 'chatInspect', (s) => !s.activity)

    // The pick: one structured user turn, and the summary in that turn's prompt.
    await host.request('chatPerform', {
      action: 'chat-ui',
      card: shown.id,
      value: JSON.stringify({ choice: 'stacked', comment: 'Keep the headline short' })
    })
    await waitFor(() => sent.length === 2, 'the pick reached the provider stub')
    assert.match(sent[1], /User picked option B: Stacked hero \(id "stacked"\)/)
    assert.match(sent[1], /Picked option B: Stacked hero\. Keep the headline short$/)
    const picked = await inspectUntil(
      request,
      'chatInspect',
      (s) => component(s, shown.id)?.answered === true
    )
    assert.ok(
      picked.messages.some((m: any) => m.role === 'user' && m.text.startsWith('Picked option B'))
    )
    await capture('options-answered', shown.id)

    // The agent asks a structured question with a form; Submit sends every value.
    const form: any = await chatUiTool({ action: 'show', component: FORM }, scope)
    assert.ok(form.shown, JSON.stringify(form))
    await inspectUntil(request, 'chatInspect', (s) => component(s, form.id)?.kind === 'form')
    emit({ type: 'done' })
    await inspectUntil(request, 'chatInspect', (s) => !s.activity)
    for (const mode of ['light', 'dark'] as const)
      await capture(`form-${mode}`, form.id, mode === 'dark')
    // An answer missing a required field is refused and nothing is sent.
    await host.request('chatPerform', {
      action: 'chat-ui',
      card: form.id,
      value: JSON.stringify({ values: { density: 'airy' } })
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(sent.length, 2, 'An invalid submit reached the provider')
    await host.request('chatPerform', {
      action: 'chat-ui',
      card: form.id,
      value: JSON.stringify({
        values: {
          density: 'airy',
          radius: 12,
          gap: 16,
          accent: '--brand-teal',
          shadow: true,
          note: 'Keep the card calm and easy to scan. Let each answer sit directly beneath its question, and let this longer note wrap across the available card width at an ordinary chat size.'
        }
      })
    })
    await waitFor(() => sent.length === 3, 'the submit reached the provider stub')
    assert.match(
      sent[2],
      /"Card details" \(chat_ui form [\w-]+\): the user submitted \{"density":"airy"/
    )
    assert.match(sent[2], /- Corner radius: 12 px/)
    assert.match(sent[2], /- Anything else: Keep the card calm and easy to scan\./)
    await inspectUntil(request, 'chatInspect', (s) => component(s, form.id)?.answered === true)
    // Measure rendered SwiftUI line frames at narrow, ordinary and wide supported widths.
    // The synthetic answer must wrap inside the card at all three sizes.
    let previousCardWidth = 0
    for (const [name, width] of [
      ['narrow', 320],
      ['ordinary', 400],
      ['wide', 520]
    ] as const) {
      const layout = await host.request('chatAcceptance', { prepare: true, width })
      assert.ok(Math.abs(layout.chatWidth - width) <= 1, `${name}: chat width ${layout.chatWidth}`)
      const result = await capture(`form-answered-${name}`, form.id, undefined, true, width)
      const card = rect(result.frame)
      assert.ok(Math.abs(card.width - (width - 36)) <= 20, `${name}: card fills chat width`)
      assert.ok(
        card.width > previousCardWidth + 40,
        `${name}: card grows with chat width (${card.width} pt)`
      )
      assert.ok(result.inView, `${name}: accepted card stays in the foreground reading area`)
      previousCardWidth = card.width
      const lines = result.acceptedLines as Record<string, string>
      let previousAnswerBottom = -Infinity
      for (const field of FORM.fields) {
        const question = rect(lines[`${form.id}:${field.id}:question`])
        const answer = rect(lines[`${form.id}:${field.id}:answer`])
        assert.ok(
          question.y >= previousAnswerBottom - 1,
          `${name}: ${field.id} follows the prior answer`
        )
        assert.ok(
          answer.y >= question.bottom + 2,
          `${name}: ${field.id} answer follows its question`
        )
        assert.ok(Math.abs(question.x - answer.x) <= 1, `${name}: ${field.id} leading edges`)
        assert.ok(
          Math.abs(question.width - answer.width) <= 1,
          `${name}: ${field.id} full line widths`
        )
        assert.ok(
          Math.abs(question.width - (card.width - 24)) <= 3,
          `${name}: ${field.id} uses card width`
        )
        assert.ok(
          question.x >= card.x + 10 && answer.right <= card.right - 10,
          `${name}: ${field.id} stays inside card`
        )
        assert.ok(answer.bottom <= card.bottom - 8, `${name}: ${field.id} answer stays inside card`)
        previousAnswerBottom = answer.bottom
        if (field.id === 'note')
          assert.ok(
            answer.height >= 28,
            `${name}: synthetic long answer wraps (${answer.height} pt)`
          )
      }
      writeFileSync(
        join(artifacts, `chat-ui-form-answered-${name}.json`),
        JSON.stringify({ chatWidth: layout.chatWidth, card: result.frame, lines }, null, 2)
      )
    }
    emit({ type: 'done' })
    await inspectUntil(request, 'chatInspect', (s) => !s.activity)
    console.log(
      `Chat UI: options shown mid-turn with skeletons (${filled.images.length} preview images, ${filled.missing.length} missing), form; light and dark captures; pick and submit sent structured turns with their summaries.`
    )
  } finally {
    if (originalChatWidth !== undefined)
      await host.request('chatAcceptance', { prepare: true, width: originalChatWidth })
    await host.request('chatUi', { restore: true })
    // The refused submit's "… is required." card stays shown otherwise.
    await host.request('chatPerform', { action: 'error-dismiss', card: 'error' })
    // Like smoke-chat: keep the stub if nothing was sent, so a late send never escapes.
    if (sent.length) provider.restore()
  }
}
