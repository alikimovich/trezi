// LKM-196: open_preview reports the real result (HTTP status, load error, dev-server
// state) and the preview shows a loading / error state instead of a blank page.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { previewServers } from '../src/main/preview-evidence.ts'
import { PreviewLoads, previewLoads } from '../src/main/preview-loads.ts'
import { openAgentPreview } from '../src/main/preview-tools.ts'
import { loadErrorStatus } from '../src/native/preview-load-runtime.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const listen = (handler) =>
  new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
const close = (server) => new Promise((resolve) => server.close(() => resolve()))

// The reducer: a slow navigation shows a loading pill, an HTTP error an error pill.
{
  const loads = new PreviewLoads(20)
  let changes = 0
  loads.onChange = () => changes++
  loads.record({ type: 'start', url: 'http://127.0.0.1:1/slow' })
  assert.equal(loads.banner, null, 'a quick navigation never flashes the pill')
  await wait(50)
  assert.deepEqual(loads.banner, { kind: 'loading', path: '/slow' })
  loads.record({ type: 'response', url: 'http://127.0.0.1:1/slow', status: 200 })
  loads.record({ type: 'loaded', url: 'http://127.0.0.1:1/slow' })
  assert.equal(loads.banner, null)
  loads.record({ type: 'start', url: 'http://127.0.0.1:1/boom' })
  loads.record({ type: 'response', url: 'http://127.0.0.1:1/boom', status: 500 })
  loads.record({ type: 'loaded', url: 'http://127.0.0.1:1/boom' })
  assert.equal(loads.banner?.kind, 'error')
  assert.equal(loads.banner?.status, 500)
  assert.equal(loads.banner?.path, '/boom')
  loads.record({ type: 'start', url: 'http://127.0.0.1:1/next' })
  assert.equal(loads.banner, null, 'a new navigation clears the error pill')
  loads.record({ type: 'cancelled', url: 'http://127.0.0.1:1/next' })
  await wait(50)
  assert.equal(loads.banner, null, 'a cancelled navigation leaves no pill behind')
  loads.record({ type: 'start', url: 'http://127.0.0.1:1/boom' })
  loads.record({ type: 'response', url: 'http://127.0.0.1:1/boom', status: 404 })
  loads.record({ type: 'loaded', url: 'http://127.0.0.1:1/boom' })
  loads.dismiss()
  assert.equal(loads.banner, null)
  assert(changes >= 4)
  const waiter = loads.nextLoad('http://127.0.0.1:1/a#x', 1000)
  loads.record({ type: 'start', url: 'http://127.0.0.1:1/other' })
  loads.record({ type: 'loaded', url: 'http://127.0.0.1:1/other' })
  loads.record({ type: 'start', url: 'http://127.0.0.1:1/a' })
  loads.record({ type: 'loaded', url: 'http://127.0.0.1:1/a' })
  assert.equal((await waiter.done)?.finalUrl, 'http://127.0.0.1:1/a', 'only the target settles')
}

// A stand-in for the native host: it handles `preview:open` and reports WebKit events.
const root = '/project-preview-open'
const nativeHost = (script) => (channel, request) => {
  assert.equal(channel, 'preview:open')
  setTimeout(() => script(request), 5)
}
const open = (path, script) =>
  openAgentPreview(root, 'chat-preview-open', { path }, nativeHost(script))

const failing = await listen((_req, res) => {
  res.writeHead(500, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>Internal Server Error</title>')
})
try {
  const url = `http://127.0.0.1:${failing.address().port}`
  previewServers.set(projectKey(root), { url })

  // HTTP 500: the page "loads", but the tool and the preview say it is an error page.
  const served = await open('/broken?x=1', (request) => {
    assert.equal(request.now, true)
    previewLoads.dispatched(request.id, 'loading')
    previewLoads.record({ type: 'start', url: `${url}/broken?x=1` })
    previewLoads.record({ type: 'response', url: `${url}/broken?x=1`, status: 500 })
    previewLoads.record({ type: 'loaded', url: `${url}/broken?x=1` })
  })
  assert.equal(served.requested, true)
  assert.equal(served.navigation, 'loaded')
  assert.equal(served.finalUrl, `${url}/broken?x=1`)
  assert.equal(served.httpStatus, 500)
  assert.equal(served.loadError, 'HTTP 500')
  assert.equal(served.devServer.running, true)
  assert.match(served.message, /HTTP 500/)
  assert.deepEqual(previewLoads.banner, {
    kind: 'error',
    path: '/broken?x=1',
    status: 500,
    message: 'The dev server answered HTTP 500.'
  })

  // Deferred until the turn lands: reported as requested, with what the server says now.
  const deferred = await open('/later', (request) =>
    previewLoads.dispatched(request.id, 'deferred')
  )
  assert.equal(deferred.navigation, 'deferred')
  assert.equal(deferred.loaded, false)
  assert.equal(deferred.devServer.status, 500)
  assert.match(deferred.message, /after this turn lands/)
  assert.match(deferred.message, /HTTP 500/)
} finally {
  await close(failing)
}

// Server down: the load fails, the probe is refused, the result offers Restart.
{
  const gone = await listen((_req, res) => res.end())
  const url = `http://127.0.0.1:${gone.address().port}`
  await close(gone)
  previewServers.set(projectKey(root), { url })
  const failure = { view: 'preview', url: `${url}/`, message: 'Could not connect to the server.' }
  const down = await open('/', (request) => {
    previewLoads.dispatched(request.id, 'loading')
    previewLoads.record({ type: 'start', url: `${url}/` })
    previewLoads.record({ type: 'failed', url: failure.url, message: failure.message })
  })
  assert.equal(down.navigation, 'failed')
  assert.equal(down.loaded, false)
  assert.equal(down.loadError, 'Could not connect to the server.')
  assert.equal(down.devServer.answering, false)
  assert.match(down.message, /press Restart/)
  assert.match(down.message, /Do not start it yourself/)
  assert.equal(previewLoads.banner, null, 'a failed load is the status overlay, not the pill')
  // The preview's status overlay: a clear error with Restart, never blank white.
  assert.deepEqual(loadErrorStatus(failure), {
    kind: 'error',
    message:
      'The preview could not open /: Could not connect to the server. The dev server may have stopped; Restart starts it again.',
    restart: true
  })
}

// No dev server at all: nothing loads, and the tool says to Restart.
{
  previewServers.delete(projectKey(root))
  const none = await open('/', () => {})
  assert.equal(none.navigation, 'waiting-for-server')
  assert.equal(none.devServer.running, false)
  assert.match(none.message, /dev server is stopped/)
  assert.match(none.message, /press Restart/)
}

console.log(
  'PREVIEW-OPEN OK — loading/error pill, HTTP 500 reported, deferred probe, server down + Restart'
)
