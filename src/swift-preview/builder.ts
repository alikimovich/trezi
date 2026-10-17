import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveXcodeSettings } from './build-settings'
import type { NativeGraph } from './graph'
import {
  collectSources,
  type Diagnostic,
  libraryCompileArgs,
  type PreviewManifest,
  parseDiagnostics
} from './manifest'
import { buildPackages, treeStamps } from './package-build'
import type { BuildPlan } from './plan'
import { compileResources, hasSymbols, placeAssets } from './resources'
import { mapBuildSettings, maxVersion } from './settings'
import type { ToolchainSelection } from './toolchain'

/**
 * The build authority of a target-graph preview build (LKM-275), between the plan and
 * the host: resolves each module's settings (`xcodebuild -showBuildSettings` for the
 * scheme, a package's manifest, else the project file) and maps them to flags
 * (`settings.ts`), builds the Swift package dependencies (`package-build.ts`), links
 * binary frameworks, compiles asset catalogs and their symbols (`resources.ts`), and
 * compiles every module into its own cached folder of Trezi's derived data, keyed by
 * the toolchain, the mapped settings, its sources and its dependencies' keys. Nothing
 * is written to the project. No tool runs with its sandbox disabled.
 */
export interface BuildReport {
  /** Trezi's derived data for this project and toolchain. */
  derivedData: string
  /** Where the settings came from, per module (`xcodebuild (scheme S)`, `package manifest`, `project file`). */
  settingsFrom: Record<string, string>
  errors: string[]
  /** Files xcodebuild left in the project (expected: none). */
  leftovers: string[]
  modules: { module: string; cached: boolean; key: string; durationMs: number }[]
  packages: {
    key: string
    cached: boolean
    durationMs: number
    bin: string
    bundles: string[]
  } | null
  resources: { assets: string; symbols: string[]; cached: boolean; errors: string[] } | null
}

export interface PreparedBuild {
  /** Package and framework search paths for every module and the host. */
  compile: string[]
  /** Package and framework link flags for every module and the host. */
  link: string[]
  /** Module → generated sources compiled into it (asset symbols). */
  generated: Record<string, string[]>
  /** Module → the `Assets.car` of its own catalogs, placed beside its dylib. */
  moduleAssets: Record<string, string>
  /** The host's deployment target (the highest of its modules and packages). */
  deploymentTarget: string
  assets: string
  accentColor: string
  /** Part of every module key: the package build's key. */
  salt: string
  report: BuildReport
  /** Set when the build cannot go on. */
  error: string
}

export interface ModuleInput {
  module: string
  /** Absolute sources. */
  sources: string[]
  /** Direct dependencies, built earlier. */
  dependencies: string[]
  testing: boolean
  flags: string[]
  /** Its compiled `Assets.car`, '' when none: `Bundle(for:)` of its classes finds it. */
  assets: string
}

export const ARCH = process.arch === 'x64' ? 'x86_64' : 'arm64'
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const yes = (value: string | undefined) => /^(YES|TRUE|1)$/i.test((value ?? '').trim())

export class TargetBuilder {
  private memo: { key: string; resolved: Awaited<ReturnType<typeof resolveXcodeSettings>> } | null =
    null

  constructor(
    private readonly options: {
      root: string
      cacheDir: string
      xcodebuild?: string
      xcrun?: string
      log: (line: string) => void
    }
  ) {}

  /** A requested rebuild reads the settings again (an edited `.xcconfig` is not stamped). */
  invalidate() {
    this.memo = null
  }

  /**
   * Resolves and maps each plan module's settings (stored on the plan), then builds the
   * packages and resources the modules need.
   */
  async prepare(
    plan: BuildPlan,
    graph: NativeGraph,
    toolchain: ToolchainSelection
  ): Promise<PreparedBuild> {
    const { root, cacheDir } = this.options
    const derivedData = join(cacheDir, `xcode-${toolchain.key || 'none'}`)
    const report: BuildReport = {
      derivedData,
      settingsFrom: {},
      errors: [],
      leftovers: [],
      modules: [],
      packages: null,
      resources: null
    }
    const prepared: PreparedBuild = {
      compile: [],
      link: [],
      generated: {},
      moduleAssets: {},
      deploymentTarget: '',
      assets: '',
      accentColor: '',
      salt: '',
      report,
      error: ''
    }
    const container = graph.containers.find((c) => c.path === plan.container)
    const targets = new Map((container?.targets ?? []).map((t) => [t.name, t]))
    let resolved: Record<string, Record<string, string>> = {}
    let scheme = ''
    if (container?.kind === 'project') {
      const key = [
        toolchain.key,
        ...plan.modules.map((m) => m.target),
        ...treeStamps(join(root, container.path))
      ].join('\n')
      if (this.memo?.key !== key) {
        this.options.log(`Swift previews: resolving build settings of ${container.path}…`)
        const found = await resolveXcodeSettings(
          root,
          container,
          plan.modules.map((m) => m.target),
          { derivedData, env: toolchain.env, xcodebuild: this.options.xcodebuild }
        )
        this.memo = { key, resolved: found }
      }
      resolved = this.memo.resolved.targets
      scheme = this.memo.resolved.scheme
      report.errors.push(...this.memo.resolved.errors)
      report.leftovers.push(...this.memo.resolved.leftovers)
    }

    const symbols: Record<string, { enabled: boolean; extensions: boolean }> = {}
    for (const module of plan.modules) {
      const target = targets.get(module.target)
      const xcode = resolved[module.target]
      const values = xcode ?? target?.settings ?? {}
      const from = xcode
        ? 'xcodebuild'
        : container?.kind === 'package'
          ? 'package manifest'
          : 'project file'
      report.settingsFrom[module.module] = xcode ? `xcodebuild (scheme ${scheme})` : from
      const products = [
        values.BUILT_PRODUCTS_DIR,
        values.TARGET_BUILD_DIR,
        values.CONFIGURATION_BUILD_DIR,
        values.BUILD_DIR,
        derivedData
      ].filter((dir): dir is string => !!dir)
      module.settings = mapBuildSettings(values, { from, arch: ARCH, exists: existsSync, products })
      if (
        yes(values.STRING_CATALOG_GENERATE_SYMBOLS) &&
        target?.resources.some((r) => r.endsWith('.xcstrings'))
      )
        module.settings.notes.push(
          'String Catalog symbols are not generated: code using them does not compile.'
        )
      for (const note of target?.notes ?? [])
        if (/run-script phase/.test(note))
          module.settings.notes.push(`${note}: files it generates are missing.`)
      // The resolved module name wins over the project file's guess.
      const name = (xcode?.PRODUCT_MODULE_NAME ?? '').trim()
      if (name && name !== module.module && IDENTIFIER.test(name)) {
        for (const other of plan.modules)
          other.dependencies = other.dependencies.map((d) => (d === module.module ? name : d))
        for (const entry of Object.values(plan.resources).flat())
          if (entry.module === module.module) entry.module = name
        module.settings.notes.push(
          `Built as module ${name} (PRODUCT_MODULE_NAME), not ${module.module}.`
        )
        module.module = name
      }
      symbols[module.module] = {
        enabled: values.ASSETCATALOG_COMPILER_GENERATE_ASSET_SYMBOLS?.trim() !== 'NO',
        extensions: yes(values.ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS)
      }
      prepared.deploymentTarget = maxVersion(
        prepared.deploymentTarget,
        module.settings.deploymentTarget
      )
      if (module.target === plan.target)
        prepared.accentColor = values.ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME?.trim() ?? ''
    }
    prepared.deploymentTarget ||= '14.0'

    const { packages, binaries } = plan.dependencies
    if (packages.length) {
      this.options.log(
        `Swift previews: building packages ${packages.map((p) => p.identity).join(', ')}…`
      )
      const built = await buildPackages(plan.dependencies, {
        cacheDir,
        root,
        toolchainKey: toolchain.key,
        env: toolchain.env,
        arch: ARCH,
        deploymentTarget: prepared.deploymentTarget,
        xcrun: this.options.xcrun
      })
      report.packages = {
        key: built.key,
        cached: built.cached,
        durationMs: built.durationMs,
        bin: built.bin,
        bundles: built.bundles
      }
      report.leftovers.push(...built.leftovers)
      if (built.error) {
        prepared.error = `The Swift packages did not build: ${built.error}`
        report.errors.push(prepared.error)
        if (built.output.trim())
          this.options.log(built.output.trim().split('\n').slice(-12).join('\n'))
        return prepared
      }
      prepared.compile.push(...built.compileFlags)
      prepared.link.push(...built.linkFlags)
      prepared.salt = built.key
    }
    for (const binary of binaries) {
      prepared.compile.push('-F', binary.searchDir)
      prepared.link.push(
        '-framework',
        binary.framework,
        '-Xlinker',
        '-rpath',
        '-Xlinker',
        binary.searchDir
      )
    }

    if (plan.resources.catalogs.length) {
      const compiled = await compileResources(plan.resources, {
        root,
        cacheDir,
        toolchainKey: toolchain.key,
        env: toolchain.env,
        deploymentTarget: prepared.deploymentTarget,
        symbols,
        xcrun: this.options.xcrun
      })
      for (const [module, file] of Object.entries(compiled.symbols))
        if (hasSymbols(file)) prepared.generated[module] = [file]
      prepared.assets = compiled.assets
      prepared.moduleAssets = compiled.modules
      report.resources = {
        assets: compiled.assets,
        symbols: Object.keys(prepared.generated),
        cached: compiled.cached,
        errors: compiled.errors
      }
      // Not fatal: code that uses no asset still builds; what does fails with its error.
      report.errors.push(...compiled.errors)
    }
    return prepared
  }
}

/** The modules a build compiles: the manifest's libraries, then the plan's modules. */
export function moduleInputs(
  root: string,
  manifest: PreviewManifest,
  plan: BuildPlan | null,
  prepared: PreparedBuild | null
): ModuleInput[] {
  return [
    ...manifest.libraries.map((library) => ({
      module: library.name,
      sources: collectSources(root, manifest, library.sources),
      dependencies: [],
      testing: false,
      flags: [],
      assets: ''
    })),
    ...(plan?.modules ?? []).map((module) => ({
      module: module.module,
      sources: [
        ...module.sources.map((file) => join(root, file)),
        ...(prepared?.generated[module.module] ?? [])
      ],
      dependencies: module.dependencies,
      testing: true,
      flags: module.settings?.flags ?? [],
      assets: prepared?.moduleAssets[module.module] ?? ''
    }))
  ]
}

/** A module's cache key: toolchain, flags, sources and its dependencies' keys. */
export function moduleKey(parts: {
  toolchain: string
  module: ModuleInput
  shared: string[]
  dependencyKeys: string[]
}): string {
  const { module } = parts
  return createHash('sha256')
    .update(
      JSON.stringify([
        parts.toolchain,
        module.module,
        module.testing,
        module.flags,
        parts.shared,
        module.sources.map(stamp),
        parts.dependencyKeys
      ])
    )
    .digest('hex')
    .slice(0, 16)
}

/**
 * Compiles the modules in order, each into `cacheDir/modules/<module>-<key>`; a folder
 * with a finished build is reused. Stops at the first module that fails.
 */
export async function compileModules(
  modules: ModuleInput[],
  options: {
    root: string
    cacheDir: string
    toolchainKey: string
    moduleCache: string
    env: Record<string, string>
    compile: string[]
    link: string[]
    salt: string
    log: (line: string) => void
  }
) {
  const built: { name: string; dir: string; key: string }[] = []
  const report: BuildReport['modules'] = []
  let result: Awaited<ReturnType<typeof run>> = { code: 0, output: '', spawnError: false }
  let failed = ''
  for (const module of modules) {
    const started = Date.now()
    const direct = built.filter((b) => module.dependencies.includes(b.name))
    const key = moduleKey({
      toolchain: options.toolchainKey,
      module,
      shared: [...options.compile, ...options.link, options.salt],
      dependencyKeys: built.map((b) => b.key)
    })
    const dir = join(options.cacheDir, 'modules', `${module.module}-${key}`)
    const cached = existsSync(join(dir, '.complete'))
    if (!cached) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      options.log(`Swift previews: compiling library ${module.module}…`)
      // Every earlier module is importable (transitive imports); direct ones are linked.
      const visible = built.filter((b) => !direct.includes(b)).flatMap((b) => ['-I', b.dir])
      result = await run(
        '/usr/bin/xcrun',
        libraryCompileArgs({
          name: module.module,
          sources: module.sources,
          moduleCache: options.moduleCache,
          dir,
          testing: module.testing,
          dependencyDirs: direct.map(({ name, dir }) => ({ name, dir })),
          flags: [...module.flags, ...options.compile, ...visible],
          link: options.link
        }),
        options.root,
        options.env
      )
      if (result.code !== 0) {
        failed = module.module
        rmSync(dir, { recursive: true, force: true })
        break
      }
      writeFileSync(join(dir, '.complete'), '')
    } else options.log(`Swift previews: library ${module.module} is up to date.`)
    placeAssets(module.assets, dir, module.module)
    built.push({ name: module.module, dir, key })
    report.push({ module: module.module, cached, key, durationMs: Date.now() - started })
  }
  return { ...result, failed, built, report }
}

/**
 * A failed compile's diagnostics and message. Target-graph builds name the module of
 * each diagnostic; the host is "previews".
 */
export function describeFailure(
  result: { output: string; spawnError: boolean },
  context: { root: string; module: string; targetBuild: boolean; toolchain: ToolchainSelection }
) {
  const found = parseDiagnostics(result.output, context.root)
  const diagnostics: Diagnostic[] = context.targetBuild
    ? found.map((d) => ({ ...d, module: context.module || 'previews' }))
    : found
  const errors = diagnostics.filter((d) => d.severity === 'error')
  const where = context.module && context.targetBuild ? ` in ${context.module}` : ''
  // A #Preview the toolchain cannot expand: say which toolchain and what to do.
  const { toolchain } = context
  const macros =
    /PreviewsMacros|swift-plugin-server/.test(result.output) &&
    toolchain.capability?.status !== 'supported'
      ? ` ${toolchain.message}`
      : ''
  const message = result.spawnError
    ? 'Could not run swiftc: install Xcode or its command-line tools.'
    : `Build failed${where}: ${errors.length || 'unknown'} error${errors.length === 1 ? '' : 's'}.${macros}`
  return { message, diagnostics, errors }
}

/** Removes cached module folders the current build does not use. */
export function pruneModules(cacheDir: string, keep: string[]) {
  const base = join(cacheDir, 'modules')
  let names: string[] = []
  try {
    names = readdirSync(base)
  } catch {}
  for (const name of names)
    if (!keep.includes(join(base, name))) rmSync(join(base, name), { recursive: true, force: true })
}

export function stamp(path: string): string {
  if (!path) return ''
  try {
    const stat = statSync(path)
    return `${path}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `${path}:missing`
  }
}

export function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>
): Promise<{ code: number | null; output: string; spawnError: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
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
