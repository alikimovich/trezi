import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, posix } from 'node:path'
import { runTool } from './graph'
import { treeStamps } from './package-build'

/**
 * Resources of a preview build (LKM-275). Asset catalogs are compiled with the
 * selected toolchain's `actool` into the preview host's bundle (`Assets.car`, so
 * `Image("name")`, `NSImage(named:)` and `Color("name")` find them in `Bundle.main`),
 * and per module beside its dylib (`Bundle(for:)` of its classes). Each module gets the
 * asset symbols Xcode generates (`GeneratedAssetSymbols.swift`, `Color(.brand)`,
 * `Image(.logo)`), compiled into it. Plain files are copied into the
 * host's Resources. What is not handled is named with the reason. A package's
 * `Bundle.module` comes from SwiftPM's own resource bundle (`package-build.ts`).
 * Compiled catalogs are cached by their files and the toolchain.
 */
export interface ResourcePlan {
  catalogs: { module: string; path: string }[]
  copied: { module: string; path: string }[]
  unsupported: { module: string; path: string; reason: string }[]
}

const UNSUPPORTED: [RegExp, string][] = [
  [/\.(storyboard|xib)$/, 'Interface Builder files are not compiled (ibtool)'],
  [/\.xcstrings$/, 'String Catalogs are not compiled: text shows the source-language strings'],
  [/\.icon$/, 'app icons are not used by previews'],
  [/\.storekit$/, 'StoreKit configuration files are not used by previews'],
  [/\.metal$/, 'Metal shaders are not compiled'],
  [/\.(xcdatamodeld|xcdatamodel|xcmappingmodel)$/, 'Core Data models are not compiled (momc)'],
  [
    /\.(intentdefinition|rcproject|reality|scnassets|mlmodel|mlpackage)$/,
    'this resource type is not compiled'
  ]
]

/** Each plan module's resources: catalogs, plain files, and what is not handled. */
export function planResources(modules: { module: string; resources: string[] }[]): ResourcePlan {
  const plan: ResourcePlan = { catalogs: [], copied: [], unsupported: [] }
  for (const { module, resources } of modules)
    for (const path of resources) {
      if (path.endsWith('.xcassets')) plan.catalogs.push({ module, path })
      else if (posix.basename(path) === 'Info.plist' || path.endsWith('.entitlements')) continue
      else {
        const reason = UNSUPPORTED.find(([pattern]) => pattern.test(path))?.[1]
        if (reason) plan.unsupported.push({ module, path, reason })
        else plan.copied.push({ module, path })
      }
    }
  return plan
}

/** The actool arguments for a set of catalogs (`--generate-swift-asset-symbols` when `symbols`). */
export function actoolArgs(options: {
  catalogs: string[]
  output: string
  deploymentTarget: string
  symbols?: { file: string; extensions: boolean }
}): string[] {
  return [
    'actool',
    '--compile',
    options.output,
    '--platform',
    'macosx',
    '--minimum-deployment-target',
    options.deploymentTarget || '13.0',
    '--target-device',
    'mac',
    '--output-format',
    'human-readable-text',
    '--output-partial-info-plist',
    join(options.output, 'partial.plist'),
    '--enable-on-demand-resources',
    'NO',
    '--development-region',
    'en',
    ...(options.symbols
      ? [
          '--bundle-identifier',
          'dev.trezi.preview-host',
          '--generate-swift-asset-symbol-extensions',
          options.symbols.extensions ? 'YES' : 'NO',
          '--generate-swift-asset-symbols',
          options.symbols.file
        ]
      : []),
    ...options.catalogs
  ]
}

export interface CompiledResources {
  /** Module → its generated asset symbols file. */
  symbols: Record<string, string>
  /**
   * Module → the `Assets.car` of its own catalogs, placed beside its dylib: there
   * `Bundle(for:)` of a class in the module, which the generated symbols use, finds it
   * (as a framework's own bundle or the app's `Bundle.main` would in an Xcode build).
   */
  modules: Record<string, string>
  /** The compiled `Assets.car` of every catalog, '' when there is none. */
  assets: string
  errors: string[]
  cached: boolean
}

function catalogKey(
  toolchain: string,
  deploymentTarget: string,
  catalogs: string[],
  extra: string
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        toolchain,
        deploymentTarget,
        extra,
        catalogs.flatMap((c) => [c, ...treeStamps(c)])
      ])
    )
    .digest('hex')
    .slice(0, 16)
}

export async function compileResources(
  plan: ResourcePlan,
  options: {
    root: string
    cacheDir: string
    toolchainKey: string
    env: Record<string, string>
    deploymentTarget: string
    /** Module → whether Xcode generates its asset symbols, and their extensions. */
    symbols: Record<string, { enabled: boolean; extensions: boolean }>
    xcrun?: string
    timeoutMs?: number
  }
): Promise<CompiledResources> {
  const compiled: CompiledResources = {
    symbols: {},
    modules: {},
    assets: '',
    errors: [],
    cached: true
  }
  if (!plan.catalogs.length) return compiled
  const base = join(options.cacheDir, 'resources')
  const run = async (
    catalogs: string[],
    output: string,
    symbols?: { file: string; extensions: boolean }
  ) => {
    if (existsSync(join(output, '.complete'))) return true
    compiled.cached = false
    rmSync(output, { recursive: true, force: true })
    mkdirSync(output, { recursive: true })
    const result = await runTool(
      options.xcrun ?? '/usr/bin/xcrun',
      actoolArgs({ catalogs, output, deploymentTarget: options.deploymentTarget, symbols }),
      { cwd: options.root, timeoutMs: options.timeoutMs ?? 120_000, env: options.env }
    )
    const errors = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .filter((line) => /error/i.test(line))
      .slice(0, 5)
    if (result.error) {
      compiled.errors.push(`actool: ${errors.join(' ').trim() || result.error}`)
      return false
    }
    writeFileSync(join(output, '.complete'), '')
    return true
  }
  const modules = [...new Set(plan.catalogs.map((c) => c.module))]
  for (const module of modules) {
    const want = options.symbols[module] ?? { enabled: true, extensions: true }
    const catalogs = plan.catalogs
      .filter((c) => c.module === module)
      .map((c) => join(options.root, c.path))
    const keyFor = (extra: string) =>
      catalogKey(options.toolchainKey, options.deploymentTarget, catalogs, extra)
    // The symbols pass writes no `Assets.car` (Xcode also runs it apart from the compile).
    const output = join(base, `${module}-${keyFor('module')}`)
    if ((await run(catalogs, output)) && existsSync(join(output, 'Assets.car')))
      compiled.modules[module] = join(output, 'Assets.car')
    if (!want.enabled) continue
    const symbols = join(base, `${module}-${keyFor(`symbols:${want.extensions}`)}`)
    const file = join(symbols, 'GeneratedAssetSymbols.swift')
    if ((await run(catalogs, symbols, { file, extensions: want.extensions })) && existsSync(file))
      compiled.symbols[module] = file
  }
  const all = plan.catalogs.map((c) => join(options.root, c.path))
  const key = catalogKey(options.toolchainKey, options.deploymentTarget, all, 'assets')
  const output = join(base, `assets-${key}`)
  if ((await run(all, output)) && existsSync(join(output, 'Assets.car')))
    compiled.assets = join(output, 'Assets.car')
  return compiled
}

/**
 * The preview host as an app bundle, so `Bundle.main` holds the compiled catalogs and
 * copied resources: `<app>/Contents/{MacOS,Resources,Info.plist}`. Returns the
 * executable's path.
 */
export function hostBundle(
  app: string,
  options: { root: string; assets: string; copied: ResourcePlan['copied']; accentColor?: string }
): string {
  const resources = join(app, 'Contents', 'Resources')
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(resources, { recursive: true })
  if (options.assets) cpSync(options.assets, join(resources, 'Assets.car'))
  for (const { path } of options.copied) {
    const from = join(options.root, path)
    if (existsSync(from)) cpSync(from, join(resources, posix.basename(path)), { recursive: true })
  }
  const accent =
    options.accentColor && /^[\w .-]+$/.test(options.accentColor) ? options.accentColor : ''
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.trezi.preview-host</string>
  <key>CFBundleExecutable</key><string>TreziPreviewHost</string>
  <key>CFBundleName</key><string>Trezi Preview Host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>ATSApplicationFontsPath</key><string>.</string>${accent ? `\n  <key>NSAccentColorName</key><string>${accent}</string>` : ''}
</dict>
</plist>
`
  )
  return join(app, 'Contents', 'MacOS', 'TreziPreviewHost')
}

/**
 * Puts a module's `Assets.car` beside its dylib, or removes a stale one. A changed
 * catalog replaces it by rename, so a host still running keeps the one it opened.
 * The folder also gets an `Info.plist` with a bundle identifier: without one AppKit
 * finds no named asset in it (checked: `NSColor(named:bundle:)` returns nil).
 */
export function placeAssets(assets: string, dir: string, module: string) {
  const target = join(dir, 'Assets.car')
  const info = join(dir, 'Info.plist')
  if (!assets) {
    rmSync(target, { force: true })
    return rmSync(info, { force: true })
  }
  if (!existsSync(info))
    writeFileSync(
      info,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.trezi.preview-module.${module.replace(/[^A-Za-z0-9.-]/g, '-')}</string>
</dict>
</plist>
`
    )
  if (existsSync(target) && readFileSync(target).equals(readFileSync(assets))) return
  const next = `${target}.${process.pid}`
  copyFileSync(assets, next)
  renameSync(next, target)
}

/** Whether a generated symbols file declares anything (actool writes one for empty catalogs too). */
export function hasSymbols(file: string): boolean {
  try {
    return /\b(ColorResource|ImageResource)\b/.test(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}
