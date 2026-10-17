import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { NativeStructure } from '../shared/api'
import { discoverNative } from './discovery'
import {
  type NativeTarget,
  type PackageReference,
  parsePbxproj,
  targetKind,
  workspaceProjects
} from './pbxproj'

export type { NativeTarget, PackageReference }

/**
 * A native project's schemes and target graph (LKM-273, `docs/SWIFT-PREVIEWS-PLAN.md`
 * Stage 1). Xcode projects are read from `project.pbxproj` through `plutil` (works
 * with the command-line tools alone); schemes come from `xcodebuild -list -json`, or
 * from the shared scheme files when Xcode is missing; `xcodebuild -showBuildSettings
 * -json` fills the settings of targets configured by `.xcconfig` files; Swift packages
 * come from `swift package describe --type json`. Every tool run has a timeout and a
 * clear error. Nothing is written into the project: SwiftPM's scratch folder is in
 * `cacheDir`.
 */
export interface NativeContainer {
  kind: 'workspace' | 'project' | 'package'
  /** Project-relative path of the `.xcworkspace`, `.xcodeproj` or `Package.swift`. */
  path: string
  schemes: string[]
  /** Where `schemes` came from. */
  schemesFrom: 'xcodebuild' | 'scheme files' | 'package products' | 'none'
  targets: NativeTarget[]
  packages: PackageReference[]
  /** A workspace's projects. */
  projects: string[]
  errors: string[]
}

export interface NativeGraph {
  structure: NativeStructure | null
  containers: NativeContainer[]
  errors: string[]
  durationMs: number
}

export interface GraphOptions {
  cacheDir: string
  moduleCache: string
  /** Per tool run (default 45 s). */
  timeoutMs?: number
  /** The `xcodebuild` and `xcrun` to run (tests point them at scripted ones). */
  xcodebuild?: string
  xcrun?: string
  plutil?: string
  /** The selected toolchain's `DEVELOPER_DIR` for every tool run (LKM-274, `toolchain.ts`). */
  env?: Record<string, string>
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  error: string
}

/** One tool run with a timeout; `error` is a sentence for the user, empty on success. */
export function runTool(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const label = [command.split('/').pop(), ...args.slice(0, 2)].join(' ')
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (code: number | null, error: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, error })
    }
    // Its own process group, so a timeout also ends the tool's children (xcodebuild's).
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      child.stdout.destroy()
      child.stderr.destroy()
      done(null, `${label} timed out after ${Math.round(options.timeoutMs / 1000)} s.`)
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-8_000_000)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-200_000)
    })
    child.on('error', (error: NodeJS.ErrnoException) =>
      done(
        null,
        error.code === 'ENOENT'
          ? `${command} is missing: install Xcode or its command-line tools (xcode-select --install).`
          : `${label} could not run: ${error.message}`
      )
    )
    child.on('close', (code) => {
      if (code === 0) return done(code, '')
      done(code, toolError(label, stderr || stdout))
    })
  })
}

/** The first meaningful line of a failed tool's output, with the usual causes named. */
export function toolError(label: string, output: string): string {
  if (/requires Xcode, but active developer directory/.test(output))
    return `${label} needs Xcode, but only the command-line tools are selected (xcode-select -p).`
  if (/xcrun: error: (unable to find utility|invalid active developer path)/.test(output))
    return `${label}: the developer tools are missing. Install Xcode or run xcode-select --install.`
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /error/i.test(l) && !/^warning:/.test(l))
  return `${label} failed: ${(line || output.trim().split('\n').pop() || 'no output').slice(0, 300)}`
}

/** Project-relative files under a project-relative folder; bundles count as one file. */
function listFiles(root: string, dir: string): string[] {
  const found: string[] = []
  const visit = (relative: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(join(root, relative))
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const path = posix.join(relative, name)
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(join(root, path))
      } catch {
        continue
      }
      if (stat.isFile() || /\.(xcassets|xcstrings|bundle)$/.test(name)) found.push(path)
      else if (stat.isDirectory() && depth < 24) visit(path, depth + 1)
    }
  }
  visit(dir, 0)
  return found
}

/** Shared and user scheme names stored in a project or workspace bundle. */
function schemeFiles(root: string, bundle: string): string[] {
  const names = new Set<string>()
  const add = (dir: string) => {
    try {
      for (const file of readdirSync(join(root, bundle, dir)))
        if (file.endsWith('.xcscheme')) names.add(file.slice(0, -'.xcscheme'.length))
    } catch {}
  }
  add('xcshareddata/xcschemes')
  try {
    for (const user of readdirSync(join(root, bundle, 'xcuserdata')))
      add(join('xcuserdata', user, 'xcschemes'))
  } catch {}
  return [...names].sort()
}

async function schemes(
  root: string,
  container: NativeContainer,
  options: Required<Pick<GraphOptions, 'xcodebuild' | 'env'>> & { timeoutMs: number }
) {
  const flag = container.kind === 'workspace' ? '-workspace' : '-project'
  const listed = await runTool(options.xcodebuild, ['-list', '-json', flag, container.path], {
    cwd: root,
    timeoutMs: options.timeoutMs,
    env: options.env
  })
  if (!listed.error) {
    try {
      const json = JSON.parse(listed.stdout)
      container.schemes = (json.workspace ?? json.project)?.schemes ?? []
      container.schemesFrom = 'xcodebuild'
      return true
    } catch {
      container.errors.push('xcodebuild -list returned no JSON.')
    }
  } else container.errors.push(listed.error)
  container.schemes = schemeFiles(root, container.path)
  container.schemesFrom = container.schemes.length ? 'scheme files' : 'none'
  return false
}

/** `xcodebuild -showBuildSettings -json` for one target: where .xcconfig files set them. */
async function buildSettings(
  root: string,
  project: string,
  target: NativeTarget,
  options: { xcodebuild: string; timeoutMs: number; env: Record<string, string> }
) {
  const result = await runTool(
    options.xcodebuild,
    ['-showBuildSettings', '-json', '-project', project, '-target', target.name],
    { cwd: root, timeoutMs: options.timeoutMs, env: options.env }
  )
  if (result.error) return target.notes.push(result.error)
  try {
    const settings = JSON.parse(result.stdout)?.[0]?.buildSettings ?? {}
    for (const key of Object.keys(target.settings))
      if (typeof settings[key] === 'string') target.settings[key] = settings[key]
    for (const key of [
      'SWIFT_VERSION',
      'MACOSX_DEPLOYMENT_TARGET',
      'SDKROOT',
      'PRODUCT_MODULE_NAME'
    ])
      if (typeof settings[key] === 'string') target.settings[key] = settings[key]
    if (settings.PRODUCT_MODULE_NAME) target.module = settings.PRODUCT_MODULE_NAME
  } catch {
    target.notes.push('xcodebuild -showBuildSettings returned no JSON.')
  }
}

async function xcodeProject(
  root: string,
  path: string,
  options: Required<Omit<GraphOptions, 'cacheDir' | 'moduleCache'>>
): Promise<NativeContainer> {
  const container: NativeContainer = {
    kind: 'project',
    path,
    schemes: [],
    schemesFrom: 'none',
    targets: [],
    packages: [],
    projects: [],
    errors: []
  }
  const converted = await runTool(
    options.plutil,
    ['-convert', 'json', '-o', '-', join(path, 'project.pbxproj')],
    { cwd: root, timeoutMs: options.timeoutMs, env: options.env }
  )
  if (converted.error) container.errors.push(converted.error)
  else {
    try {
      const parsed = parsePbxproj(JSON.parse(converted.stdout), posix.dirname(path), (dir) =>
        listFiles(root, dir)
      )
      container.targets = parsed.targets
      container.packages = parsed.packages
    } catch (error) {
      container.errors.push(`${path}/project.pbxproj: ${(error as Error).message}`)
    }
  }
  const xcode = await schemes(root, container, options)
  if (xcode)
    for (const target of container.targets)
      if (target.notes.includes('settings come partly from an .xcconfig file'))
        await buildSettings(root, path, target, options)
  return container
}

async function swiftPackage(
  root: string,
  path: string,
  options: Required<GraphOptions>
): Promise<NativeContainer> {
  const container: NativeContainer = {
    kind: 'package',
    path,
    schemes: [],
    schemesFrom: 'none',
    targets: [],
    packages: [],
    projects: [],
    errors: []
  }
  const dir = posix.dirname(path)
  const scratch = join(
    options.cacheDir,
    `spm-${createHash('sha256').update(join(root, dir)).digest('hex').slice(0, 12)}`
  )
  const describe = (sandbox: boolean) =>
    runTool(
      options.xcrun,
      [
        'swift',
        'package',
        ...(sandbox ? [] : ['--disable-sandbox']),
        '--scratch-path',
        scratch,
        'describe',
        '--type',
        'json'
      ],
      {
        cwd: join(root, dir),
        timeoutMs: options.timeoutMs,
        env: { ...options.env, CLANG_MODULE_CACHE_PATH: options.moduleCache }
      }
    )
  let described = await describe(true)
  // Inside another sandbox SwiftPM cannot apply its own manifest sandbox; the manifest
  // then runs without it, as a JS project's dev script does.
  if (described.error && /sandbox_apply/.test(described.stderr)) {
    container.errors.push('SwiftPM could not sandbox the manifest here; it ran without it.')
    described = await describe(false)
  }
  if (described.error) {
    container.errors.push(described.error)
    return container
  }
  let json: any
  try {
    json = JSON.parse(described.stdout.slice(described.stdout.indexOf('{')))
  } catch {
    container.errors.push('swift package describe returned no JSON.')
    return container
  }
  container.packages = (json.dependencies ?? []).map((dep: any) => ({
    kind: dep.type === 'fileSystem' ? 'local' : 'remote',
    location: dep.url ?? dep.path ?? dep.identity ?? ''
  }))
  container.schemes = (json.products ?? []).map((product: any) => product.name)
  container.schemesFrom = container.schemes.length ? 'package products' : 'none'
  container.targets = (json.targets ?? []).map(
    (target: any): NativeTarget => ({
      name: target.name,
      module: target.c99name ?? target.name,
      kind:
        target.type === 'library'
          ? 'library'
          : target.type === 'executable'
            ? 'executable'
            : target.type === 'test'
              ? 'test'
              : targetKind(''),
      productType: `swiftpm.${target.type}`,
      dependencies: target.target_dependencies ?? [],
      packageProducts: target.product_dependencies ?? [],
      sources: (target.sources ?? [])
        .filter((file: string) => file.endsWith('.swift'))
        .map((file: string) => posix.join(dir, target.path, file))
        .sort(),
      resources: (target.resources ?? []).map((r: any) => posix.relative(join(root), r.path ?? '')),
      settings: {},
      notes: target.module_type && target.module_type !== 'SwiftTarget' ? [target.module_type] : []
    })
  )
  return container
}

/** Discovery plus every container's schemes and targets. */
export async function nativeGraph(root: string, options: GraphOptions): Promise<NativeGraph> {
  const started = Date.now()
  const resolved: Required<GraphOptions> = {
    timeoutMs: 45_000,
    xcodebuild: '/usr/bin/xcodebuild',
    xcrun: '/usr/bin/xcrun',
    plutil: '/usr/bin/plutil',
    env: {},
    ...options
  }
  const structure = discoverNative(root)
  const containers: NativeContainer[] = []
  const errors: string[] = []
  const projects = new Set(structure?.projects ?? [])
  for (const workspace of structure?.workspaces ?? []) {
    const container: NativeContainer = {
      kind: 'workspace',
      path: workspace,
      schemes: [],
      schemesFrom: 'none',
      targets: [],
      packages: [],
      projects: [],
      errors: []
    }
    try {
      container.projects = workspaceProjects(
        readFileSync(join(root, workspace, 'contents.xcworkspacedata'), 'utf8'),
        workspace
      )
    } catch {
      container.errors.push(`${workspace} has no readable contents.xcworkspacedata.`)
    }
    for (const project of container.projects) projects.add(project)
    await schemes(root, container, resolved)
    containers.push(container)
  }
  for (const project of [...projects].sort())
    containers.push(await xcodeProject(root, project, resolved))
  for (const pkg of structure?.packages ?? [])
    containers.push(await swiftPackage(root, pkg, resolved))
  if (!structure) errors.push('No Xcode workspace, Xcode project or Package.swift was found.')
  return { structure, containers, errors, durationMs: Date.now() - started }
}

/** The files whose change means the graph must be read again. */
export function graphInputs(root: string, structure: NativeStructure | null): string[] {
  if (!structure) return []
  return [
    ...structure.workspaces.map((path) => join(root, path, 'contents.xcworkspacedata')),
    ...structure.projects.map((path) => join(root, path, 'project.pbxproj')),
    ...structure.packages.map((path) => join(root, path))
  ]
}
