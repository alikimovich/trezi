import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DependencyPlan, dependencyKey, WRAPPER, wrapperManifest } from './dependencies'
import { runTool } from './graph'
import { Shadow } from './shadow'

/**
 * Builds a plan's Swift package products (LKM-275) with `swift build` on the generated
 * wrapper package (`dependencies.ts`), all in Trezi's derived data: the wrapper, its
 * scratch folder (checkouts, build products, resource bundles), the stamp of the
 * last good build and a mirror of the local packages (`locals/`: `Package.swift`
 * copied, the rest symlinked), which the wrapper refers to instead of the project's
 * folders, so SwiftPM's own `.swiftpm` state lands in the mirror. The project and its
 * local packages are only read. SwiftPM keeps its
 * own manifest and plugin sandbox: Trezi never turns it off, and where
 * that sandbox cannot be applied (Trezi itself runs inside another sandbox) the build
 * fails with that reason. Skipped when the key (toolchain, wrapper, pins, local package
 * files) is the last good build's.
 */
export interface PackageBuild {
  key: string
  cached: boolean
  /** The folder holding the products' modules, the wrapper dylib and resource bundles. */
  bin: string
  /** Flags every module and the host compile with: module and framework search paths. */
  compileFlags: string[]
  /** Flags every module and the host link with. */
  linkFlags: string[]
  /** Resource bundles SwiftPM built (Bundle.module finds them at their build path). */
  bundles: string[]
  error: string
  output: string
  durationMs: number
}

/** The command a build runs, for tests and the report: default sandboxing only. */
export function packageBuildArgs(wrapper: string, scratch: string): string[] {
  return [
    'swift',
    'build',
    '--package-path',
    wrapper,
    '--scratch-path',
    scratch,
    '--configuration',
    'debug',
    '--product',
    WRAPPER
  ]
}

/** Size and mtime of a local package's files, skipping build output and hidden folders. */
export function treeStamps(dir: string, depth = 0): string[] {
  if (depth > 16) return []
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names.flatMap((name) => {
    if (name.startsWith('.') || name === 'DerivedData' || name === 'build') return []
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (stat.isDirectory()) return treeStamps(path, depth + 1)
      return stat.isFile() ? [`${path}:${stat.size}:${stat.mtimeMs}`] : []
    } catch {
      return []
    }
  })
}

export async function buildPackages(
  plan: DependencyPlan,
  options: {
    /** Trezi's derived data for the project. */
    cacheDir: string
    toolchainKey: string
    env: Record<string, string>
    arch: string
    deploymentTarget: string
    xcrun?: string
    timeoutMs?: number
  }
): Promise<PackageBuild> {
  const started = Date.now()
  const dir = join(options.cacheDir, 'packages', `toolchain-${options.toolchainKey || 'none'}`)
  const wrapper = join(dir, 'wrapper')
  const scratch = join(dir, 'scratch')
  const bin = join(scratch, `${options.arch}-apple-macosx`, 'debug')
  const manifest = wrapperManifest(plan, options.deploymentTarget)
  const key = dependencyKey({
    toolchain: options.toolchainKey,
    manifest,
    pins: plan.packages.flatMap((p) => (p.pin ? [p.pin] : [])),
    localStamps: plan.packages
      .filter((p) => p.kind === 'local')
      .flatMap((p) => treeStamps(p.location))
  })
  const result = (fields: Partial<PackageBuild>): PackageBuild => {
    const modules = join(bin, 'Modules')
    const bundles = listNames(bin)
      .filter((n) => n.endsWith('.bundle'))
      .map((n) => join(bin, n))
    const modulemaps = listNames(bin)
      .filter((n) => n.endsWith('.build') && existsSync(join(bin, n, 'module.modulemap')))
      .map((n) => `-fmodule-map-file=${join(bin, n, 'module.modulemap')}`)
    return {
      key,
      cached: false,
      bin,
      compileFlags: [
        ...(existsSync(modules) ? ['-I', modules] : []),
        '-I',
        bin,
        '-F',
        bin,
        ...modulemaps.flatMap((flag) => ['-Xcc', flag])
      ],
      linkFlags: ['-L', bin, `-l${WRAPPER}`, '-Xlinker', '-rpath', '-Xlinker', bin],
      bundles,
      error: '',
      output: '',
      durationMs: Date.now() - started,
      ...fields
    }
  }
  const stampFile = join(dir, 'built.key')
  const dylib = join(bin, `lib${WRAPPER}.dylib`)
  if (readText(stampFile) === key && existsSync(dylib)) return result({ cached: true })

  // SwiftPM writes `.swiftpm` into every local package it builds from, so the wrapper
  // points at Trezi's mirror of them (`shadow.ts`) and the project's folders are only read.
  const locals = plan.packages.filter((p) => p.kind === 'local').map((p) => p.location)
  let mirror: Shadow | undefined
  if (locals.length) {
    try {
      mirror = new Shadow(join(dir, 'locals'), { root: locals[0], packages: locals })
      mirror.create()
    } catch (error) {
      return result({
        error: `Trezi could not mirror the local packages for the build (the project itself is never used to run build tools): ${(error as Error).message}`
      })
    }
  }
  const mirrored = mirror
  const wrapped = mirrored
    ? wrapperManifest(
        {
          ...plan,
          packages: plan.packages.map((p) =>
            p.kind === 'local' ? { ...p, location: mirrored.of(p.location) } : p
          )
        },
        options.deploymentTarget
      )
    : manifest
  mkdirSync(join(wrapper, 'Sources', WRAPPER), { recursive: true })
  if (readText(join(wrapper, 'Package.swift')) !== wrapped)
    writeFileSync(join(wrapper, 'Package.swift'), wrapped)
  const source = join(wrapper, 'Sources', WRAPPER, 'Dependencies.swift')
  if (!existsSync(source))
    writeFileSync(source, '// Links the products a Trezi preview uses into one library.\n')
  const built = await runTool(
    options.xcrun ?? '/usr/bin/xcrun',
    packageBuildArgs(wrapper, scratch),
    {
      cwd: wrapper,
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      env: options.env
    }
  )
  if (mirror) {
    built.stdout = mirror.map(built.stdout)
    built.stderr = mirror.map(built.stderr)
    built.error = mirror.map(built.error)
  }
  const output = `${built.stdout}\n${built.stderr}`.slice(-8_000)
  if (built.error)
    return result({
      error: /sandbox_apply|sandbox-exec/.test(output)
        ? "swift build could not apply SwiftPM's sandbox in this environment (Trezi runs inside another sandbox). Trezi never disables it: run Trezi outside a sandbox to build the package dependencies."
        : /Could not resolve|Failed to clone|unable to access|Could not connect/i.test(output)
          ? `swift build could not fetch a pinned package (network needed for remote packages): ${built.error}`
          : built.error,
      output
    })
  if (!existsSync(dylib))
    return result({ error: `swift build left no lib${WRAPPER}.dylib in ${bin}.`, output })
  writeFileSync(stampFile, key)
  return result({ output })
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
