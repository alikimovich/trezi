import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { feedbackHandlers } from '../main/feedback'
import type { NativeSheetAction } from '../shared/native-sheet'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { showProjectMemoryNote } from './memory-note'
import { NativeSheetController } from './sheets-runtime'
import { waitFor } from './smoke-wait'
import { NativeSupportSheets } from './support-sheets'
import { nativeWorkspace } from './workspace-runtime'

/** LKM-170: app alerts are NSAlert-style sheets attached to the main window, and sent
 *  feedback is a self-dismissing toast, never a titled window. The feedback path runs on
 *  its own controller against a loopback mock of the Trezi feedback endpoint (LKM-336),
 *  with the invite code kept in memory, so nothing is sent and no Keychain is touched. */
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

  // Feedback (LKM-336): the real feedback logic against a local mock of the private Trezi
  // endpoint. The first send asks for the invite code; a failed post shows the standard
  // error sheet; Retry sends it, the screenshot is uploaded and attached, and the toast
  // names the Linear key. Nothing goes to GitHub: the IPC stub refuses every other channel.
  const mock = await feedbackMock()
  let saved: string | null = null
  const feedback = feedbackHandlers({
    code: {
      has: async () => saved !== null,
      read: async () => saved,
      save: async (code: string) => {
        saved = code
        return true
      },
      remove: async () => {
        saved = null
      }
    },
    endpoint: { origin: mock.origin, timeoutMs: 5000 },
    appVersion: () => 'Trezi smoke',
    macOS: () => 'macOS smoke'
  })
  const channels: string[] = []
  const sheets = new NativeSheetController(
    host,
    nativeWorkspace,
    nativeChat,
    async (channel, input) => {
      channels.push(channel)
      if (channel === 'feedback:account') return feedback.account()
      if (channel === 'feedback:code') return feedback.saveCode(input)
      assert.equal(channel, 'feedback:submit')
      return feedback.submit(input)
    }
  )
  const support = new NativeSupportSheets(sheets, async () => ({
    contentType: 'image/png',
    data: TINY_PNG,
    preview: `data:image/png;base64,${TINY_PNG}`
  }))
  const onSheet = (action: NativeSheetAction) => void sheets.action(action)
  const onToast = (action: { id: string; index?: number }) => void sheets.toastAction(action)
  host.on('sheet-action', onSheet)
  host.on('toast-action', onToast)
  try {
    // LKM-336: the real host capture (Host.swift `captureFeedback`) is what the form attaches in
    // the app: a real image for the endpoint, not a data URI, plus the small JPEG preview.
    const shot = await host.request('captureFeedback')
    assert.ok(shot && typeof shot === 'object', 'The host captured the window')
    const image = Buffer.from(String(shot.data), 'base64')
    assert.ok(image.length > 0 && image.length <= 10 * 1024 * 1024, `Image size ${image.length}`)
    if (shot.contentType === 'image/png')
      assert.deepEqual([...image.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature')
    else if (shot.contentType === 'image/jpeg')
      assert.deepEqual([...image.subarray(0, 2)], [0xff, 0xd8], 'JPEG start-of-image marker')
    else assert.fail(`Unexpected capture type ${shot.contentType}`)
    assert.ok(!String(shot.data).startsWith('data:'), 'The image is raw base64, not a data URI')
    assert.ok(
      String(shot.preview).startsWith('data:image/jpeg;base64,'),
      'The preview is a small JPEG data URI'
    )
    writeFileSync(
      join(
        artifacts,
        shot.contentType === 'image/png' ? 'feedback-capture.png' : 'feedback-capture.jpg'
      ),
      image
    )
    await support.feedback()
    const prompt = await until(
      'sheetInspect',
      (s) => s.visible && s.title === 'Enter your invite code',
      'Invite code prompt'
    )
    assert.match(prompt.detail, /invite code from your Trezi beta invite/)
    await host.request('sheetPerform', { action: 'continue', values: { code: 'smoke-invite' } })
    const form = await until(
      'sheetInspect',
      (s) => s.visible && s.title === 'Send feedback',
      'Feedback form'
    )
    assert.match(form.detail, /Sending as Smoke Tester\./)
    assert.match(form.detail, /privately to the Trezi developer/)
    assert.equal(saved, 'smoke-invite', 'The checked code is saved')
    await capture('captureSheet', 'feedback-form.png')
    await host.request('sheetPerform', {
      action: 'send',
      values: { body: 'Smoke feedback', screenshot: 'yes', conversation: 'no', diagnostics: 'no' }
    })
    await until(
      'sheetInspect',
      (s) => s.visible && s.title === 'Couldn’t send feedback' && !s.busy,
      'Feedback error sheet did not open'
    )
    const failed = await standard('Feedback error sheet')
    assert.deepEqual(failed.actions, ['copy', 'cancel', 'retry'])
    assert.equal(failed.defaultAction, 'retry', 'Return retries')
    assert.equal(failed.cancelAction, 'cancel', 'Esc cancels')
    assert.match(failed.detail, /down for maintenance/, 'The endpoint’s own message')
    await capture('captureSheet', 'alert-feedback-error.png')
    mock.fail = false
    await host.request('sheetPerform', { action: 'retry' })
    await until('sheetInspect', (s) => !s.visible, 'Retry did not close the error sheet')
    const posts = mock.seen.filter((r) => r.path === '/api/feedback')
    assert.equal(posts.length, 2, 'Retry sends the same feedback once more')
    assert.deepEqual(posts[1].body, posts[0].body)
    assert.deepEqual(posts[0].body, {
      body: 'Smoke feedback',
      appVersion: 'Trezi smoke',
      macOS: 'macOS smoke',
      screenshot: { contentType: 'image/png', size: Buffer.from(TINY_PNG, 'base64').length }
    })
    assert.deepEqual(
      mock.seen.map((r) => `${r.method} ${r.path} ${r.auth}`),
      [
        'GET /api/feedback/me Bearer smoke-invite',
        'POST /api/feedback Bearer smoke-invite',
        'POST /api/feedback Bearer smoke-invite',
        'PUT /upload/shot.png ',
        'POST /api/feedback/attach Bearer smoke-invite'
      ],
      'The code goes only to the endpoint; the upload carries no Bearer'
    )
    assert.deepEqual(mock.seen.at(-1)?.body, {
      issue: 'LKM-170',
      assetUrl: 'https://assets.trezi.test/shot.png'
    })
    assert.equal(mock.uploaded, Buffer.from(TINY_PNG, 'base64').length, 'The real PNG bytes')
    assert.deepEqual(
      [...new Set(channels)].sort(),
      ['feedback:account', 'feedback:code', 'feedback:submit'],
      'No GitHub channel is used'
    )
    const toast = await until('toastInspect', (s) => s.visible, 'Feedback toast did not show')
    assert.equal(toast.message, 'Feedback sent (LKM-170).')
    assert.equal(toast.action, '', 'No public page to open')
    assert.ok(
      toast.inWindow && toast.pending,
      'The toast is in the main window and dismisses itself'
    )
    assert.ok(toast.hitToast, 'The native toast takes clicks across its frame')
    assert.equal(toast.cover.length, 1, 'The visible toast covers one preview rect')
    assert.deepEqual(toast.sentCover, toast.cover, 'The host sent the laid-out toast rect')
    const pageCover = async () =>
      host.request('evaluate', {
        view: 'preview',
        isolated: true,
        code: `([...document.querySelector('[data-trezi-cover]')?.shadowRoot?.children ?? []].map(e => { const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }))`
      })
    const shields = await waitFor(async () => {
      const value = await pageCover()
      return Array.isArray(value) && value.length === 1 && value
    }, 'toast shield in the preview')
    for (const key of ['x', 'y', 'width', 'height'] as const)
      assert.ok(
        Math.abs(shields[0][key] - toast.cover[0][key]) <= 1,
        `toast shield ${key} matches its native frame`
      )
    await capture('captureToast', 'feedback-toast.png')
    // No action to press: the toast dismisses itself (6 s).
    await waitFor(
      async () => !(await host.request('toastInspect')).visible,
      'The feedback toast did not dismiss itself',
      12_000
    )
    await waitFor(
      async () => (await pageCover()).length === 0,
      'toast shield cleared after dismissal'
    )

    // LKM-177: the memory note after an automatic update offers View and Undo; Undo is
    // stubbed, so the profile's memory is untouched.
    const undone: string[] = []
    const memory = (content: string, digest: string) => ({ content, digest, updatedAt: 0 })
    showProjectMemoryNote(
      sheets,
      {
        root: '/smoke/project',
        before: memory('- Answer briefly.', 'a'),
        after: memory('- Answer briefly.\n- Check the mobile width after UI changes.', 'b')
      },
      {
        view: () => {},
        undo: async (update) => {
          undone.push(update.before.content)
          return memory(update.before.content, 'c')
        }
      }
    )
    const note = await until(
      'toastInspect',
      (s) => s.visible && s.message === 'Project memory updated: +1 rule',
      'Memory note did not show'
    )
    assert.deepEqual(note.actions, ['View', 'Undo'], 'The memory note offers View and Undo')
    assert.ok(note.hitToast && note.pending, 'The memory note takes clicks and dismisses itself')
    await capture('captureToast', 'memory-note-toast.png')
    await host.request('toastPerform', { index: 1 })
    await until('toastInspect', () => undone.length === 1, 'Undo did not run')
    assert.deepEqual(undone, ['- Answer briefly.'], 'Undo restores the memory before the update')
    await until(
      'toastInspect',
      (s) => s.visible && s.message === 'Project memory change undone',
      'Undo did not confirm itself'
    )
  } finally {
    host.off('sheet-action', onSheet)
    host.off('toast-action', onToast)
    sheets.close()
    mock.stop()
  }
}

/** A 1×1 PNG. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/**
 * The private feedback endpoint's contract, on loopback: `/me` names the tester, the first
 * report fails with a 503 until `fail` is cleared, then the report becomes `LKM-170` with
 * an upload target on the same mock.
 */
async function feedbackMock() {
  const seen: { method: string; path: string; auth: string; body: unknown }[] = []
  const state = { fail: true, uploaded: 0 }
  let origin = ''
  const answer = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const data = Buffer.concat(chunks)
    const path = new URL(request.url ?? '/', origin).pathname
    const auth = request.headers.authorization ?? ''
    if (request.method === 'PUT') {
      state.uploaded = data.length
      seen.push({ method: 'PUT', path, auth, body: null })
      return answer(response, 200, {})
    }
    const text = data.toString('utf8')
    seen.push({ method: request.method ?? '', path, auth, body: text ? JSON.parse(text) : null })
    if (auth !== 'Bearer smoke-invite')
      return answer(response, 401, { ok: false, error: 'Unknown invite code.' })
    if (path === '/api/feedback/me')
      return answer(response, 200, { ok: true, name: 'Smoke Tester' })
    if (path === '/api/feedback/attach') return answer(response, 200, { ok: true })
    if (state.fail)
      return answer(response, 503, { ok: false, error: 'Feedback is down for maintenance.' })
    answer(response, 200, {
      ok: true,
      issue: 'LKM-170',
      upload: {
        url: `${origin}/upload/shot.png`,
        headers: { 'x-smoke-upload': '1' },
        assetUrl: 'https://assets.trezi.test/shot.png'
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    seen,
    get uploaded() {
      return state.uploaded
    },
    set fail(value: boolean) {
      state.fail = value
    },
    stop: () => server.close()
  }
}
