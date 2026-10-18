// LKM-273 disposable-copy check: copies a Scraib repo (never writes into it), puts the
// manifest and previews in a Trezi-side folder (so even the copy's tree is untouched),
// and runs the target-graph build of the named target.
// node --experimental-strip-types check-target.mjs <trezi root> <source> <target> <previews.swift> [exclude,…]
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [, , ROOT, source, target, previewsFile, exclude = ''] = process.argv
const { PreviewSession } = await import(join(ROOT, 'src/swift-preview/session.ts'))
const { treziManifestDir } = await import(join(ROOT, 'src/main/swift-preview.ts'))
const { MODULE_CACHE } = await import(join(ROOT, 'test/helpers/swift-build.mjs'))
const temp = mkdtempSync(join(tmpdir(), 'scraib-target-'))
const copy = join(temp, 'copy')
cpSync(source, copy, {
  recursive: true,
  filter: (p) => !/\/(\.git|DerivedData|build|\.build)(\/|$)/.test(p)
})
const manifestDir = treziManifestDir(copy, join(temp, 'userData'))
mkdirSync(join(manifestDir, 'Previews'), { recursive: true })
cpSync(previewsFile, join(manifestDir, 'Previews/TreziPreviews.swift'))
const manifest = { name: 'Scraib (disposable copy)', target, previews: ['Previews'] }
if (exclude) manifest.exclude = exclude.split(',')
writeFileSync(join(manifestDir, 'trezi-previews.json'), JSON.stringify(manifest))
const logs = []
const session = new PreviewSession({
  root: copy,
  cacheDir: join(temp, 'cache'),
  hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
  moduleCache: MODULE_CACHE,
  log: (l) => logs.push(l),
  pollMs: 150,
  manifestDir
})
session.start()
const end = Date.now() + 280_000
while (Date.now() < end && !['ready', 'failed', 'error'].includes(session.state.status))
  await new Promise((r) => setTimeout(r, 200))
const s = session.state
const errors = s.diagnostics.filter((d) => d.severity === 'error')
const byFile = {}
for (const d of errors) byFile[d.file] = (byFile[d.file] ?? 0) + 1
const report = {
  manifest,
  status: s.status,
  message: s.message,
  durationMs: s.durationMs,
  plan: s.plan && {
    target: s.plan.target,
    modules: s.plan.modules.map((m) => ({
      module: m.module,
      dependencies: m.dependencies,
      sources: m.sources.length,
      entries: m.entries
    })),
    blockers: s.plan.blockers,
    warnings: s.plan.warnings
  },
  errorsByFile: byFile,
  firstErrors: errors.slice(0, 6).map((d) => `${d.module} ${d.file}:${d.line}: ${d.message}`),
  previews: s.previews.map((p) => p.id),
  frames: {}
}
if (s.status === 'ready')
  for (const id of report.previews) {
    const f = await session.frame(id)
    report.frames[id] = { width: f.width, height: f.height, texts: await session.describe(id) }
    writeFileSync(join(process.env.TMPDIR, `scraib-target-${id}.png`), f.png)
  }
console.log(JSON.stringify(report, null, 2))
await session.stop()
rmSync(temp, { recursive: true, force: true })
