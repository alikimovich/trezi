import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPreviewIpc } from '../src/main/preview-ipc.ts'
import { dispatchIPC, NativeView, views } from '../src/native/platform.ts'
import { inspectThreeDRoute } from '../src/native/three-d-route-trace.ts'
import { PREVIEW_TOOLBAR_ACTION } from '../src/shared/preview-channels.ts'

const hostSource = readFileSync(new URL('../src/native/Host.swift', import.meta.url), 'utf8')
assert.match(hostSource, /ThreeDStateRelay\.handle\(view: name, body: body/)
assert.match(hostSource, /guard threeD\.receive\(state, document: document\)/)
assert.match(hostSource, /guard threeD\.document == document/)

const scratch = mkdtempSync(join(tmpdir(), 'trezi-three-d-relay-'))
try {
  if (process.platform === 'darwin') {
    const binary = join(scratch, 'relay')
    const compile = Bun.spawnSync(
      [
        'swiftc',
        '-module-cache-path',
        join(scratch, 'module-cache'),
        new URL('../src/native/ThreeDStateRelay.swift', import.meta.url).pathname,
        new URL('./fixtures/three-d-state-relay.swift', import.meta.url).pathname,
        '-o',
        binary
      ],
      {
        env: {
          ...process.env,
          HOME: scratch,
          CLANG_MODULE_CACHE_PATH: join(scratch, 'module-cache')
        }
      }
    )
    assert.equal(compile.exitCode, 0, compile.stderr.toString())
    const run = Bun.spawnSync([binary])
    assert.equal(run.exitCode, 0, run.stderr.toString())
    const events = JSON.parse(run.stdout.toString())
    const preview = new NativeView('preview')
    const output = []
    const state = {
      url: 'http://127.0.0.1:7777/page',
      retries: 0,
      bounds: { x: 0, y: 0, width: 800, height: 600, radius: 0 },
      selectMode: false,
      commentMode: null,
      frameMode: false,
      layersWatch: false,
      statusText: null,
      pins: []
    }
    preview.url = state.url
    registerPreviewIpc({
      state,
      ensurePreviewView: () => preview,
      getPreviewView: () => preview,
      getMainWindow: () => null,
      sendToMain: (...args) => output.push(args),
      isLocalPreviewUrl: (url) => new URL(url).origin === new URL(state.url).origin,
      placeholderUrl: 'data:,'
    })
    const code = (source, selected, page = state.url) =>
      dispatchIPC('preview', {
        type: 'send',
        channel: PREVIEW_TOOLBAR_ACTION,
        args: [
          {
            action: 'three-d-code',
            source,
            page,
            session: 'scene-1',
            revision: 4,
            selected
          }
        ]
      })
    await dispatchIPC(events[0].view, events[0].message)
    await code('src/A.tsx:1', 0)
    assert.equal(output.at(-1)?.[1]?.source, 'src/A.tsx:1')
    assert.equal(inspectThreeDRoute()['preview-ipc']?.reason, 'forwarded')
    await dispatchIPC(events[1].view, events[1].message)
    const count = output.length
    await code('src/A.tsx:1', 0)
    assert.equal(output.length, count, 'delayed A Code cannot reopen A after B is selected')
    assert.equal(inspectThreeDRoute()['preview-ipc']?.reason, 'wrong-selection')
    await code('src/B.tsx:2', 1)
    assert.equal(
      output.at(-1)?.[1]?.source,
      'src/B.tsx:2',
      'valid B Code reaches the existing route'
    )
    assert.equal(inspectThreeDRoute()['preview-ipc']?.reason, 'forwarded')
    const beforeRoute = output.length
    const oldPage = state.url
    preview.url = `${oldPage}#next`
    await code('src/B.tsx:2', 1, oldPage)
    assert.equal(output.length, beforeRoute, 'old-route Code cannot reopen after pushState')
    assert.equal(inspectThreeDRoute()['preview-ipc']?.reason, 'stale-page')
    preview.url = oldPage
    await dispatchIPC(events[2].view, events[2].message)
    const closedCount = output.length
    await code('src/B.tsx:2', 1)
    assert.equal(output.length, closedCount, 'close invalidates the Code target')
    views.delete('preview')
  } else {
    console.log('three-d-state-routing: native relay execution requires macOS')
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log('three-d-state-routing: ok')
