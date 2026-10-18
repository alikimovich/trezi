import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

/**
 * Build authority (LKM-275): a target's resolved build settings mapped to the `swiftc`
 * flags a preview module compiles with. The values come from `xcodebuild
 * -showBuildSettings -json` (`build-settings.ts`), from a Swift package's `dump-package`
 * (`packageSettings` below) or, when neither tool can run, from the project file. Only
 * settings on an explicit allowlist become flags; every other flag a target sets is
 * dropped and reported with the reason, so a preview never silently differs from Xcode
 * without saying how. Pure: the caller says which paths exist.
 */
export interface DroppedFlag {
  setting: string
  flag: string
  reason: string
}

export interface ModuleSettings {
  /** Where the values came from. */
  from: 'xcodebuild' | 'package manifest' | 'project file'
  /** The language mode passed as `-swift-version`, empty for the compiler's default. */
  swiftVersion: string
  /** Compilation conditions passed as `-D`. */
  defines: string[]
  /** The macOS deployment target in `-target`, empty for the SDK's default. */
  deploymentTarget: string
  /** An absolute SDK path from the settings, else empty (`xcrun --sdk macosx`). */
  sdk: string
  /** The mapped flags, in order (the `-target` triple last). */
  flags: string[]
  dropped: DroppedFlag[]
  notes: string[]
  /** A digest of `flags`: part of each module's cache key. */
  key: string
}

/** Setting suffixes of `SWIFT_UPCOMING_FEATURE_*` and the feature each enables. */
const UPCOMING: Record<string, string> = {
  BARE_SLASH_REGEX_LITERALS: 'BareSlashRegexLiterals',
  CONCISE_MAGIC_FILE: 'ConciseMagicFile',
  DEPRECATE_APPLICATION_MAIN: 'DeprecateApplicationMain',
  DISABLE_OUTWARD_ACTOR_ISOLATION: 'DisableOutwardActorInference',
  DYNAMIC_ACTOR_ISOLATION: 'DynamicActorIsolation',
  EXISTENTIAL_ANY: 'ExistentialAny',
  FORWARD_TRAILING_CLOSURES: 'ForwardTrailingClosures',
  GLOBAL_ACTOR_ISOLATED_TYPES_USABILITY: 'GlobalActorIsolatedTypesUsability',
  GLOBAL_CONCURRENCY: 'GlobalConcurrency',
  IMPLICIT_OPEN_EXISTENTIALS: 'ImplicitOpenExistentials',
  IMPORT_OBJC_FORWARD_DECLS: 'ImportObjcForwardDeclarations',
  INFER_ISOLATED_CONFORMANCES: 'InferIsolatedConformances',
  INFER_SENDABLE_FROM_CAPTURES: 'InferSendableFromCaptures',
  INTERNAL_IMPORTS_BY_DEFAULT: 'InternalImportsByDefault',
  ISOLATED_DEFAULT_VALUES: 'IsolatedDefaultValues',
  MEMBER_IMPORT_VISIBILITY: 'MemberImportVisibility',
  NONFROZEN_ENUM_EXHAUSTIVITY: 'NonfrozenEnumExhaustivity',
  NONISOLATED_NONSENDING_BY_DEFAULT: 'NonisolatedNonsendingByDefault',
  REGION_BASED_ISOLATION: 'RegionBasedIsolation'
}

/** What Xcode 26's "Approachable Concurrency" turns on. */
const APPROACHABLE = [
  'DisableOutwardActorInference',
  'GlobalActorIsolatedTypesUsability',
  'InferIsolatedConformances',
  'InferSendableFromCaptures',
  'NonisolatedNonsendingByDefault'
]

/** `OTHER_SWIFT_FLAGS` passed through: flag → whether it takes the next token. */
const ALLOWED_FLAGS: Record<string, boolean> = {
  '-D': true,
  '-enable-upcoming-feature': true,
  '-enable-experimental-feature': true,
  '-disable-upcoming-feature': true,
  '-default-isolation': true,
  '-warn-concurrency': false,
  '-enable-actor-data-race-checks': false,
  '-enable-bare-slash-regex': false,
  '-suppress-warnings': false,
  '-warnings-as-errors': false,
  '-no-warnings-as-errors': false
}

/** Settings that change how Xcode compiles or links but are not applied, when set. */
const NOT_APPLIED: Record<string, string> = {
  OTHER_LDFLAGS: 'linker flags are not applied: the preview links its own modules',
  OTHER_CFLAGS: 'C flags are not applied: only Swift sources are compiled',
  SWIFT_OBJC_BRIDGING_HEADER: 'bridging headers are not supported yet',
  SWIFT_OPTIMIZATION_LEVEL: 'previews always compile with -Onone',
  SWIFT_COMPILATION_MODE: 'previews always compile incrementally per module'
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Xcode's list syntax: whitespace-separated, with quoted words kept whole. */
export function splitList(value: string | undefined): string[] {
  const words: string[] = []
  for (const match of (value ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g))
    words.push((match[1] ?? match[2] ?? match[3]).replace(/\\(.)/g, '$1'))
  return words.filter((word) => word !== '$(inherited)' && word !== '')
}

/** "5.0" → "5", "4.2" stays, "6" stays; empty when unset or not a version. */
export function swiftVersionFlag(value: string | undefined): string {
  const version = (value ?? '').trim()
  if (!/^\d+(\.\d+)*$/.test(version)) return ''
  return version.replace(/^(\d+)\.0(\.0)?$/, '$1')
}

const yes = (value: string | undefined) => /^(YES|TRUE|1)$/i.test((value ?? '').trim())

export function mapBuildSettings(
  values: Record<string, string>,
  context: {
    from: ModuleSettings['from']
    /** `arm64` or `x86_64`. */
    arch: string
    exists: (path: string) => boolean
    /** Xcode's own product folders: search paths there are Trezi's to provide. */
    products?: string[]
  }
): ModuleSettings {
  const flags: string[] = []
  const dropped: DroppedFlag[] = []
  const notes: string[] = []
  const defines: string[] = []
  const drop = (setting: string, flag: string, reason: string) =>
    dropped.push({ setting, flag, reason })
  const define = (setting: string, name: string) => {
    if (!IDENTIFIER.test(name)) return drop(setting, name, 'not a Swift compilation condition')
    if (!defines.includes(name)) defines.push(name)
  }
  const feature = (name: string) => {
    const pair = ['-enable-upcoming-feature', name]
    for (let i = 0; i < flags.length - 1; i++)
      if (flags[i] === pair[0] && flags[i + 1] === name) return
    flags.push(...pair)
  }

  const swiftVersion = swiftVersionFlag(values.SWIFT_VERSION)
  if (values.SWIFT_VERSION?.trim() && !swiftVersion)
    drop('SWIFT_VERSION', values.SWIFT_VERSION, 'not a Swift language version')
  if (swiftVersion) flags.push('-swift-version', swiftVersion)

  for (const name of splitList(values.SWIFT_ACTIVE_COMPILATION_CONDITIONS))
    define('SWIFT_ACTIVE_COMPILATION_CONDITIONS', name)

  for (const definition of splitList(values.GCC_PREPROCESSOR_DEFINITIONS))
    flags.push('-Xcc', `-D${definition}`)

  const strict = (values.SWIFT_STRICT_CONCURRENCY ?? '').trim()
  if (/^(minimal|targeted|complete)$/.test(strict)) flags.push(`-strict-concurrency=${strict}`)
  else if (strict) drop('SWIFT_STRICT_CONCURRENCY', strict, 'not minimal, targeted or complete')

  const isolation = (values.SWIFT_DEFAULT_ACTOR_ISOLATION ?? '').trim()
  if (/^mainactor$/i.test(isolation)) flags.push('-default-isolation', 'MainActor')
  else if (isolation && !/^nonisolated$/i.test(isolation))
    drop('SWIFT_DEFAULT_ACTOR_ISOLATION', isolation, 'not MainActor or nonisolated')

  if (yes(values.SWIFT_APPROACHABLE_CONCURRENCY)) for (const name of APPROACHABLE) feature(name)
  for (const [setting, value] of Object.entries(values).sort()) {
    if (!setting.startsWith('SWIFT_UPCOMING_FEATURE_') || !yes(value)) continue
    const name = UPCOMING[setting.slice('SWIFT_UPCOMING_FEATURE_'.length)]
    if (name) feature(name)
    else drop(setting, value, 'an upcoming feature Trezi does not know')
  }
  if (yes(values.SWIFT_ENABLE_BARE_SLASH_REGEX)) flags.push('-enable-bare-slash-regex')

  // OTHER_SWIFT_FLAGS: only the allowlist; every other flag is reported, never passed.
  const other = splitList(values.OTHER_SWIFT_FLAGS)
  for (let i = 0; i < other.length; i++) {
    const word = other[i]
    if (word.startsWith('-D') && word.length > 2) {
      define('OTHER_SWIFT_FLAGS', word.slice(2))
      continue
    }
    if (word.startsWith('-strict-concurrency=')) {
      flags.push(word)
      continue
    }
    if (!(word in ALLOWED_FLAGS)) {
      // A value of the dropped flag goes with it.
      const next = other[i + 1]
      const takesValue =
        next !== undefined &&
        (/^-X(frontend|cc|linker|llvm|clang-linker)$/.test(word) ||
          (!next.startsWith('-') && word.startsWith('-')))
      drop(
        'OTHER_SWIFT_FLAGS',
        takesValue ? `${word} ${next}` : word,
        "not on Trezi's allowlist of Swift flags"
      )
      if (takesValue) i++
      continue
    }
    if (!ALLOWED_FLAGS[word]) {
      flags.push(word)
      continue
    }
    const value = other[i + 1]
    if (value === undefined) {
      drop('OTHER_SWIFT_FLAGS', word, 'is missing its value')
      continue
    }
    i++
    if (word === '-D') define('OTHER_SWIFT_FLAGS', value)
    else if (word === '-enable-upcoming-feature') feature(value)
    else flags.push(word, value)
  }
  for (const name of defines) flags.push('-D', name)

  const products = (context.products ?? []).filter(Boolean)
  const searchPaths: [string, string, string[]][] = [
    ['FRAMEWORK_SEARCH_PATHS', '-F', []],
    ['SYSTEM_FRAMEWORK_SEARCH_PATHS', '-F', []],
    ['SWIFT_INCLUDE_PATHS', '-I', []],
    ['HEADER_SEARCH_PATHS', '-I', ['-Xcc']],
    ['LIBRARY_SEARCH_PATHS', '-L', []]
  ]
  for (const [setting, flag, prefix] of searchPaths)
    for (const path of splitList(values[setting])) {
      const clean = path.replace(/\/+$/, '')
      if (products.some((dir) => clean === dir || clean.startsWith(`${dir}/`))) continue
      if (clean.includes('$(')) drop(setting, path, 'an unresolved build setting')
      else if (clean.endsWith('/**')) drop(setting, path, 'recursive search paths are not expanded')
      else if (!isAbsolute(clean)) drop(setting, path, 'a relative search path')
      else if (!context.exists(clean)) drop(setting, path, 'the folder does not exist')
      else flags.push(...prefix, flag, clean)
    }

  const sdk = (values.SDKROOT ?? '').trim()
  const sdkPath = isAbsolute(sdk) && context.exists(sdk) ? sdk : ''
  if (sdkPath) flags.push('-sdk', sdkPath)
  else if (sdk && isAbsolute(sdk))
    notes.push(`The SDK ${sdk} is missing; the default macOS SDK is used.`)

  for (const [setting, reason] of Object.entries(NOT_APPLIED)) {
    const value = splitList(values[setting]).join(' ')
    if (!value) continue
    if (setting === 'SWIFT_OPTIMIZATION_LEVEL' && value === '-Onone') continue
    if (setting === 'SWIFT_COMPILATION_MODE' && value === 'singlefile') continue
    drop(setting, value, reason)
  }

  const deployment = (values.MACOSX_DEPLOYMENT_TARGET ?? '').trim()
  const deploymentTarget = /^\d+(\.\d+)*$/.test(deployment) ? deployment : ''
  if (deployment && !deploymentTarget)
    drop('MACOSX_DEPLOYMENT_TARGET', deployment, 'not a macOS version')
  if (deploymentTarget) flags.push('-target', `${context.arch}-apple-macosx${deploymentTarget}`)

  return {
    from: context.from,
    swiftVersion,
    defines,
    deploymentTarget,
    sdk: sdkPath,
    flags,
    dropped,
    notes,
    key: createHash('sha256').update(JSON.stringify(flags)).digest('hex').slice(0, 16)
  }
}

/** The higher of two dotted versions ('' counts as lowest). */
export function maxVersion(a: string, b: string): string {
  const parts = (v: string) => v.split('.').map(Number)
  const [x, y] = [parts(a || '0'), parts(b || '0')]
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b
  return a || b
}

/**
 * A Swift package target's settings (`swift package dump-package`) as the build-setting
 * values `mapBuildSettings` reads, for a debug macOS build: the language mode from the
 * tools version or `swiftLanguageModes`, `platforms`, and the target's `define`,
 * `unsafeFlags`, upcoming/experimental features and default isolation. SwiftPM always
 * defines DEBUG and SWIFT_PACKAGE in debug builds; it does too.
 */
export function packageSettings(
  dump: any,
  target: string
): { values: Record<string, string>; dropped: DroppedFlag[] } {
  const dropped: DroppedFlag[] = []
  const tools = String(dump?.toolsVersion?._version ?? '5.0')
  // SwiftPM builds with the highest declared mode, else the tools version's default.
  const modes: string[] = (dump?.swiftLanguageVersions ?? [])
    .map(String)
    .filter((mode: string) => /^\d+(\.\d+)*$/.test(mode))
  let swiftVersion = modes.length
    ? modes.reduce((a, b) => maxVersion(a, b))
    : Number.parseInt(tools, 10) >= 6
      ? '6'
      : Number.parseInt(tools, 10) >= 5
        ? '5'
        : '4'
  const macos = (dump?.platforms ?? []).find((p: any) => p?.platformName === 'macos')
  const defines = ['DEBUG', 'SWIFT_PACKAGE']
  const other: string[] = []
  const found = (dump?.targets ?? []).find((t: any) => t?.name === target)
  let isolation = ''
  for (const setting of found?.settings ?? []) {
    if (setting?.tool !== 'swift') continue
    const condition = setting.condition
    if (condition?.config && condition.config !== 'debug') continue
    if (condition?.platformNames?.length && !condition.platformNames.includes('macos')) continue
    const kind = setting.kind ?? {}
    const [name] = Object.keys(kind)
    const value = kind[name]?._0
    if (name === 'define' && typeof value === 'string') defines.push(value)
    else if (name === 'unsafeFlags' && Array.isArray(value)) other.push(...value)
    else if (name === 'enableUpcomingFeature') other.push('-enable-upcoming-feature', value)
    else if (name === 'enableExperimentalFeature') other.push('-enable-experimental-feature', value)
    else if (name === 'defaultIsolation') isolation = String(value)
    else if (name === 'swiftLanguageMode' || name === 'swiftLanguageVersion')
      swiftVersion = String(value)
    else if (name)
      dropped.push({
        setting: 'swiftSettings',
        flag: name,
        reason: 'a package setting Trezi does not map'
      })
  }
  const values: Record<string, string> = {
    SWIFT_VERSION: swiftVersion,
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: defines.join(' '),
    OTHER_SWIFT_FLAGS: other.map((word) => (/\s/.test(word) ? `"${word}"` : word)).join(' ')
  }
  if (macos?.version) values.MACOSX_DEPLOYMENT_TARGET = String(macos.version)
  if (isolation) values.SWIFT_DEFAULT_ACTOR_ISOLATION = isolation
  return { values, dropped }
}
