import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type PreviewEntry, PreviewHostProcess, type PreviewInputEvent } from './host-client'
import {
  collectSources,
  type Diagnostic,
  hostCompileArgs,
  libraryCompileArgs,
  type PreviewManifest,
  parseDiagnostics,
  parseManifest
} from './manifest'

export interface SessionState {
  /** building: compiling; ready: the host runs the latest sources; failed: the
   *  latest build failed (an older host may still run); error: nothing to show. */
  status: 'building' | 'ready' | 'failed' | 'error'
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
}

const MANIFEST = 'trezi-previews.json'
const OUTPUT_TAIL = 8_000

/**
 * One project's previews: builds the host from the manifest's files, rebuilds when
 * they change, and swaps in the new host only once it is ready, so a failed build
 * keeps showing the last good one next to its errors.
 */
export class PreviewSession {
  state: SessionState = {
    status: 'building',
    name: '',
    generation: 0,
    builds: 0,
    previews: [],
    diagnostics: [],
    message: 'Building previews…',
    output: '',
    durationMs: 0,
    stale: false
  }
  private host: PreviewHostProcess | null = null
  private building = false
  private pending = false
  private built = ''
  private watcher: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(
    private readonly options: {
      root: string
      cacheDir: string
      hostSource: string
      log: (line: string) => void
      /** Clang's module cache, shared by every project (default: beside `cacheDir`). */
      moduleCache?: string
      pollMs?: number
    }
  ) {}

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

  /** The manifest and every compiled file's size and mtime. */
  private fingerprint(): string {
    const parts: string[] = []
    const stamp = (path: string) => {
      try {
        const stat = statSync(path)
        parts.push(`${path}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        parts.push(`${path}:missing`)
      }
    }
    stamp(join(this.options.root, MANIFEST))
    try {
      const manifest = this.manifest()
      for (const file of collectSources(this.options.root, manifest)) stamp(file)
      for (const library of manifest.libraries)
        for (const file of collectSources(this.options.root, manifest, library.sources)) stamp(file)
    } catch {}
    return parts.join('\n')
  }

  private manifest(): PreviewManifest {
    return parseManifest(readFileSync(join(this.options.root, MANIFEST), 'utf8'))
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
    this.built = this.fingerprint()
    let manifest: PreviewManifest
    let sources: string[]
    try {
      manifest = this.manifest()
      sources = collectSources(this.options.root, manifest)
      if (sources.length === 0) throw new Error('trezi-previews.json lists no .swift files.')
    } catch (error) {
      return this.fail(started, (error as Error).message, '', [])
    }
    this.state.name = manifest.name
    this.options.log(`Swift previews: ${reason.toLowerCase()}, compiling ${sources.length} files…`)
    const output = join(this.options.cacheDir, `host-${process.pid}-${builds}`)
    const moduleCache = this.options.moduleCache ?? join(this.options.cacheDir, '..', 'ModuleCache')
    // Library modules first, each into this build's own folder (the host links to it).
    const libs = join(this.options.cacheDir, `libs-${process.pid}-${builds}`)
    const cleanup = () => {
      rmSync(output, { force: true })
      rmSync(libs, { recursive: true, force: true })
    }
    let compiled: Awaited<ReturnType<typeof run>> = { code: 0, output: '', spawnError: false }
    for (const library of manifest.libraries) {
      mkdirSync(libs, { recursive: true })
      this.options.log(`Swift previews: compiling library ${library.name}…`)
      compiled = await run(
        '/usr/bin/xcrun',
        libraryCompileArgs({
          name: library.name,
          sources: collectSources(this.options.root, manifest, library.sources),
          moduleCache,
          dir: libs
        }),
        this.options.root
      )
      if (compiled.code !== 0) break
    }
    if (compiled.code === 0)
      compiled = await run(
        '/usr/bin/xcrun',
        hostCompileArgs({
          host: this.options.hostSource,
          sources,
          moduleCache,
          output,
          libraries: manifest.libraries.map(({ name }) => ({ name, dir: libs }))
        }),
        this.options.root
      )
    if (this.closed) return cleanup()
    if (compiled.code !== 0) {
      cleanup()
      const diagnostics = parseDiagnostics(compiled.output, this.options.root)
      const errors = diagnostics.filter((d) => d.severity === 'error')
      const message = compiled.spawnError
        ? 'Could not run swiftc: install Xcode or its command-line tools.'
        : `Build failed: ${errors.length || 'unknown'} error${errors.length === 1 ? '' : 's'}.`
      for (const d of errors.slice(0, 20))
        this.options.log(`${d.file}:${d.line}:${d.column}: error: ${d.message}`)
      return this.fail(started, message, compiled.output, diagnostics)
    }
    const host = new PreviewHostProcess(output, {
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
    let previews: PreviewEntry[]
    try {
      previews = await host.ready
    } catch (error) {
      await host.stop()
      return this.fail(started, (error as Error).message, '', [])
    }
    const previous = this.host
    this.host = host
    void previous?.stop()
    this.state = {
      ...this.state,
      status: 'ready',
      generation: this.state.generation + 1,
      previews,
      diagnostics: parseDiagnostics(compiled.output, this.options.root),
      message: `Built ${previews.length} preview${previews.length === 1 ? '' : 's'}.`,
      output: '',
      durationMs: Date.now() - started,
      stale: false
    }
    this.options.log(`Swift previews: ${this.state.message} (${this.state.durationMs} ms)`)
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

function run(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number | null; output: string; spawnError: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-200_000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', () => resolve({ code: null, output, spawnError: true }))
    child.on('close', (code) => resolve({ code, output, spawnError: false }))
  })
}
