import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { sendPathStages, summarizeSendPath } from './send-path-timing'

/** LKM-304: the real composer edits its draft after Return and before the cleared snapshot
 *  arrives, each sequence in one main-thread turn. The sent draft must not come back, text
 *  typed after it stays, and nothing is sent twice or stopped. Provider calls are stubbed. */
export async function checkComposerSend(host: NativeBridge) {
  const chat = nativeChat.get(nativeChat.active)
  const invoke = nativeChat.services.invoke
  const calls: { channel: string; args: any[] }[] = []
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'agent:send' || channel === 'agent:interrupt') {
      calls.push({ channel, args })
      return { ok: true }
    }
    return invoke(channel, ...args)
  }
  const sends = () => calls.filter((c) => c.channel === 'agent:send').map((c) => c.args[0])
  const inspect = () => host.request('composerInspect')
  const wait = async (check: () => Promise<boolean> | boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Composer send: timed out waiting for ${what}`)
  }
  const finish = async () => {
    nativeChat.event({ type: 'done', projectKey: chat.chat, landingPending: false })
    await wait(() => !chat.isRunning, 'the turn to finish')
  }
  try {
    // A turn left running by an earlier check queues the Return below instead of sending it.
    assert.ok(!chat.isRunning, 'Composer send starts with no turn running')
    // Keep the provider pending while the real Swift composer and toolbar cross the
    // host/service/Bun bridge. A blocked bridge delays both the optimistic row and Code.
    if ((await host.request('sourceInspect')).visible) {
      assert.equal(await host.request('shellPerform', { action: 'code' }), true)
      await wait(async () => !(await host.request('sourceInspect')).visible, 'Code to close')
    }
    await host.request('composerPerform', { text: 'Send latency probe' })
    await wait(async () => (await inspect()).enabled === true, 'latency probe enabled')
    const logSince = Date.now()
    const sentAt = performance.now()
    await host.request('composerPerform', { action: 'send' })
    let rowAt = 0
    while (performance.now() - sentAt < 300) {
      const state = await host.request('chatInspect')
      if (
        state.messages.some(
          (message: { role: string; text: string }) =>
            message.role === 'user' && message.text === 'Send latency probe'
        )
      ) {
        rowAt = performance.now()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const codeAt = performance.now()
    const clicked = await host.request('shellPerform', { action: 'code' })
    let openedAt = 0
    while (performance.now() - codeAt < 500) {
      if ((await host.request('sourceInspect')).visible) {
        openedAt = performance.now()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    console.log(
      `SEND PATH rowMs=${rowAt ? Math.round(rowAt - sentAt) : 'timeout'} codeMs=${openedAt ? Math.round(openedAt - codeAt) : 'timeout'} running=${chat.isRunning}`
    )
    if (process.env.TREZI_LOG_DIR) {
      const day = new Date().toISOString().slice(0, 10)
      try {
        const log = readFileSync(join(process.env.TREZI_LOG_DIR, `trezi-${day}.log`), 'utf8')
        console.log(`SEND HOPS ${summarizeSendPath(sendPathStages(log), logSince)}`)
      } catch {
        console.log('SEND HOPS product log unavailable')
      }
    }
    assert.ok(rowAt && rowAt - sentAt <= 300, 'user row visible within 300 ms of Send')
    assert.equal(clicked, true, 'Code toolbar click accepted while provider pending')
    assert.ok(openedAt && openedAt - codeAt <= 500, 'Code visible within 500 ms of click')
    assert.equal(chat.isRunning, true, 'provider still pending when Code opens')
    await host.request('shellPerform', { action: 'code' })
    await finish()
    // Return, then AppKit's smart quote curls the sent apostrophe (the user's report).
    await host.request('composerPerform', {
      steps: [{ text: "Don't stop" }, { key: 'Enter' }, { substitute: ["'", '’'] }]
    })
    await wait(async () => chat.isRunning && (await inspect()).text === '', 'the cleared draft')
    // One more round trip: a late stale input would have restored it by now.
    assert.equal((await inspect()).text, '', 'the smart-quoted sent draft stays cleared')
    assert.equal(chat.text, '', 'the controller has no draft')
    assert.equal(sends().length, 1, 'sent once')
    assert.ok(sends()[0].includes("Don't stop"), 'the submitted text is sent')
    assert.ok(chat.isRunning && !chat.text.trim(), 'Stop replaces Send while the turn runs')
    await finish()

    // The Send button twice (the second still showed Send), then a key typed after it.
    // LKM-325: Send is enabled by the draft's snapshot, as after real typing; in the same turn
    // as the text it still had the idle snapshot's disabled state and sent nothing.
    await host.request('composerPerform', { text: 'Ship it' })
    await wait(
      async () => chat.text === 'Ship it' && (await inspect()).enabled === true,
      'Send enabled for the draft'
    )
    await host.request('composerPerform', {
      steps: [{ action: 'send' }, { action: 'send' }, { append: 'Next' }]
    })
    await wait(async () => (await inspect()).text === 'Next' && chat.text === 'Next', 'Next')
    assert.equal(sends().length, 2, 'the second click sent nothing')
    assert.ok(sends()[1].includes('Ship it') && !sends()[1].includes('Next'))
    assert.equal(calls.filter((c) => c.channel === 'agent:interrupt').length, 0, 'not stopped')
    assert.ok(chat.isRunning && !chat.stopping, 'the turn still runs')
    await finish()
    console.log('Composer send: smart quote after Return, double Send and new text passed.')
  } finally {
    nativeChat.services.invoke = invoke
    if (chat.isRunning) await finish()
    await host.request('composerPerform', { text: '' })
  }
}
