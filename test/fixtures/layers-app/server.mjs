// Serves the layers fixture's index.html fresh each request, mirroring
// propedit-app's server.mjs — a real localhost preview is needed to drive the
// Layers panel's tree read + drag through real IPC. The page carries
// `data-trezi-source` stamps matching src/Layers.tsx.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))

const server = createServer(async (_req, res) => {
  try {
    const html = await readFile(join(dir, 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } catch {
    res.writeHead(500)
    res.end('error')
  }
})

server.listen(Number(process.env.PORT) || 0, () => {
  console.log(`  ➜  Local:   http://localhost:${server.address().port}/`)
})
