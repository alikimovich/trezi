import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { inspectUntil } from './smoke-wait'

/** `NSStringFromRect` text, `{{x, y}, {w, h}}`, in the conversation's top-left coordinates. */
const rect = (value: string) => {
  const [x, y, width, height] = (value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)
  return { x, y, width, height }
}
/** Largest channel difference between two sampled sRGB colours (0–255). */
const contrast = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

const MARKDOWN = [
  'First paragraph with a [link](https://example.com/) and `inline code`.',
  '',
  '- one',
  '- two',
  '',
  '## Heading',
  '',
  '```swift',
  'let first = 1',
  '```',
  '',
  'Between the blocks.',
  '',
  '```js',
  'const last = 2',
  '```'
].join('\n')
// Copy gives the shown text with paragraph breaks; whole code blocks keep their fences.
const COPIED = [
  'First paragraph with a link and inline code.',
  '',
  '- one',
  '- two',
  '',
  'Heading',
  '',
  '```swift',
  'let first = 1',
  '```',
  '',
  'Between the blocks.',
  '',
  '```js',
  'const last = 2',
  '```'
].join('\n')

/** LKM-186: one assistant message is one text view. A selection from its first paragraph
 *  to its last code block (by point, where a drag lands) holds both, Copy gives the full
 *  text, Select All selects the message, and the code Copy button and link survive.
 *  Captured with the selection in light and dark mode. */
export async function checkChatText(host: NativeBridge, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const kept = chat.messages.length
  const id = 'chat-text-selection'
  chat.messages.push({
    id,
    role: 'assistant',
    at: Date.now(),
    text: MARKDOWN,
    statuses: [],
    segments: [{ kind: 'text', text: MARKDOWN }]
  })
  nativeChat.changed(chat)
  try {
    await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => s.messages.some((m: { id: string }) => m.id === id)
    )
    // Focus is required for the window capture; the runner restores it if lost.
    await host.request('chatAcceptance', { prepare: true })
    for (const mode of ['light', 'dark'] as const) {
      const result = await host.request('chatText', { dark: mode === 'dark', message: id })
      writeFileSync(
        join(artifacts, `chat-text-selection-${mode}.png`),
        Buffer.from(result.png, 'base64')
      )
      assert.equal(/dark/i.test(result.appearance), mode === 'dark', result.appearance)
      assert.equal(result.views, 1, `${mode}: the message is one text view`)
      assert.deepEqual(result.blockKinds, ['text', 'text', 'heading', 'code', 'text', 'code'])
      assert.ok(
        result.from === 0 && result.to === result.length,
        `${mode}: the drag spans the message (${result.from}…${result.to} of ${result.length})`
      )
      assert.ok(
        result.selected.startsWith('First paragraph') && result.selected.endsWith('const last = 2'),
        `${mode}: the selection holds the first paragraph and the last code block: ${JSON.stringify(result.selected)}`
      )
      assert.equal(result.copied, COPIED, `${mode}: Copy gives the whole selection`)
      assert.equal(
        result.selectAll,
        `{0, ${result.length}}`,
        `${mode}: Select All selects the message`
      )
      assert.equal(result.copiedAll, COPIED, `${mode}: Copy after Select All`)
      assert.ok(result.firstResponder, `${mode}: the text view kept focus`)
      assert.equal(result.copyButtons, 2, `${mode}: every code block keeps its Copy button`)
      assert.equal(result.copiedCode, 'const last = 2', `${mode}: the code Copy button`)
      assert.deepEqual(result.links, ['https://example.com/'], `${mode}: the link survives`)
      const text = rect(result.textFrame)
      const code = rect(result.codeFrame)
      assert.ok(
        text.y >= 0 && code.y + code.height <= result.readingHeight,
        `${mode}: the message is in view ${result.textFrame} ${result.codeFrame}`
      )
      const fill = contrast(result.codeFill, result.background)
      assert.ok(
        fill >= 2,
        `${mode}: code background ${result.codeFill} shows on ${result.background}`
      )
    }
    console.log(
      'Chat text: one view per message; drag, Copy and Select All span paragraphs, list, heading and code in light and dark.'
    )
  } finally {
    await host.request('chatText', { restore: true })
    chat.messages.splice(kept)
    nativeChat.changed(chat)
  }
}
