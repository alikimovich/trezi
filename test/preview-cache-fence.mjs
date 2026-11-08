import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { swiftBuild } from './helpers/swift-build.mjs'

// LKM-584: a hard preview load or reload that a newer `load` / `reload` superseded while
// WebKit cleared its caches never loads its old URL over the newer page.
if (process.platform !== 'darwin') {
  console.log('PREVIEW-CACHE-FENCE SKIP — macOS Swift toolchain required')
} else {
  const binary = swiftBuild('preview-cache-fence', [
    'test/fixtures/preview-cache-fence/main.swift',
    'src/native/PreviewCache.swift'
  ])
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(`<!doctype html><title>${req.url}</title>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const child = spawn(binary, [`http://127.0.0.1:${server.address().port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const code = await new Promise((resolve) => child.on('close', resolve))
    clearTimeout(timer)
    assert.equal(code, 0, out)
    console.log(out.trim())
  } finally {
    server.close()
  }
}
