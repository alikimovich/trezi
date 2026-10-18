import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NativePreviewCatalog } from '../shared/api'
import { type BuildReport, describeFailure, pruneModules, stamp, TargetBuilder } from './builder'
import { discoverNative } from './discovery'
import { GeneratedPreviews } from './generated'
import { type GraphOptions, graphInputs, type NativeGraph, nativeGraph } from './graph'
import { compileHost } from './host-build'
import { type PreviewEntry, PreviewHostProcess, type PreviewInputEvent } from './host-client'
import {
  collectSources,
  type Diagnostic,
  type PreviewManifest,
  parseDiagnostics,
  parseManifest
} from './manifest'
import { treeStamps } from './package-build'
import { type BuildPlan, planTargetBuild } from './plan'
import type { TargetSelection } from './targets'
import type { ToolchainOptions, ToolchainSelection } from './toolchain'
import { ToolchainPicker } from './toolchain-picker'

export interface SessionState {
  /** building: compiling; ready: the host runs the latest sources; failed: the
   *  latest build failed (an older host may still run); error: nothing to show;
   *  setup: nothing to build yet: no manifest and no target chosen (the native
   *  structure and the choices are still reported). */
  status: 'building' | 'ready' | 'failed' | 'error' | 'setup'
  name: string
  /** Successful builds so far; a new host appears with each one. */
  generation: number
  builds: number
  previews: PreviewEntry[]
  diagnostics: Diagnostic[]
  message: string
  /** The latest failed build's compiler output (tail), for the error panel. */
  output: string
  durationMs: number
  /** An older host still shows the last good build while the latest one failed. */
  stale: boolean
  /** Which manifest declared the previews: Trezi's app data, the repo, or none (generated, LKM-276). */
  manifest: { source: 'trezi' | 'repo' | 'none'; path: string; treziPath: string }
  /** Without a manifest: the target choices and the generated previews and components (LKM-276). */
  catalog: NativePreviewCatalog | null
  /** The project's schemes and target graph (LKM-273), once read. */
  native: NativeGraph | null
  /** The latest target-graph build plan, for a manifest with `target`. */
  plan: BuildPlan | null
  /** The developer directory every tool runs with, and whether it expands `#Preview` (LKM-274). */
  toolchain: ToolchainSelection | null
  /** The latest target build's settings sources, packages, resources and cache use (LKM-275). */
  build: BuildReport | null
}

const MANIFEST = 'trezi-previews.json'
const OUTPUT_TAIL = 8_000

interface LoadedManifest {
  manifest: PreviewManifest
  /** Where the manifest's `previews` paths start: the repo, or Trezi's folder for it. */
  previewRoot: string
}

/**
 * One project's previews: builds the host from the manifest's files, rebuilds when
 * they change, and swaps in the new host only once it is ready, so a failed build
 * keeps showing the last good one next to its errors. A manifest with `target`
 * builds that target's module graph first (LKM-273).
 */
export class PreviewSession {
  state: SessionState
  private host: PreviewHostProcess | null = null
  private building = false
  private pending = false
  private built = ''
  private watcher: ReturnType<typeof setInterval> | null = null
  private closed = false
  private graph: Promise<NativeGraph> | null = null
  private graphStamp = ''
  private readonly picker: ToolchainPicker
  private readonly builder: TargetBuilder
  private readonly generated: GeneratedPreviews

  constructor(
    private readonly options: {
      root: string
      cacheDir: string
      hostSource: string
      log: (line: string) => void
      /** Clang's module cache, shared by every project (default: beside `cacheDir`). */
      moduleCache?: string
      pollMs?: number
      /** Trezi's own folder for this project; a manifest there wins over the repo's. */
      manifestDir?: string
      graph?: Partial<GraphOptions>
      /** The app's developer directory setting (`TREZI_DEVELOPER_DIR`); the manifest's wins. */
      developerDir?: string
      /** Discovery and probe options (tests point them at scripted toolchains). */
      toolchain?: Partial<ToolchainOptions>
    }
  ) {
    const treziPath = options.manifestDir ? join(options.manifestDir, MANIFEST) : ''
    this.picker = new ToolchainPicker(options)
    this.builder = new TargetBuilder({
      root: options.root,
      cacheDir: options.cacheDir,
      xcodebuild: options.graph?.xcodebuild,
      xcrun: options.graph?.xcrun,
      log: options.log
    })
    const shared = join(options.cacheDir, '..')
    this.generated = new GeneratedPreviews({
      root: options.root,
      dir: options.manifestDir ?? options.cacheDir,
      toolsDir: join(shared, 'tools'),
      moduleCache: join(options.moduleCache ?? join(shared, 'ModuleCache'), 'scanner'),
      log: options.log
    })
    this.state = {
      status: 'building',
      name: '',
      generation: 0,
      builds: 0,
      previews: [],
      diagnostics: [],
      message: 'Building previews…',
      output: '',
      durationMs: 0,
      stale: false,
      manifest: { source: 'none', path: '', treziPath },
      catalog: null,
      native: null,
      plan: null,
      toolchain: null,
      build: null
    }
  }

  start(): void {
    mkdirSync(this.options.cacheDir, { recursive: true })
    void this.rebuild('Initial build')
    this.watcher = setInterval(() => {
      if (!this.building && this.fingerprint() !== this.built) void this.rebuild('Source changed')
    }, this.options.pollMs ?? 400)
  }

  async stop(): Promise<void> {
    this.closed = true
    if (this.watcher) clearInterval(this.watcher)
    await this.host?.stop()
  }

  /** Keyed by the selected toolchain, so switching toolchains starts a fresh cache. */
  private moduleCache(): string {
    const base = this.options.moduleCache ?? join(this.options.cacheDir, '..', 'ModuleCache')
    return join(base, `toolchain-${this.state.toolchain?.key || 'none'}`)
  }

  /**
   * The developer directory for this project (`toolchain.ts`): the manifest's
   * `developerDir`, else the app's, else discovery. Selected again when what it
   * depends on changed, and on a requested rebuild (which also rereads xcode-select).
   */
  async toolchain(manifest: PreviewManifest | null, force = false): Promise<ToolchainSelection> {
    const override = manifest?.developerDir
      ? { path: manifest.developerDir, from: `${this.state.manifest.path} "developerDir"` }
      : this.options.developerDir
        ? { path: this.options.developerDir, from: 'TREZI_DEVELOPER_DIR' }
        : undefined
    const selection = await this.picker.pick(override, force)
    this.state.toolchain = this.picker.current
    return selection
  }

  /**
   * The graph's inputs and the folders of every target's sources (a new file in a
   * synchronized folder changes them). Empty until the graph was first asked for.
   */
  private nativeStamp(): string {
    if (!this.graph) return ''
    const native = this.state.native
    const dirs = new Set(
      native?.containers.flatMap((c) =>
        c.targets.flatMap((t) => t.sources.map((s) => join(this.options.root, dirname(s))))
      ) ?? []
    )
    const paths = [...graphInputs(this.options.root, discoverNative(this.options.root)), ...dirs]
    return [this.state.toolchain?.key ?? '', ...paths.map(stamp)].join('\n')
  }

  /** The current manifest, or null when there is none or it does not parse. */
  private manifestOrNull(): PreviewManifest | null {
    try {
      return this.loadManifest()?.manifest ?? null
    } catch {
      return null
    }
  }

  /**
   * The project's graph, read on first use (a target build, the setup screen or the
   * page's project panel) and again when its inputs or the toolchain changed. Every
   * tool runs with the selected toolchain's `DEVELOPER_DIR`.
   */
  nativeGraph(): Promise<NativeGraph> {
    if (this.graph && this.nativeStamp() === this.graphStamp) return this.graph
    const graph = this.toolchain(this.manifestOrNull())
      .then((selection) =>
        nativeGraph(this.options.root, {
          cacheDir: join(this.options.cacheDir, `graph-${selection.key || 'none'}`),
          moduleCache: this.moduleCache(),
          env: selection.env,
          ...this.options.graph
        })
      )
      .then((read) => {
        if (this.graph !== graph) return read
        this.state.native = read
        // Reading the targets adds their folders to the stamp.
        this.graphStamp = this.nativeStamp()
        for (const error of [...read.errors, ...read.containers.flatMap((c) => c.errors)])
          this.options.log(`Swift previews: ${error}`)
        return read
      })
    this.graph = graph
    this.graphStamp = this.nativeStamp()
    return graph
  }

  /** The Trezi-side manifest if there is one, else the repo's; null when neither exists. */
  private loadManifest(): LoadedManifest | null {
    const trezi = this.state.manifest.treziPath
    const repo = join(this.options.root, MANIFEST)
    const path = trezi && existsSync(trezi) ? trezi : existsSync(repo) ? repo : ''
    this.state.manifest = {
      ...this.state.manifest,
      source: path === '' ? 'none' : path === trezi ? 'trezi' : 'repo',
      path
    }
    if (!path) return null
    return {
      manifest: parseManifest(readFileSync(path, 'utf8')),
      previewRoot: path === trezi ? dirname(trezi) : this.options.root
    }
  }

  /**
   * Both manifests and every compiled file's size and mtime; for a target build or the
   * setup screen also the graph's inputs, so a new target or file is picked up.
   */
  private fingerprint(): string {
    const parts = [join(this.options.root, MANIFEST), this.state.manifest.treziPath].map(stamp)
    try {
      const loaded = this.loadManifest()
      if (!loaded || loaded.manifest.target) parts.push(this.nativeStamp())
      // Without a manifest the saved target choice and the plan's files (LKM-276).
      if (!loaded) parts.push(stamp(this.generated.selectionPath))
      if (loaded) {
        const { manifest, previewRoot } = loaded
        for (const file of collectSources(this.options.root, manifest, manifest.sources))
          parts.push(stamp(file))
        for (const file of collectSources(previewRoot, manifest, manifest.previews))
          parts.push(stamp(file))
        for (const library of manifest.libraries)
          for (const file of collectSources(this.options.root, manifest, library.sources))
            parts.push(stamp(file))
      }
      for (const module of this.state.plan?.modules ?? [])
        for (const file of [...module.sources, ...module.entries])
          parts.push(stamp(join(this.options.root, file)))
      // Asset catalogs and local packages rebuild too (LKM-275).
      for (const { path } of this.state.plan?.resources.catalogs ?? [])
        parts.push(...treeStamps(join(this.options.root, path)))
      for (const pkg of this.state.plan?.dependencies.packages ?? [])
        if (pkg.kind === 'local') parts.push(...treeStamps(pkg.location))
    } catch {}
    return parts.join('\n')
  }

  async rebuild(reason: string): Promise<void> {
    if (this.closed) return
    if (this.building) {
      this.pending = true
      return
    }
    this.building = true
    try {
      do {
        this.pending = false
        await this.buildOnce(reason)
        reason = 'Source changed'
      } while (this.pending && !this.closed)
    } finally {
      this.building = false
    }
  }

  private async buildOnce(reason: string): Promise<void> {
    const started = Date.now()
    const builds = ++this.state.builds
    this.state = { ...this.state, status: 'building', message: `${reason}: building…` }
    let loaded: LoadedManifest | null
    let previews: string[]
    let sources: string[]
    let toolchain: ToolchainSelection
    try {
      loaded = this.loadManifest()
      toolchain = await this.toolchain(loaded?.manifest ?? null, reason === 'Rebuild requested')
      if (loaded) this.state.catalog = null
      else {
        // No manifest: Trezi generates the previews of the chosen target (LKM-276).
        const found = this.generated.manifest(await this.nativeGraph())
        this.state.catalog = this.generated.catalog
        if (!found) {
          this.built = this.fingerprint()
          return this.setup(started)
        }
        loaded = { manifest: found.manifest, previewRoot: this.generated.generatedDir }
      }
      if (!toolchain.toolchain || toolchain.toolchain.errors.length)
        throw new Error(toolchain.message)
      const { manifest, previewRoot } = loaded
      previews = collectSources(previewRoot, manifest, manifest.previews)
      sources = collectSources(this.options.root, manifest, manifest.sources)
      this.state.plan = manifest.target
        ? planTargetBuild(
            await this.nativeGraph(),
            {
              target: manifest.target,
              project: manifest.project,
              exclude: manifest.exclude,
              preview: toolchain.capability ?? undefined,
              generated: !!this.state.catalog
            },
            (file) => readFileSync(join(this.options.root, file), 'utf8'),
            { root: this.options.root, exists: existsSync, list: listDir }
          )
        : null
      this.built = this.fingerprint()
      if (this.state.plan?.blockers.length)
        throw new Error(`Cannot build ${manifest.target}: ${this.state.plan.blockers.join(' ')}`)
      sources = sources.filter((file) => !previews.includes(file))
      if (!this.state.catalog && sources.length + previews.length === 0)
        throw new Error('trezi-previews.json lists no .swift files.')
    } catch (error) {
      this.built = this.fingerprint()
      return this.fail(started, (error as Error).message, '', [])
    }
    const { manifest } = loaded
    const plan = this.state.plan
    const generated = this.state.catalog ? this.generated : null
    this.state.name = manifest.name || plan?.target || ''
    this.options.log(`Swift previews: ${reason.toLowerCase()}, compiling…`)
    // Settings, packages and resources first (LKM-275); then modules into their cached folders.
    if (reason === 'Rebuild requested') this.builder.invalidate()
    const prepared = plan
      ? await this.builder.prepare(plan, await this.nativeGraph(), toolchain)
      : null
    this.state.build = prepared?.report ?? null
    if (prepared?.error) return this.fail(started, prepared.error, '', [])
    const app = join(this.options.cacheDir, `host-${process.pid}-${builds}.app`)
    const cleanup = () => rmSync(app, { recursive: true, force: true })
    let compiled: Awaited<ReturnType<typeof compileHost>>
    // A generated entry that does not compile is left out and the build retried (LKM-276).
    for (let attempt = 0; ; attempt++) {
      try {
        if (generated && plan && prepared)
          previews = await generated.prepare(plan, prepared, toolchain)
      } catch (error) {
        return this.fail(started, (error as Error).message, '', [])
      }
      compiled = await compileHost({
        ...this.options,
        app,
        manifest,
        plan,
        prepared,
        toolchain,
        moduleCache: this.moduleCache(),
        sources: [...sources, ...previews]
      })
      if (compiled.code === 0 || !generated || attempt >= 2 || !generated.reject(compiled.output))
        break
    }
    if (this.state.build) this.state.build.modules = compiled.report
    if (this.closed) return cleanup()
    if (compiled.code !== 0) {
      cleanup()
      const failure = describeFailure(compiled, {
        root: this.options.root,
        module: compiled.failed,
        targetBuild: !!plan,
        toolchain
      })
      for (const d of failure.errors.slice(0, 20))
        this.options.log(`${d.file}:${d.line}:${d.column}: error: ${d.message}`)
      return this.fail(started, failure.message, compiled.output, failure.diagnostics)
    }
    const host = new PreviewHostProcess(compiled.executable, {
      cwd: this.options.root,
      onLog: (line) => this.options.log(`[component] ${line}`),
      onExit: (code, signal) => {
        cleanup()
        if (this.host !== host || this.closed) return
        this.host = null
        this.state = {
          ...this.state,
          status: 'error',
          stale: false,
          message: `The preview host exited (${code ?? signal}). Fix the component and save to rebuild.`
        }
        this.options.log(this.state.message)
      }
    })
    let entries: PreviewEntry[]
    try {
      entries = await host.ready
    } catch (error) {
      await host.stop()
      return this.fail(started, (error as Error).message, '', [])
    }
    generated?.hosted(entries)
    const previous = this.host
    this.host = host
    void previous?.stop()
    pruneModules(
      this.options.cacheDir,
      compiled.built.map((b) => b.dir)
    )
    const built = plan ? ` from ${plan.modules.map((m) => m.module).join(' → ')}` : ''
    const unsupported = this.state.catalog?.entries.filter((e) => !e.supported).length ?? 0
    const listed = unsupported
      ? ` ${unsupported} more listed with the reason they are not shown.`
      : ''
    const warnings = parseDiagnostics(compiled.output, this.options.root)
    this.state = {
      ...this.state,
      status: 'ready',
      generation: this.state.generation + 1,
      previews: entries,
      // Target-graph builds name the module of each diagnostic; the host is "previews".
      diagnostics: plan ? warnings.map((d) => ({ ...d, module: 'previews' })) : warnings,
      message: `Built ${entries.length} preview${entries.length === 1 ? '' : 's'}${built}.${listed}`,
      output: '',
      durationMs: Date.now() - started,
      stale: false
    }
    this.options.log(`Swift previews: ${this.state.message} (${this.state.durationMs} ms)`)
  }

  /**
   * No manifest and no target to generate previews for: report what was found, the
   * choice to make (LKM-276) and where previews can be declared instead.
   */
  private setup(started: number) {
    const native = this.state.native
    const targets = native?.containers.flatMap((c) => c.targets.map((t) => t.name)) ?? []
    const found = native?.structure
      ? `Found ${targets.length} target${targets.length === 1 ? '' : 's'}${targets.length ? ` (${targets.join(', ')})` : ''}. `
      : ''
    const choose = this.generated.reason ? `${this.generated.reason} ` : ''
    this.state = {
      ...this.state,
      status: 'setup',
      plan: null,
      build: null,
      message: `${found}${choose}No previews are declared yet: choose a target, or add ${MANIFEST} with a "target" and "previews"${this.state.manifest.treziPath ? ` at ${this.state.manifest.treziPath} (Trezi's copy; the repo stays untouched) or` : ''} in the project root.`,
      durationMs: Date.now() - started
    }
    this.options.log(`Swift previews: ${this.state.message}`)
  }

  private fail(started: number, message: string, output: string, diagnostics: Diagnostic[]) {
    this.state = {
      ...this.state,
      status: this.host ? 'failed' : 'error',
      message,
      output: output.slice(-OUTPUT_TAIL),
      diagnostics,
      durationMs: Date.now() - started,
      stale: !!this.host
    }
    this.options.log(`Swift previews: ${message}`)
  }

  /** Saves the target to generate previews for (Trezi's folder only) and rebuilds. */
  configure(selection: TargetSelection) {
    this.generated.select(selection)
    void this.rebuild('Target chosen')
  }

  private running(): PreviewHostProcess {
    if (!this.host?.alive) throw new Error('No preview host is running.')
    return this.host
  }

  async frame(preview: string) {
    return this.running().frame(preview)
  }

  async describe(preview: string) {
    return this.running().describe(preview)
  }

  async input(preview: string, event: PreviewInputEvent) {
    return this.running().input(preview, event)
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
