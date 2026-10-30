import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { capture } from './smoke-toolbar'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Focus = 'composer' | 'preview' | 'source' | 'address' | 'none'

/**
 * LKM-380: Actions → Toggle UI (⌘.) in full screen toggles the UI and the window stays in
 * full screen. ⌘. is posted to the app's event queue (`toggleUIKey`), so it takes the real
 * key dispatch with the focus in the composer, the docked source editor, the preview's
 * WKWebView, the address field or nowhere. Windowed, it toggles as before; repeated presses
 * toggle every time; Escape toggles nothing; the draft and its attachment survive.
 */
export async function checkToggleUI(host: NativeBridge, artifacts: string) {
  const results: State = { presses: [] }
  const save = () =>
    writeFileSync(join(artifacts, 'toggle-ui.json'), JSON.stringify(results, null, 2))
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
    results.skipped = {
      reason: 'background test: key dispatch and full screen need a foreground window'
    }
    console.log('SKIP toggle-ui: TREZI_NATIVE_BACKGROUND_TEST')
    return save()
  }
  const hidden = async () => (await host.request('layoutInspect')).fraction === 0
  const inspect = (): Promise<State> => host.request('toggleUIKey', { inspect: true })
  const fullScreen = (value: boolean) =>
    host.request('previewOverlayTest', { action: 'fullscreen', value })
  const composer = (): Promise<State> => host.request('composerInspect')
  const shots: Record<string, string> = {}
  const shot = async (name: string) => {
    shots[name] = await capture(host, artifacts, `toggle-ui-${name}`)
  }
  /** One ⌘. that must toggle the UI exactly once and leave full screen as it was. */
  const press = async (focus: Focus, full: boolean, label: string) => {
    const was = await hidden()
    const sent: State = await host.request('toggleUIKey', { focus })
    await waitFor(
      async () => (await hidden()) !== was,
      `${label}: ⌘. toggles the UI`,
      5000,
      inspect
    )
    // A full-screen exit starts within a frame; give it time to show before reading.
    await pause(700)
    const after = await inspect()
    results.presses.push({ label, focus, was, now: await hidden(), sent, after })
    save()
    assert.equal(
      sent.firstResponder,
      focus === 'none' ? 'window' : focus,
      `Toggle UI ${label}: the focus is in the ${focus} when ⌘. is sent: ${JSON.stringify(sent)}`
    )
    assert.equal(await hidden(), !was, `Toggle UI ${label}: one press toggles once`)
    assert.equal(
      after.fullScreen,
      full,
      `Toggle UI ${label}: full screen stays ${full}: ${JSON.stringify(after)}`
    )
    assert.equal(after.transition, false, `Toggle UI ${label}: no full-screen transition started`)
  }
  const ensureShown = async () => {
    if (await hidden()) await press('none', (await inspect()).fullScreen, 'restore')
  }
  const code = async (open: boolean) => {
    if ((await host.request('sourceInspect')).visible === open) return
    await host.request('shellPerform', { action: 'code' })
    await waitFor(
      async () => (await host.request('sourceInspect')).visible === open,
      `Code ${open}`
    )
  }
  const attachment = join(artifacts, 'toggle-ui-attachment.txt')
  writeFileSync(attachment, 'LKM-380 toggle attachment\n')
  const draft = 'Toggle UI keeps this draft'
  try {
    const menu = (await inspect()).menu
    results.menu = menu
    assert.deepEqual(
      [menu.menu, menu.title, menu.key, menu.command, menu.enabled],
      ['Actions', 'Toggle UI', '.', true, true],
      `Toggle UI: Actions → Toggle UI is ⌘.: ${JSON.stringify(menu)}`
    )
    await fullScreen(false)
    await ensureShown()
    await host.request('composerPerform', { text: draft })
    await host.request('composerPerform', { files: [attachment] })
    await waitFor(async () => (await composer()).attachments.length === 1, 'the attachment')
    const before = await composer()

    // Windowed: as before.
    await shot('windowed-open')
    await press('composer', false, 'windowed composer closes')
    await shot('windowed-closed')
    await press('preview', false, 'windowed preview opens')

    // Escape stays its own key: no toggle, no full-screen change.
    const escaped = await host.request('toggleUIKey', { focus: 'none', key: 'escape' })
    await pause(700)
    results.escape = { sent: escaped, hidden: await hidden(), after: await inspect() }
    assert.equal(await hidden(), false, 'Toggle UI: Escape does not toggle the UI')

    // Full screen, each focus: the first press closes, the next opens, full screen stays.
    await fullScreen(true)
    await waitFor(async () => (await inspect()).fullScreen, 'full screen')
    await shot('fullscreen-open')
    await press('composer', true, 'full screen composer closes')
    await shot('fullscreen-closed')
    await press('preview', true, 'full screen preview opens (sidebar was closed)')
    await shot('fullscreen-reopened')
    await press('preview', true, 'full screen preview closes')
    await press('none', true, 'full screen no focus opens')
    await press('address', true, 'full screen address closes')
    await press('preview', true, 'full screen preview opens again')
    await code(true)
    await press('source', true, 'full screen source editor closes')
    await press('preview', true, 'full screen preview opens with Code')
    await code(false)
    // Repeated presses toggle every time.
    for (let i = 0; i < 4; i++) await press('preview', true, `full screen repeat ${i + 1}`)
    await shot('fullscreen-repeated')

    const after = await composer()
    results.composer = {
      before: { text: before.text, attachments: before.attachments.length, chat: before.chat },
      after: { text: after.text, attachments: after.attachments.length, chat: after.chat }
    }
    assert.equal(after.text, draft, 'Toggle UI: the draft survives the toggles')
    assert.equal(after.attachments.length, 1, 'Toggle UI: the attachment survives the toggles')
    assert.equal(after.chat, before.chat, 'Toggle UI: the active chat is unchanged')
  } finally {
    results.captures = shots
    await code(false).catch(() => {})
    await ensureShown().catch(() => {})
    await fullScreen(false).catch(() => {})
    await host.request('composerPerform', { text: '' }).catch(() => {})
    for (let i = 0; i < 5 && (await composer()).attachments.length; i++)
      await host.request('composerPerform', { remove: 0 })
    save()
  }
}
