import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (id, role, text) => ({
  id,
  role,
  text,
  segments: text ? [{ kind: 'text', text }] : []
})
const PROMPT = 'BLANK CHECK PROMPT'
const REPLY = 'STREAMING REPLY'
// Answers far taller than the rows a send inserts (a short prompt and an empty
// placeholder), so a lazy stack's estimate for the new rows is far too tall.
const history = (key) =>
  Array.from({ length: 24 }, (_, i) =>
    i % 2
      ? message(
          `${key}-${i}`,
          'assistant',
          Array.from(
            { length: 3 + (i % 5) },
            (_, p) =>
              `Paragraph ${p} of answer ${i}. ${'The transcript keeps a long explanation here. '.repeat(14 + ((i * 7) % 20))}`
          ).join('\n\n')
        )
      : message(`${key}-${i}`, 'user', `Question ${i}`)
  )

/** LKM-139: after a send, while streaming and after completion, the transcript
 *  shows rows and its offset stays within the content, at the default and the
 *  narrowest width, with a fixed and a growing composer. Every sample is
 *  recorded (send-visibility.json) before any failure is reported. */
export async function checkSendVisibility(host, artifacts) {
  const samples = [],
    failures = []
  const inspect = () => host.request('chatInspect')
  const sample = async (condition, phase) => {
    const state = await inspect()
    const entry = {
      condition,
      phase,
      visibleRows: state.visibleMessageIDs?.length ?? 0,
      realizedRows: state.realizedRows,
      latestSettleAttempts: state.latestSettleAttempts,
      ...state.scroll,
      tailFrames: state.tailFrames,
      composerInset: state.composerInset,
      height: state.height
    }
    samples.push(entry)
    if (!(entry.visibleRows > 0)) failures.push(`${condition} ${phase}: no visible transcript rows`)
    if (!(entry.offset <= entry.maxOffset + 1))
      failures.push(`${condition} ${phase}: offset ${entry.offset} exceeds max ${entry.maxOffset}`)
    return entry
  }
  const settle = async (id, condition, phase) => {
    for (let i = 0; i < 40; i++) {
      if ((await inspect()).visibleMessageIDs?.includes(id)) return
      await delay(50)
    }
    failures.push(`${condition} ${phase}: latest row ${id} never settled into view`)
  }
  const capture = async (name, marker) => {
    const { image, ...geometry } = await host.request('chatAcceptance', { capture: true })
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.png, 'base64'))
    const state = await inspect()
    writeFileSync(
      join(artifacts, `${name}.json`),
      JSON.stringify(
        {
          scroll: state.scroll,
          visibleMessageIDs: state.visibleMessageIDs,
          latestVisible: geometry.latestVisible,
          text: image.text,
          pixels: [image.width, image.height]
        },
        null,
        2
      )
    )
    if (!image.text.join(' ').toUpperCase().includes(marker))
      failures.push(`${name}: capture does not show "${marker}"`)
  }
  try {
    for (const width of [440, 320])
      for (const composer of ['fixed', 'growing']) {
        const condition = `${width}-${composer}`
        host.send('layoutWidth', { width })
        await delay(200)
        const state = {
          chat: `send-${condition}`,
          messages: history(condition),
          cards: [],
          questions: [],
          running: false,
          status: '↑ 46k ↓ 186',
          composer: { enabled: true, text: '', revision: 1 }
        }
        const send = () => host.send('chatState', { state })
        send()
        await settle(state.messages.at(-1).id, condition, 'load')
        // Foreground for the captures (the chat is shown by the first chatState).
        if (condition === '440-fixed') await host.request('chatAcceptance', { prepare: true })
        await delay(300)
        const loaded = await sample(condition, 'loaded')
        if (composer === 'growing')
          for (const lines of [3, 8, 14]) {
            state.composer = {
              enabled: true,
              text: 'Please also check this.\n'.repeat(lines),
              revision: state.composer.revision + 1
            }
            send()
            await delay(80)
          }
        // One update, as ChatController.run sends it: prompt, empty placeholder,
        // running, and the composer cleared.
        const reply = `reply-${condition}`
        state.messages.push(
          message(`prompt-${condition}`, 'user', PROMPT),
          message(reply, 'assistant', '')
        )
        Object.assign(state, {
          running: true,
          streamingId: reply,
          activity: { kind: 'thinking', label: 'Thinking…', animated: true }
        })
        state.composer = {
          enabled: true,
          text: '',
          thinking: true,
          stop: true,
          revision: state.composer.revision + 1
        }
        send()
        for (const wait of [60, 200, 500]) {
          await delay(wait)
          await sample(condition, `sent+${wait}`)
        }
        if (condition === '440-fixed') await capture('send-after-send', PROMPT)
        state.activity = { kind: 'writing', label: 'Writing…', animated: true }
        for (let chunk = 1; chunk <= 12; chunk++) {
          const text = `${REPLY}. ${'The answer stays visible while it streams. '.repeat(chunk)}`
          state.messages[state.messages.length - 1] = message(reply, 'assistant', text)
          if (composer === 'growing' && chunk === 6) {
            state.composer = {
              enabled: true,
              text: 'Next request typed while streaming.\n'.repeat(7),
              revision: state.composer.revision + 1
            }
          }
          send()
          await delay(40)
          if (chunk % 3 === 0) await sample(condition, `stream-${chunk}`)
          if (chunk === 6 && condition === '440-fixed') await capture('send-mid-stream', REPLY)
        }
        Object.assign(state, { running: false, activity: null, streamingId: null })
        Object.assign(state.messages[state.messages.length - 1], {
          workedMs: 42000,
          at: Date.now()
        })
        Object.assign(state.composer, {
          thinking: false,
          stop: false,
          revision: state.composer.revision + 1
        })
        send()
        for (const wait of [60, 400]) {
          await delay(wait)
          await sample(condition, `done+${wait}`)
        }
        await settle(reply, condition, 'done')
        const done = await sample(condition, 'done-settled')
        // Keep-latest (LKM-103): the reply sits above the composer.
        if (!done.tailFrames?.length) failures.push(`${condition}: no tail frames`)
        // The transcript keeps its scroll view and document across the turn.
        for (const entry of samples.filter((entry) => entry.condition === condition))
          if (entry.documentID !== loaded.documentID || entry.scrollID !== loaded.scrollID)
            failures.push(
              `${condition} ${entry.phase}: transcript scroll view or document replaced`
            )
      }
  } finally {
    writeFileSync(
      join(artifacts, 'send-visibility.json'),
      JSON.stringify({ failures, samples }, null, 2)
    )
    host.send('layoutWidth', { width: 440 })
    await delay(200)
  }
  assert.deepEqual(
    failures,
    [],
    `LKM-139 send visibility (see ${join(artifacts, 'send-visibility.json')})`
  )
  const worst = Math.max(...samples.map((entry) => entry.offset - entry.maxOffset))
  console.log(
    `SEND VISIBILITY PASS — ${samples.length} samples at 440/320pt with a fixed and a growing composer: rows visible after send, mid-stream and after completion; offset - maxOffset ≤ ${worst.toFixed(1)}pt; same scroll document throughout.`
  )
}
