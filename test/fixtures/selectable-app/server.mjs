// Serves the selectable fixture fresh each request and prints a localhost URL
// the way a real dev server does — so the runner's detect/launch/parse path
// works without auth or a real framework. The page carries `data-trezi-source`
// stamps so the v2 select-element flow can resolve a source location.
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

// Honor the PORT the runner assigns (like a real dev server) so its free-port
// allocator is what gets exercised — and a port collision would be a real bug.
server.listen(Number(process.env.PORT) || 0, () => {
  console.log(`  ➜  Local:   http://localhost:${server.address().port}/`)
})
