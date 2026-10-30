import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>

/** Runs `cleanup` after `body`, pass or fail. A cleanup failure fails a passing body, but
 *  must not replace the error a failing body already threw. */
async function withCleanup(body: () => Promise<void>, cleanup: () => Promise<unknown>) {
  try {
    await body()
  } catch (error) {
    await cleanup().catch((failure) =>
      console.error(`Composer attach cleanup also failed: ${String(failure)}`)
    )
    throw error
  }
  await cleanup()
}

/** LKM-381: one press of + opens the native file chooser as a sheet, with no menu first.
 *  Cancel keeps a draft and its attachments (a .mov among them), accepting appends, and
 *  repeated open/cancel keeps working, in a normal window and in macOS full screen. Each
 *  round saves a foreground capture of the open chooser sheet, a composer capture after
 *  Cancel, and the chooser's state and geometry.
 *  Opening and cancelling go through the real chooser; the OK step (`acceptDialog`) is a
 *  programmatic seam that runs the OK branch with given paths, not a person picking files.
 *  The composer is emptied at the end, pass or fail. */
export async function checkComposerAttach(host: NativeBridge, artifacts: string) {
  const verify = (params: State = {}): Promise<State> =>
    host.request('composerVerification', params)
  const inspect = (): Promise<State> => host.request('composerInspect')
  const names = (state: State) => state.attachments.map((file: State) => file.name)
  // A reply can be `{ error }` (the app is not foreground), which says nothing about the
  // chooser, so only an explicit false counts as closed.
  const chooserClosed = async (params: State = {}) => {
    const state = await verify(params)
    return !state.error && state.attachmentDialog === false
  }
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
    // The chooser is a sheet whose window is key, so the main window's composer capture is
    // refused while it is open: capture the sheet's own window.
    const image = await host.request('captureComposerChooser')
    const stem = join(artifacts, `composer-attach-${mode}-${index}`)
    writeFileSync(`${stem}.png`, Buffer.from(image.png, 'base64'))
    assert.ok(image.width > 200 && image.height > 100, `${stem}.png: nonempty chooser pixels`)
    await verify({ cancelDialog: true })
    await waitFor(() => chooserClosed(), `${mode}: Cancel closes it`)
    // With the chooser gone the main window is key again: the composer must still show the draft.
    await verify({ prepare: true })
    const composerImage = await waitFor(
      () => host.request('captureVisibleComposer').catch(() => null),
      `${mode} ${index}: foreground composer capture after Cancel`
    )
    writeFileSync(`${stem}-composer.png`, Buffer.from(composerImage.png, 'base64'))
    assert.ok(
      composerImage.width > 200 && composerImage.height > 50,
      `${stem}-composer.png: nonempty`
    )
    const after = await inspect()
    assert.equal(after.text, before.text, `${mode} ${index}: Cancel keeps the draft`)
    assert.deepEqual(names(after), names(before), `${mode} ${index}: Cancel keeps attachments`)
    results[`${mode}-${index}`] = {
      dialog: shown.dialog,
      attachButton: shown.attachButton,
      capture: {
        png: `${stem}.png`,
        width: image.width,
        height: image.height,
        window: image.window
      },
      composerCapture: {
        png: `${stem}-composer.png`,
        width: composerImage.width,
        height: composerImage.height
      },
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
      return (await chooserClosed()) && names(state).length === expected.length && state
    }, `${mode}: accepting appends ${paths.length} file(s)`)
    assert.deepEqual(names(after), expected, `${mode}: accepted files append in order`)
    assert.equal(after.text, draft, `${mode}: accepting keeps the draft`)
    results[`${mode}-accept`] = { attachments: names(after) }
    save()
  }

  // The draft and the three files must not leak into the next check (`composer-send` would
  // send them): runs after a pass and after a failure, once full screen is left.
  // Every try cancels again with `prepare`, because a cancel refused while the app was not
  // foreground did nothing. A reply reads the chooser before its cancel acts, so only a later
  // try reports closed; the interval outlasts the sheet closing, so one cancel normally does it.
  const closeChooser = () =>
    waitFor(
      () => chooserClosed({ prepare: true, cancelDialog: true }),
      'an open file chooser is cancelled',
      10000,
      undefined,
      500
    )
  const clear = async () => {
    await closeChooser()
    await host.request('composerPerform', { text: '' })
    for (let i = 0; i < 10 && (await inspect()).attachments.length; i++)
      await host.request('composerPerform', { remove: 0 })
  }

  await withCleanup(async () => {
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
    } else {
      await withCleanup(
        async () => {
          await host.request('previewOverlayTest', { action: 'fullscreen', value: true })
          await round('fullscreen', 1)
          await accept('fullscreen', [files[2]])
          await round('fullscreen', 2)
        },
        async () => {
          // A full-screen transition with a sheet attached can fail: close the chooser first.
          // If it cannot be closed, full screen stays.
          await closeChooser()
          await host.request('previewOverlayTest', { action: 'fullscreen', value: false })
        }
      )
      assert.deepEqual(
        names(await inspect()),
        ['attach-clip.mov', 'attach-notes.txt', 'attach-more.txt'],
        'Every accepted file is attached once'
      )
    }
  }, clear)
  const left = await waitFor(async () => {
    const state = await inspect()
    return state.text === '' && state.attachments.length === 0 && state
  }, 'the composer is empty after the attach check')
  assert.equal(left.attachments.length, 0, 'The attach check leaves no draft or attachment behind')
}
