// Disposable-copy validation: copies a Scraib repo (never writes into it), adds a manifest
// and previews, and runs the driver's PreviewSession on it.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const ROOT = process.argv[2]
const [, , , source, manifestJson, previewsFile] = process.argv
const { PreviewSession } = await import(join(ROOT, 'src/swift-preview/session.ts'))
const { MODULE_CACHE } = await import(join(ROOT, 'test/helpers/swift-build.mjs'))
const copy = mkdtempSync(join(tmpdir(), 'scraib-copy-'))
cpSync(source, copy, { recursive: true, filter: (p) => !/\/(\.git|DerivedData|build|\.build)(\/|$)/.test(p) })
writeFileSync(join(copy, 'trezi-previews.json'), manifestJson)
mkdirSync(join(copy, 'Previews'), { recursive: true })
cpSync(previewsFile, join(copy, 'Previews/TreziPreviews.swift'))
const logs = []
const session = new PreviewSession({
  root: copy, cacheDir: copy + '-cache',
  hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
  moduleCache: MODULE_CACHE, log: (l) => logs.push(l), pollMs: 150
})
session.start()
const end = Date.now() + 280_000
while (Date.now() < end && !['ready', 'failed', 'error'].includes(session.state.status)) await new Promise((r) => setTimeout(r, 200))
const s = session.state
console.log(JSON.stringify({ status: s.status, message: s.message, durationMs: s.durationMs, previews: s.previews.map((p) => p.id), diagnostics: s.diagnostics.slice(0, 8) }, null, 1))
if (s.status !== 'ready') console.log(s.output.slice(-1500))
else {
  for (const id of s.previews.map((p) => p.id)) {
    const f = await session.frame(id)
    console.log(id, f.width + 'x' + f.height, f.png.length, 'bytes', JSON.stringify(await session.describe(id)).slice(0, 200))
    writeFileSync(join(process.env.TMPDIR, 'scraib', `${process.argv[6] ?? 'x'}-${id}.png`), f.png)
  }
}
await session.stop()
rmSync(copy, { recursive: true, force: true }); rmSync(copy + '-cache', { recursive: true, force: true })
