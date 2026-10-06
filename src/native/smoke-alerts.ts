import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeSheetAction } from '../shared/native-sheet'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { NativeSheetController } from './sheets-runtime'
import { NativeSupportSheets } from './support-sheets'
import { nativeWorkspace } from './workspace-runtime'

/** LKM-170: app alerts are NSAlert-style sheets attached to the main window, and sent
 *  feedback is a self-dismissing toast, never a titled window. The feedback path runs on
 *  its own controller with GitHub and the browser stubbed, so no issue is filed. */
export async function checkNativeAlerts(host: NativeBridge, artifacts: string) {
  const until = async (method: string, check: (state: any) => boolean, label: string) => {
    let state: any
    for (let i = 0; i < 100; i++) {
      state = await host.request(method)
      if (check(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`${label}: ${JSON.stringify(state)}`)
  }
  const capture = async (method: string, name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    writeFileSync(join(artifacts, name), Buffer.from(await host.request(method), 'base64'))
  }
  // Sized to content: the sheet's content is the alert's height, give or take a point.
  const fitted = (s: any) => s.height > 0 && Math.abs(s.height - s.contentHeight) <= 2
  const standard = async (label: string) => {
    const state = await until('sheetInspect', fitted, `${label} is not sized to content`)
    assert.ok(state.alert && state.attached, `${label} is a sheet on the main window`)
    assert.ok(!state.titled && !state.closable && !state.resizable, `${label} has no window chrome`)
    assert.ok(state.height < 320, `${label} has no spare space: ${JSON.stringify(state)}`)
    return state
  }

  // A production alert: Trezi → Check for updates (nothing runs until its button).
  host.emit('menu', { action: 'updates' })
  await until(
    'sheetInspect',
    (s) => s.visible && s.title === 'Trezi updates',
    'Updates alert did not open'
  )
  const updates = await standard('Updates alert')
  assert.equal(updates.defaultAction, 'check', 'Return checks for updates')
  assert.equal(updates.cancelAction, 'cancel', 'Esc closes the alert')
  assert.deepEqual(updates.actions, ['cancel', 'check'], 'An alert keeps its visible Close')
  await capture('captureSheet', 'alert-updates.png')
  await host.request('sheetPerform', { action: 'cancel' })
  await until('sheetInspect', (s) => !s.visible, 'Updates alert did not close')

  // Feedback: a failed post shows the standard error sheet, Retry posts it and shows the toast.
  const posted: unknown[] = [],
    opened: string[] = []
  let fail = true
  const sheets = new NativeSheetController(
    host,
    nativeWorkspace,
    nativeChat,
    async (channel, input) => {
      assert.equal(channel, 'feedback:submit')
      posted.push(input)
      return fail
        ? { ok: false, error: 'gh: To get started with GitHub CLI, please run: gh auth login' }
        : { ok: true, url: 'https://github.com/alikimovich/trezi/issues/170' }
    }
  )
  const support = new NativeSupportSheets(
    sheets,
    async () => null,
    async (url) => opened.push(url)
  )
  const onSheet = (action: NativeSheetAction) => void sheets.action(action)
  const onToast = (action: { id: string }) => void sheets.toastAction(action)
  host.on('sheet-action', onSheet)
  host.on('toast-action', onToast)
  try {
    await support.feedback()
    await until('sheetInspect', (s) => s.visible && s.title === 'Send feedback', 'Feedback form')
    await host.request('sheetPerform', { action: 'send', values: { body: 'Smoke feedback' } })
    await until(
      'sheetInspect',
      (s) => s.visible && s.title === 'Couldn’t send feedback' && !s.busy,
      'Feedback error sheet did not open'
    )
    const failed = await standard('Feedback error sheet')
    assert.deepEqual(failed.actions, ['copy', 'cancel', 'retry'])
    assert.equal(failed.defaultAction, 'retry', 'Return retries')
    assert.equal(failed.cancelAction, 'cancel', 'Esc cancels')
    assert.match(failed.detail, /gh auth login/)
    await capture('captureSheet', 'alert-feedback-error.png')
    fail = false
    await host.request('sheetPerform', { action: 'retry' })
    await until('sheetInspect', (s) => !s.visible, 'Retry did not close the error sheet')
    assert.equal(posted.length, 2, 'Retry posts the same feedback once more')
    assert.deepEqual(posted[1], posted[0])
    const toast = await until('toastInspect', (s) => s.visible, 'Feedback toast did not show')
    assert.equal(toast.message, 'Feedback sent')
    assert.equal(toast.action, 'View on GitHub')
    assert.ok(
      toast.inWindow && toast.pending,
      'The toast is in the main window and dismisses itself'
    )
    await capture('captureToast', 'feedback-toast.png')
    await host.request('toastPerform')
    await until('toastInspect', (s) => !s.visible, 'The toast action did not dismiss it')
    await until('sheetInspect', () => opened.length === 1, 'View on GitHub did not open')
    assert.deepEqual(opened, ['https://github.com/alikimovich/trezi/issues/170'])
  } finally {
    host.off('sheet-action', onSheet)
    host.off('toast-action', onToast)
    sheets.close()
  }
}
