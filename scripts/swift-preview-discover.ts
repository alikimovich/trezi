/**
 * Prints what the Swift preview driver would discover and plan for a folder, as JSON:
 * `bun scripts/swift-preview-discover.ts <root> [--target NAME] [--project PATH]`.
 * Read-only on <root>: the SwiftPM scratch path and module cache go to a temp folder.
 * Used for the disposable-copy checks of real projects (LKM-273).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { discoverNative } from '../src/swift-preview/discovery'
import { nativeGraph } from '../src/swift-preview/graph'
import { planTargetBuild } from '../src/swift-preview/plan'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args.splice(at, 2)[1] : undefined
}
const target = flag('--target')
const project = flag('--project')
const root = resolve(args[0] ?? '.')
const temp = mkdtempSync(join(tmpdir(), 'swift-discover-'))
try {
  const graph = await nativeGraph(root, {
    cacheDir: join(temp, 'cache'),
    moduleCache: join(temp, 'module-cache')
  })
  let plan: unknown = null
  let planError = ''
  if (target)
    try {
      plan = planTargetBuild(graph, { target, project }, (path) =>
        readFileSync(join(root, path), 'utf8')
      )
    } catch (error) {
      planError = error instanceof Error ? error.message : String(error)
    }
  const report = { structure: discoverNative(root), graph, plan, planError }
  console.log(JSON.stringify(report, null, 2))
} finally {
  rmSync(temp, { recursive: true, force: true })
}
