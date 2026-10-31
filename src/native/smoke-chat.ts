import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import { requestMergeApproval, takeMergeApproval } from '../main/merge-approval'
import type { AgentEvent } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { serviceEvents } from './platform'
import { preparePreviewInput } from './smoke-input'
import { checkProductLog } from './smoke-logs'
import { checkQueueGeometry, checkQueueInsertion, emptyQueueProblems } from './smoke-queue'
import { cleanSharedChat } from './smoke-shared-chat'
import { shimmers } from './smoke-sidebar-shimmer'
import { inspectUntil, waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/** Deterministic stream/card coverage without calling a paid provider. */
export async function checkNativeChat(host: NativeBridge, screenshot: string) {
  const wait = async (check: (state: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const state = await host.request('chatInspect')
      if (check(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Swift chat state did not update')
  }
  const state = await wait((state) => state.visible && state.chat)
  if (JSON.stringify(await host.request('webViews')) !== JSON.stringify(['preview']))
    throw new Error('Unexpected application WebView')
  // Disable renderer event delivery: Swift input, streaming and queues must
  // continue through Bun without the web UI participating.
  const priorError = nativeWorkspace.state.error
  const originalInvoke = nativeChat.services.invoke
  const sent: unknown[][] = []
  let turn = ''
  let noTerminalStop = false
  let reset: unknown
  // The actual agent:send RPC and its provider event hook own the log lines.
  // Only the provider's outbound send is stubbed; no paid provider call occurs.
  const provider = stubAgentSendForSmoke(state.chat, (...args) => {
    sent.push(args)
  })
  const send = (event: object) => provider.emit(event as AgentEvent)
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'agent:send') turn = String(args[4])
    if (noTerminalStop && channel === 'agent:interrupt') return undefined
    if (noTerminalStop && channel === 'agent:turn-state') return { turn, running: false }
    return originalInvoke(channel, ...args)
  }
  try {
    const before = await host.request('layoutInspect')
    if (!before.native) throw new Error('Native layout unavailable')
    // The chat width is clamped to 320...520: step away from the minimum first so a
    // narrow starting width still returns to where it began.
    for (const delta of before.width >= 340 ? [-20, 20] : [20, -20]) {
      await host.request('dividerPerform', { delta })
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    const after = await host.request('layoutInspect')
    if (Math.abs(before.width - after.width) > 1)
      throw new Error('Native divider needs renderer delivery')
    serviceEvents.emit('event', 'preview:element-picked', {
      tag: 'button',
      id: 'native-context',
      classes: [],
      selector: '#native-context',
      text: 'Native context',
      source: 'index.html:3:1'
    })
    if (!nativeChat.get(state.chat).context?.selection?.prompt.includes('#native-context'))
      throw new Error('Preview selection still depends on renderer delivery')
    await host.request('composerPerform', { text: 'Render this conversation in Swift.' })
    for (let i = 0; i < 100 && !(await host.request('composerInspect')).enabled; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    await host.request('composerPerform', { action: 'send' })
    await wait((state) =>
      state.messages.some(
        (message: any) =>
          message.role === 'user' && message.text === 'Render this conversation in Swift.'
      )
    )
    // The UI publishes the optimistic message before agent:send finishes its
    // worktree and conversation preparation. Wait for the provider seam itself.
    for (let i = 0; i < 200 && sent.length !== 1; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (sent.length !== 1) throw new Error('Native Send did not reach the provider stub')
    if (nativeChat.get(state.chat).context?.selection)
      throw new Error('Native Send did not clear selection context')
    if (nativeWorkspace.state.error !== priorError)
      throw new Error('Native context effect failed: ' + nativeWorkspace.state.error)
    await wait((state) => state.activity === 'Thinking…')
    writeFileSync(
      screenshot.replace('.png', '-thinking.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
    const runningCat = await wait((state) => state.catPose === 'run' && state.catArtwork)
    await wait((state) => state.catPose === 'run' && state.catFrame !== runningCat.catFrame)
    if (!(await host.request('composerInspect')).buttonBeam)
      throw new Error('Running Stop button has no beam')
    writeFileSync(
      screenshot.replace('.png', '-beam-stop.png'),
      Buffer.from(await host.request('captureComposer'), 'base64')
    )
    await host.request('composerPerform', { text: 'A queued native message' })
    // Allow the input action and its controlled state to cross the bridge.
    for (let i = 0; i < 100; i++) {
      if ((await host.request('composerInspect')).text === 'A queued native message') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (!(await host.request('composerInspect')).buttonBeam)
      throw new Error('Drafting a queued message stopped the beam')
    writeFileSync(
      screenshot.replace('.png', '-beam-queue.png'),
      Buffer.from(await host.request('captureComposer'), 'base64')
    )
    await host.request('composerPerform', { action: 'send' })
    let queue: any
    for (let i = 0; i < 100; i++) {
      queue = await host.request('composerInspect')
      if (queue.queueCount === 1) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // One row and no reason row: a running turn is the normal wait (LKM-191).
    if (queue.queueNote !== '') throw new Error('A running turn gave the queue a note')
    queue = await checkQueueGeometry(host, screenshot, '1', 1, false)
    if ((await host.request('chatInspect')).cards.some((id: string) => id.startsWith('queued-')))
      throw new Error('Queue duplicated in conversation')
    writeFileSync(
      screenshot.replace('.png', '-queue-stack.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
    // Edit takes the queued message back into the composer; sending queues it again.
    await host.request('chatPerform', { action: 'queue-edit', card: queue.queue[0].id })
    for (let i = 0; i < 100; i++) {
      const edited = await host.request('composerInspect')
      if (!edited.queueCount && edited.text === 'A queued native message') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const edited = await host.request('composerInspect')
    if (edited.queueCount || edited.text !== 'A queued native message')
      throw new Error('Editing a queued message did not return it to the composer')
    await host.request('composerPerform', { action: 'send' })
    for (let i = 0; i < 100; i++) {
      queue = await host.request('composerInspect')
      if (queue.queueCount === 1) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (queue.queueCount !== 1) throw new Error('An edited message was not queued again')
    // LKM-294: the second message slides in, the third only fades in under Reduce Motion.
    for (const [index, text] of ['A second queued message', 'A third queued message'].entries()) {
      await host.request('composerPerform', { text })
      await inspectUntil(
        (method) => host.request(method),
        'composerInspect',
        (value) => value.text === text
      )
      await checkQueueInsertion(host, screenshot, index === 1, () =>
        host.request('composerPerform', { action: 'send' })
      )
      if (index === 0) await checkQueueGeometry(host, screenshot, '2', 2, false)
    }
    queue = await checkQueueGeometry(host, screenshot, '3', 3, false)
    // LKM-302: the same three rows paused (as after Stop): pause glyph, Send now and divider.
    const pausing = nativeChat.get(state.chat)
    pausing.paused = true
    nativeChat.changed(pausing)
    await checkQueueGeometry(host, screenshot, 'paused', 3, true, true)
    pausing.paused = false
    nativeChat.changed(pausing)
    await checkQueueGeometry(host, screenshot, '3-resumed', 3, false)
    for (const { id } of queue.queue)
      await host.request('chatPerform', { action: 'queue-remove', card: id })
    for (let i = 0; i < 100 && (await host.request('composerInspect')).queueCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if ((await host.request('composerInspect')).queueCount)
      throw new Error('Removed queue row remained visible')
    const emptied = emptyQueueProblems(await host.request('composerInspect'))
    if (emptied.length) throw new Error(`Empty queue still shows its panel: ${emptied.join('; ')}`)
    if (sent.length !== 1) throw new Error('Queued message bypassed the active turn')
    send({
      type: 'delta',
      text: '# Native conversation\n\nThis response is **Swift-rendered** with [a link](https://example.com).\n\n```swift\nlet native = true\n```\n\n| Surface | Owner |\n| --- | --- |\n| Chat | SwiftUI |\n| Preview | WebKit |'
    })
    send({ type: 'status', text: 'Reading project files…' })
    send({ type: 'delta', text: '\n\nStreaming continued after tool activity.' })
    // The chat's nested sidebar row shimmers while the model works (it is the selected, active
    // chat), and only then: a wait for the user or the landing keeps it Running, without shimmer.
    const sidebarRow = async () =>
      (await host.request('shellInspect')).sidebarChats?.find(
        (row: any) => row.id === `chat:${state.chat}`
      )
    const runningRow = await waitFor(async () => {
      const row = await sidebarRow()
      return row?.running && row.thinking && shimmers(row) && row
    }, 'native sidebar running indicator')
    if (!runningRow.selected || !runningRow.label.endsWith(', Running'))
      throw new Error(
        `Sidebar running row is not the selected Running row: ${JSON.stringify(runningRow)}`
      )
    const runningWithoutShimmer = (what: string) =>
      waitFor(async () => {
        const row = await sidebarRow()
        return (
          row?.running &&
          !row.thinking &&
          row.shimmer.mode === 'none' &&
          row.label.endsWith(', Running')
        )
      }, `native sidebar row stops shimmering ${what}`)
    await wait((state) => state.activityKind === 'writing')
    writeFileSync(
      screenshot.replace('.png', '-streaming.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
    send({
      type: 'permission-request',
      request: { id: 'beam-wait', sessionKey: state.chat, title: 'Allow fixture?' }
    })
    await wait((state) => state.activityKind === 'waiting' && !state.activityAnimated)
    if ((await host.request('composerInspect')).buttonBeam)
      throw new Error('Permission wait retained thinking beam')
    await runningWithoutShimmer('while it waits for approval')
    send({ type: 'permission-resolved', id: 'beam-wait' })
    await wait((state) => state.activityKind === 'writing')
    await waitFor(async () => {
      const row = await sidebarRow()
      return row?.thinking && shimmers(row)
    }, 'native sidebar row shimmers again after the approval')
    // The provider's `done` runs the real landing, which has nothing to land here and ends by
    // itself, often before a poll sees the row (LKM-392). So the landing is held on the
    // controller alone for these checks, and only the real `done` below can end it.
    nativeChat.event({ type: 'done', projectKey: state.chat, landingPending: true })
    await wait((state) => state.activityKind === 'applying')
    if ((await host.request('composerInspect')).buttonBeam)
      throw new Error('Landing retained thinking beam')
    await runningWithoutShimmer('while it lands')
    send({ type: 'done', landingPending: true })
    let lastRow: any
    await waitFor(async () => {
      lastRow = await sidebarRow()
      return (
        lastRow &&
        !lastRow.running &&
        lastRow.shimmer.mode === 'none' &&
        lastRow.label === lastRow.title
      )
    }, 'native sidebar idle indicator').catch((error) => {
      throw new Error(`${error.message} (last row: ${JSON.stringify(lastRow)})`)
    })
    await wait((state) => !state.activity)
    await wait((state) =>
      state.messages.some((message: any) =>
        message.text.includes('Streaming continued after tool activity.')
      )
    )
    if ((await host.request('composerInspect')).buttonBeam)
      throw new Error('Completed turn retained its beam')
    send({
      type: 'permission-request',
      request: {
        id: 'native-permission',
        sessionKey: state.chat,
        title: 'Allow fixture command?',
        detail: 'Read the test project'
      }
    })
    await wait((state) => state.cards.includes('native-permission'))
    await host.request('chatPerform', {
      action: 'permission',
      card: 'native-permission',
      value: 'deny'
    })
    await wait((state) => !state.cards.includes('native-permission'))
    send({
      type: 'question-request',
      request: {
        id: 'native-question',
        sessionKey: state.chat,
        questions: [
          {
            header: 'Layout',
            question: 'Which layout?',
            options: [{ label: 'Compact', description: 'Less spacing' }, { label: 'Roomy' }],
            multiSelect: false
          }
        ]
      }
    })
    await wait((state) => state.questionCount === 1 && state.catPose === 'think')
    writeFileSync(screenshot, Buffer.from(await host.request('captureShell'), 'base64'))
    await host.request('chatPerform', {
      action: 'question',
      card: 'native-question',
      answers: { 'Which layout?': 'Compact' }
    })
    await wait((state) => state.questionCount === 0)
    // A stale reply from another chat must never resolve this chat's request.
    send({
      type: 'permission-request',
      request: {
        id: 'other-chat-permission',
        sessionKey: 'other-chat',
        title: 'Background permission'
      }
    })
    await wait((state) => !state.cards.includes('other-chat-permission'))
    send({ type: 'permission-resolved', id: 'other-chat-permission' })
    await checkProductLog(state.chat, turn)
    // LKM-169: a drift park is visible together with the waiting queue, at both
    // supported chat widths. The provider send is stubbed above.
    send({ type: 'isolation', state: 'parked', files: ['src/native/fixture.ts'] })
    await wait((current) => current.cards.includes('conflict'))
    const parkedText = 'Send this after Resolve'
    await host.request('composerPerform', { text: parkedText })
    await inspectUntil(
      (method) => host.request(method),
      'composerInspect',
      (value) => value.text === parkedText
    )
    await host.request('composerPerform', { action: 'send' })
    const captureResolve = async (width: number) => {
      const current = await wait((value) => value.cards.includes('conflict'))
      const composer = await inspectUntil(
        (method) => host.request(method),
        'composerInspect',
        (value) => value.queueCount === 1 && value.queueNote.startsWith('Waiting for Resolve')
      )
      const card = current.cardStates.find((value: any) => value.id === 'conflict')
      const layout = await host.request('layoutInspect')
      if (Math.abs(layout.width - width) > 1)
        throw new Error(`Resolve chat width: ${layout.width}, wanted ${width}`)
      if (
        composer.queueCount !== 1 ||
        composer.queue[0].text !== parkedText ||
        !composer.queueNote.startsWith('Waiting for Resolve')
      )
        throw new Error(`Resolve queue is not visibly waiting: ${JSON.stringify(composer)}`)
      await checkQueueGeometry(
        host,
        screenshot,
        `note-${width}`,
        1,
        true,
        composer.queuePaused === true
      )
      if (
        !card?.detail?.includes('project changed under them') ||
        !card.detail.includes('src/native/fixture.ts') ||
        !card.actions.includes('Resolve')
      )
        throw new Error(`Resolve card lacks reason or action: ${JSON.stringify(card)}`)
      if (
        current.messages.some(
          (message: any) =>
            message.text.includes(parkedText) ||
            message.text.includes('Unable to send') ||
            message.text.includes('Worked for 0s')
        )
      )
        throw new Error('Parked message duplicated or refused in the transcript')
      if (sent.length !== 1) throw new Error('Parked message reached the provider')
      await preparePreviewInput(host, true)
      const capture = await host.request('captureVisibleShell')
      const path = screenshot.replace('.png', `-resolve-${width}.png`)
      writeFileSync(path, Buffer.from(capture.png, 'base64'))
      writeFileSync(
        screenshot.replace('.png', `-resolve-${width}.json`),
        JSON.stringify(
          {
            path,
            width: layout.width,
            queue: composer.queue,
            queueNote: composer.queueNote,
            card,
            transcript: current.messages
          },
          null,
          2
        )
      )
    }
    await captureResolve(440)
    await host.request('dividerPerform', { delta: -120 })
    try {
      await captureResolve(320)
    } finally {
      await host.request('dividerPerform', { delta: 120 })
    }
    send({
      type: 'isolation',
      state: 'merged',
      files: ['src/native/fixture.ts'],
      group: 'native-resolve'
    })
    await waitFor(() => sent.slice().length === 2, 'queued Resolve message sent')
    // agent:send prepends Trezi instructions; the submitted text remains the suffix.
    if (
      sent.slice().length !== 2 ||
      typeof sent[1][0] !== 'string' ||
      !sent[1][0].endsWith(parkedText)
    )
      throw new Error('Queued Resolve message did not send exactly once after the park cleared')
    send({ type: 'done' })
    await wait((current) => !current.activity)
    // LKM-281: the host-authored merge approval card, as the user sees it, and the denial
    // path. It runs last because answering sends the user's next message to the stubbed
    // provider, which the counts above would otherwise have to expect.
    const mergeRoot = '/fixture/merge-approval'
    const mergeTarget = {
      repo: 'github.com/fixture/app',
      number: 7,
      head: '0123456789abcdef0123456789abcdef01234567'
    }
    const mergeId = requestMergeApproval(state.chat, mergeRoot, mergeTarget, (_channel, payload) =>
      send(payload as object)
    )
    await wait((current) => current.questionCount === 1)
    const shown = nativeChat.get(state.chat).questions.find((item) => item.id === mergeId)
    const asked = shown?.questions[0]
    const mergeQuestion = `Merge pull request #7 in github.com/fixture/app at commit ${mergeTarget.head.slice(0, 12)}?`
    if (
      shown?.questions.length !== 1 ||
      asked?.header !== 'Merge PR' ||
      asked.question !== mergeQuestion ||
      JSON.stringify(asked.options.map((option) => option.label)) !==
        JSON.stringify(['Merge', "Don't merge"])
    )
      throw new Error(`Merge approval card is not the host's: ${JSON.stringify(shown)}`)
    const mergeShots: Record<string, string> = {}
    const captureMerge = async (name: string, width: number) => {
      const layout = await host.request('layoutInspect')
      if (Math.abs(layout.width - width) > 1)
        throw new Error(`Merge approval chat width: ${layout.width}, wanted ${width}`)
      await wait((current) => current.questionCount === 1)
      await preparePreviewInput(host, true)
      const capture = await host.request('captureVisibleShell')
      const path = join(dirname(screenshot), name)
      writeFileSync(path, Buffer.from(capture.png, 'base64'))
      mergeShots[String(width)] = path
    }
    await captureMerge('agent-merge-approval.png', 440)
    await host.request('dividerPerform', { delta: -120 })
    try {
      await captureMerge('agent-merge-approval-320.png', 320)
    } finally {
      await host.request('dividerPerform', { delta: 120 })
    }
    await host.request('chatPerform', {
      action: 'question',
      card: mergeId,
      answers: { [mergeQuestion]: "Don't merge" }
    })
    await wait((current) => current.questionCount === 0)
    const declined = takeMergeApproval(state.chat, mergeRoot, mergeTarget)
    if (declined !== 'none') throw new Error(`Declining a merge left an approval: ${declined}`)
    await waitFor(
      () => sent.slice().length === 3,
      'declined merge reached the provider as a message'
    )
    const declinedText = 'Do not merge pull request #7 in github.com/fixture/app. Leave it open.'
    if (typeof sent[2][0] !== 'string' || !sent[2][0].endsWith(declinedText))
      throw new Error('The declined merge was not reported to the agent as a refusal')
    writeFileSync(
      join(dirname(screenshot), 'agent-merge-approval.json'),
      JSON.stringify(
        {
          captures: mergeShots,
          shown: { id: mergeId, ...asked },
          target: mergeTarget,
          answered: "Don't merge",
          afterDecline: { questionCount: 0, approval: declined, agentMessage: declinedText }
        },
        null,
        2
      )
    )
    send({ type: 'done' })
    await wait((current) => !current.activity)
    // A provider that acknowledges Stop without a terminal must still clear
    // Stopping, while the user's next message and draft remain in the composer.
    await host.request('composerPerform', { text: 'Stop fixture turn' })
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.slice().length === 4, 'stop fixture reached the provider')
    await host.request('composerPerform', { text: 'Keep queued message' })
    await host.request('composerPerform', { action: 'send' })
    await host.request('composerPerform', { text: 'Keep draft' })
    noTerminalStop = true
    await host.request('chatPerform', { action: 'stop' })
    await wait((current) => !current.activity)
    const stopped = await host.request('composerInspect')
    if (!stopped.queuePaused || stopped.queueCount !== 1 || stopped.text !== 'Keep draft')
      throw new Error(`Stop lost the paused queue or draft: ${JSON.stringify(stopped)}`)
    if (sent.slice().length !== 4) throw new Error('Stop sent a queued message automatically')
    writeFileSync(
      join(dirname(screenshot), 'chat-stop-queue.png'),
      Buffer.from((await host.request('captureVisibleShell')).png, 'base64')
    )
    writeFileSync(
      join(dirname(screenshot), 'chat-stop-queue.json'),
      JSON.stringify(
        { queuePaused: stopped.queuePaused, queue: stopped.queue, draft: stopped.text },
        null,
        2
      )
    )
  } finally {
    noTerminalStop = false
    // LKM-376: the Stop check above leaves its paused queue and draft for the capture; the
    // next check sends on this same chat. Reset it, pass or fail, while the stubs still
    // catch any send. A reset failure fails only a check that otherwise passed (below).
    // LKM-377: the no-terminal Stop left the backend turn running (only the override said
    // otherwise). End it with the provider's untagged `done`, as the sends above do: a
    // turn-tagged `done` is stale to the turn tracker and ends nothing. Then wait for the
    // real agent:turn-state and the controller to be idle before the stubs go.
    reset = await cleanSharedChat(
      host,
      {
        state: () => originalInvoke('agent:turn-state', state.chat),
        controller: () => nativeChat.get(state.chat)
      },
      () => send({ type: 'done' })
    )
    nativeChat.services.invoke = originalInvoke
    // If preparation failed before send, retain the stub until this test process
    // exits: a late agent:send must never escape to a real provider subscription.
    if (sent.length) provider.restore()
  }
  if (reset) throw reset
  console.log(
    'Swift/Bun chat without an application WebView: Send, queue, streamed Markdown, permissions and questions passed.'
  )
}
