import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runningAgentWork, stubAgentSendForSmoke } from '../main/agent'
import type { AgentEvent } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { QUIT_DONT_ASK_KEY, QUIT_TITLE } from './quit-guard'
import { nativeQuit, quitWorkSources } from './quit-install'
import { inspectUntil, waitFor } from './smoke-wait'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** LKM-221: a user quit while a (stubbed) turn runs. The host's `quitRequest` is a real
 *  quit request whose final `quitProceed` is counted instead of quitting. The sheet shows
 *  Cancel (default, Esc), Wait and Quit, Quit Anyway and "Don't ask again"; Cancel keeps the
 *  turn running; Wait and Quit quits once it ends; Quit Anyway stops it the way Stop does;
 *  a landing in progress is finished first, also with "Don't ask again". No provider is called. */
export async function checkQuitAlert(
  host: NativeBridge,
  artifacts: string,
  preference: (key: string) => string | null
) {
  const request = (method: string) => host.request(method)
  const quit = (check: (s: any) => boolean, timeout = 10000) =>
    inspectUntil(request, 'quitInspect', check, undefined, timeout)
  const key = nativeChat.active
  const sent: string[] = []
  const provider = stubAgentSendForSmoke(key, (text) => {
    sent.push(text)
  })
  const running = () => runningAgentWork().filter((w) => w.id === key)
  const capture = async (name: string) => {
    const png = await host.request('captureQuit')
    writeFileSync(join(artifacts, `quit-${name}.png`), Buffer.from(png, 'base64'))
  }
  const send = async (text: string, count: number) => {
    await inspectUntil(request, 'chatInspect', (s) => !s.activity)
    await host.request('composerPerform', { text })
    await inspectUntil(request, 'composerInspect', (s) => s.enabled)
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.length === count, 'the turn reached the provider stub')
    await waitFor(() => running().length === 1, 'the turn counts as running agent work')
  }
  let landing = false
  const landingSource = () => (landing ? [{ kind: 'landing' as const, project: 'smoke' }] : [])
  try {
    await send('Make the heading blue.', 1)
    const start = (await host.request('quitInspect')).proceeded

    // The sheet: title, what runs, the three buttons with Cancel as default and Esc.
    await host.request('quitRequest')
    const asked = await quit((s) => s.phase === 'asking' && s.alert?.visible)
    assert.equal(asked.alert.attached, true, 'the alert is a sheet on the main window')
    assert.equal(asked.alert.title, QUIT_TITLE)
    assert.match(asked.alert.text, /^1 chat in .+ is still running\./)
    assert.match(asked.alert.text, /keeps their work in each chat’s copy/)
    assert.deepEqual(asked.alert.buttons, ['Cancel', 'Wait and Quit', 'Quit Anyway'])
    assert.equal(asked.alert.defaultButton, 'Cancel')
    assert.equal(asked.alert.escapeButton, 'Cancel')
    assert.equal(asked.alert.suppression, 'Don’t ask again')
    await capture('alert')

    // Cancel: no quit, the turn keeps running.
    await host.request('quitPerform', { action: 'cancel' })
    await quit((s) => s.phase === 'idle' && !s.alert && !s.note)
    await delay(500)
    assert.equal(running().length, 1, 'Cancel keeps the turn running')
    assert.equal((await host.request('quitInspect')).proceeded, start)

    // Wait and Quit: a cancellable note until the turn ends, then the quit.
    await host.request('quitRequest')
    await quit((s) => s.phase === 'asking' && s.alert?.visible)
    await host.request('quitPerform', { action: 'wait' })
    const waiting = await quit((s) => s.phase === 'waiting' && s.note?.visible)
    assert.equal(waiting.note.cancellable, true)
    assert.match(waiting.note.text, /^Waiting for 1 chat in .+ to finish\./)
    await capture('wait')
    await delay(500)
    assert.equal((await host.request('quitInspect')).proceeded, start, 'no quit while it runs')
    provider.emit({ type: 'done' } as AgentEvent)
    await quit((s) => s.proceeded === start + 1 && s.phase === 'idle' && !s.note)

    // Quit Anyway: the turn is stopped as Stop does, then the quit.
    await send('Make the heading red.', 2)
    await host.request('quitRequest')
    await quit((s) => s.phase === 'asking' && s.alert?.visible)
    await host.request('quitPerform', { action: 'stop' })
    await waitFor(() => nativeChat.get(key).stopping, 'Quit Anyway stops the chat like Stop')
    assert.equal(nativeChat.get(key).paused, true)
    // The stub provider ends its turn the way a real one does after an interrupt.
    provider.emit({ type: 'done' } as AgentEvent)
    // The stop waits for the provider's interrupt, which agent.ts caps at 5 s.
    await quit((s) => s.proceeded === start + 2 && s.phase === 'idle', 20000)
    await waitFor(() => running().length === 0, 'the stopped turn ended')

    // A landing in progress is finished first: Quit Anyway waits for it, Cancel is gone.
    quitWorkSources.add(landingSource)
    landing = true
    await host.request('quitRequest')
    const landingAlert = await quit((s) => s.phase === 'asking' && s.alert?.visible)
    assert.match(landingAlert.alert.text, /A landing is in progress\./)
    await host.request('quitPerform', { action: 'stop', dontAsk: true })
    const finishing = await quit((s) => s.phase === 'stopping' && s.note?.visible)
    assert.equal(finishing.note.text, 'Finishing a landing before quitting…')
    assert.equal(finishing.note.cancellable, false)
    await capture('landing')
    await host.request('quitPerform', { action: 'cancel' })
    await delay(1000)
    const held = await host.request('quitInspect')
    assert.equal(held.proceeded, start + 2, 'no quit before the landing finished')
    assert.equal(held.phase, 'stopping')
    await waitFor(() => preference(QUIT_DONT_ASK_KEY) === 'true', '"Don’t ask again" is saved')
    landing = false
    await quit((s) => s.proceeded === start + 3 && s.phase === 'idle')

    // "Don't ask again": no alert, but the landing still finishes before the quit.
    landing = true
    await host.request('quitRequest')
    const direct = await quit((s) => s.phase === 'stopping' && s.note?.visible)
    assert.equal(direct.alert, undefined, 'no alert once "Don’t ask again" is set')
    await delay(500)
    assert.equal((await host.request('quitInspect')).proceeded, start + 3)
    landing = false
    await quit((s) => s.proceeded === start + 4 && s.phase === 'idle')
    console.log(
      'Native quit alert',
      JSON.stringify({ asked: asked.alert, waiting: waiting.note, finishing: finishing.note })
    )
  } finally {
    landing = false
    quitWorkSources.delete(landingSource)
    await host.request('quitPerform', { action: 'cancel' }).catch(() => {})
    nativeQuit.current?.cancel()
    await nativeQuit.setDontAsk(false)
    if (running().length) provider.emit({ type: 'done' } as AgentEvent)
    provider.restore()
  }
}
