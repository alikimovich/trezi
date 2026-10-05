import { writeFileSync } from 'node:fs'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { serviceEvents, views } from './platform'
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
  const send = (event: object) =>
    views.get('main')!.webContents.send('agent:event', { ...event, projectKey: state.chat })
  // Disable renderer event delivery: Swift input, streaming and queues must
  // continue through Bun without the web UI participating.
  const priorError = nativeWorkspace.state.error
  const originalInvoke = nativeChat.services.invoke
  const sent: unknown[][] = []
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'agent:send') {
      sent.push(args)
      return
    }
    return originalInvoke(channel, ...args)
  }
  try {
    const before = await host.request('layoutInspect')
    if (!before.native) throw new Error('Native layout unavailable')
    for (const delta of [-20, 20]) {
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
    if (sent.length !== 1) throw new Error('Native Send did not reach Bun service')
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
    if (
      queue.queueCount !== 1 ||
      queue.queueHeight !== 34 ||
      queue.queueInset !== 14 ||
      Math.abs(queue.queueOverlap - 16) > 1
    )
      throw new Error('Composer queue stack geometry incorrect')
    if ((await host.request('chatInspect')).cards.some((id: string) => id.startsWith('queued-')))
      throw new Error('Queue duplicated in conversation')
    writeFileSync(
      screenshot.replace('.png', '-queue-stack.png'),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
    const id = queue.queue[0].id
    await host.request('chatPerform', { action: 'queue-remove', card: id })
    for (let i = 0; i < 100 && (await host.request('composerInspect')).queueCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    if ((await host.request('composerInspect')).queueCount)
      throw new Error('Removed queue row remained visible')
    if (sent.length !== 1) throw new Error('Queued message bypassed the active turn')
    send({
      type: 'delta',
      text: '# Native conversation\n\nThis response is **Swift-rendered** with [a link](https://example.com).\n\n```swift\nlet native = true\n```\n\n| Surface | Owner |\n| --- | --- |\n| Chat | SwiftUI |\n| Preview | WebKit |'
    })
    send({ type: 'status', text: 'Reading project files…' })
    send({ type: 'delta', text: '\n\nStreaming continued after tool activity.' })
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
    send({ type: 'permission-resolved', id: 'beam-wait' })
    await wait((state) => state.activityKind === 'writing')
    send({ type: 'done', landingPending: true })
    await wait((state) => state.activityKind === 'applying')
    if ((await host.request('composerInspect')).buttonBeam)
      throw new Error('Landing retained thinking beam')
    send({ type: 'landing-finished' })
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
  } finally {
    nativeChat.services.invoke = originalInvoke
  }
  console.log(
    'Swift/Bun chat without an application WebView: Send, queue, streamed Markdown, permissions and questions passed.'
  )
}
