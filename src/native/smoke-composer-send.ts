import assert from 'node:assert/strict'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'

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
