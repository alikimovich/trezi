import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'

/** Foreground composer evidence; provider calls are intercepted, never sent. */
export async function checkVisibleComposer(host: NativeBridge, fixture: string, artifacts: string) {
  const initial = await host.request('chatAcceptance', { prepare: true })
  try {
    for (const width of [440, 320]) {
      // Re-activate before each pass: the window may lose key status between passes
      // (a loaded or shared desktop), and `chatAcceptance` fails without foreground.
      await host.request('chatAcceptance', { prepare: true, width })
      await checkComposerAtWidth(host, fixture, artifacts, width)
    }
  } finally {
    // Always restore the width, even after a failure, so later checks start from it.
    await host.request('chatAcceptance', { prepare: true, width: initial.chatWidth })
  }
}

async function checkComposerAtWidth(
  host: NativeBridge,
  fixture: string,
  artifacts: string,
  width: number
) {
  const wait = async (check: () => Promise<any> | any) => {
    for (let i = 0; i < 100; i++) {
      const result = await check()
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    throw new Error('Visible composer verification timed out')
  }
  const chat = nativeChat.get(nativeChat.active)
  const settings = { ...chat.settings }
  const choices = nativeChat.choices
  const invoke = nativeChat.services.invoke
  const calls: { channel: string; args: any[] }[] = []
  nativeChat.services.invoke = async (channel, ...args) => {
    if (['agent:restart-chat', 'agent:set-permission-mode', 'agent:send'].includes(channel)) {
      calls.push({ channel, args })
      return { ok: true }
    }
    return invoke(channel, ...args)
  }
  const inspect = () => host.request('composerInspect')
  // With `latest`, the newest message must end above the composer clearance. The
  // pin and its geometry are LKM-103's: read them from `chatAcceptance`, waiting on
  // the observable (never a fixed sleep). Only its end is required, since the
  // drafted prompt and the tall reply are taller than the reading area.
  const settleLatest = async (name: string) => {
    let state: any = {}
    const ended = (s: any) =>
      !!s.latestID && s.latestBottom > 0 && s.latestBottom <= s.readingHeight + 1
    try {
      await wait(async () => {
        state = await host.request('chatAcceptance', {})
        return ended(state)
      })
    } catch (cause) {
      const { latestID, latestTop, latestBottom, readingHeight, pinned } = state
      throw new Error(
        `Composer capture ${width}-${name}: latest message did not end above the composer: ${JSON.stringify({ latestID, latestTop, latestBottom, readingHeight, pinned })}`,
        { cause }
      )
    }
  }
  const capture = async (name: string, expected: string[], latest = false) => {
    if (latest) await settleLatest(name)
    const layout = await host.request('composerVerification')
    await new Promise((resolve) => setTimeout(resolve, 350))
    const image = await host.request('captureVisibleComposer')
    const stem = join(artifacts, `composer-visible-${width}-${name}`)
    writeFileSync(`${stem}.png`, Buffer.from(image.png, 'base64'))
    writeFileSync(
      `${stem}.json`,
      JSON.stringify(
        { ...layout, text: image.text, width: image.width, height: image.height },
        null,
        2
      )
    )
    assert.equal(layout.foreground, true, JSON.stringify(layout))
    assert.equal(layout.contained, true, 'Input and control row share the bubble')
    assert.equal(
      layout.alignment,
      true,
      'Attachment left; provider/model/Auto right: ' + JSON.stringify(layout)
    )
    assert.equal(
      layout.hitTargets,
      true,
      'Composer controls receive hits above glass/beam overlays'
    )
    assert.ok(layout.bottomInset >= 7, 'Rounded bottom extends below the controls')
    assert.ok(image.width > 200 && image.height > 100, 'Nonempty foreground composer pixels')
    if (latest) {
      // Full-column capture plus geometry as evidence of the latest row above the composer.
      const { image: column, ...geometry } = await host.request('chatAcceptance', { capture: true })
      writeFileSync(`${stem}-chat.png`, Buffer.from(column.png, 'base64'))
      writeFileSync(
        `${stem}-chat.json`,
        JSON.stringify(
          { ...geometry, text: column.text, pixels: [column.width, column.height] },
          null,
          2
        )
      )
      assert.ok(
        geometry.latestBottom > 0 && geometry.latestBottom <= geometry.readingHeight + 1,
        `${stem}-chat.png: latest message ends above the composer`
      )
    }
    for (const label of expected)
      assert.ok(
        image.text.join(' ').toLowerCase().includes(label.toLowerCase()),
        `Missing rendered ${label} in ${stem}.png`
      )
  }
  const choose = async (label: string, value: string) => {
    await host.request('composerVerification', { label, value })
    await wait(async () => {
      if (chat.pendingModel) await host.request('chatPerform', { action: 'model-confirm' })
      return (
        !chat.switching &&
        (await inspect()).choices.some((c: any) => c.label === label && c.value === value)
      )
    })
  }
  try {
    assert.ok(
      chat.ready && !chat.isRunning && !chat.text && !chat.attachments.length,
      'Idle empty composer fixture'
    )
    nativeChat.choices = [
      {
        value: 'composer-a',
        modelId: 'composer-a',
        label: 'Fixture A',
        provider: 'codex',
        group: 'Codex'
      },
      {
        value: 'composer-b',
        modelId: 'composer-b',
        label: 'Fixture B',
        provider: 'codex',
        group: 'Codex'
      }
    ]
    chat.settings = {
      ...settings,
      provider: 'codex',
      connectionId: undefined,
      model: 'composer-a',
      modelId: 'composer-a',
      permissionMode: 'auto'
    }
    nativeChat.changed(chat)
    await wait(async () => (await inspect()).choices.some((c: any) => c.value === 'composer-a'))
    await wait(
      async () => (await host.request('composerVerification', { prepare: true })).foreground
    )
    await capture('initial', ['Codex', 'Fixture A', 'Auto'])
    // Empty draft: Send is disabled, and neither a click nor Return submits it.
    const empty = await inspect()
    assert.equal(
      (await host.request('composerVerification')).send.enabled,
      false,
      `${width}: Send is disabled without a draft`
    )
    await host.request('composerVerification', { submit: true })
    await host.request('composerVerification', { keySubmit: true })
    assert.equal((await inspect()).text, '', `${width}: Return adds no newline to an empty draft`)
    await host.request('composerVerification', { prepare: true })
    assert.equal(
      calls.filter((c) => c.channel === 'agent:send').length,
      0,
      `${width}: an empty draft is never submitted`
    )
    await host.request('composerVerification', { attachDialog: true })
    await wait(async () => (await host.request('composerVerification')).attachmentDialog)
    await host.request('composerVerification', { cancelDialog: true })
    await wait(async () => !(await host.request('composerVerification')).attachmentDialog)
    await wait(
      async () => (await host.request('composerVerification', { prepare: true })).foreground
    )
    // The panel was exercised above; use the existing file hook for deterministic selection.
    const attachment = join(fixture, 'index.html')
    await host.request('composerPerform', { files: [attachment] })
    await wait(async () => (await inspect()).attachments.length === 1)
    await choose('Model', 'composer-b')
    await choose('Permission mode', 'default')
    await capture('ask', ['Codex', 'Fixture B', 'Ask always', 'index.html'])
    const prompt = Array(width === 320 ? 80 : 6)
      .fill('Composer verification message')
      .join('\n')
    await host.request('composerVerification', { typing: prompt })
    await wait(async () => (await inspect()).text === prompt && (await inspect()).enabled)
    await choose('Permission mode', 'auto')
    await capture('draft', [
      'Codex',
      'Fixture B',
      'Auto',
      'Composer verification message',
      'index.html'
    ])
    const drafted = await host.request('composerVerification')
    assert.equal(drafted.send.enabled, true, `${width}: Send is enabled for a draft`)
    assert.ok(
      drafted.composerHeight > empty.bounds.height,
      `${width}: composer grows for the multiline draft`
    )
    if (width !== 320)
      assert.ok(drafted.textFits, `${width}: uncapped multiline draft fits without scrolling`)
    // Normal width submits with a real Return key event, narrow with the row's Send.
    await host.request(
      'composerVerification',
      width === 320 ? { submit: true } : { keySubmit: true }
    )
    await wait(() => calls.some((c) => c.channel === 'agent:send'))
    const sent = calls.filter((c) => c.channel === 'agent:send')
    assert.equal(sent.length, 1)
    assert.ok(sent[0].args[0].includes(prompt) && sent[0].args[0].includes(attachment))
    assert.equal(sent[0].args[2], chat.chat)
    assert.ok(calls.some((c) => c.channel === 'agent:restart-chat'))
    assert.deepEqual(
      calls.filter((c) => c.channel === 'agent:set-permission-mode').map((c) => c.args[0]),
      ['default', 'auto']
    )
    // Sending: the draft cleared, so the composer is compact again while the
    // turn runs. Stop replaces Send; the model locks while Auto stays usable.
    await wait(
      async () =>
        chat.isRunning &&
        (await inspect()).text === '' &&
        (await inspect()).bounds.height === empty.bounds.height
    )
    await capture('sending', ['Auto'], true)
    const sending = await host.request('composerVerification')
    assert.equal(sending.send.label, 'Stop', `${width}: Send becomes Stop while the turn runs`)
    assert.equal(sending.send.enabled, true, `${width}: Stop remains available`)
    assert.deepEqual(
      sending.pickersEnabled,
      { Provider: false, Model: false, 'Permission mode': true },
      `${width}: model locks during the turn`
    )
    assert.deepEqual(
      sending.labels,
      ['Codex', 'Fixture B', 'Auto'],
      `${width}: selectors retain their values`
    )
    // A tall reply overflows the conversation while the composer is compact, so
    // the newest line depends on the pin to the end above the composer.
    const reply =
      Array.from({ length: 24 }, (_, i) => `Composer scroll fixture paragraph ${i + 1}.`).join(
        '\n\n'
      ) + `\n\nLatest composer reply at ${width}.`
    nativeChat.event({ type: 'delta', projectKey: chat.chat, text: reply })
    nativeChat.event({ type: 'done', projectKey: chat.chat, landingPending: false })
    await wait(
      async () =>
        !chat.isRunning && !(await inspect()).text && !(await inspect()).attachments.length
    )
    await capture('submitted', ['Codex', 'Fixture B', 'Auto'], true)
    console.log(
      'Visible composer: foreground captures, containment/hit targets, attachment dialog/file, model, Auto, AppKit typing and submission passed.'
    )
  } finally {
    nativeChat.services.invoke = invoke
    nativeChat.choices = choices
    chat.settings = settings
    nativeChat.changed(chat)
  }
}
