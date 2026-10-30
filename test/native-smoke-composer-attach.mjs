// LKM-386: `composerVerification` answers `{ error: 'Composer is not foreground' }` as a normal
// reply, and the attach check read that as "chooser closed". This drives the real
// `checkComposerAttach` against a host that keeps `verifyInteraction`'s reply rules: no
// foreground means an error and no effect, and `attachmentDialog` is read before a cancel acts.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { waitFor } = await import('../src/native/smoke-wait.ts')
// Failing waits are the point here: keep them short, whatever the check asked for.
mock.module('../src/native/smoke-wait.ts', () => ({
  waitFor: (check, label) => waitFor(check, label, 300, undefined, 10)
}))
const { checkComposerAttach } = await import('../src/native/smoke-composer-attach.ts')

const artifacts = mkdtempSync(join(tmpdir(), 'trezi-composer-attach-'))
process.on('exit', () => rmSync(artifacts, { recursive: true, force: true }))
delete process.env.TREZI_NATIVE_BACKGROUND_TEST

const name = (path) => path.split('/').pop()

/** `hooks` run before a method's reply, to lose the foreground or fail a step at a set moment. */
function fakeHost(hooks = {}) {
  const host = {
    sheet: false,
    foreground: true,
    fullScreen: false,
    text: '',
    attachments: [],
    cancels: [],
    exits: [],
    verifyError: null,
    composerVerification(c) {
      if (c.prepare) host.foreground = true
      if (host.verifyError) throw new Error(host.verifyError)
      if (!host.foreground) return { error: 'Composer is not foreground' }
      if (c.attachDialog && !host.sheet) host.sheet = true
      const attachmentDialog = host.sheet
      if (c.cancelDialog && host.sheet) {
        host.cancels.push({ prepare: c.prepare === true })
        host.sheet = false
      }
      if (c.acceptDialog && host.sheet) {
        host.sheet = false
        host.attachments.push(...c.acceptDialog.map((path) => ({ name: name(path) })))
      }
      return {
        foreground: true,
        attachmentDialog,
        dialog: attachmentDialog
          ? { visible: true, multiple: true, files: true, directories: false, onScreen: true }
          : {},
        attachButton: { popUp: false, label: 'Attach files', fullScreen: host.fullScreen }
      }
    },
    composerInspect: () => ({ text: host.text, attachments: [...host.attachments] }),
    composerPerform(c) {
      if (c.text !== undefined) host.text = c.text
      for (const path of c.files ?? []) host.attachments.push({ name: name(path) })
      if (c.remove !== undefined) host.attachments.splice(c.remove, 1)
    },
    captureComposerChooser() {
      assert.ok(host.sheet, 'The chooser capture needs an open chooser')
      return { png: '', width: 640, height: 400, window: 1 }
    },
    captureVisibleComposer() {
      if (host.sheet || !host.foreground) throw new Error('not in the foreground')
      return { png: '', width: 400, height: 120 }
    },
    previewOverlayTest(c) {
      if (!c.value) host.exits.push({ sheet: host.sheet })
      host.fullScreen = c.value
    },
    request: async (method, params = {}) => {
      await hooks[method]?.(params)
      return host[method](params)
    }
  }
  return host
}

const fails = (host) =>
  checkComposerAttach(host, artifacts).then(
    () => assert.fail('The attach check must fail'),
    (error) => error
  )

// The full-screen capture fails with the chooser open and the app inactive: the error the
// `finally` of the old check could lose.
const inactiveAtCapture = (host, then = () => {}) => {
  let captures = 0
  return () => {
    if (++captures < 3) return
    host.foreground = false
    then()
    throw new Error('capture refused')
  }
}

{
  const host = fakeHost()
  await checkComposerAttach(host, artifacts)
  assert.equal(host.text, '', 'A pass leaves no draft')
  assert.deepEqual(host.attachments, [], 'A pass leaves no attachment')
  assert.deepEqual(host.exits, [{ sheet: false }], 'A pass leaves full screen once, chooser shut')
  assert.equal(host.cancels.length, 4, 'One cancel for each of the four rounds, none in cleanup')
}

{
  // The cancel is refused and the chooser stays: the error reply must not read as closed.
  const hooks = {}
  const host = fakeHost(hooks)
  hooks.composerVerification = (c) => {
    if (c.cancelDialog && !c.prepare) host.foreground = false
  }
  const error = await fails(host)
  assert.match(error.message, /window: Cancel closes it/, "An error reply isn't a closed chooser")
  assert.equal(host.sheet, false, 'Cleanup closes the chooser the refused cancel left open')
  assert.deepEqual(host.cancels, [{ prepare: true }], 'Only the prepared retry reached the chooser')
  assert.equal(host.text, '', 'A failure still empties the composer')
  assert.deepEqual(host.attachments, [], 'A failure still removes the attachments')
}

{
  // Accepting works but the app then loses the foreground, so nothing proves the chooser closed.
  const hooks = {}
  const host = fakeHost(hooks)
  let lost = false
  hooks.composerInspect = () => {
    if (host.attachments.length === 2 && !lost) {
      lost = true
      host.foreground = false
    }
  }
  const error = await fails(host)
  assert.match(error.message, /window: accepting appends 1 file/, 'Accept needs a closed chooser')
}

{
  const hooks = {}
  const host = fakeHost(hooks)
  hooks.captureComposerChooser = inactiveAtCapture(host)
  const error = await fails(host)
  assert.equal(error.message, 'capture refused', 'The original error survives the cleanup')
  assert.deepEqual(host.exits, [{ sheet: false }], 'The chooser closes before full screen ends')
  assert.deepEqual(host.cancels.at(-1), { prepare: true }, 'The cancel was retried with prepare')
  assert.equal(host.text, '', 'The composer is emptied after the failure')
}

{
  // The chooser cannot be closed at all (a rejected request is not "closed" either).
  const hooks = {}
  const host = fakeHost(hooks)
  hooks.captureComposerChooser = inactiveAtCapture(host, () => {
    host.verifyError = 'Native composerVerification timed out'
  })
  const logged = []
  const log = console.error
  console.error = (line) => logged.push(line)
  const error = await fails(host).finally(() => {
    console.error = log
  })
  assert.equal(error.message, 'capture refused', 'A failing cleanup keeps the original error')
  assert.deepEqual(host.exits, [], 'Full screen is not left with the chooser open')
  assert.equal(host.sheet, true, 'The chooser really is still open')
  assert.ok(
    logged.every((line) => line.includes('an open file chooser is cancelled')) && logged.length,
    'The cleanup failure is still logged'
  )
}

{
  // With nothing else failing, a cleanup failure is the check's failure.
  const hooks = {}
  const host = fakeHost(hooks)
  hooks.previewOverlayTest = ({ value }) => {
    if (!value) throw new Error('Full screen false did not finish')
  }
  const error = await fails(host)
  assert.equal(error.message, 'Full screen false did not finish', 'Cleanup can fail a pass')
  assert.equal(host.text, '', 'The outer cleanup still runs')
}

console.log('native-smoke-composer-attach: all assertions passed')
