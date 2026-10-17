import { createHash } from 'node:crypto'
import { isAbsolute, join, posix, relative } from 'node:path'
import type { NativeContainer, NativeGraph, NativeTarget } from './graph'
import { packageIdentity } from './pbxproj'

/**
 * The dependency graph of a preview build (LKM-275): which Swift packages, pinned
 * versions and binary frameworks the plan's targets need, and every dependency kind
 * Trezi does not build, named with the reason. Packages are built by `swift build` in
 * Trezi's derived data through a generated wrapper package (`wrapperManifest`,
 * `package-build.ts`); nothing is resolved, updated or written in the project. A remote
 * package is built only at the version its `Package.resolved` pins. Pure: the caller
 * reads the resolved file and lists folders.
 */
export interface PackagePin {
  identity: string
  location: string
  version?: string
  revision?: string
  branch?: string
}

export interface PlannedPackage {
  identity: string
  kind: 'local' | 'remote'
  /** A local package's absolute folder, a remote package's URL. */
  location: string
  pin?: PackagePin
  /** The products the plan's targets use. */
  products: string[]
  /** The targets that need it. */
  targets: string[]
}

export interface PlannedBinary {
  /** Project-relative `.xcframework` or `.framework`. */
  path: string
  /** The framework name linked with `-framework`. */
  framework: string
  /** The absolute folder passed as `-F` (an xcframework's macOS slice). */
  searchDir: string
  targets: string[]
}

export interface UnsupportedDependency {
  name: string
  kind: string
  reason: string
  /** A plan target needs it: the build cannot succeed without it. */
  required: boolean
  target?: string
}

export interface DependencyPlan {
  packages: PlannedPackage[]
  binaries: PlannedBinary[]
  unsupported: UnsupportedDependency[]
  /** The `Package.resolved` the pins came from, project-relative ('' when none). */
  resolvedFile: string
}

/** `Package.resolved`, version 1 to 3. */
export function parseResolved(text: string): PackagePin[] {
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const pins: any[] = json?.pins ?? json?.object?.pins ?? []
  return pins.flatMap((pin) => {
    const location = String(pin?.location ?? pin?.repositoryURL ?? '')
    const identity = String(pin?.identity ?? (location ? packageIdentity(location) : pin?.package))
    const state = pin?.state ?? {}
    if (!identity || !state.revision) return []
    return [
      {
        identity: identity.toLowerCase(),
        location,
        revision: String(state.revision),
        ...(state.version ? { version: String(state.version) } : {}),
        ...(state.branch ? { branch: String(state.branch) } : {})
      }
    ]
  })
}

/** Where Xcode and SwiftPM keep the pins of a container, project-relative, in order. */
export function resolvedFiles(container: NativeContainer, workspaces: string[]): string[] {
  if (container.kind === 'package')
    return [posix.join(posix.dirname(container.path), 'Package.resolved')]
  return [
    posix.join(container.path, 'project.xcworkspace/xcshareddata/swiftpm/Package.resolved'),
    ...workspaces.map((w) => posix.join(w, 'xcshareddata/swiftpm/Package.resolved'))
  ]
}

const sameUrl = (a: string, b: string) =>
  a
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase() ===
  b
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()

export function planDependencies(input: {
  root: string
  container: NativeContainer
  graph: NativeGraph
  /** The plan's targets, dependencies first. */
  targets: NativeTarget[]
  resolved: { path: string; text: string } | null
  exists: (path: string) => boolean
  /** Entry names of an absolute folder, [] when unreadable. */
  list: (dir: string) => string[]
}): DependencyPlan {
  const { root, container, graph } = input
  const pins = input.resolved ? parseResolved(input.resolved.text) : []
  const packages = new Map<string, PlannedPackage>()
  const binaries = new Map<string, PlannedBinary>()
  const unsupported: UnsupportedDependency[] = []
  const insideRoot = (path: string) => {
    const rel = relative(root, path)
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
  }
  const add = (
    target: string,
    entry: Omit<PlannedPackage, 'products' | 'targets'>,
    product: string
  ) => {
    const found = packages.get(entry.identity) ?? { ...entry, products: [], targets: [] }
    if (!found.products.includes(product)) found.products.push(product)
    if (!found.targets.includes(target)) found.targets.push(target)
    packages.set(entry.identity, found)
  }
  // Local packages found in the project: Xcode can also reference them as plain folders.
  const discovered = graph.containers.filter((c) => c.kind === 'package' && c !== container)

  for (const target of input.targets) {
    for (const { product, package: location } of target.packageDependencies ?? []) {
      const label = `${product}${location ? ` (${location})` : ''}`
      const ref = location
        ? container.packages.find(
            (p) =>
              p.location === location ||
              p.identity === location.toLowerCase() ||
              packageIdentity(p.location) === location.toLowerCase()
          )
        : container.packages.find((p) => p.identity === product.toLowerCase())
      let dir = ''
      if (ref?.kind === 'local' || (!ref && !location)) {
        const path = ref?.path ?? discovered.find((c) => c.schemes.includes(product))?.path
        if (!path) {
          unsupported.push({
            name: label,
            kind: 'package product',
            reason: 'no package in the project provides it',
            required: true,
            target: target.name
          })
          continue
        }
        dir = isAbsolute(path)
          ? path
          : join(root, path.endsWith('Package.swift') ? posix.dirname(path) : path)
        if (!insideRoot(dir)) {
          unsupported.push({
            name: label,
            kind: 'local package outside the project',
            reason: `${dir} is outside the project folder; Trezi only builds packages inside it`,
            required: true,
            target: target.name
          })
          continue
        }
        if (!input.exists(join(dir, 'Package.swift'))) {
          unsupported.push({
            name: label,
            kind: 'local package',
            reason: `${relative(root, dir) || '.'} has no Package.swift`,
            required: true,
            target: target.name
          })
          continue
        }
        add(target.name, { identity: packageIdentity(dir), kind: 'local', location: dir }, product)
        continue
      }
      if (!ref) {
        unsupported.push({
          name: label,
          kind: 'package product',
          reason: `the project does not reference the package ${location}`,
          required: true,
          target: target.name
        })
        continue
      }
      const identity = ref.identity ?? packageIdentity(ref.location)
      const pin = pins.find(
        (p) => p.identity === identity || (p.location && sameUrl(p.location, ref.location))
      )
      if (!pin) {
        unsupported.push({
          name: label,
          kind: 'remote package without a pin',
          reason: input.resolved
            ? `${input.resolved.path} has no pin for ${ref.location}; resolve the packages in Xcode once (Trezi never resolves or updates them)`
            : `there is no Package.resolved for ${ref.location}; resolve the packages in Xcode once (Trezi never resolves or updates them)`,
          required: true,
          target: target.name
        })
        continue
      }
      add(target.name, { identity, kind: 'remote', location: ref.location, pin }, product)
    }

    for (const path of target.binaries ?? []) {
      const absolute = join(root, path)
      const name = posix.basename(path).replace(/\.(xc)?framework$/, '')
      const fail = (reason: string) =>
        unsupported.push({
          name: path,
          kind: 'binary framework',
          reason,
          required: true,
          target: target.name
        })
      if (!input.exists(absolute)) {
        fail('the file is missing')
        continue
      }
      let searchDir = posix.dirname(absolute)
      if (path.endsWith('.xcframework')) {
        const slices = input.list(absolute).filter((slice) => slice.startsWith('macos-'))
        const slice = slices.find((s) =>
          input.list(join(absolute, s)).some((f) => f.endsWith('.framework'))
        )
        if (!slice) {
          fail(
            slices.length
              ? 'its macOS slice is a library, not a framework; library slices are not linked yet'
              : 'it has no macOS slice'
          )
          continue
        }
        const framework =
          input.list(join(absolute, slice)).find((f) => f.endsWith('.framework')) ?? ''
        searchDir = join(absolute, slice)
        const entry = binaries.get(path) ?? {
          path,
          framework: framework.replace(/\.framework$/, ''),
          searchDir,
          targets: []
        }
        entry.targets.push(target.name)
        binaries.set(path, entry)
        continue
      }
      const entry = binaries.get(path) ?? { path, framework: name, searchDir, targets: [] }
      entry.targets.push(target.name)
      binaries.set(path, entry)
    }

    for (const note of target.notes) {
      const other = /^depends on "(.+)" in another project$/.exec(note)
      if (other)
        unsupported.push({
          name: other[1],
          kind: 'target in another project',
          reason: 'cross-project target dependencies are not built yet',
          required: true,
          target: target.name
        })
    }
  }

  // Dependency managers Trezi never runs: named, not required unless a target shows it.
  if (input.exists(join(root, 'Podfile')) || input.exists(join(root, 'Pods')))
    unsupported.push({
      name: 'CocoaPods',
      kind: 'CocoaPods',
      reason: 'pods are not installed or built; components that import a pod do not compile',
      required: false
    })
  if (input.exists(join(root, 'Cartfile')))
    unsupported.push({
      name: 'Carthage',
      kind: 'Carthage',
      reason: 'Carthage frameworks are not built; link them as .xcframework files instead',
      required: false
    })
  return {
    packages: [...packages.values()],
    binaries: [...binaries.values()],
    unsupported,
    resolvedFile: input.resolved?.path ?? ''
  }
}

export const WRAPPER = 'TreziPreviewDependencies'

/** A Swift string literal; refuses what it cannot write safely. */
function literal(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f))
    throw new Error(`A package location has control characters: ${JSON.stringify(value)}`)
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * The generated wrapper package: one dynamic library linking every product the plan
 * uses, at the pinned versions (`exact:` or `revision:`), so one `swift build` builds
 * them all in Trezi's derived data.
 */
export function wrapperManifest(plan: DependencyPlan, deploymentTarget: string): string {
  const dependencies = plan.packages.map((p) =>
    p.kind === 'local'
      ? `.package(path: ${literal(p.location)})`
      : p.pin?.version
        ? `.package(url: ${literal(p.location)}, exact: ${literal(p.pin.version)})`
        : `.package(url: ${literal(p.location)}, revision: ${literal(p.pin?.revision ?? '')})`
  )
  const products = plan.packages.flatMap((p) =>
    p.products.map(
      (product) => `.product(name: ${literal(product)}, package: ${literal(p.identity)})`
    )
  )
  const platform = /^\d+(\.\d+)*$/.test(deploymentTarget) ? deploymentTarget : '13.0'
  return `// swift-tools-version:5.9
// Generated by Trezi for Swift previews (LKM-275). Built in Trezi's derived data only.
import PackageDescription

let package = Package(
    name: "${WRAPPER}",
    platforms: [.macOS("${platform}")],
    products: [.library(name: "${WRAPPER}", type: .dynamic, targets: ["${WRAPPER}"])],
    dependencies: [
        ${dependencies.join(',\n        ')}
    ],
    targets: [
        .target(
            name: "${WRAPPER}",
            dependencies: [
                ${products.join(',\n                ')}
            ],
            path: "Sources/${WRAPPER}"
        )
    ]
)
`
}

/** The cache key of the dependency build: toolchain, wrapper, pins and local package files. */
export function dependencyKey(parts: {
  toolchain: string
  manifest: string
  pins: PackagePin[]
  /** Size and mtime of every file of the local packages. */
  localStamps: string[]
}): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.toolchain, parts.manifest, parts.pins, parts.localStamps]))
    .digest('hex')
    .slice(0, 16)
}
