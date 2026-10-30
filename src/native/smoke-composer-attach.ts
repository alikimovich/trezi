import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>

/** LKM-381: one press of + opens the native file chooser as a sheet, with no menu first.
 *  Cancel keeps a draft and its attachments (a .mov among them), accepting appends, and
 *  repeated open/cancel keeps working, in a normal window and in macOS full screen. Each
 *  open phase saves a foreground composer capture plus the chooser's state and geometry. */
export async function checkComposerAttach(host: NativeBridge, artifacts: string) {
  const verify = (params: State = {}): Promise<State> =>
    host.request('composerVerification', params)
  const inspect = (): Promise<State> => host.request('composerInspect')
  const names = (state: State) => state.attachments.map((file: State) => file.name)
  const results: State = {}
  const save = () =>
    writeFileSync(join(artifacts, 'composer-attach.json'), JSON.stringify(results, null, 2))
  const files = ['attach-clip.mov', 'attach-notes.txt', 'attach-more.txt'].map((name) => {
    const path = join(artifacts, name)
    writeFileSync(path, `LKM-381 ${name}\n`)
    return path
  })
  const draft = 'Draft kept across the file chooser'

  const round = async (mode: string, index: number) => {
    const before = await inspect()
    const opened = await verify({ prepare: true, attachDialog: true })
    assert.equal(opened.attachButton.popUp, false, `${mode}: + is a plain button`)
    assert.equal(opened.attachButton.label, 'Attach files', `${mode}: + is labelled`)
    const shown = await waitFor(async () => {
      const state = await verify()
      return state.attachmentDialog && state.dialog.visible && state
    }, `${mode} ${index}: one press of + shows the file chooser`)
    assert.equal(shown.dialog.multiple, true, `${mode}: the chooser takes several files`)
    assert.equal(shown.dialog.files && !shown.dialog.directories, true, `${mode}: files only`)
    assert.equal(shown.dialog.onScreen, true, `${mode}: the chooser is on screen`)
    assert.equal(shown.attachButton.fullScreen, mode === 'fullscreen', `${mode}: window mode`)
    const image = await host.request('captureVisibleComposer')
    const stem = join(artifacts, `composer-attach-${mode}-${index}`)
    writeFileSync(`${stem}.png`, Buffer.from(image.png, 'base64'))
    assert.ok(image.width > 200 && image.height > 100, `${stem}.png: nonempty foreground pixels`)
    await verify({ cancelDialog: true })
    await waitFor(async () => !(await verify()).attachmentDialog, `${mode}: Cancel closes it`)
    const after = await inspect()
    assert.equal(after.text, before.text, `${mode} ${index}: Cancel keeps the draft`)
    assert.deepEqual(names(after), names(before), `${mode} ${index}: Cancel keeps attachments`)
    results[`${mode}-${index}`] = {
      dialog: shown.dialog,
      attachButton: shown.attachButton,
      capture: { png: `${stem}.png`, width: image.width, height: image.height },
      text: after.text,
      attachments: names(after)
    }
    save()
  }

  const accept = async (mode: string, paths: string[]) => {
    const before = names(await inspect())
    await verify({ prepare: true, attachDialog: true })
    await waitFor(async () => (await verify()).attachmentDialog, `${mode}: chooser for accept`)
    await verify({ acceptDialog: paths })
    const expected = [...before, ...paths.map((path) => path.split('/').pop())]
    const after = await waitFor(async () => {
      const state = await inspect()
      return !(await verify()).attachmentDialog && names(state).length === expected.length && state
    }, `${mode}: accepting appends ${paths.length} file(s)`)
    assert.deepEqual(names(after), expected, `${mode}: accepted files append in order`)
    assert.equal(after.text, draft, `${mode}: accepting keeps the draft`)
    results[`${mode}-accept`] = { attachments: names(after) }
    save()
  }

  await host.request('composerPerform', { text: draft, files: [files[0]] })
  await waitFor(async () => {
    const state = await inspect()
    return state.text === draft && names(state).join() === 'attach-clip.mov'
  }, 'draft with a .mov attachment')
  await round('window', 1)
  await round('window', 2)
  await accept('window', [files[1]])
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
    results.fullscreen = { skipped: 'background test: full screen needs a foreground window' }
    save()
    return
  }
  try {
    await host.request('previewOverlayTest', { action: 'fullscreen', value: true })
    await round('fullscreen', 1)
    await accept('fullscreen', [files[2]])
    await round('fullscreen', 2)
  } finally {
    await host.request('previewOverlayTest', { action: 'fullscreen', value: false })
  }
  assert.deepEqual(
    names(await inspect()),
    ['attach-clip.mov', 'attach-notes.txt', 'attach-more.txt'],
    'Every accepted file is attached once'
  )
}
