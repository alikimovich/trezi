import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DependencyPlan, dependencyKey, WRAPPER, wrapperManifest } from './dependencies'
import { runTool } from './graph'
import { tidySwiftPM } from './xcode-tidy'

/**
 * Builds a plan's Swift package products (LKM-275) with `swift build` on the generated
 * wrapper package (`dependencies.ts`), all in Trezi's derived data: the wrapper, its
 * scratch folder (checkouts, build products, resource bundles) and the stamp of the
 * last good build. The project and its local packages are only read. SwiftPM keeps its
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
  /** What SwiftPM left in a local package beyond the configuration folder it removes. */
  leftovers: string[]
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
    /** The project, which leftovers are relative to. */
    root?: string
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
      leftovers: [],
      durationMs: Date.now() - started,
      ...fields
    }
  }
  const stampFile = join(dir, 'built.key')
  const dylib = join(bin, `lib${WRAPPER}.dylib`)
  if (readText(stampFile) === key && existsSync(dylib)) return result({ cached: true })

  mkdirSync(join(wrapper, 'Sources', WRAPPER), { recursive: true })
  if (readText(join(wrapper, 'Package.swift')) !== manifest)
    writeFileSync(join(wrapper, 'Package.swift'), manifest)
  const source = join(wrapper, 'Sources', WRAPPER, 'Dependencies.swift')
  if (!existsSync(source))
    writeFileSync(source, '// Links the products a Trezi preview uses into one library.\n')
  const locals = plan.packages.filter((p) => p.kind === 'local').map((p) => p.location)
  const { value: built, leftovers } = await tidySwiftPM(options.root ?? '/', locals, () =>
    runTool(options.xcrun ?? '/usr/bin/xcrun', packageBuildArgs(wrapper, scratch), {
      cwd: wrapper,
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      env: options.env
    })
  )
  const output = `${built.stdout}\n${built.stderr}`.slice(-8_000)
  if (built.error)
    return result({
      leftovers,
      error: /sandbox_apply|sandbox-exec/.test(output)
        ? "swift build could not apply SwiftPM's sandbox in this environment (Trezi runs inside another sandbox). Trezi never disables it: run Trezi outside a sandbox to build the package dependencies."
        : /Could not resolve|Failed to clone|unable to access|Could not connect/i.test(output)
          ? `swift build could not fetch a pinned package (network needed for remote packages): ${built.error}`
          : built.error,
      output
    })
  if (!existsSync(dylib))
    return result({
      error: `swift build left no lib${WRAPPER}.dylib in ${bin}.`,
      output,
      leftovers
    })
  writeFileSync(stampFile, key)
  return result({ output, leftovers })
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
