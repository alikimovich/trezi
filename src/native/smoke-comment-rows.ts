import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { inspectUntil } from './smoke-wait'

/** `NSStringFromRect` text, `{{x, y}, {w, h}}`, in the conversation's coordinates. */
const rect = (value: string) => {
  const [x, y, width, height] = (value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)
  return { x, y, width, height }
}
/** Largest channel difference between two sampled sRGB colours (0–255). */
const contrast = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

const LONG =
  'Make the hero heading larger and give its underline the brand blue so it stands out against the photo behind it on every breakpoint'
// One finished comment per outcome. The no-change one carries no comment text, as an
// older event would: its line falls back to the summary's first line.
const FINISHED = [
  {
    outcome: 'applied',
    branch: null,
    label: LONG,
    summary: 'Set the hero `h1` to 48 px.\nThe underline uses `--brand-blue`.'
  },
  {
    outcome: 'failed',
    branch: 'trezi/comment-rows-failed',
    label: 'Tighten the card grid gap',
    summary: 'The build failed after editing `grid.css`.'
  },
  { outcome: 'cancelled', branch: null, label: 'Add a footer link to the changelog' },
  {
    outcome: 'no-change',
    branch: null,
    summary: 'The button already uses the requested colour.\nNothing to change.'
  },
  {
    outcome: 'review',
    branch: 'trezi/comment-rows-review',
    label: 'Rename the call to action',
    summary: 'Renamed the call to action to “Start free”.'
  }
] as const
const TITLES = [
  'Comment applied',
  'Comment failed',
  'Comment cancelled',
  'Comment finished without changes',
  'Comment finished — changes are ready for review'
]

/** LKM-178: comment results render as one collapsed line in a light bubble; the toggle a
 *  click uses expands and collapses one row at a time. Captured in light and dark mode. */
export async function checkCommentRows(host: NativeBridge, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const kept = chat.messages.length
  const user = 'comment-rows-user'
  chat.messages.push({
    id: user,
    role: 'user',
    at: Date.now(),
    text: 'Reference bubble',
    statuses: [],
    segments: [{ kind: 'text', text: 'Reference bubble' }]
  })
  for (const [i, finished] of FINISHED.entries())
    nativeChat.event({
      type: 'spawn-finished',
      projectKey: chat.chat,
      sessionId: `comment-rows-${i}`,
      origin: 'comment',
      ...finished
    })
  const ids = chat.messages.slice(kept + 1).map((m) => m.id)
  try {
    assert.equal(ids.length, FINISHED.length, 'Every outcome posts one result row')
    const state = await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => ids.every((id) => s.comments.some((c: { id: string }) => c.id === id))
    )
    const shown = ids.map((id) => state.comments.find((c: { id: string }) => c.id === id))
    assert.deepEqual(
      shown.map((c) => c.title),
      TITLES
    )
    assert.equal(shown[0].line, LONG, 'The row names the comment by its text')
    assert.equal(shown[3].line, 'The button already uses the requested colour.')
    assert.ok(
      shown.every((c) => !c.expanded),
      'Every row starts collapsed'
    )
    // Focus is required for the window capture; the runner restores it if lost.
    await host.request('chatAcceptance', { prepare: true })
    const expand = [ids[0], ids[1]]
    let collapsedHeight = 0
    for (const mode of ['light', 'dark'] as const) {
      const dark = mode === 'dark'
      // Sampled while the reference bubble is in view; expanded rows can scroll it away.
      let bubble = 0
      let bubbleColours = ''
      const capture = async (state: string, toggle: string[]) => {
        const result = await host.request('chatCommentRows', {
          dark,
          toggle,
          messages: ids,
          user
        })
        writeFileSync(
          join(artifacts, `comment-rows-${mode}-${state}.png`),
          Buffer.from(result.png, 'base64')
        )
        assert.equal(/dark/i.test(result.appearance), dark, `Appearance ${result.appearance}`)
        const rows = result.rows.map((row: any) => ({ ...row, frame: rect(row.frame) }))
        if (result.user.length && result.userBackground.length) {
          bubble = contrast(result.user, result.userBackground)
          bubbleColours = `${result.user} on ${result.userBackground}`
        }
        assert.ok(bubble > 0, `${mode} ${state}: the user bubble was sampled`)
        for (const row of rows) {
          assert.ok(
            row.frame.height > 0 && row.frame.y >= 0 && row.frame.y < result.readingHeight,
            `${mode} ${state}: row is in view ${JSON.stringify(row.frame)}`
          )
          // A semantic fill: visible against the chat, but lighter than the user bubble.
          const fill = contrast(row.fill, row.background)
          assert.ok(
            fill >= 2 && fill < bubble,
            `${mode} ${state}: row fill ${row.fill} on ${row.background} must be lighter than the user bubble ${bubbleColours}`
          )
        }
        return rows
      }
      const collapsed = await capture('collapsed', [])
      const heights = collapsed.map((row: any) => row.frame.height)
      collapsedHeight = Math.max(...heights)
      // One line each, the long comment truncated: the same compact height for all.
      assert.ok(
        collapsedHeight <= 40 && Math.min(...heights) > collapsedHeight - 1,
        `${mode}: collapsed rows are single lines ${heights}`
      )
      assert.ok(collapsed.every((row: any) => !row.expanded))
      const expanded = await capture('expanded', expand)
      for (const [i, row] of expanded.entries()) {
        const open = expand.includes(row.id)
        assert.equal(row.expanded, open)
        assert.ok(
          open ? row.frame.height > collapsedHeight + 20 : row.frame.height <= collapsedHeight + 1,
          `${mode}: row ${i} ${open ? 'expands' : 'stays collapsed'} (${row.frame.height} pt)`
        )
      }
      // A second click collapses it again.
      const closed = await host.request('chatCommentRows', {
        toggle: expand,
        messages: ids,
        user
      })
      for (const row of closed.rows)
        assert.ok(!row.expanded && rect(row.frame).height <= collapsedHeight + 1)
    }
    console.log(
      `Comment rows: ${ids.length} outcomes collapsed at ${collapsedHeight} pt, expanded and collapsed again in light and dark.`
    )
  } finally {
    await host.request('chatCommentRows', { restore: true })
    chat.messages.splice(kept)
    nativeChat.changed(chat)
  }
}
