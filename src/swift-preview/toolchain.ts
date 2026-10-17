import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import type { NativeToolchainInfo } from '../shared/api'
import { runTool } from './graph'

/**
 * Which developer directory builds the previews (LKM-274, `docs/SWIFT-PREVIEWS-PLAN.md`
 * Stage 2A). `#Preview` needs the `PreviewsMacros` compiler plugin, which only full
 * Xcode ships; the command-line tools lack it. Trezi never changes the machine's
 * `xcode-select`: it finds every installed developer directory, picks one, and passes
 * it as `DEVELOPER_DIR` to every tool it spawns for this project only. Order: an
 * explicit setting, then `DEVELOPER_DIR` from the environment, then the newest full Xcode
 * that can expand `#Preview`, then `xcode-select -p`. The pick is checked by compiling
 * a tiny intact `#Preview`; the result is cached by toolchain path, versions and SDK.
 */
export interface Toolchain {
  developerDir: string
  kind: 'xcode' | 'clt' | 'unknown'
  /** How it was found: "setting", "DEVELOPER_DIR", "/Applications", "xcode-select", "command-line tools". */
  foundBy: string[]
  /** "Xcode 26.5 (17F42)", "Command Line Tools" or the path. */
  label: string
  xcodeVersion: string
  xcodeBuild: string
  swiftVersion: string
  sdkVersion: string
  sdkPath: string
  /** The `libPreviewsMacros.dylib` found in the toolchain's plugin folders, '' if none. */
  previewsMacros: string
  /** Why it cannot build at all (missing folder, no swiftc, no macOS SDK). */
  errors: string[]
}

export interface PreviewCapability {
  /**
   * supported: an intact `#Preview` compiled; unsupported: no PreviewsMacros; broken: it
   * failed otherwise; unavailable: the compiler's plugin server could not start in this
   * environment (Trezi run inside another sandbox), which says nothing about the
   * toolchain and is not cached. Trezi never disables the compiler's plugin sandbox.
   */
  status: 'supported' | 'unsupported' | 'broken' | 'unavailable'
  message: string
  /** Read from the probe cache instead of compiled now. */
  cached: boolean
  durationMs: number
}

export interface ToolchainSelection {
  toolchain: Toolchain | null
  reason: string
  capability: PreviewCapability | null
  candidates: Toolchain[]
  /** Passed to every spawned tool: `{ DEVELOPER_DIR }`, empty when nothing was found. */
  env: Record<string, string>
  /** Build caches are keyed by it: toolchain path, versions and SDK. */
  key: string
  /** One sentence for the user: what builds the previews, or what to do. */
  message: string
  /** `xcode-select -p` when selecting, read only: Trezi never changes it. */
  systemDefault: string
}

export interface ToolchainOptions {
  /** An explicit developer directory (or `.app`) and where it was set. Wins over everything. */
  override?: { path: string; from: string }
  /** `DEVELOPER_DIR` from the environment (default: this process's). */
  environment?: string
  /** Folders searched for `Xcode*.app` (default `/Applications`). */
  applications?: string[]
  commandLineTools?: string
  xcodeSelect?: string
  xcrun?: string
  plutil?: string
  /** The probe results, shared by every project. */
  cacheFile: string
  /** Where the probe's source and module cache live. */
  workDir: string
  timeoutMs?: number
}

const PLUGIN = 'libPreviewsMacros.dylib'
const PLUGIN_DIRS = [
  'Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins',
  'Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins',
  'usr/lib/swift/host/plugins'
]
const PROBE = `import SwiftUI

struct TreziPreviewProbe: View {
  var body: some View { Text("Probe") }
}

#Preview { TreziPreviewProbe() }
`
const NOT_FOUND = /plugin for module 'PreviewsMacros' not found/
/** The plugin server's own sandbox could not start (nested sandbox): an environment failure. */
const ENVIRONMENT = /produced malformed response|sandbox_apply|sandbox-exec|Operation not permitted/
const HOW_TO_SELECT =
  'set "developerDir" in trezi-previews.json or TREZI_DEVELOPER_DIR; the machine default stays as it is'

/** `/Applications/Xcode.app` and `…/Xcode.app/Contents/Developer` both mean the latter. */
export function developerDirOf(path: string): string {
  const clean = normalize(path).replace(/\/+$/, '')
  return clean.endsWith('.app') ? join(clean, 'Contents/Developer') : clean
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function stamp(path: string): string {
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/** Every installed developer directory, each once, with how it was found. */
export async function findDeveloperDirs(
  options: ToolchainOptions
): Promise<{ dirs: Map<string, string[]>; systemDefault: string }> {
  const dirs = new Map<string, string[]>()
  const add = (path: string, by: string) => {
    const dir = canonical(developerDirOf(path))
    dirs.set(dir, [...(dirs.get(dir) ?? []), by])
  }
  if (options.override?.path) add(options.override.path, 'setting')
  const environment = options.environment ?? process.env.DEVELOPER_DIR
  if (environment) add(environment, 'DEVELOPER_DIR')
  for (const folder of options.applications ?? ['/Applications']) {
    let names: string[] = []
    try {
      names = readdirSync(folder)
    } catch {}
    for (const name of names.sort())
      if (/^Xcode.*\.app$/.test(name) && existsSync(join(folder, name, 'Contents/Developer')))
        add(join(folder, name), folder)
  }
  const selected = await runTool(options.xcodeSelect ?? '/usr/bin/xcode-select', ['-p'], {
    cwd: '/',
    timeoutMs: options.timeoutMs ?? 20_000,
    // xcode-select -p reports DEVELOPER_DIR when it is set; the global choice is wanted.
    env: { DEVELOPER_DIR: '' }
  })
  const systemDefault = selected.error ? '' : selected.stdout.trim()
  if (systemDefault) add(systemDefault, 'xcode-select')
  const clt = options.commandLineTools ?? '/Library/Developer/CommandLineTools'
  if (existsSync(clt)) add(clt, 'command-line tools')
  return { dirs, systemDefault }
}

/** One developer directory's Xcode and Swift versions, macOS SDK and PreviewsMacros. */
export async function inspectToolchain(
  developerDir: string,
  foundBy: string[],
  options: ToolchainOptions
): Promise<Toolchain> {
  const toolchain: Toolchain = {
    developerDir,
    kind: 'unknown',
    foundBy,
    label: developerDir,
    xcodeVersion: '',
    xcodeBuild: '',
    swiftVersion: '',
    sdkVersion: '',
    sdkPath: '',
    previewsMacros: '',
    errors: []
  }
  if (!isAbsolute(developerDir) || !existsSync(developerDir)) {
    toolchain.errors.push(`The developer directory ${developerDir} does not exist.`)
    return toolchain
  }
  const versionPlist = join(dirname(developerDir), 'version.plist')
  const run = (command: string, args: string[]) =>
    runTool(command, args, {
      cwd: '/',
      timeoutMs: options.timeoutMs ?? 20_000,
      env: { DEVELOPER_DIR: developerDir }
    })
  const xcrun = options.xcrun ?? '/usr/bin/xcrun'
  const [plist, swift, sdkVersion, sdkPath] = await Promise.all([
    existsSync(versionPlist)
      ? run(options.plutil ?? '/usr/bin/plutil', ['-convert', 'json', '-o', '-', versionPlist])
      : null,
    run(xcrun, ['swiftc', '--version']),
    run(xcrun, ['--sdk', 'macosx', '--show-sdk-version']),
    run(xcrun, ['--sdk', 'macosx', '--show-sdk-path'])
  ])
  if (plist && !plist.error) {
    try {
      const json = JSON.parse(plist.stdout)
      toolchain.kind = 'xcode'
      toolchain.xcodeVersion = String(json.CFBundleShortVersionString ?? '')
      toolchain.xcodeBuild = String(json.ProductBuildVersion ?? '')
      toolchain.label = `Xcode ${toolchain.xcodeVersion}${toolchain.xcodeBuild ? ` (${toolchain.xcodeBuild})` : ''}`
    } catch {}
  } else if (!existsSync(join(developerDir, 'Platforms'))) {
    toolchain.kind = 'clt'
    toolchain.label = 'Command Line Tools'
  }
  toolchain.swiftVersion = /Swift version (\S+)/.exec(swift.stdout + swift.stderr)?.[1] ?? ''
  if (!toolchain.swiftVersion)
    toolchain.errors.push(swift.error || `${toolchain.label} has no usable swiftc.`)
  toolchain.sdkVersion = sdkVersion.error ? '' : sdkVersion.stdout.trim()
  toolchain.sdkPath = sdkPath.error ? '' : sdkPath.stdout.trim()
  if (!toolchain.sdkPath) toolchain.errors.push(`${toolchain.label} has no macOS SDK.`)
  toolchain.previewsMacros =
    PLUGIN_DIRS.map((dir) => join(developerDir, dir, PLUGIN)).find((path) => existsSync(path)) ?? ''
  return toolchain
}

/** The probe cache key: path, versions, SDK and the plugin file itself. */
export function toolchainKey(toolchain: Toolchain): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        toolchain.developerDir,
        toolchain.xcodeVersion,
        toolchain.xcodeBuild,
        toolchain.swiftVersion,
        toolchain.sdkVersion,
        toolchain.sdkPath,
        toolchain.previewsMacros,
        stamp(toolchain.previewsMacros)
      ])
    )
    .digest('hex')
}

type ProbeCache = Record<string, Omit<PreviewCapability, 'cached' | 'durationMs'>>

function readCache(path: string): ProbeCache {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProbeCache
  } catch {
    return {}
  }
}

const firstError = (output: string) =>
  (output.split('\n').find((line) => /error:/.test(line)) ?? output.trim().split('\n').pop() ?? '')
    .trim()
    .slice(0, 300)

/** What a failed probe means for the user, and what to do about it. */
export function classifyProbe(
  toolchain: Toolchain,
  output: string
): Omit<PreviewCapability, 'cached' | 'durationMs'> {
  if (NOT_FOUND.test(output) || (!toolchain.previewsMacros && /PreviewsMacros/.test(output)))
    return {
      status: 'unsupported',
      message: `${toolchain.label} lack${toolchain.kind === 'clt' ? '' : 's'} PreviewsMacros, so #Preview cannot expand: install or select full Xcode (${HOW_TO_SELECT}).`
    }
  if (ENVIRONMENT.test(output))
    return {
      status: 'unavailable',
      message: `The compiler's macro plugin server could not start with ${toolchain.label} in this environment (${firstError(output)}). This usually means Trezi runs inside another sandbox: start Trezi normally. If it persists, reinstall that Xcode or select another one (${HOW_TO_SELECT}).`
    }
  if (/PreviewsMacros|external macro|swift-plugin-server|compiler plugin/.test(output))
    return {
      status: 'broken',
      message: `The PreviewsMacros plugin of ${toolchain.label} is broken or incompatible (${firstError(output)}): reinstall that Xcode or select another one (${HOW_TO_SELECT}).`
    }
  return {
    status: 'broken',
    message: `${toolchain.label} could not compile a #Preview (${firstError(output)}): reinstall it or select another Xcode (${HOW_TO_SELECT}).`
  }
}

/**
 * Compiles a tiny intact `#Preview` with the toolchain, process-locally and with the
 * same normal flags as a preview build. Cached by `toolchainKey`; timeouts, spawn
 * failures and environment failures are not cached.
 */
export async function probePreview(
  toolchain: Toolchain,
  options: ToolchainOptions
): Promise<PreviewCapability> {
  const started = Date.now()
  if (toolchain.errors.length)
    return {
      status: 'broken',
      message: `${toolchain.errors.join(' ')} Install Xcode or select another developer directory (${HOW_TO_SELECT}).`,
      cached: false,
      durationMs: 0
    }
  const key = toolchainKey(toolchain)
  const cache = readCache(options.cacheFile)
  if (cache[key]) return { ...cache[key], cached: true, durationMs: Date.now() - started }
  const dir = join(options.workDir, `probe-${key.slice(0, 12)}`)
  mkdirSync(dir, { recursive: true })
  const source = join(dir, 'Probe.swift')
  writeFileSync(source, PROBE)
  const result = await runTool(
    options.xcrun ?? '/usr/bin/xcrun',
    [
      '--sdk',
      'macosx',
      'swiftc',
      '-parse-as-library',
      '-module-name',
      'TreziPreviewProbe',
      '-module-cache-path',
      join(dir, 'ModuleCache'),
      '-c',
      source,
      '-o',
      join(dir, 'Probe.o')
    ],
    {
      cwd: dir,
      timeoutMs: options.timeoutMs ?? 120_000,
      env: { DEVELOPER_DIR: toolchain.developerDir }
    }
  )
  const found: Omit<PreviewCapability, 'cached' | 'durationMs'> =
    result.code === 0
      ? {
          status: 'supported',
          message: `#Preview expands with ${toolchain.label} (Swift ${toolchain.swiftVersion}, macOS SDK ${toolchain.sdkVersion}).`
        }
      : result.code === null
        ? {
            status: 'broken',
            message: `${toolchain.label} could not compile a #Preview: ${result.error}`
          }
        : classifyProbe(toolchain, result.stderr + result.stdout)
  if (result.code !== null && found.status !== 'unavailable') {
    // Re-read: another project may have probed meanwhile.
    mkdirSync(dirname(options.cacheFile), { recursive: true })
    writeFileSync(
      options.cacheFile,
      JSON.stringify({ ...readCache(options.cacheFile), [key]: found }, null, 2)
    )
  }
  return { ...found, cached: false, durationMs: Date.now() - started }
}

const versionParts = (version: string) => version.split('.').map((part) => Number(part) || 0)

/** Newest first: Xcode version, then build, then path. */
export function newestFirst(a: Toolchain, b: Toolchain): number {
  const [x, y] = [versionParts(a.xcodeVersion), versionParts(b.xcodeVersion)]
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
  if (a.xcodeBuild !== b.xcodeBuild) return a.xcodeBuild < b.xcodeBuild ? 1 : -1
  return a.developerDir < b.developerDir ? -1 : 1
}

/** Discovery, precedence and the capability probe of the pick. */
export async function selectToolchain(options: ToolchainOptions): Promise<ToolchainSelection> {
  const { dirs, systemDefault } = await findDeveloperDirs(options)
  const candidates = await Promise.all(
    [...dirs].map(([dir, by]) => inspectToolchain(dir, by, options))
  )
  const byBy = (by: string) => candidates.find((c) => c.foundBy.includes(by)) ?? null
  const notes: string[] = []
  let toolchain: Toolchain | null = null
  let capability: PreviewCapability | null = null
  let reason = ''
  const explicit = byBy('setting')
  const environment = byBy('DEVELOPER_DIR')
  if (explicit) {
    toolchain = explicit
    reason = `${options.override?.from ?? 'The setting'} selects ${explicit.developerDir}.`
  } else if (environment) {
    toolchain = environment
    reason = `DEVELOPER_DIR is set to ${environment.developerDir} in the environment.`
  } else {
    const xcodes = candidates
      .filter((c) => c.kind === 'xcode' && !c.errors.length && c.previewsMacros)
      .sort(newestFirst)
    for (const xcode of xcodes) {
      const probed = await probePreview(xcode, options)
      // An environment failure is not the toolchain's fault: keep the newest Xcode.
      if (probed.status === 'supported' || probed.status === 'unavailable') {
        toolchain = xcode
        capability = probed
        reason = `The newest full Xcode with PreviewsMacros${probed.status === 'supported' ? ' that expands #Preview' : ''}${systemDefault ? ` (xcode-select points at ${systemDefault})` : ''}.`
        break
      }
      notes.push(probed.message)
    }
    if (!toolchain) {
      toolchain = byBy('xcode-select') ?? byBy('command-line tools')
      reason = toolchain
        ? toolchain.foundBy.includes('xcode-select')
          ? `xcode-select -p (no installed full Xcode expands #Preview).`
          : 'The command-line tools (xcode-select gave no path).'
        : ''
    }
  }
  if (!toolchain)
    return {
      toolchain: null,
      reason: 'No developer directory was found.',
      capability: null,
      candidates,
      env: {},
      key: '',
      message:
        'No Xcode or command-line tools were found: install Xcode for #Preview (the command-line tools alone build previews without it).',
      systemDefault
    }
  capability ??= await probePreview(toolchain, options)
  const message = [capability.message, ...notes.filter((note) => note !== capability.message)]
  return {
    toolchain,
    reason,
    capability,
    candidates,
    env: { DEVELOPER_DIR: toolchain.developerDir },
    key: toolchain.errors.length ? '' : toolchainKey(toolchain).slice(0, 16),
    message: message.join(' '),
    systemDefault
  }
}

/** What the backend API (`project:native`) reports about a selection. */
export function toolchainInfo(selection: ToolchainSelection): NativeToolchainInfo {
  return {
    developerDir: selection.toolchain?.developerDir ?? '',
    label: selection.toolchain?.label ?? '',
    swiftVersion: selection.toolchain?.swiftVersion ?? '',
    sdkVersion: selection.toolchain?.sdkVersion ?? '',
    reason: selection.reason,
    preview: selection.capability?.status ?? 'none',
    message: selection.message,
    systemDefault: selection.systemDefault
  }
}

/**
 * A cheap stamp of what selection depends on, without spawning: the setting, the
 * environment and each `Xcode*.app`'s version. `xcode-select -p` is read again on a
 * requested rebuild.
 */
export function toolchainStamp(options: ToolchainOptions): string {
  const parts = [
    options.override?.path ?? '',
    options.environment ?? process.env.DEVELOPER_DIR ?? ''
  ]
  for (const folder of options.applications ?? ['/Applications']) {
    try {
      for (const name of readdirSync(folder).sort())
        if (/^Xcode.*\.app$/.test(name))
          parts.push(`${name}:${stamp(join(folder, name, 'Contents/version.plist'))}`)
    } catch {}
  }
  parts.push(stamp(options.commandLineTools ?? '/Library/Developer/CommandLineTools'))
  return parts.join('\n')
}
