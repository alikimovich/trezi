import { posix } from 'node:path'

/**
 * The target graph of an Xcode project (LKM-273), read from `project.pbxproj` after
 * `plutil -convert json` (`graph.ts` runs it). Targets, product types, inter-target and
 * Swift package dependencies, Swift sources (build-phase files and Xcode 16
 * synchronized folders with their membership exceptions), resources and the build
 * settings Stage 1 reports. Pure: the caller lists synchronized folders.
 */
export type TargetKind = 'app' | 'framework' | 'library' | 'executable' | 'test' | 'other'

export interface NativeTarget {
  name: string
  /** The Swift module name (`PRODUCT_MODULE_NAME`, else the product or target name). */
  module: string
  kind: TargetKind
  /** The Xcode product type or SwiftPM target type, verbatim. */
  productType: string
  /** Targets of the same container this one depends on, by name. */
  dependencies: string[]
  /** Swift package products it needs, as `product (package location)`. */
  packageProducts: string[]
  /** The same products with their package's `location` ('' when the project names none). */
  packageDependencies: { product: string; package: string }[]
  /** Project-relative `.framework`/`.xcframework` files it links (LKM-275). */
  binaries: string[]
  /** Project-relative Swift sources. */
  sources: string[]
  /** Project-relative resources (asset catalogs, storyboards, plists copied as resources). */
  resources: string[]
  /** The Debug settings Stage 1 reports (target over project). */
  settings: Record<string, string>
  /** Why parts of the target could not be read. */
  notes: string[]
}

export interface PackageReference {
  kind: 'remote' | 'local'
  /** A remote package's URL, a local one's path as the project or manifest wrote it. */
  location: string
  /** A local package's project-relative folder, or an absolute one from a package manifest. */
  path?: string
  /** SwiftPM's package identity (the URL's or folder's last component, lowercased). */
  identity?: string
  /** The declared version requirement, as written (pins decide what is built). */
  requirement?: string
}

/** SwiftPM's identity for a package URL or folder. */
export function packageIdentity(location: string): string {
  const last = location.replace(/\/+$/, '').split('/').pop() ?? ''
  return last.replace(/\.git$/, '').toLowerCase()
}

const REPORTED_SETTINGS = [
  'SDKROOT',
  'SUPPORTED_PLATFORMS',
  'SWIFT_VERSION',
  'MACOSX_DEPLOYMENT_TARGET',
  'IPHONEOS_DEPLOYMENT_TARGET',
  'PRODUCT_NAME',
  'PRODUCT_MODULE_NAME',
  'SWIFT_DEFAULT_ACTOR_ISOLATION',
  'SWIFT_STRICT_CONCURRENCY',
  'SWIFT_APPROACHABLE_CONCURRENCY',
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS',
  'OTHER_SWIFT_FLAGS',
  'ENABLE_PREVIEWS',
  // Build authority (LKM-275, `settings.ts`): read from the file when xcodebuild cannot run.
  'GCC_PREPROCESSOR_DEFINITIONS',
  'FRAMEWORK_SEARCH_PATHS',
  'HEADER_SEARCH_PATHS',
  'SWIFT_INCLUDE_PATHS',
  'LIBRARY_SEARCH_PATHS',
  'OTHER_LDFLAGS',
  'SWIFT_OBJC_BRIDGING_HEADER',
  'SWIFT_ENABLE_BARE_SLASH_REGEX',
  'ASSETCATALOG_COMPILER_GENERATE_ASSET_SYMBOLS',
  'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME',
  'ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS',
  'STRING_CATALOG_GENERATE_SYMBOLS',
  'SYSTEM_FRAMEWORK_SEARCH_PATHS',
  'OTHER_CFLAGS',
  'SWIFT_OPTIMIZATION_LEVEL',
  'SWIFT_COMPILATION_MODE',
  'PRODUCT_BUNDLE_IDENTIFIER'
]

export function targetKind(productType: string): TargetKind {
  const type = productType.replace(/^com\.apple\.product-type\./, '')
  if (type === 'application' || type.startsWith('application.')) return 'app'
  if (type.startsWith('framework')) return 'framework'
  if (type.startsWith('library.')) return 'library'
  if (type === 'tool') return 'executable'
  if (type.startsWith('bundle.unit-test') || type.startsWith('bundle.ui-testing')) return 'test'
  return 'other'
}

/** A C99 identifier, as Xcode derives the module name from a product name. */
export function moduleName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[0-9]/.test(safe) ? `_${safe}` : safe || '_'
}

type Objects = Record<string, Record<string, any>>

export function parsePbxproj(
  json: unknown,
  /** The folder holding the `.xcodeproj`, project-relative ('' for the root). */
  projectDir: string,
  /** Project-relative files under a project-relative folder (synchronized groups). */
  listFiles: (dir: string) => string[]
): { targets: NativeTarget[]; packages: PackageReference[] } {
  const objects = ((json as { objects?: Objects })?.objects ?? {}) as Objects
  const root = (json as { rootObject?: string })?.rootObject
  const project =
    (root && objects[root]) || Object.values(objects).find((o) => o?.isa === 'PBXProject') || {}
  const base = posix.normalize(posix.join(projectDir || '.', project.projectDirPath || '.'))
  const parents = new Map<string, string>()
  for (const [id, object] of Object.entries(objects))
    for (const child of Array.isArray(object?.children) ? object.children : [])
      parents.set(child, id)
  const pathOf = (id: string, depth = 0): string | null => {
    const object = objects[id]
    if (!object || depth > 64) return null
    const tree = object.sourceTree ?? '<group>'
    let from: string | null
    if (tree === '<group>') {
      const parent = parents.get(id)
      from = parent ? pathOf(parent, depth + 1) : base
    } else if (tree === 'SOURCE_ROOT') from = base
    else from = null // absolute, SDK or build-product paths are outside the project
    if (from === null) return null
    const joined = posix.normalize(posix.join(from, object.path ?? '.'))
    return joined === '..' || joined.startsWith('../') ? null : joined
  }
  const nameOf = (id: string) => objects[id]?.name as string | undefined
  const settingsOf = (listId: string | undefined) => {
    const list = listId ? objects[listId] : undefined
    const configs: string[] = Array.isArray(list?.buildConfigurations)
      ? list.buildConfigurations
      : []
    // Previews are debug builds, whatever the list's default configuration is.
    const config =
      configs.map((id) => objects[id]).find((c) => c?.name === 'Debug') ?? objects[configs[0]]
    return {
      settings: (config?.buildSettings ?? {}) as Record<string, unknown>,
      xcconfig: !!config?.baseConfigurationReference
    }
  }
  const projectSettings = settingsOf(project.buildConfigurationList)

  const packages: PackageReference[] = []
  const packageOf = (id: string | undefined): string => {
    const ref = id ? objects[id] : undefined
    if (ref?.isa === 'XCRemoteSwiftPackageReference') return ref.repositoryURL ?? 'remote'
    if (ref?.isa === 'XCLocalSwiftPackageReference') return ref.relativePath ?? 'local'
    return ''
  }
  for (const id of Array.isArray(project.packageReferences) ? project.packageReferences : []) {
    const ref = objects[id]
    if (ref?.isa === 'XCRemoteSwiftPackageReference') {
      const location = ref.repositoryURL ?? ''
      const requirement = ref.requirement ?? {}
      const declared = [requirement.kind, requirement.minimumVersion ?? requirement.version]
        .concat(requirement.branch ?? requirement.revision ?? [])
        .filter(Boolean)
        .join(' ')
      packages.push({
        kind: 'remote',
        location,
        identity: packageIdentity(location),
        ...(declared ? { requirement: declared } : {})
      })
    } else if (ref?.isa === 'XCLocalSwiftPackageReference') {
      const location = ref.relativePath ?? ''
      packages.push({
        kind: 'local',
        location,
        path: posix.normalize(posix.join(projectDir || '.', location)),
        identity: packageIdentity(location)
      })
    }
  }

  const targetIds: string[] = Array.isArray(project.targets) ? project.targets : []
  const targets = targetIds
    .map((id) => [id, objects[id]] as const)
    .filter(([, t]) => t?.isa === 'PBXNativeTarget' || t?.isa === 'PBXAggregateTarget')
    .map(([id, target]): NativeTarget => {
      const notes: string[] = []
      const sources = new Set<string>()
      const resources = new Set<string>()
      const productType: string = target.productType ?? 'aggregate'
      const binaries = new Set<string>()
      for (const phaseId of target.buildPhases ?? []) {
        const phase = objects[phaseId]
        if (phase?.isa === 'PBXShellScriptBuildPhase')
          notes.push(
            `has a run-script phase "${phase.name ?? 'Run Script'}" that previews do not run`
          )
        if (phase?.isa === 'PBXFrameworksBuildPhase')
          for (const fileId of phase.files ?? []) {
            // Linked bundles inside the project; SDK and built-product frameworks are not files here.
            const ref = objects[fileId]?.fileRef
            const path = ref ? pathOf(ref) : null
            if (path && /\.(xc)?framework$/.test(path)) binaries.add(path)
          }
        const into =
          phase?.isa === 'PBXSourcesBuildPhase'
            ? sources
            : phase?.isa === 'PBXResourcesBuildPhase'
              ? resources
              : null
        if (!into) continue
        for (const fileId of phase.files ?? []) {
          const ref = objects[fileId]?.fileRef
          const path = ref ? pathOf(ref) : null
          if (path && (into === resources || path.endsWith('.swift'))) into.add(path)
        }
      }
      // Synchronized folders: every file is a member unless an exception set says otherwise.
      const exceptionsFor = (groupId: string) =>
        (objects[groupId]?.exceptions ?? [])
          .map((exceptionId: string) => objects[exceptionId])
          .filter(
            (set: any) =>
              set?.isa === 'PBXFileSystemSynchronizedBuildFileExceptionSet' && set.target === id
          )
          .flatMap((set: any) => set.membershipExceptions ?? []) as string[]
      const synced: string[] = target.fileSystemSynchronizedGroups ?? []
      for (const groupId of synced) {
        const dir = pathOf(groupId)
        if (!dir) continue
        const excluded = new Set(exceptionsFor(groupId).map((p) => posix.join(dir, p)))
        for (const file of listFiles(dir)) {
          if (excluded.has(file)) continue
          if (file.endsWith('.swift')) sources.add(file)
          else if (/\.(xcassets|xcstrings|storyboard|xib|ttf|otf|metal)$/.test(file))
            resources.add(file)
        }
      }
      const dependencies: string[] = []
      const packageProducts: string[] = []
      const packageDependencies: NativeTarget['packageDependencies'] = []
      const addProduct = (productId: string | undefined) => {
        const product = productId ? objects[productId] : undefined
        const name: string = (product?.productName ?? '?').replace(/^plugin:/, '')
        const location = packageOf(product?.package)
        if (packageDependencies.some((d) => d.product === name && d.package === location)) return
        packageDependencies.push({ product: name, package: location })
        packageProducts.push(`${name} (${location || 'package'})`)
      }
      for (const depId of target.dependencies ?? []) {
        const dep = objects[depId]
        if (dep?.target && objects[dep.target]) dependencies.push(objects[dep.target].name)
        else if (dep?.productRef) addProduct(dep.productRef)
        else {
          const proxy = objects[dep?.targetProxy]
          notes.push(`depends on "${proxy?.remoteInfo ?? '?'}" in another project`)
        }
      }
      for (const productId of target.packageProductDependencies ?? []) addProduct(productId)
      const own = settingsOf(target.buildConfigurationList)
      const merged = { ...projectSettings.settings, ...own.settings }
      const text = (value: unknown) =>
        typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : undefined
      const settings: Record<string, string> = {}
      for (const key of Object.keys(merged))
        if (REPORTED_SETTINGS.includes(key) || key.startsWith('SWIFT_UPCOMING_FEATURE_')) {
          const value = text(merged[key])
          // A target's `$(inherited)` is the project level's value (xcconfigs aside).
          const inherited = key in own.settings ? (text(projectSettings.settings[key]) ?? '') : ''
          if (value !== undefined)
            settings[key] = value
              .replace(/\$[({]inherited[)}]/g, inherited)
              .replace(/\s+/g, ' ')
              .trim()
        }
      if (own.xcconfig || projectSettings.xcconfig)
        notes.push('settings come partly from an .xcconfig file')
      const product = settings.PRODUCT_MODULE_NAME || settings.PRODUCT_NAME || ''
      const name: string = target.name ?? nameOf(id) ?? id
      return {
        name,
        module: moduleName(!product || product.includes('$(') ? name : product),
        kind: target.isa === 'PBXAggregateTarget' ? 'other' : targetKind(productType),
        productType,
        dependencies,
        packageProducts,
        packageDependencies,
        binaries: [...binaries].sort(),
        sources: [...sources].sort(),
        resources: [...resources].sort(),
        settings,
        notes
      }
    })
  return { targets, packages }
}

/**
 * The `.xcodeproj` files a workspace's `contents.xcworkspacedata` references,
 * project-relative; references outside the project are dropped.
 */
export function workspaceProjects(xml: string, workspace: string): string[] {
  const dir = posix.dirname(workspace)
  const found = new Set<string>()
  for (const match of xml.matchAll(/location\s*=\s*"(group|container):([^"]+)"/g)) {
    const path = posix.normalize(posix.join(dir, match[2]))
    if (path.endsWith('.xcodeproj') && path !== '..' && !path.startsWith('../')) found.add(path)
  }
  return [...found].sort()
}
