import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreviewInputEvent } from './host-client'
import { previewPage } from './page'
import { PreviewSession } from './session'

/**
 * The Swift component preview driver (LKM-271): what Trezi's runtime owner runs as
 * the "dev server" of a project that has `trezi-previews.json`. It builds the
 * project's declared components into a preview host, serves the preview page on
 * HOST:PORT (both from the runtime owner) and rebuilds when the sources change.
 * Usage: `bun src/swift-preview/driver.ts [projectRoot]` (default: the cwd).
 */
const root = process.argv[2] || process.cwd()
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT) || 5199
const cacheRoot = process.env.TREZI_SWIFT_PREVIEW_CACHE || join(tmpdir(), 'trezi-swift-preview')
const project = createHash('sha256').update(root).digest('hex').slice(0, 12)
const token = randomBytes(16).toString('hex')
const inputTypes = new Set(['mousedown', 'mouseup', 'mousedrag', 'keydown', 'keyup', 'scroll'])

const session = new PreviewSession({
  root,
  cacheDir: join(cacheRoot, project),
  hostSource: join(__dirname, 'PreviewHost.swift'),
  log: (line) => console.log(line)
})

function reply(res: ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
}

const json = (res: ServerResponse, status: number, value: unknown) =>
  reply(res, status, JSON.stringify(value), 'application/json; charset=utf-8')

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      text += chunk
      if (text.length > 16_384) req.destroy(new Error('Request too large.'))
    })
    req.on('end', () => resolve(text))
    req.on('error', reject)
  })
}

/** Only this machine's preview may call in: no other Host (DNS rebinding) or origin. */
function allowed(req: IncomingMessage): boolean {
  const name = (req.headers.host ?? '').replace(/:\d+$/, '')
  return ['127.0.0.1', 'localhost', '[::1]', host].includes(name)
}

const server = createServer(async (req, res) => {
  if (!allowed(req)) return reply(res, 403, 'Forbidden', 'text/plain')
  const url = new URL(req.url ?? '/', 'http://preview.local')
  const preview = url.searchParams.get('preview') ?? ''
  try {
    if (req.method === 'GET' && url.pathname === '/')
      return reply(res, 200, previewPage(token), 'text/html; charset=utf-8')
    if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, session.state)
    if (req.method === 'GET' && url.pathname === '/frame') {
      const frame = await session.frame(preview)
      return reply(res, 200, frame.png, 'image/png')
    }
    if (req.method === 'GET' && url.pathname === '/describe')
      return json(res, 200, { texts: await session.describe(preview) })
    if (req.method === 'POST' && req.headers['x-trezi-token'] !== token)
      return reply(res, 403, 'Forbidden', 'text/plain')
    if (req.method === 'POST' && url.pathname === '/input') {
      const event = JSON.parse(await body(req)) as PreviewInputEvent
      if (!event || !inputTypes.has(event.type)) return json(res, 400, { error: 'Unknown input.' })
      await session.input(preview, event)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/rebuild') {
      void session.rebuild('Rebuild requested')
      return json(res, 202, { ok: true })
    }
    return reply(res, 404, 'Not found', 'text/plain')
  } catch (error) {
    return json(res, 409, { error: (error as Error).message })
  }
})

server.listen(port, host, () => {
  console.log(`Swift previews for ${root}`)
  console.log(`Serving at http://${host}:${port}`)
  session.start()
})

const shutdown = () => {
  server.close()
  void session.stop().finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 3_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
