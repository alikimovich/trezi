import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkChatAcceptance } from './chat-acceptance.mjs'
import { checkSendVisibility } from './chat-send-visibility.mjs'
import { spawnHostBridge } from './host-bridge.mjs'

const directory = resolve('out/native')
const executable = `${directory}/Trezi.app/Contents/MacOS/TreziHost`
if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-SCROLL SKIP — macOS native host required.')
  process.exit(0)
}
if (!existsSync(executable)) {
  // `bun run test:native` builds first, so a missing host there is a failure,
  // not a silent SKIP that would hide the reveal/overlap coverage.
  if (process.argv.includes('--require-build')) {
    console.error(`NATIVE-CHAT-SCROLL FAIL — native host missing after build: ${executable}`)
    process.exit(1)
  }
  console.log('NATIVE-CHAT-SCROLL SKIP — build the macOS native host first.')
  process.exit(0)
}
const artifacts = resolve('test/artifacts/native/chat-scroll')
mkdirSync(artifacts, { recursive: true })
const host = spawnHostBridge(executable, directory, 'ephemeral')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// NSStringFromRect: "{{x, y}, {width, height}}"
const rect = (value) => {
  const [x, y, width, height] = (String(value).match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)
  assert([x, y, width, height].every(Number.isFinite), `Unparseable rect: ${value}`)
  return { x, y, width, height }
}
const message = (id, role, text) => ({ id, role, text, segments: [{ kind: 'text', text }] })
let stage = 'startup'
const capture = async (name) =>
  writeFileSync(
    `${artifacts}/${name}.png`,
    Buffer.from(await host.request('captureShell'), 'base64')
  )
const visible = async (id) => {
  let state
  for (let i = 0; i < 40; i++) {
    state = await host.request('chatInspect')
    if (state.visibleMessageIDs?.includes(id)) return state
    await delay(50)
  }
  await capture(`failure-${stage}`)
  assert.fail(`${stage}: ${id} missing from visible messages: ${JSON.stringify(state)}`)
}
try {
  await Promise.race([
    once(host, 'ready'),
    delay(10000).then(() => {
      throw Error('Native host did not become ready')
    })
  ])
  host.send('shellState', {
    state: {
      project: '/tmp/trezi-chat-scroll-fixture',
      chatReady: true,
      chatWidth: 440,
      rows: [],
      homeState: { visible: false }
    }
  })
  stage = 'send-visibility'
  await checkSendVisibility(host, artifacts)
  for (const history of [0, 1, 8, 45]) {
    const state = {
      chat: `history-${history}`,
      messages: Array.from({ length: history }, (_, i) =>
        message(
          `old-${i}`,
          i % 2 ? 'assistant' : 'user',
          `Message ${i}\n\n${'A paragraph about the project. '.repeat(3 + (i % 7))}`
        )
      ),
      cards: [],
      questions: [],
      running: false,
      status: '↑ 46k ↓ 186',
      composer: { enabled: true, text: '', revision: 1 }
    }
    if (history === 1)
      state.messages[0] = message(
        'old-0',
        'user',
        Array.from({ length: 100 }, (_, i) => `Build log line ${i}: checking the project.`).join(
          '\n'
        )
      )
    const send = () => host.send('chatState', { state })
    send()
    await delay(200)
    for (const lines of [1, 8, 80]) {
      stage = `history-${history}-draft-${lines}`
      state.composer = {
        enabled: true,
        text: 'Explain this change.\n'.repeat(lines),
        revision: lines * 2
      }
      send()
      await delay(150)
      const id = `question-${history}-${lines}`
      state.messages.push(message(id, 'user', 'Explain this change.'))
      state.running = true
      state.streamingId = `answer-${history}-${lines}`
      state.activity = { kind: 'thinking', label: 'Thinking…', animated: true }
      state.composer = {
        enabled: true,
        text: '',
        thinking: true,
        stop: true,
        revision: lines * 2 + 1
      }
      send()
      await delay(80)
      await visible(id)
      if (history === 8 && lines === 8) await capture('sending')
      // Replace the standalone thinking row with a growing streamed response.
      state.messages.push(message(state.streamingId, 'assistant', ''))
      state.activity = { kind: 'writing', label: 'Writing…', animated: true }
      for (let chunk = 1; chunk <= 15; chunk++) {
        state.messages[state.messages.length - 1] = message(
          state.streamingId,
          'assistant',
          'The answer remains visible while it streams. '.repeat(chunk)
        )
        send()
        await delay(20)
      }
      await visible(state.streamingId)
      state.messages[state.messages.length - 1].workedMs = 104000
      state.messages[state.messages.length - 1].at = Date.now()
      state.running = false
      state.activity = null
      state.composer.thinking = false
      state.composer.stop = false
      send()
      await visible(state.streamingId)
      assert.equal(
        (await host.request('chatInspect')).height,
        (await host.request('layoutInspect')).canvasHeight
      )
    }
  }
  await capture('streamed')
  // Source-value refreshes must not request follow-to-bottom, even if the last
  // scroll event was missed. A new island definition remains conversation content.
  const island = {
    id: 'controls',
    revision: 1,
    title: 'Radius',
    engine: 'agent',
    status: 'ready',
    detail: '',
    sourceRevision: 'a',
    replay: false,
    blocks: [{ id: 'geometry', title: 'Geometry', kind: 'group', params: ['radius'] }],
    fields: [
      { id: 'radius', label: 'Radius', kind: 'number', value: 32, min: 1, max: 100, step: 1 }
    ]
  }
  const controls = message('panel', 'assistant', 'Tune the radius.')
  controls.segments.push({ kind: 'island', island })
  // History on both sides: each reveal edge must be reachable (not clamped at a
  // scroll end), and following to the bottom leaves the island's lazy row
  // unrealized, so the first reveal has to scroll that row in before its anchor.
  const filler = (prefix, text) =>
    Array.from({ length: 20 }, (_, i) => message(`${prefix}-${i}`, 'assistant', text.repeat(20)))
  const state = {
    chat: 'controls-refresh',
    messages: [
      ...filler('earlier', 'Text before the controls. '),
      controls,
      ...filler('later', 'Text after the controls. ')
    ],
    cards: [],
    questions: [],
    running: false,
    status: '',
    composer: { enabled: true, text: '', revision: 1 }
  }
  host.send('chatState', { state })
  await delay(250)
  const before = await host.request('chatInspect')
  for (const value of [40, 60, 80, 32]) {
    island.fields[0].value = value
    island.sourceRevision = String(value)
    host.send('chatState', { state })
    await delay(60)
    assert.equal(
      (await host.request('chatInspect')).followRevision,
      before.followRevision,
      'Control values must not request auto-follow'
    )
  }
  island.revision++
  host.send('chatState', { state })
  await delay(100)
  assert(
    (await host.request('chatInspect')).followRevision > before.followRevision,
    'New definitions can follow with conversation content'
  )
  // Reveal IDs live inside a message row rather than as direct LazyVStack
  // children. Completion must wait for the nested anchor's post-scroll geometry.
  // Run at the default and the narrowest chat width (WorkspaceLayout clamps to
  // 320), where the island reflows taller.
  const edge = (bottom) => (bottom ? 'bottom' : 'top')
  const settled = async (reveal, bottom, label) => {
    const layout = await host.request('chatInspect')
    assert.equal(
      layout.revealAppliedRevision,
      reveal.revision,
      `${label}: SwiftUI applied the acknowledged revision`
    )
    assert(layout.revealAttempt >= 1, `${label}: reveal reports at least one layout-aware attempt`)
    const frame = rect(reveal.position),
      reading = layout.height - layout.composerInset
    const offset = bottom ? frame.y + frame.height - reading : frame.y
    assert(
      Math.abs(offset) <= 8,
      `${label}: acknowledged ${edge(bottom)} anchor ${reveal.position} is ${offset}pt from the reading edge (${reading})`
    )
    return {
      revision: reveal.revision,
      position: reveal.position,
      readingHeight: reading,
      offset,
      attempts: layout.revealAttempt
    }
  }
  for (const width of [440, 320]) {
    stage = `reveal-${width}`
    host.send('layoutWidth', { width })
    await delay(250)
    const chatFrame = rect((await host.request('chatInspect')).frame)
    assert.equal(chatFrame.width, width, `Chat column is ${width}pt wide for reveal checks`)
    // Evidence only: whether the island's lazy row had published frames before
    // the first reveal (SwiftUI decides row retention, so this is not asserted).
    const realizedBefore = Object.keys(
      (await host.request('chatInspect')).islandPositions ?? {}
    ).filter((key) => key.endsWith(`-${island.id}`))
    const record = { width, chatFrame, realizedBefore, edges: {}, overlaps: [] }
    for (const bottom of [false, true]) {
      const reveal = await host.request('revealChatIsland', { island: island.id, bottom })
      record.edges[edge(bottom)] = await settled(
        reveal,
        bottom,
        `${width}pt nested island ${edge(bottom)} reveal`
      )
      await capture(`reveal-${width}-${edge(bottom)}`)
    }
    // Overlapping requests, sent in one tick: the older one is superseded (an
    // error naming the newest revision), never acknowledged with the newer
    // revision's applied state; only the newest settles against its own anchor.
    // Opposite edges both ways, plus a same-edge pair whose stale anchor
    // already sits at the requested edge.
    for (const [first, second] of [
      [false, true],
      [true, false],
      [false, false]
    ]) {
      const label = `${width}pt overlap ${edge(first)}→${edge(second)}`
      const stale = host.request('revealChatIsland', { island: island.id, bottom: first }).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      const newest = await host.request('revealChatIsland', { island: island.id, bottom: second })
      const superseded = await stale
      const match = /Island reveal superseded; revision=(\d+), newer=(\d+)/.exec(
        superseded.error?.message ?? ''
      )
      assert(
        match,
        `${label}: older reveal must be rejected as superseded, got ${JSON.stringify(superseded.value ?? superseded.error?.message)}`
      )
      assert.equal(
        Number(match[1]),
        newest.revision - 1,
        `${label}: the rejected request is the older revision`
      )
      assert.equal(
        Number(match[2]),
        newest.revision,
        `${label}: rejection names the newest revision`
      )
      record.overlaps.push({
        first: edge(first),
        second: edge(second),
        superseded: superseded.error.message,
        newest: await settled(newest, second, `${label} newest`)
      })
      await capture(`reveal-${width}-overlap-${edge(first)}-${edge(second)}`)
    }
    writeFileSync(`${artifacts}/reveal-${width}.json`, JSON.stringify(record, null, 2))
  }

  // LKM-147 (on the LKM-145 layout): during a long tool run there is exactly one
  // status line, its step timer ticks locally, and the running counter sits on its
  // own line under it and grows with each snapshot. "No activity" shows only when
  // the turn's heartbeats stopped. Once done the counter is gone and the footer
  // keeps its height, so completion moves nothing. LKM-145: Copy/Revert stay laid
  // out but only show on hover (or keyboard focus); the hover is the in-app
  // override, so the real cursor position cannot leak into the captures.
  // Foreground captures at the default and the narrowest width.
  for (const width of [440, 320]) {
    stage = `progress-${width}`
    const foreground = async (name, args = {}) => {
      const { image, ...state } = await host.request('chatAcceptance', {
        prepare: true,
        capture: true,
        ...args
      })
      writeFileSync(`${artifacts}/${name}.png`, Buffer.from(image.png, 'base64'))
      return state
    }
    const answer = message(
      'progress-answer',
      'assistant',
      'I tightened the radius; now running the tests. '.repeat(4)
    )
    const counter = (label) => ({
      label,
      detail: 'Tokens across this turn’s model calls, not current context size.'
    })
    const tool = {
      kind: 'working',
      label: 'Running bun test',
      animated: true,
      since: Date.now() - 84000,
      aliveAt: Date.now(),
      tokens: counter('↑ 3.9M  ↓ 66k')
    }
    const turn = {
      chat: `progress-${width}`,
      cards: [],
      questions: [],
      running: true,
      streamingId: answer.id,
      // Enough history to overflow, so the conversation is pinned to its end.
      messages: [
        ...Array.from({ length: 16 }, (_, i) =>
          message(
            `progress-old-${i}`,
            i % 2 ? 'assistant' : 'user',
            `Earlier message ${i}. ${'Some project history. '.repeat(10)}`
          )
        ),
        message('progress-question', 'user', 'Tighten the button radius.'),
        answer
      ],
      activity: tool,
      composer: { enabled: true, text: '', thinking: true, stop: true, revision: 1 }
    }
    const footer = async (label, ready, settled = () => true) => {
      let last
      for (let i = 0; i < 60; i++) {
        last = await host.request('chatInspect')
        const frames = last.footerFrames ?? {}
        if (
          frames[answer.id] &&
          last.messageFrames?.[answer.id] &&
          last.messageFrames?.['progress-question'] &&
          ready(last, frames)
        ) {
          const result = {
            footer: rect(frames[answer.id]),
            statusLines: last.statusLines,
            activityTokens: last.activityTokens,
            message: rect(last.messageFrames[answer.id]),
            question: rect(last.messageFrames['progress-question']),
            revealed: last.revealedActions ?? [],
            footers: Object.fromEntries(
              Object.entries(frames).map(([id, value]) => [id, rect(value)])
            ),
            ...(frames[`${answer.id}-tokens`]
              ? { tokens: rect(frames[`${answer.id}-tokens`]) }
              : {})
          }
          if (i > 2 && settled(result)) return result
        }
        await delay(50)
      }
      await capture(`failure-${stage}`)
      assert.fail(`${label}: ${JSON.stringify(last)}`)
    }
    const same = (a, b) =>
      ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 0.5)
    const runningFooter = (label, line, tokens = tool.tokens.label) =>
      footer(
        label,
        (state, frames) =>
          state.activity === tool.label &&
          state.activityTokens === tokens &&
          frames[`${answer.id}-tokens`] &&
          state.statusLines?.length === 1 &&
          line.test(state.statusLines[0])
      )
    host.send('chatState', { state: turn })
    await foreground(`progress-${width}-layout`, { width, hoverMessage: '' })
    const running = await runningFooter(
      `${width}pt long tool run`,
      /^Running bun test · 1:[2-5]\d$/
    )
    await foreground(`progress-running-${width}`)
    assert.equal(
      running.statusLines.length,
      1,
      `${width}pt: exactly one status line ${JSON.stringify(running)}`
    )
    assert(
      running.tokens.y >= running.footer.y + 28 - 0.5,
      `${width}pt: running counter is on its own line under the status ${JSON.stringify(running)}`
    )
    assert(
      Math.abs(running.tokens.x - running.footer.x) <= 1,
      `${width}pt: running counter is leading-aligned ${JSON.stringify(running)}`
    )
    assert(
      Math.abs(running.footer.height - 44) <= 0.5,
      `${width}pt: running footer is the status row plus the counter line ${JSON.stringify(running)}`
    )
    // LKM-149: history responses have no counter line, only the 28 pt Copy/Revert row.
    const history = Object.entries(running.footers).filter(([id]) => id.startsWith('progress-old-'))
    assert(
      history.length > 0 && history.every(([, frame]) => Math.abs(frame.height - 28) <= 0.5),
      `${width}pt: history footers are 28 pt ${JSON.stringify(running.footers)}`
    )
    // The timer ticks from the host's own clock: no new snapshot is sent.
    await delay(1200)
    const ticked = await runningFooter(
      `${width}pt timer ticks`,
      /^Running bun test · 1:[2-5]\d$/,
      tool.tokens.label
    )
    assert.notEqual(
      ticked.statusLines[0],
      running.statusLines[0],
      `${width}pt: the step timer ticks ${JSON.stringify({ running, ticked })}`
    )
    // Streamed usage deltas arrive as snapshots with a larger counter.
    tool.tokens = counter('↑ 3.9M  ↓ 68k')
    host.send('chatState', { state: turn })
    await runningFooter(
      `${width}pt counter grows`,
      /^Running bun test · 1:[2-5]\d$/,
      '↑ 3.9M  ↓ 68k'
    )
    // Heartbeats stopped three minutes ago: the hint joins the one status line.
    tool.aliveAt = Date.now() - 185000
    host.send('chatState', { state: turn })
    const idle = await runningFooter(
      `${width}pt idle hint`,
      /^Running bun test · 1:[2-5]\d · No activity for 3 min$/,
      '↑ 3.9M  ↓ 68k'
    )
    await foreground(`progress-idle-${width}`)
    tool.aliveAt = Date.now()
    host.send('chatState', { state: turn })
    const alive = await runningFooter(
      `${width}pt heartbeat clears the hint`,
      /^Running bun test · 1:[2-5]\d$/,
      '↑ 3.9M  ↓ 68k'
    )
    assert(
      Math.abs(alive.footer.height - running.footer.height) <= 0.5,
      `${width}pt: the idle hint does not change the footer ${JSON.stringify({ running, idle, alive })}`
    )
    Object.assign(turn, {
      running: false,
      activity: null,
      composer: { enabled: true, text: '', revision: 2 }
    })
    Object.assign(answer, { workedMs: 42000, at: Date.now(), revertGroup: 'progress-group' })
    host.send('chatState', { state: turn })
    const done = await footer(
      `${width}pt completed footer keeps its place`,
      (state, frames) =>
        state.activity === '' &&
        !frames[`${answer.id}-tokens`] &&
        state.statusLines?.length === 0 &&
        state.activityTokens === '',
      (result) =>
        Math.abs(
          result.footer.y + result.footer.height - (running.footer.y + running.footer.height)
        ) <= 1
    )
    await foreground(`progress-done-${width}`)
    assert.equal(done.tokens, undefined, `${width}pt: no counter once the turn ends`)
    // The footer's width follows its content (status label, then the buttons); its place and height must not move.
    const place = (frame) => ({ ...frame, width: 0 })
    assert(
      same(place(done.footer), place(running.footer)),
      `${width}pt: footer position and height unchanged on completion ${JSON.stringify({ running, done })}`
    )
    assert(
      same(done.message, running.message),
      `${width}pt: response frame unchanged on completion ${JSON.stringify({ running, done })}`
    )
    assert(
      same(done.question, running.question) && Math.abs(done.message.y - running.message.y) <= 0.5,
      `${width}pt: nothing above the counter line moves on completion ${JSON.stringify({ running, done })}`
    )
    assert(
      !done.revealed.includes(answer.id),
      `${width}pt: Copy/Revert hidden without hover ${JSON.stringify(done)}`
    )
    const hoverState = await host.request('chatAcceptance', {
      prepare: true,
      hoverMessage: answer.id
    })
    assert.equal(hoverState.hoverOverride, answer.id)
    const idleDone = (state, frames) =>
      state.activity === '' && !frames[`${answer.id}-tokens`] && state.statusLines?.length === 0
    const hovered = await footer(
      `${width}pt hovered message reveals Copy/Revert`,
      idleDone,
      (result) => result.revealed.includes(answer.id)
    )
    await foreground(`progress-hover-${width}`)
    assert(
      same(hovered.message, done.message) && same(hovered.footer, done.footer),
      `${width}pt: message frame identical with and without hover ${JSON.stringify({ done, hovered })}`
    )
    await host.request('chatAcceptance', { prepare: true, hoverMessage: '' })
    const unhovered = await footer(
      `${width}pt Copy/Revert hide again`,
      idleDone,
      (result) => !result.revealed.includes(answer.id)
    )
    assert(
      same(unhovered.message, done.message),
      `${width}pt: message frame unchanged after hover ends ${JSON.stringify({ done, unhovered })}`
    )
    writeFileSync(
      `${artifacts}/progress-${width}.json`,
      JSON.stringify({ width, running, ticked, idle, alive, done, hovered, unhovered }, null, 2)
    )
  }
  await host.request('chatAcceptance', { prepare: true, hoverMessage: null })

  await checkChatAcceptance(host, artifacts)

  console.log(
    'Native chat scroll: sent questions and streamed responses stay visible across short/long history and shrinking composers; nested island reveals settle at both edges and overlapping reveals reject the superseded request at 440pt and 320pt chat widths.'
  )
} finally {
  host.child.kill()
  await host.closed
}
