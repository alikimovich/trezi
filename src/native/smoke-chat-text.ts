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
        `${mode}: code background ${result.codeFill} shows on ${result.background} (code ${result.codeFrame}, capture ${JSON.stringify(result.capture)})`
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
  await checkCodeClick(host, artifacts)
}

const BLOCK = ['  func café() {', '\treturn "日本語 🚀"   ', '', '  }'].join('\n')
const LONG = 'packages/some-long-folder/another-long-folder/yet-another-long-folder/file.test.ts'
const CLICK_MARKDOWN = [
  'Prose before `inline  code` and after, then `https://example.com/never` and `rm -rf ./nothing`.',
  '',
  `A [candidate](trezi-code:src/never.ts#L1) and \`${LONG}\` end.`,
  '',
  '```swift',
  BLOCK,
  '```',
  '',
  'Last words.'
].join('\n')
const SENTINEL = 'not copied'

/** Sum of the channels, enough to compare two greys. */
const light = (color: number[]) => color.reduce((sum, value) => sum + value, 0)

/** LKM-431: real pointer input on the glyphs of a synthetic message, into a private
 *  pasteboard. One click copies the exact raw code and shows Copied by the pointer in
 *  light, dark, wide and narrow chats; a repeat replaces it and it dismisses itself.
 *  Prose, empty space, links, a double click and a drag do not copy. */
async function checkCodeClick(host: NativeBridge, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const kept = chat.messages.length
  const id = 'chat-code-click'
  chat.messages.push({
    id,
    role: 'assistant',
    at: Date.now(),
    text: CLICK_MARKDOWN,
    statuses: [],
    segments: [{ kind: 'text', text: CLICK_MARKDOWN }]
  })
  nativeChat.changed(chat)
  await inspectUntil(
    (m) => host.request(m),
    'chatInspect',
    (s) => s.messages.some((m: { id: string }) => m.id === id)
  )
  const { chatWidth } = await host.request('chatAcceptance', { prepare: true })
  try {
    for (const layout of ['wide', 'narrow'] as const) {
      const width = layout === 'narrow' ? 320 : chatWidth
      await host.request('chatAcceptance', { prepare: true, width })
      for (const mode of ['light', 'dark'] as const) {
        const label = `${layout} ${mode}`
        const pointer = async (action: string, find: string, extra = {}) => {
          const result = await host.request('chatText', {
            dark: mode === 'dark',
            message: id,
            pointer: action,
            find,
            ...extra
          })
          // Not a view above the text, so a click that copies nothing proves something.
          if (result.hit) assert.equal(result.hit, 'ChatTextView', `${label}: ${find} is reachable`)
          return result
        }
        const copies = async (find: string, expected: string, extra = {}) => {
          const result = await pointer('click', find, extra)
          assert.equal(result.pasteboard, expected, `${label}: click on ${find}`)
          assert.equal(result.toasts, 1, `${label}: one Copied after ${find}`)
          const toast = rect(result.toast)
          const { x, y } = rect(result.point)
          const away = Math.hypot(toast.x + toast.width / 2 - x, toast.y + toast.height / 2 - y)
          assert.ok(away < 70, `${label}: Copied ${result.toast} by the pointer ${result.point}`)
          const covered = x >= toast.x && x <= toast.x + toast.width
          assert.ok(
            !(covered && y >= toast.y && y <= toast.y + toast.height),
            `${label}: Copied ${result.toast} is not under the pointer ${result.point}`
          )
          const visible = rect(result.visible)
          assert.ok(
            toast.x >= visible.x &&
              toast.y >= visible.y &&
              toast.x + toast.width <= visible.x + visible.width &&
              toast.y + toast.height <= visible.y + visible.height,
            `${label}: Copied ${result.toast} stays inside ${result.visible}`
          )
          return result
        }
        const inline = await copies('inline  code', 'inline  code', { capture: true })
        writeFileSync(
          join(artifacts, `chat-code-click-${layout}-${mode}.png`),
          Buffer.from(inline.png, 'base64')
        )
        assert.ok(inline.toastInCapture, `${label}: Copied is on screen during the capture`)
        for (const [name, fill, ground] of [
          ['inline', inline.chipFill, inline.chipBackground],
          ['block', inline.codeFill, inline.background]
        ]) {
          assert.ok(
            contrast(fill, ground) >= 2 && light(fill) < light(ground),
            `${label}: ${name} code ${fill} is a darker grey than ${ground}`
          )
        }
        await copies('func café', BLOCK)
        await copies('func café', BLOCK, { spot: 'end' })
        await copies(LONG, LONG, { line: 1 })
        assert.deepEqual((await pointer('dismiss', '')).dismissed, true, `${label}: Copied leaves`)
        if (layout !== 'wide' || mode !== 'light') continue

        // A repeat after the dismissal, and code that must only be copied.
        await copies('inline  code', 'inline  code')
        const url = await copies('https://example.com/never', 'https://example.com/never')
        assert.equal(url.appKitLinks, 0, 'a URL in code opens nothing')
        assert.equal(url.frontmost, url.pid, 'a URL in code leaves Trezi in front')
        await copies('rm -rf ./nothing', 'rm -rf ./nothing')
        await pointer('dismiss', '')

        for (const [name, find, extra] of [
          ['prose', 'Prose before', {}],
          ['last prose', 'Last words.', {}],
          ['space after a line', 'Last words.', { spot: 'end' }],
          ['the gap under a block', 'Last words.', { spot: 'gap' }]
        ] as const) {
          const result = await pointer('click', find, extra)
          assert.equal(result.pasteboard, SENTINEL, `a click on ${name} does not copy`)
          assert.equal(result.toasts, 0, `a click on ${name} shows nothing`)
        }
        const link = await pointer('click', 'candidate')
        assert.equal(link.pasteboard, SENTINEL, 'a link does not copy')
        assert.equal(
          link.routed.map((value: string) => value.replace('%23', '#')).join(),
          'trezi-code:src/never.ts#L1',
          'a link still opens'
        )
        const double = await pointer('double', 'func café')
        assert.equal(double.pasteboard, SENTINEL, 'a double click does not copy')
        assert.ok(double.selected.length > 0, 'a double click still selects')
        const drag = await pointer('drag', 'inline  code', { to: 'and after', copy: true })
        assert.equal(drag.pasteboard, SENTINEL, 'a drag does not copy')
        assert.ok(drag.selected.includes('code'), `the drag selects: ${drag.selected}`)
        assert.equal(drag.copied, drag.selected, 'Copy still gives the dragged selection')
      }
    }
    console.log('Chat code click: exact raw copies with Copied by the pointer, in four layouts.')
  } finally {
    await host.request('chatAcceptance', { prepare: true, width: chatWidth })
    await host.request('chatText', { restore: true })
    chat.messages.splice(kept)
    nativeChat.changed(chat)
  }
}
