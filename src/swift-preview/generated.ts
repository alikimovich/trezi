import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { NativePreviewCatalog } from '../shared/api'
import { type PreparedBuild, stamp } from './builder'
import { buildCatalog, type CatalogModule, type Factory } from './catalog'
import { failedEntries, type GeneratedBuild, generatePreviews } from './generate'
import type { NativeGraph } from './graph'
import type { PreviewEntry } from './host-client'
import type { PreviewManifest } from './manifest'
import type { BuildPlan } from './plan'
import { PreviewScanner } from './scanner'
import { SidecarWriter } from './sidecar'
import { chooseTarget, type TargetSelection } from './targets'
import type { ToolchainSelection } from './toolchain'

const SELECTION = 'selection.json'
const GENERATED = 'generated'

/**
 * Previews for a project with no `trezi-previews.json` (LKM-276): the target comes from
 * the saved choice, else is chosen when only one can be; its modules are scanned with
 * the selected toolchain's SwiftSyntax (`PreviewScanner.swift`), and the declarations
 * of every supported `#Preview`, `PreviewProvider` and component are written through
 * the sidecar writer into Trezi's folder for the project. A build that fails in a
 * generated entry is retried without it, and the entry says why.
 */
export class GeneratedPreviews {
  catalog: NativePreviewCatalog | null = null
  /** Why the target is what it is, or why there is none to build. */
  reason = ''
  private writer: SidecarWriter | null = null
  private readonly scanner: PreviewScanner
  private rejected: Record<string, string> = {}
  private rejectedFor = ''
  private last: { build: GeneratedBuild; factories: Factory[] } | null = null

  constructor(
    private readonly options: {
      root: string
      /** Trezi's folder for this project (never inside it). */
      dir: string
      /** Trezi's derived data for tools, shared by projects. */
      toolsDir: string
      moduleCache: string
      log: (line: string) => void
    }
  ) {
    this.scanner = new PreviewScanner({
      toolsDir: options.toolsDir,
      moduleCache: options.moduleCache,
      log: options.log
    })
  }

  private sidecar(): SidecarWriter {
    this.writer ??= new SidecarWriter(this.options.dir, this.options.root)
    return this.writer
  }

  get generatedDir(): string {
    return join(this.sidecar().dir, GENERATED)
  }

  /** The saved choice's file, stamped by the session's watcher. */
  get selectionPath(): string {
    return join(this.options.dir, SELECTION)
  }

  selection(): TargetSelection {
    try {
      const saved = JSON.parse(this.sidecar().read(SELECTION) ?? '{}')
      return {
        project: typeof saved.project === 'string' ? saved.project : undefined,
        target: typeof saved.target === 'string' ? saved.target : undefined
      }
    } catch {
      return {}
    }
  }

  /** Saves the user's target choice (only into Trezi's folder). */
  select(selection: TargetSelection) {
    if (!selection.target) throw new Error('Choose a target to preview.')
    this.sidecar().write(
      SELECTION,
      `${JSON.stringify({ project: selection.project, target: selection.target }, null, 2)}\n`
    )
    this.rejected = {}
  }

  /**
   * The manifest a generated build runs with, or null while there is no target to
   * build (the catalog then carries the choices and the reason).
   */
  manifest(graph: NativeGraph): { manifest: PreviewManifest } | null {
    const decision = chooseTarget(graph, this.selection())
    this.reason = decision.reason
    const dir = this.generatedDir
    if (decision.status !== 'chosen') {
      this.catalog = {
        target: '',
        project: '',
        chosenBy: '',
        choices: decision.choices,
        entries: [],
        dir,
        retries: 0
      }
      this.last = null
      return null
    }
    const { choice } = decision
    const same = this.catalog?.target === choice.target && this.catalog.project === choice.project
    this.catalog = {
      target: choice.target,
      project: choice.project,
      chosenBy: decision.reason,
      choices: decision.choices,
      entries: same ? (this.catalog?.entries ?? []) : [],
      dir,
      retries: 0
    }
    return {
      manifest: {
        name: choice.target,
        sources: [],
        previews: [],
        exclude: [],
        libraries: [],
        target: choice.target,
        project: choice.project
      }
    }
  }

  /**
   * Scans the plan's modules, writes their declarations and adds them to the build:
   * support files and overlays per module, and the host's file, which it returns.
   */
  async prepare(
    plan: BuildPlan,
    prepared: PreparedBuild,
    toolchain: ToolchainSelection
  ): Promise<string[]> {
    const { root } = this.options
    const modules: CatalogModule[] = plan.modules.map((m) => ({
      module: m.module,
      sources: m.sources.map((file) => join(root, file)),
      entries: m.entries.map((file) => join(root, file))
    }))
    const files = modules.flatMap((m) => [...m.sources, ...m.entries])
    // A compile error rules entries out until a source changes.
    const sources = files.map(stamp).join('\n')
    if (sources !== this.rejectedFor) {
      this.rejected = {}
      this.rejectedFor = sources
    }
    const scans = await this.scanner.scan(files, toolchain)
    for (const scan of scans.values())
      if (scan.error) this.options.log(`Swift previews: could not read ${scan.path}: ${scan.error}`)
    const { entries, factories } = buildCatalog({ root, modules, scans, rejected: this.rejected })
    const build = generatePreviews({
      root,
      modules,
      factories,
      scans,
      read: (path) => readFileSync(path, 'utf8')
    })
    const writer = this.sidecar()
    writer.writeSet(GENERATED, build.files)
    const dir = this.generatedDir
    // A retry prepares again: replace what the previous attempt added.
    for (const [module, support] of Object.entries(build.support))
      prepared.generated[module] = [
        ...(prepared.generated[module] ?? []).filter((path) => !path.startsWith(`${dir}${sep}`)),
        ...support.map((rel) => join(dir, rel))
      ]
    prepared.overlays = Object.fromEntries(
      Object.entries(build.overlays).map(([original, rel]) => [original, join(dir, rel)])
    )
    this.last = { build, factories }
    if (this.catalog) this.catalog.entries = entries
    const supported = entries.filter((e) => e.supported).length
    this.options.log(
      `Swift previews: generated ${supported} of ${entries.length} previews and components into Trezi's folder.`
    )
    return [join(dir, build.host)]
  }

  /**
   * Rules out the entries a failed compile's errors point at; true when there are new
   * ones, so the build is worth retrying without them.
   */
  reject(output: string): boolean {
    if (!this.last) return false
    const { rejected } = failedEntries(
      output,
      this.last.build,
      this.generatedDir,
      this.last.factories
    )
    const fresh = Object.keys(rejected).filter((id) => !this.rejected[id])
    if (!fresh.length) return false
    for (const id of fresh) this.rejected[id] = rejected[id]
    if (this.catalog) this.catalog.retries++
    this.options.log(
      `Swift previews: ${fresh.length} generated preview${fresh.length === 1 ? '' : 's'} did not compile; building without ${fresh.length === 1 ? 'it' : 'them'}.`
    )
    return true
  }

  /** Supported entries the host did not list were compiled out (`#if`, `if #available`). */
  hosted(previews: PreviewEntry[]) {
    const ids = new Set(previews.map((p) => p.id))
    for (const entry of this.catalog?.entries ?? [])
      if (entry.supported && !ids.has(entry.id)) {
        const conditions = entry.notes.filter(
          (n) => n.startsWith('only where') || n.startsWith('needs macOS')
        )
        entry.supported = false
        entry.reason = conditions.length
          ? `it is compiled out for the preview host (${conditions.join('; ')})`
          : 'the preview host did not list it'
      }
  }
}
