/**
 * LKM-275: the build authority of a native preview, with scripted tools only. Resolved
 * settings mapped to swiftc flags (SWIFT_VERSION, compilation conditions, deployment
 * target, the OTHER_SWIFT_FLAGS allowlist and every dropped flag), a package's settings,
 * Package.resolved pins, the dependency plan (local, remote pinned, binary frameworks and
 * every unsupported kind with its message), the wrapper package, cache keys,
 * `xcodebuild -showBuildSettings` (transient folders removed, leftovers reported), the
 * package build and asset catalogs in Trezi's derived data, and the whole build authority
 * on `test/fixtures/swift-package-app`. Regression: no command any LKM-275 step runs
 * disables a sandbox, and no LKM-275 source can add such a flag.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(ROOT, 'test/fixtures/swift-package-app')
const { mapBuildSettings, packageSettings, splitList, swiftVersionFlag, maxVersion } = await import(
  '../src/swift-preview/settings.ts'
)
const { parseResolved, resolvedFiles, planDependencies, wrapperManifest, dependencyKey, WRAPPER } =
  await import('../src/swift-preview/dependencies.ts')
const { packageBuildArgs, buildPackages } = await import('../src/swift-preview/package-build.ts')
const { planResources, actoolArgs, compileResources, hostBundle, hasSymbols, placeAssets } =
  await import('../src/swift-preview/resources.ts')
const { showSettingsArgs, resolveXcodeSettings } = await import(
  '../src/swift-preview/build-settings.ts'
)
const { moduleKey, moduleInputs, TargetBuilder } = await import('../src/swift-preview/builder.ts')
const { dumpPackage, nativeGraph } = await import('../src/swift-preview/graph.ts')
const { planTargetBuild } = await import('../src/swift-preview/plan.ts')
const { parsePbxproj } = await import('../src/swift-preview/pbxproj.ts')

const temp = mkdtempSync(join(tmpdir(), 'swift-settings-'))
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const exists = (path) => existsSync(path)
const list = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
// Every scripted tool appends its arguments here: the sandbox regression reads them all.
const LOG = join(temp, 'tools.log')
const logged = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n') : [])
const tools = join(temp, 'tools')
const script = (name, body) => {
  write(
    join(tools, name),
    `#!/bin/sh
printf '%s\\n' "$(basename "$0") $*" >> "${LOG}"
prev=""; for a in "$@"; do
  case "$prev" in
    --scratch-path) scratch="$a" ;; --compile) out="$a" ;;
    --generate-swift-asset-symbols) sym="$a" ;; -project) project="$a" ;;
  esac
  prev="$a"
done
${body}
`
  )
  chmodSync(join(tools, name), 0o755)
  return join(tools, name)
}

try {
  // --- Settings mapping: language mode, conditions, deployment target, allowlist ---
  assert.deepEqual(splitList('$(inherited) DEBUG "A B" \'C\''), ['DEBUG', 'A B', 'C'])
  assert.equal(swiftVersionFlag('5.0'), '5')
  assert.equal(swiftVersionFlag('6'), '6')
  assert.equal(swiftVersionFlag('4.2'), '4.2')
  assert.equal(swiftVersionFlag('five'), '')
  assert.equal(maxVersion('14.0', '13.5'), '14.0')
  assert.equal(maxVersion('', '15.2'), '15.2')
  const existing = join(temp, 'Frameworks')
  mkdirSync(existing)
  const products = join(temp, 'DerivedData/Build/Products/Debug')
  const mapped = mapBuildSettings(
    {
      SWIFT_VERSION: '5.0',
      SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG $(inherited) GALLERY 1BAD',
      MACOSX_DEPLOYMENT_TARGET: '14.0',
      GCC_PREPROCESSOR_DEFINITIONS: 'DEBUG=1',
      OTHER_SWIFT_FLAGS:
        '$(inherited) -D FLAG -DSECOND -Xfrontend -warn-long-function-bodies=500 -enable-upcoming-feature ExistentialAny -suppress-warnings -load-plugin-executable /x#Y -O',
      SWIFT_STRICT_CONCURRENCY: 'complete',
      SWIFT_UPCOMING_FEATURE_CONCISE_MAGIC_FILE: 'YES',
      SWIFT_UPCOMING_FEATURE_SOMETHING_NEW: 'YES',
      SWIFT_OPTIMIZATION_LEVEL: '-Onone',
      SWIFT_COMPILATION_MODE: 'wholemodule',
      OTHER_LDFLAGS: '-ObjC',
      SWIFT_OBJC_BRIDGING_HEADER: 'App/Bridge.h',
      FRAMEWORK_SEARCH_PATHS: `$(inherited) ${products} ${existing} /nowhere relative/Dir $(SRCROOT)/X /deep/**`,
      SDKROOT: '/missing/MacOSX.sdk'
    },
    { from: 'xcodebuild', arch: 'arm64', exists, products: [products] }
  )
  assert.equal(mapped.from, 'xcodebuild')
  assert.equal(mapped.swiftVersion, '5', 'SWIFT_VERSION 5.0 is -swift-version 5')
  assert.deepEqual(mapped.defines, ['DEBUG', 'GALLERY', 'FLAG', 'SECOND'])
  assert.equal(mapped.deploymentTarget, '14.0')
  assert.deepEqual(mapped.flags.slice(0, 2), ['-swift-version', '5'])
  assert.deepEqual(mapped.flags.slice(-2), ['-target', 'arm64-apple-macosx14.0'], 'triple last')
  const has = (...pair) =>
    mapped.flags.some((_, i) => pair.every((word, j) => mapped.flags[i + j] === word))
  for (const pair of [
    ['-D', 'DEBUG'],
    ['-D', 'GALLERY'],
    ['-D', 'FLAG'],
    ['-Xcc', '-DDEBUG=1'],
    ['-strict-concurrency=complete'],
    ['-enable-upcoming-feature', 'ExistentialAny'],
    ['-enable-upcoming-feature', 'ConciseMagicFile'],
    ['-suppress-warnings'],
    ['-F', existing]
  ])
    assert.ok(has(...pair), `${pair.join(' ')} in ${mapped.flags.join(' ')}`)
  assert.ok(!mapped.flags.includes(products), "Xcode's product folders are Trezi's to provide")
  assert.ok(!mapped.flags.includes('-sdk'), 'a missing SDK is not passed')
  assert.match(mapped.notes.join(' '), /The SDK \/missing\/MacOSX\.sdk is missing/)
  const dropped = mapped.dropped.map((d) => `${d.setting}: ${d.flag}: ${d.reason}`)
  for (const line of [
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS: 1BAD: not a Swift compilation condition',
    "OTHER_SWIFT_FLAGS: -Xfrontend -warn-long-function-bodies=500: not on Trezi's allowlist of Swift flags",
    "OTHER_SWIFT_FLAGS: -load-plugin-executable /x#Y: not on Trezi's allowlist of Swift flags",
    "OTHER_SWIFT_FLAGS: -O: not on Trezi's allowlist of Swift flags",
    'SWIFT_UPCOMING_FEATURE_SOMETHING_NEW: YES: an upcoming feature Trezi does not know',
    'SWIFT_COMPILATION_MODE: wholemodule: previews always compile incrementally per module',
    'OTHER_LDFLAGS: -ObjC: linker flags are not applied: the preview links its own modules',
    'SWIFT_OBJC_BRIDGING_HEADER: App/Bridge.h: bridging headers are not supported yet',
    'FRAMEWORK_SEARCH_PATHS: /nowhere: the folder does not exist',
    'FRAMEWORK_SEARCH_PATHS: relative/Dir: a relative search path',
    'FRAMEWORK_SEARCH_PATHS: $(SRCROOT)/X: an unresolved build setting',
    'FRAMEWORK_SEARCH_PATHS: /deep/**: recursive search paths are not expanded'
  ])
    assert.ok(dropped.includes(line), `dropped "${line}" in ${JSON.stringify(dropped, null, 1)}`)
  assert.ok(
    !dropped.some((d) => /SWIFT_OPTIMIZATION_LEVEL/.test(d)),
    '-Onone is what previews use anyway'
  )
  for (const word of ['-Xfrontend', '-O', '-load-plugin-executable', '-ObjC'])
    assert.ok(!mapped.flags.includes(word), `${word} is never passed`)
  const again = mapBuildSettings(
    { SWIFT_VERSION: '5.0', MACOSX_DEPLOYMENT_TARGET: '14.0' },
    { from: 'project file', arch: 'arm64', exists }
  )
  assert.deepEqual(again.flags, ['-swift-version', '5', '-target', 'arm64-apple-macosx14.0'])
  assert.equal(
    mapBuildSettings(
      { SWIFT_VERSION: '5.0', MACOSX_DEPLOYMENT_TARGET: '14.0' },
      { from: 'xcodebuild', arch: 'arm64', exists }
    ).key,
    again.key,
    'the key is the flags'
  )
  assert.notEqual(
    mapBuildSettings(
      { SWIFT_VERSION: '6', MACOSX_DEPLOYMENT_TARGET: '14.0' },
      { from: 'project file', arch: 'arm64', exists }
    ).key,
    again.key
  )
  const bad = mapBuildSettings(
    { SWIFT_VERSION: 'latest', MACOSX_DEPLOYMENT_TARGET: 'fourteen', OTHER_SWIFT_FLAGS: '-D' },
    { from: 'project file', arch: 'x86_64', exists }
  )
  assert.deepEqual(bad.flags, [])
  assert.deepEqual(
    bad.dropped.map((d) => `${d.setting} ${d.flag}`),
    ['SWIFT_VERSION latest', 'OTHER_SWIFT_FLAGS -D', 'MACOSX_DEPLOYMENT_TARGET fourteen']
  )

  // --- A package's settings from dump-package ---
  const dump = {
    toolsVersion: { _version: '5.9.0' },
    platforms: [{ platformName: 'macos', version: '14.0' }],
    targets: [
      {
        name: 'Kit',
        settings: [
          { tool: 'swift', kind: { define: { _0: 'KIT' } } },
          {
            tool: 'swift',
            kind: { define: { _0: 'RELEASE_ONLY' } },
            condition: { config: 'release' }
          },
          {
            tool: 'swift',
            kind: { define: { _0: 'IOS_ONLY' } },
            condition: { platformNames: ['ios'] }
          },
          { tool: 'swift', kind: { unsafeFlags: { _0: ['-Xfrontend', '-enable-x'] } } },
          { tool: 'swift', kind: { enableUpcomingFeature: { _0: 'ExistentialAny' } } },
          { tool: 'swift', kind: { interoperabilityMode: { _0: 'Cxx' } } },
          { tool: 'c', kind: { define: { _0: 'C_ONLY' } } }
        ]
      }
    ]
  }
  const pkg = packageSettings(dump, 'Kit')
  assert.deepEqual(pkg.values, {
    SWIFT_VERSION: '5',
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG SWIFT_PACKAGE KIT',
    OTHER_SWIFT_FLAGS: '-Xfrontend -enable-x -enable-upcoming-feature ExistentialAny',
    MACOSX_DEPLOYMENT_TARGET: '14.0'
  })
  assert.deepEqual(pkg.dropped, [
    {
      setting: 'swiftSettings',
      flag: 'interoperabilityMode',
      reason: 'a package setting Trezi does not map'
    }
  ])
  const pkgMapped = mapBuildSettings(pkg.values, {
    from: 'package manifest',
    arch: 'arm64',
    exists
  })
  assert.deepEqual(pkgMapped.defines, ['DEBUG', 'SWIFT_PACKAGE', 'KIT'])
  assert.equal(pkgMapped.dropped[0].flag, '-Xfrontend -enable-x', 'unsafe flags meet the allowlist')
  assert.equal(
    packageSettings({ toolsVersion: { _version: '6.0.0' } }, 'X').values.SWIFT_VERSION,
    '6'
  )
  assert.equal(
    packageSettings({ toolsVersion: { _version: '6.0.0' }, swiftLanguageVersions: ['5'] }, 'X')
      .values.SWIFT_VERSION,
    '5'
  )

  // --- Package.resolved, versions 1 to 3 ---
  const v1 = JSON.stringify({
    object: {
      pins: [
        {
          package: 'Sparkle',
          repositoryURL: 'https://github.com/sparkle-project/Sparkle.git',
          state: { revision: 'aaa', version: '2.6.0' }
        }
      ]
    },
    version: 1
  })
  const v3 = JSON.stringify({
    pins: [
      {
        identity: 'sparkle',
        kind: 'remoteSourceControl',
        location: 'https://github.com/sparkle-project/Sparkle',
        state: { revision: 'bbb', version: '2.6.4' }
      },
      {
        identity: 'tip',
        kind: 'remoteSourceControl',
        location: 'https://e.x/tip.git',
        state: { branch: 'main', revision: 'ccc' }
      },
      { identity: 'unpinned', location: 'https://e.x/u', state: {} }
    ],
    version: 3
  })
  assert.deepEqual(parseResolved(v1), [
    {
      identity: 'sparkle',
      location: 'https://github.com/sparkle-project/Sparkle.git',
      revision: 'aaa',
      version: '2.6.0'
    }
  ])
  assert.deepEqual(
    parseResolved(v3).map((p) => [p.identity, p.version, p.branch, p.revision]),
    [
      ['sparkle', '2.6.4', undefined, 'bbb'],
      ['tip', undefined, 'main', 'ccc']
    ]
  )
  assert.deepEqual(parseResolved('not json'), [])
  assert.deepEqual(
    resolvedFiles({ kind: 'project', path: 'ios/App.xcodeproj' }, ['ios/App.xcworkspace']),
    [
      'ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      'ios/App.xcworkspace/xcshareddata/swiftpm/Package.resolved'
    ]
  )
  assert.deepEqual(resolvedFiles({ kind: 'package', path: 'Kit/Package.swift' }, []), [
    'Kit/Package.resolved'
  ])

  // --- The dependency plan: every kind and every unsupported message ---
  const repo = join(temp, 'deps')
  write(join(repo, 'Packages/Design/Package.swift'), '// swift-tools-version:5.9')
  mkdirSync(join(repo, 'Packages/Empty'), { recursive: true })
  mkdirSync(join(repo, 'Vendor/Fast.xcframework/macos-arm64_x86_64/Fast.framework'), {
    recursive: true
  })
  mkdirSync(join(repo, 'Vendor/Fast.xcframework/ios-arm64/Fast.framework'), { recursive: true })
  mkdirSync(join(repo, 'Vendor/Phone.xcframework/ios-arm64/Phone.framework'), { recursive: true })
  write(join(repo, 'Vendor/Lib.xcframework/macos-arm64/libLib.a'), '')
  mkdirSync(join(repo, 'Vendor/Plain.framework'), { recursive: true })
  write(join(repo, 'Podfile'), "target 'App'")
  write(join(repo, 'Cartfile'), 'github "x/y"')
  const target = (name, fields = {}) => ({
    name,
    module: name,
    kind: 'app',
    productType: 'com.apple.product-type.application',
    dependencies: [],
    packageProducts: [],
    packageDependencies: [],
    binaries: [],
    sources: [`${name}/A.swift`],
    resources: [],
    settings: {},
    notes: [],
    ...fields
  })
  const app = target('App', {
    packageDependencies: [
      { product: 'Design', package: 'Packages/Design' },
      { product: 'Sparkle', package: 'https://github.com/sparkle-project/Sparkle' },
      { product: 'Tip', package: 'https://e.x/tip.git' },
      { product: 'Nope', package: 'https://e.x/nope' },
      { product: 'Outside', package: '../Outside' },
      { product: 'Empty', package: 'Packages/Empty' },
      { product: 'Ghost', package: '' },
      { product: 'Stray', package: 'https://e.x/stray' }
    ],
    binaries: [
      'Vendor/Fast.xcframework',
      'Vendor/Phone.xcframework',
      'Vendor/Lib.xcframework',
      'Vendor/Plain.framework',
      'Vendor/Gone.framework'
    ],
    notes: ['depends on "Other" in another project']
  })
  const container = {
    kind: 'project',
    path: 'App.xcodeproj',
    schemes: ['App'],
    schemesFrom: 'scheme files',
    targets: [app],
    packages: [
      { kind: 'local', location: 'Packages/Design', path: 'Packages/Design', identity: 'design' },
      {
        kind: 'remote',
        location: 'https://github.com/sparkle-project/Sparkle',
        identity: 'sparkle',
        requirement: 'upToNextMajorVersion 2.0.0'
      },
      { kind: 'remote', location: 'https://e.x/tip.git', identity: 'tip' },
      { kind: 'remote', location: 'https://e.x/nope', identity: 'nope' },
      { kind: 'local', location: '../Outside', path: '../Outside', identity: 'outside' },
      { kind: 'local', location: 'Packages/Empty', path: 'Packages/Empty', identity: 'empty' }
    ],
    projects: [],
    errors: []
  }
  const graph = { structure: null, containers: [container], errors: [], durationMs: 0 }
  const resolved = {
    path: 'App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    text: v3
  }
  const deps = planDependencies({
    root: repo,
    container,
    graph,
    targets: [app],
    resolved,
    exists,
    list
  })
  assert.equal(deps.resolvedFile, resolved.path)
  assert.deepEqual(
    deps.packages.map((p) => [p.identity, p.kind, p.location, p.pin?.version, p.products]),
    [
      ['design', 'local', join(repo, 'Packages/Design'), undefined, ['Design']],
      ['sparkle', 'remote', 'https://github.com/sparkle-project/Sparkle', '2.6.4', ['Sparkle']],
      ['tip', 'remote', 'https://e.x/tip.git', undefined, ['Tip']]
    ],
    'a local package, a version pin and a branch pin'
  )
  assert.equal(deps.packages[2].pin.revision, 'ccc')
  assert.deepEqual(
    deps.binaries.map((b) => [b.path, b.framework, b.searchDir]),
    [
      ['Vendor/Fast.xcframework', 'Fast', join(repo, 'Vendor/Fast.xcframework/macos-arm64_x86_64')],
      ['Vendor/Plain.framework', 'Plain', join(repo, 'Vendor')]
    ],
    "an xcframework's macOS slice and a plain framework"
  )
  const unsupported = deps.unsupported.map(
    (u) => `${u.kind} | ${u.name} | ${u.reason} | ${u.required}`
  )
  assert.deepEqual(unsupported, [
    `remote package without a pin | Nope (https://e.x/nope) | ${resolved.path} has no pin for https://e.x/nope; resolve the packages in Xcode once (Trezi never resolves or updates them) | true`,
    `local package outside the project | Outside (../Outside) | ${join(temp, 'Outside')} is outside the project folder; Trezi only builds packages inside it | true`,
    'local package | Empty (Packages/Empty) | Packages/Empty has no Package.swift | true',
    'package product | Ghost | no package in the project provides it | true',
    'package product | Stray (https://e.x/stray) | the project does not reference the package https://e.x/stray | true',
    'binary framework | Vendor/Phone.xcframework | it has no macOS slice | true',
    'binary framework | Vendor/Lib.xcframework | its macOS slice is a library, not a framework; library slices are not linked yet | true',
    'binary framework | Vendor/Gone.framework | the file is missing | true',
    'target in another project | Other | cross-project target dependencies are not built yet | true',
    'CocoaPods | CocoaPods | pods are not installed or built; components that import a pod do not compile | false',
    'Carthage | Carthage | Carthage frameworks are not built; link them as .xcframework files instead | false'
  ])
  const noPins = planDependencies({
    root: repo,
    container,
    graph,
    targets: [target('App', { packageDependencies: [app.packageDependencies[1]] })],
    resolved: null,
    exists,
    list
  })
  assert.match(
    noPins.unsupported[0].reason,
    /^there is no Package\.resolved for https:\/\/github\.com\/sparkle-project\/Sparkle; resolve the packages in Xcode once/
  )

  // The plan names them in the UI and API: blockers for required ones, warnings otherwise.
  write(join(repo, 'App/A.swift'), 'struct A {}\n')
  write(join(repo, resolved.path), v3)
  const plan = planTargetBuild(
    graph,
    { target: 'App' },
    (path) => readFileSync(join(repo, path), 'utf8'),
    { root: repo, exists, list }
  )
  assert.equal(plan.dependencies.packages.length, 3)
  for (const line of [
    'App needs the Swift package product Nope (https://e.x/nope), which Trezi does not build:',
    'App needs binary framework Vendor/Gone.framework, which Trezi does not build: the file is missing.',
    'App needs target in another project Other, which Trezi does not build: cross-project target dependencies are not built yet.'
  ])
    assert.ok(
      plan.blockers.some((b) => b.startsWith(line)),
      `${line} in ${plan.blockers.join('\n')}`
    )
  assert.ok(
    plan.warnings.includes(
      'CocoaPods (CocoaPods): pods are not installed or built; components that import a pod do not compile.'
    )
  )

  // --- The wrapper package and cache keys ---
  const manifest = wrapperManifest(deps, '14.0')
  assert.match(manifest, /^\/\/ swift-tools-version:5\.9/)
  assert.ok(manifest.includes(`.package(path: "${join(repo, 'Packages/Design')}")`))
  assert.ok(
    manifest.includes(
      '.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.6.4")'
    ),
    'a remote package at its pinned version only'
  )
  assert.ok(manifest.includes('.package(url: "https://e.x/tip.git", revision: "ccc")'))
  assert.ok(manifest.includes('.product(name: "Sparkle", package: "sparkle")'))
  assert.ok(manifest.includes('platforms: [.macOS("14.0")]'))
  assert.ok(manifest.includes(`.library(name: "${WRAPPER}", type: .dynamic`))
  const quoted = wrapperManifest(
    { ...deps, packages: [{ ...deps.packages[0], location: '/a "b"\\c' }] },
    'not a version'
  )
  assert.ok(quoted.includes('.package(path: "/a \\"b\\"\\\\c")'), 'quotes are escaped')
  assert.ok(quoted.includes('.macOS("13.0")'))
  assert.throws(
    () =>
      wrapperManifest({ ...deps, packages: [{ ...deps.packages[0], location: '/a\nb' }] }, '14.0'),
    /control characters/
  )
  const keyParts = { toolchain: 'tc1', manifest, pins: parseResolved(v3), localStamps: ['a:1:2'] }
  const depKey = dependencyKey(keyParts)
  assert.match(depKey, /^[0-9a-f]{16}$/)
  assert.equal(dependencyKey({ ...keyParts }), depKey)
  for (const change of [
    { toolchain: 'tc2' },
    { manifest: `${manifest} ` },
    { pins: parseResolved(v1) },
    { localStamps: ['a:1:3'] }
  ])
    assert.notEqual(dependencyKey({ ...keyParts, ...change }), depKey, JSON.stringify(change))
  const source = join(temp, 'Key.swift')
  write(source, 'struct K {}\n')
  const module = {
    module: 'Kit',
    sources: [source],
    dependencies: [],
    testing: true,
    flags: ['-D', 'X']
  }
  const modKey = moduleKey({ toolchain: 'tc1', module, shared: ['-I', '/p'], dependencyKeys: [] })
  assert.equal(
    moduleKey({ toolchain: 'tc1', module, shared: ['-I', '/p'], dependencyKeys: [] }),
    modKey
  )
  for (const [label, parts] of [
    ['toolchain', { toolchain: 'tc2', module, shared: ['-I', '/p'], dependencyKeys: [] }],
    [
      'settings',
      {
        toolchain: 'tc1',
        module: { ...module, flags: ['-D', 'Y'] },
        shared: ['-I', '/p'],
        dependencyKeys: []
      }
    ],
    ['SDK/package flags', { toolchain: 'tc1', module, shared: ['-I', '/q'], dependencyKeys: [] }],
    ['dependency keys', { toolchain: 'tc1', module, shared: ['-I', '/p'], dependencyKeys: ['abc'] }]
  ])
    assert.notEqual(moduleKey(parts), modKey, `a module key follows the ${label}`)
  utimesSync(source, new Date(), new Date(Date.now() + 5_000))
  assert.notEqual(
    moduleKey({ toolchain: 'tc1', module, shared: ['-I', '/p'], dependencyKeys: [] }),
    modKey,
    'and its sources'
  )

  // --- Resources: the plan and actool's arguments ---
  const resources = planResources([
    {
      module: 'App',
      resources: [
        'App/Assets.xcassets',
        'App/Info.plist',
        'App/App.entitlements',
        'App/Localizable.xcstrings',
        'App/Main.storyboard',
        'App/AppIcon.icon',
        'App/Monthly.storekit',
        'App/Font.ttf',
        'App/Model.xcdatamodeld'
      ]
    }
  ])
  assert.deepEqual(resources.catalogs, [{ module: 'App', path: 'App/Assets.xcassets' }])
  assert.deepEqual(resources.copied, [{ module: 'App', path: 'App/Font.ttf' }])
  assert.deepEqual(
    resources.unsupported.map((u) => `${u.path}: ${u.reason}`),
    [
      'App/Localizable.xcstrings: String Catalogs are not compiled: text shows the source-language strings',
      'App/Main.storyboard: Interface Builder files are not compiled (ibtool)',
      'App/AppIcon.icon: app icons are not used by previews',
      'App/Monthly.storekit: StoreKit configuration files are not used by previews',
      'App/Model.xcdatamodeld: Core Data models are not compiled (momc)'
    ]
  )

  // --- xcodebuild -showBuildSettings: scheme, Debug, macOS, Trezi's derived data ---
  const gallery = join(temp, 'gallery')
  cpSync(FIXTURE, gallery, { recursive: true })
  const derivedData = join(temp, 'cache/xcode-tc1')
  const settingsJson = join(temp, 'settings.json')
  const built = join(derivedData, 'Build/Products/Debug')
  const resolvedSettings = (target, extra) => ({
    target,
    action: 'build',
    buildSettings: {
      TARGET_NAME: target,
      SWIFT_VERSION: '5.0',
      MACOSX_DEPLOYMENT_TARGET: '14.0',
      SDKROOT: '/fake/MacOSX.sdk',
      BUILT_PRODUCTS_DIR: built,
      FRAMEWORK_SEARCH_PATHS: `${built} `,
      SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG',
      PRODUCT_MODULE_NAME: target,
      ...extra
    }
  })
  writeFileSync(
    settingsJson,
    JSON.stringify([
      resolvedSettings('GalleryKit', {}),
      resolvedSettings('Gallery', {
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'GALLERY_FIXTURE DEBUG',
        OTHER_SWIFT_FLAGS: '  -D GALLERY_FLAG -Xfrontend -warn-long-function-bodies=500',
        ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS: 'YES',
        ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: 'AccentColor'
      })
    ])
  )
  const xcodebuild = script(
    'xcodebuild',
    `case "$1" in
  -list)
    mkdir -p "$project/project.xcworkspace/xcshareddata/swiftpm/configuration"
    mkdir -p "$(dirname "$project")/Packages/StudioDesign/.swiftpm/xcode"
    echo '{"project":{"name":"Gallery","schemes":["Gallery"],"targets":["Gallery","GalleryKit"]}}' ;;
  -showBuildSettings)
    mkdir -p "$project/project.xcworkspace/xcshareddata/swiftpm/configuration"
    mkdir -p "$(dirname "$project")/Packages/StudioDesign/.swiftpm/xcode"
    [ "$FAKE_MODE" = leftover ] && echo '{}' > "$project/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
    [ "$FAKE_MODE" = fail ] || [ "$FAKE_MODE" = sandbox ] && { echo "xcodebuild: error: The project is damaged." >&2; exit 65; }
    echo "Command line invocation: ignored"
    cat "${settingsJson}" ;;
esac`
  )
  const galleryContainer = {
    kind: 'project',
    path: 'Gallery.xcodeproj',
    schemes: ['Gallery'],
    targets: [],
    packages: [
      {
        kind: 'local',
        location: 'Packages/StudioDesign',
        path: 'Packages/StudioDesign',
        identity: 'studiodesign'
      }
    ],
    projects: [],
    errors: []
  }
  let xcode = await resolveXcodeSettings(gallery, galleryContainer, ['GalleryKit', 'Gallery'], {
    derivedData,
    env: {},
    xcodebuild
  })
  assert.deepEqual([xcode.scheme, xcode.errors, xcode.leftovers], ['Gallery', [], []])
  assert.equal(
    xcode.targets.Gallery.OTHER_SWIFT_FLAGS.trim(),
    '-D GALLERY_FLAG -Xfrontend -warn-long-function-bodies=500'
  )
  assert.ok(
    !existsSync(join(gallery, 'Gallery.xcodeproj/project.xcworkspace')),
    'the empty folders xcodebuild creates are removed'
  )
  assert.ok(
    !existsSync(join(gallery, 'Packages/StudioDesign/.swiftpm')),
    'and the `.swiftpm/xcode` it creates in a referenced local package'
  )
  const showLine = logged().find((line) => line.includes('-showBuildSettings'))
  assert.equal(
    showLine,
    `xcodebuild ${showSettingsArgs('Gallery.xcodeproj', 'Gallery', derivedData).join(' ')}`
  )
  for (const word of [
    '-scheme Gallery',
    '-configuration Debug',
    '-destination platform=macOS',
    `-derivedDataPath ${derivedData}`,
    '-disableAutomaticPackageResolution',
    '-skipPackageUpdates'
  ])
    assert.ok(showLine.includes(word), word)
  xcode = await resolveXcodeSettings(gallery, galleryContainer, ['Gallery'], {
    derivedData,
    env: { FAKE_MODE: 'leftover' },
    xcodebuild
  })
  assert.deepEqual(
    xcode.leftovers,
    ['Gallery.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'],
    'a file xcodebuild leaves is reported, never deleted'
  )
  rmSync(join(gallery, 'Gallery.xcodeproj/project.xcworkspace'), { recursive: true })
  xcode = await resolveXcodeSettings(gallery, galleryContainer, ['Gallery'], {
    derivedData,
    env: { FAKE_MODE: 'fail' },
    xcodebuild
  })
  assert.deepEqual(xcode.targets, {})
  assert.match(xcode.errors[0], /^Scheme Gallery: .*damaged/)
  assert.equal(
    xcode.errors[1],
    'No scheme of Gallery.xcodeproj builds Gallery; its settings come from the project file.'
  )
  assert.ok(!existsSync(join(gallery, 'Gallery.xcodeproj/project.xcworkspace')))
  const noScheme = await resolveXcodeSettings(
    gallery,
    { ...galleryContainer, schemes: [] },
    ['Gallery'],
    {
      derivedData,
      env: {},
      xcodebuild
    }
  )
  assert.match(noScheme.errors[0], /has no scheme, so xcodebuild cannot resolve its settings/)

  // --- The project file's own settings when xcodebuild cannot run: $(inherited) resolved ---
  const pbxproj = execFileSync('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    join(gallery, 'Gallery.xcodeproj/project.pbxproj')
  ])
  const parsed = parsePbxproj(JSON.parse(pbxproj.toString('utf8')), '', (dir) =>
    list(join(gallery, dir)).map((name) => join(dir, name))
  )
  const galleryTarget = parsed.targets.find((t) => t.name === 'Gallery')
  assert.equal(
    galleryTarget.settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS,
    'GALLERY_FIXTURE DEBUG $(inherited)'
  )
  assert.deepEqual(
    mapBuildSettings(galleryTarget.settings, { from: 'project file', arch: 'arm64', exists })
      .defines,
    ['GALLERY_FIXTURE', 'DEBUG', 'GALLERY_FLAG']
  )
  assert.deepEqual(parsed.packages, [
    {
      kind: 'local',
      location: 'Packages/StudioDesign',
      path: 'Packages/StudioDesign',
      identity: 'studiodesign'
    }
  ])
  assert.deepEqual(parsed.targets.find((t) => t.name === 'GalleryKit').packageDependencies, [
    { product: 'StudioDesign', package: 'Packages/StudioDesign' }
  ])

  // --- The package build, asset catalogs and dump-package (scripted xcrun) ---
  const xcrun = script(
    'xcrun',
    `case "$FAKE_MODE" in
  sandbox) echo "sandbox-exec: sandbox_apply: Operation not permitted" >&2; exit 1 ;;
  network) echo "error: Failed to clone repository https://e.x/tip.git" >&2; exit 1 ;;
esac
case "$1 $2" in
  "swift build")
    bin="$scratch/arm64-apple-macosx/debug"
    mkdir -p "$bin/Modules" "$bin/StudioDesign_StudioDesign.bundle" "$bin/Shim.build"
    echo "module Shim {}" > "$bin/Shim.build/module.modulemap"
    touch "$bin/lib${WRAPPER}.dylib"
    # Like SwiftPM: the local package's configuration folder, and with FAKE_LEFTOVER a file.
    if [ -n "$FAKE_LOCAL" ]; then
      mkdir -p "$FAKE_LOCAL/.swiftpm/configuration" "$FAKE_LOCAL/.swiftpm/xcode"
      if [ -n "$FAKE_LEFTOVER" ]; then echo '{}' > "$FAKE_LOCAL/.swiftpm/configuration/mirrors.json"; fi
    fi ;;
  "swift package")
    mkdir -p .swiftpm/configuration .swiftpm/xcode
    case "$*" in
      *dump-package*) echo '{"name":"StudioDesign","toolsVersion":{"_version":"5.9.0"},"targets":[]}' ;;
      *) exit 1 ;;
    esac ;;
  "actool --compile")
    mkdir -p "$out"
    # Like actool: the symbols pass writes no Assets.car.
    if [ -z "$sym" ]; then echo car > "$out/Assets.car"; else
      echo 'extension ColorResource { static let brand = ColorResource(name: "Brand", bundle: .main) }' > "$sym"
    fi ;;
  *) exit 1 ;;
esac`
  )
  const cacheDir = join(temp, 'cache')
  const local = {
    packages: [
      {
        identity: 'studiodesign',
        kind: 'local',
        location: join(gallery, 'Packages/StudioDesign'),
        products: ['StudioDesign'],
        targets: ['GalleryKit']
      }
    ],
    binaries: [],
    unsupported: [],
    resolvedFile: ''
  }
  const buildOptions = {
    cacheDir,
    toolchainKey: 'tc1',
    env: {},
    arch: 'arm64',
    deploymentTarget: '14.0',
    xcrun
  }
  let packages = await buildPackages(local, buildOptions)
  const bin = join(cacheDir, 'packages/toolchain-tc1/scratch/arm64-apple-macosx/debug')
  assert.deepEqual([packages.error, packages.cached, packages.bin], ['', false, bin])
  assert.deepEqual(packages.bundles, [join(bin, 'StudioDesign_StudioDesign.bundle')])
  assert.deepEqual(packages.compileFlags, [
    '-I',
    join(bin, 'Modules'),
    '-I',
    bin,
    '-F',
    bin,
    '-Xcc',
    `-fmodule-map-file=${join(bin, 'Shim.build/module.modulemap')}`
  ])
  assert.deepEqual(packages.linkFlags, [
    '-L',
    bin,
    `-l${WRAPPER}`,
    '-Xlinker',
    '-rpath',
    '-Xlinker',
    bin
  ])
  const wrapper = join(cacheDir, 'packages/toolchain-tc1/wrapper')
  assert.equal(readFileSync(join(wrapper, 'Package.swift'), 'utf8'), wrapperManifest(local, '14.0'))
  assert.equal(
    logged()
      .filter((l) => l.startsWith('xcrun swift build'))
      .at(-1),
    `xcrun ${packageBuildArgs(wrapper, join(cacheDir, 'packages/toolchain-tc1/scratch')).join(' ')}`
  )
  const builds = () => logged().filter((l) => l.startsWith('xcrun swift build')).length
  const before = builds()
  packages = await buildPackages(local, buildOptions)
  assert.deepEqual([packages.cached, builds()], [true, before], 'the same key is not built again')
  utimesSync(
    join(gallery, 'Packages/StudioDesign/Sources/StudioDesign/Tagline.swift'),
    new Date(),
    new Date(Date.now() + 9_000)
  )
  packages = await buildPackages(local, buildOptions)
  assert.deepEqual(
    [packages.cached, builds()],
    [false, before + 1],
    'an edited local package is rebuilt'
  )
  packages = await buildPackages(local, { ...buildOptions, toolchainKey: 'tc2' })
  assert.equal(packages.cached, false, 'another toolchain has its own build')
  assert.ok(packages.bin.includes('toolchain-tc2'))
  // SwiftPM's `.swiftpm/configuration` in a local package is removed; anything else is reported.
  const studio = join(gallery, 'Packages/StudioDesign')
  packages = await buildPackages(local, {
    ...buildOptions,
    root: gallery,
    toolchainKey: 'tc-tidy',
    env: { FAKE_LOCAL: studio }
  })
  assert.deepEqual([packages.error, packages.leftovers], ['', []])
  assert.ok(!existsSync(join(studio, '.swiftpm')), 'the configuration folder is removed')
  packages = await buildPackages(local, {
    ...buildOptions,
    root: gallery,
    toolchainKey: 'tc-leftover',
    env: { FAKE_LOCAL: studio, FAKE_LEFTOVER: '1' }
  })
  assert.deepEqual(packages.leftovers, [
    'Packages/StudioDesign/.swiftpm/configuration/mirrors.json'
  ])
  assert.ok(existsSync(join(studio, '.swiftpm/configuration/mirrors.json')), 'never deleted')
  rmSync(join(studio, '.swiftpm'), { recursive: true })
  packages = await buildPackages(local, {
    ...buildOptions,
    toolchainKey: 'tc3',
    env: { FAKE_MODE: 'sandbox' }
  })
  assert.equal(
    packages.error,
    "swift build could not apply SwiftPM's sandbox in this environment (Trezi runs inside another sandbox). Trezi never disables it: run Trezi outside a sandbox to build the package dependencies."
  )
  packages = await buildPackages(local, {
    ...buildOptions,
    toolchainKey: 'tc4',
    env: { FAKE_MODE: 'network' }
  })
  assert.match(
    packages.error,
    /could not fetch a pinned package \(network needed for remote packages\)/
  )

  const catalogPlan = {
    catalogs: [{ module: 'Gallery', path: 'Gallery/Assets.xcassets' }],
    copied: [],
    unsupported: []
  }
  const resourceOptions = {
    root: gallery,
    cacheDir,
    toolchainKey: 'tc1',
    env: {},
    deploymentTarget: '14.0',
    symbols: { Gallery: { enabled: true, extensions: true } },
    xcrun
  }
  let compiled = await compileResources(catalogPlan, resourceOptions)
  assert.deepEqual([compiled.errors, compiled.cached], [[], false])
  assert.match(compiled.assets, /resources\/assets-[0-9a-f]{16}\/Assets\.car$/)
  assert.ok(hasSymbols(compiled.symbols.Gallery), 'the generated asset symbols')
  // The module's own catalog, for `Bundle(for:)` beside its dylib (the generated symbols).
  assert.match(compiled.modules.Gallery, /resources\/Gallery-[0-9a-f]{16}\/Assets\.car$/)
  const moduleDir = join(temp, 'module-dir')
  mkdirSync(moduleDir, { recursive: true })
  placeAssets(compiled.modules.Gallery, moduleDir, 'Gallery')
  assert.equal(readFileSync(join(moduleDir, 'Assets.car'), 'utf8'), 'car\n')
  // AppKit finds named assets only in a folder with a bundle identifier.
  assert.match(
    readFileSync(join(moduleDir, 'Info.plist'), 'utf8'),
    /<key>CFBundleIdentifier<\/key><string>dev\.trezi\.preview-module\.Gallery<\/string>/
  )
  placeAssets('', moduleDir, 'Gallery')
  for (const file of ['Assets.car', 'Info.plist'])
    assert.equal(existsSync(join(moduleDir, file)), false, `a stale ${file} is removed`)
  const actoolLine = logged().find((l) => l.includes('--generate-swift-asset-symbols'))
  assert.ok(actoolLine.includes('--generate-swift-asset-symbol-extensions YES'))
  assert.ok(
    actoolLine.includes('--minimum-deployment-target 14.0') &&
      actoolLine.includes('--platform macosx')
  )
  compiled = await compileResources(catalogPlan, resourceOptions)
  assert.equal(compiled.cached, true, 'unchanged catalogs are not compiled again')
  const assets = compiled.assets
  compiled = await compileResources(catalogPlan, {
    ...resourceOptions,
    toolchainKey: 'tc5',
    env: { FAKE_MODE: 'network' }
  })
  assert.match(compiled.errors[0], /^actool: .*Failed to clone/)
  assert.equal(compiled.assets, '')
  const hostApp = join(temp, 'host.app')
  write(join(gallery, 'Gallery/Font.ttf'), 'font')
  const executable = hostBundle(hostApp, {
    root: gallery,
    assets,
    copied: [{ module: 'Gallery', path: 'Gallery/Font.ttf' }],
    accentColor: 'AccentColor'
  })
  assert.equal(executable, join(hostApp, 'Contents/MacOS/TreziPreviewHost'))
  assert.ok(existsSync(join(hostApp, 'Contents/Resources/Assets.car')))
  assert.ok(existsSync(join(hostApp, 'Contents/Resources/Font.ttf')))
  assert.match(
    readFileSync(join(hostApp, 'Contents/Info.plist'), 'utf8'),
    /<key>NSAccentColorName<\/key><string>AccentColor<\/string>/
  )
  rmSync(join(gallery, 'Gallery/Font.ttf'))

  const graphOptions = {
    cacheDir,
    moduleCache: MODULE_CACHE,
    timeoutMs: 20_000,
    xcodebuild,
    xcrun,
    plutil: '/usr/bin/plutil',
    env: {}
  }
  const dumpErrors = []
  assert.equal(
    (
      await dumpPackage(
        join(gallery, 'Packages/StudioDesign'),
        join(temp, 'spm'),
        graphOptions,
        dumpErrors
      )
    ).name,
    'StudioDesign'
  )
  assert.deepEqual(dumpErrors, [])
  await dumpPackage(
    join(gallery, 'Packages/StudioDesign'),
    join(temp, 'spm'),
    { ...graphOptions, env: { FAKE_MODE: 'sandbox' } },
    dumpErrors
  )
  assert.deepEqual(dumpErrors, [
    "swift package dump-package could not apply SwiftPM's manifest sandbox in this environment (it runs inside another sandbox); the package's settings were not read. Run Trezi outside a sandbox to read them."
  ])
  assert.equal(
    logged().filter((l) => l.includes('dump-package')).length,
    2,
    'a blocked dump-package is not retried in another mode'
  )
  // dumpPackage alone does not tidy (the fake's folder); the graph read around it does.
  rmSync(join(gallery, 'Packages/StudioDesign/.swiftpm'), { recursive: true, force: true })

  // --- The whole build authority on the fixture: graph, plan, prepare ---
  const fixtureGraph = await nativeGraph(gallery, graphOptions)
  assert.equal(fixtureGraph.containers[0].schemesFrom, 'xcodebuild')
  assert.ok(
    !existsSync(join(gallery, 'Gallery.xcodeproj/project.xcworkspace')),
    'the folders `xcodebuild -list` creates are removed too'
  )
  assert.ok(
    logged().some((l) => l.startsWith('xcrun swift package') && l.includes('describe')),
    'the local package was read'
  )
  assert.ok(
    !existsSync(join(gallery, 'Packages/StudioDesign/.swiftpm')),
    'the `.swiftpm/configuration` SwiftPM creates in a package is removed'
  )
  const fixturePlan = planTargetBuild(
    fixtureGraph,
    { target: 'Gallery', project: 'Gallery.xcodeproj' },
    (path) => readFileSync(join(gallery, path), 'utf8'),
    { root: gallery, exists, list }
  )
  assert.deepEqual(fixturePlan.blockers, [])
  assert.deepEqual(
    fixturePlan.modules.map((m) => [m.module, m.dependencies, m.entries]),
    [
      ['GalleryKit', [], []],
      ['Gallery', ['GalleryKit'], ['Gallery/GalleryApp.swift']]
    ],
    'the app target is compiled minus its entry point'
  )
  assert.deepEqual(
    fixturePlan.dependencies.packages.map((p) => [p.identity, p.kind, p.location, p.targets]),
    [['studiodesign', 'local', join(gallery, 'Packages/StudioDesign'), ['GalleryKit']]]
  )
  assert.deepEqual(fixturePlan.resources.catalogs, [
    { module: 'Gallery', path: 'Gallery/Assets.xcassets' }
  ])
  const builder = new TargetBuilder({ root: gallery, cacheDir, xcodebuild, xcrun, log: () => {} })
  const toolchain = { key: 'tc1', env: {} }
  const prepared = await builder.prepare(fixturePlan, fixtureGraph, toolchain)
  assert.equal(prepared.error, '')
  assert.deepEqual(prepared.report.settingsFrom, {
    GalleryKit: 'xcodebuild (scheme Gallery)',
    Gallery: 'xcodebuild (scheme Gallery)'
  })
  const appSettings = fixturePlan.modules[1].settings
  assert.deepEqual(
    [appSettings.from, appSettings.swiftVersion, appSettings.defines, appSettings.deploymentTarget],
    ['xcodebuild', '5', ['GALLERY_FIXTURE', 'DEBUG', 'GALLERY_FLAG'], '14.0']
  )
  assert.deepEqual(appSettings.dropped, [
    {
      setting: 'OTHER_SWIFT_FLAGS',
      flag: '-Xfrontend -warn-long-function-bodies=500',
      reason: "not on Trezi's allowlist of Swift flags"
    }
  ])
  assert.ok(
    !appSettings.flags.includes(built),
    'search paths into Xcode products are dropped silently'
  )
  assert.equal(prepared.deploymentTarget, '14.0')
  assert.equal(prepared.accentColor, 'AccentColor')
  assert.equal(prepared.report.derivedData, derivedData)
  assert.equal(prepared.report.packages.cached, true, 'the earlier build of the same package')
  assert.deepEqual(prepared.report.packages.bundles, [
    join(bin, 'StudioDesign_StudioDesign.bundle')
  ])
  assert.deepEqual(prepared.report.resources.symbols, ['Gallery'])
  assert.deepEqual(prepared.generated.Gallery, [
    compiled.symbols.Gallery ?? prepared.generated.Gallery[0]
  ])
  assert.ok(prepared.link.includes(`-l${WRAPPER}`) && prepared.compile.includes(bin))
  const inputs = moduleInputs(gallery, { libraries: [] }, fixturePlan, prepared)
  const galleryAssets = inputs.find((m) => m.module === 'Gallery').assets
  assert.match(galleryAssets, /resources\/Gallery-[0-9a-f]{16}\/Assets\.car$/)
  assert.ok(existsSync(galleryAssets), 'the module catalog, compiled apart from its symbols')
  assert.deepEqual(prepared.report.leftovers, [])
  const shows = () => logged().filter((l) => l.includes('-showBuildSettings')).length
  const resolvedBefore = shows()
  await builder.prepare(fixturePlan, fixtureGraph, toolchain)
  assert.equal(
    shows(),
    resolvedBefore,
    'the resolved settings are kept while the project is unchanged'
  )
  builder.invalidate()
  await builder.prepare(fixturePlan, fixtureGraph, toolchain)
  assert.equal(shows(), resolvedBefore + 1, 'a requested rebuild resolves them again')
  const blocked = new TargetBuilder({ root: gallery, cacheDir, xcodebuild, xcrun, log: () => {} })
  const failed = await blocked.prepare(fixturePlan, fixtureGraph, {
    key: 'tc6',
    env: { FAKE_MODE: 'sandbox' }
  })
  assert.match(
    failed.error,
    /^The Swift packages did not build: swift build could not apply SwiftPM's sandbox/
  )
  assert.deepEqual(
    Object.values(failed.report.settingsFrom),
    ['project file', 'project file'],
    'without xcodebuild the project file decides, and the report says so'
  )
  assert.ok(
    !existsSync(join(gallery, 'Gallery.xcodeproj/project.xcworkspace')),
    'nothing left in the project'
  )
  assert.ok(
    !existsSync(join(gallery, '.build')) &&
      !existsSync(join(gallery, 'Packages/StudioDesign/.build'))
  )

  // --- Regression: no LKM-275 command disables a sandbox ---
  const commands = logged()
  assert.ok(commands.some((l) => l.startsWith('xcrun swift build')))
  assert.ok(commands.some((l) => l.startsWith('xcrun actool')))
  assert.ok(commands.some((l) => l.includes('dump-package')))
  assert.ok(commands.some((l) => l.startsWith('xcodebuild -showBuildSettings')))
  for (const line of commands.filter((l) => !/ describe /.test(l)))
    assert.doesNotMatch(line, /disable-sandbox/, line)
  for (const args of [
    packageBuildArgs('/w', '/s'),
    showSettingsArgs('A.xcodeproj', 'A', '/d'),
    actoolArgs({
      catalogs: ['/a.xcassets'],
      output: '/o',
      deploymentTarget: '14.0',
      symbols: { file: '/s.swift', extensions: true }
    })
  ])
    assert.ok(!args.some((word) => /sandbox/i.test(word)), args.join(' '))
  // In the sources: LKM-275's files have no such flag at all, and graph.ts keeps only the
  // pre-existing describe fallback (LKM-274's disclosure), unchanged and not reused.
  for (const file of [
    'settings',
    'build-settings',
    'dependencies',
    'package-build',
    'resources',
    'builder',
    'session',
    'plan',
    'driver'
  ])
    assert.doesNotMatch(
      readFileSync(join(ROOT, `src/swift-preview/${file}.ts`), 'utf8'),
      /disable-sandbox/,
      file
    )
  const graphSource = readFileSync(join(ROOT, 'src/swift-preview/graph.ts'), 'utf8')
  assert.equal(graphSource.match(/disable-sandbox/g).length, 1)
  const fallback = graphSource.slice(graphSource.indexOf('const describe = (sandbox: boolean)'))
  assert.ok(fallback.indexOf('--disable-sandbox') < fallback.indexOf("'describe'"), 'only describe')
  assert.equal(
    (graphSource.match(/describe\(false\)/g) ?? []).length,
    1,
    'the fallback runs once, for describe only'
  )

  console.log(
    'swift-preview-settings: build authority, dependencies, resources and cache keys verified.'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
