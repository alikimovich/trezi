/**
 * LKM-273: native project discovery and the target graph, without a preview build.
 * Discovery of workspaces, Xcode projects and Swift packages; `project.pbxproj` parsing
 * (Xcode 16 synchronized folders and their exceptions, build-phase files, dependencies,
 * package products); workspace references; schemes from `xcodebuild` or the scheme
 * files, and clear errors when Xcode or a tool is missing or hangs (scripted tools);
 * `swift package describe` on a temporary package; the build plan (entry files left
 * out, order, cycles, blockers); the manifest's `target`; the Trezi-side manifest
 * folder and the launch command; and mixed repos with a package.json.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(ROOT, 'test/fixtures/swift-multi-module')
const { discoverNative } = await import('../src/swift-preview/discovery.ts')
const { parsePbxproj, workspaceProjects, targetKind, moduleName } = await import(
  '../src/swift-preview/pbxproj.ts'
)
const { nativeGraph, graphInputs, toolError } = await import('../src/swift-preview/graph.ts')
const { isEntryFile, planTargetBuild, findTarget } = await import('../src/swift-preview/plan.ts')
const { parseManifest } = await import('../src/swift-preview/manifest.ts')
const { swiftPreviewCommand, treziManifestDir, nativeProjectInfo } = await import(
  '../src/main/swift-preview.ts'
)
const { detectProject } = await import('../src/main/project-detect.ts')

const temp = mkdtempSync(join(tmpdir(), 'swift-graph-'))
const cacheDir = join(temp, 'cache')
const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const graphOptions = { cacheDir, moduleCache: MODULE_CACHE, timeoutMs: 60_000 }

try {
  // --- Discovery: every root kind, nested, skipped folders ---
  const mixed = join(temp, 'mixed')
  write(join(mixed, 'App.xcworkspace/contents.xcworkspacedata'), '<Workspace/>')
  write(join(mixed, 'App.xcodeproj/project.pbxproj'), '{}')
  write(join(mixed, 'Packages/Kit/Package.swift'), '// swift-tools-version:5.9')
  write(join(mixed, 'node_modules/x/Package.swift'), '')
  write(join(mixed, 'Pods/Pods.xcodeproj/project.pbxproj'), '')
  write(join(mixed, '.build/checkouts/y/Package.swift'), '')
  write(join(mixed, 'a/b/c/Deep.xcodeproj/project.pbxproj'), '')
  assert.deepEqual(discoverNative(mixed), {
    workspaces: ['App.xcworkspace'],
    projects: ['App.xcodeproj'],
    packages: ['Packages/Kit/Package.swift']
  })
  assert.equal(discoverNative(join(temp, 'missing')), null)
  assert.deepEqual(discoverNative(FIXTURE), {
    workspaces: [],
    projects: ['Studio.xcodeproj'],
    packages: []
  })
  assert.deepEqual(graphInputs('/r', discoverNative(mixed)), [
    '/r/App.xcworkspace/contents.xcworkspacedata',
    '/r/App.xcodeproj/project.pbxproj',
    '/r/Packages/Kit/Package.swift'
  ])

  // --- pbxproj: synchronized folders, exceptions, dependencies, settings ---
  assert.equal(targetKind('com.apple.product-type.application'), 'app')
  assert.equal(targetKind('com.apple.product-type.framework'), 'framework')
  assert.equal(targetKind('com.apple.product-type.bundle.unit-test'), 'test')
  assert.equal(targetKind('com.apple.product-type.library.dynamic'), 'library')
  assert.equal(moduleName('My App-2'), 'My_App_2')
  assert.equal(moduleName('2D'), '_2D')
  const converted = spawnSync('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    join(FIXTURE, 'Studio.xcodeproj/project.pbxproj')
  ])
  assert.equal(converted.status, 0, String(converted.stderr))
  const listed = {
    Studio: [
      'Studio/Assets.xcassets',
      'Studio/Info.plist',
      'Studio/ProjectHeader.swift',
      'Studio/StudioApp.swift'
    ],
    StudioKit: ['StudioKit/LevelMeterView.swift', 'StudioKit/StatusBadge.swift']
  }
  const parsed = parsePbxproj(JSON.parse(String(converted.stdout)), '', (dir) => listed[dir] ?? [])
  assert.deepEqual(
    parsed.targets.map((t) => [t.name, t.module, t.kind, t.dependencies, t.sources, t.resources]),
    [
      [
        'Studio',
        'Studio',
        'app',
        ['StudioKit'],
        ['Studio/ProjectHeader.swift', 'Studio/StudioApp.swift'],
        ['Studio/Assets.xcassets']
      ],
      ['StudioKit', 'StudioKit', 'framework', [], listed.StudioKit, []]
    ]
  )
  assert.equal(parsed.targets[0].settings.MACOSX_DEPLOYMENT_TARGET, '14.0', 'project setting')
  assert.equal(parsed.targets[0].settings.SWIFT_VERSION, '5.0', 'target setting')
  assert.deepEqual(parsed.packages, [])

  // Classic groups, build-phase files, packages and a project in a subfolder.
  const classic = parsePbxproj(
    {
      rootObject: 'P',
      objects: {
        P: {
          isa: 'PBXProject',
          mainGroup: 'G',
          targets: ['T', 'U'],
          packageReferences: ['R', 'L'],
          buildConfigurationList: 'PL'
        },
        PL: { isa: 'XCConfigurationList', buildConfigurations: ['PR', 'PD'] },
        PR: { isa: 'XCBuildConfiguration', name: 'Release', buildSettings: { SDKROOT: 'x' } },
        PD: {
          isa: 'XCBuildConfiguration',
          name: 'Debug',
          baseConfigurationReference: 'F3',
          buildSettings: { SDKROOT: 'iphoneos', PRODUCT_MODULE_NAME: 'AppCore' }
        },
        G: { isa: 'PBXGroup', children: ['S'], sourceTree: '<group>' },
        S: { isa: 'PBXGroup', path: 'Sources', children: ['F1', 'F2'], sourceTree: '<group>' },
        F1: { isa: 'PBXFileReference', path: 'A.swift', sourceTree: '<group>' },
        F2: { isa: 'PBXFileReference', path: 'Main.storyboard', sourceTree: '<group>' },
        F3: { isa: 'PBXFileReference', path: 'Base.xcconfig', sourceTree: 'SOURCE_ROOT' },
        B1: { isa: 'PBXBuildFile', fileRef: 'F1' },
        B2: { isa: 'PBXBuildFile', fileRef: 'F2' },
        SP: { isa: 'PBXSourcesBuildPhase', files: ['B1'] },
        RP: { isa: 'PBXResourcesBuildPhase', files: ['B2'] },
        R: { isa: 'XCRemoteSwiftPackageReference', repositoryURL: 'https://e.x/sparkle' },
        L: { isa: 'XCLocalSwiftPackageReference', relativePath: '../Kit' },
        PP: { isa: 'XCSwiftPackageProductDependency', productName: 'Sparkle', package: 'R' },
        D1: { isa: 'PBXTargetDependency', targetProxy: 'X' },
        X: { isa: 'PBXContainerItemProxy', remoteInfo: 'Other' },
        T: {
          isa: 'PBXNativeTarget',
          name: 'App',
          productType: 'com.apple.product-type.application',
          buildPhases: ['SP', 'RP'],
          dependencies: ['D1'],
          packageProductDependencies: ['PP']
        },
        U: { isa: 'PBXAggregateTarget', name: 'Lint' }
      }
    },
    'ios',
    () => []
  )
  const app = classic.targets[0]
  assert.deepEqual(app.sources, ['ios/Sources/A.swift'])
  assert.deepEqual(app.resources, ['ios/Sources/Main.storyboard'])
  assert.equal(app.module, 'AppCore')
  assert.equal(app.settings.SDKROOT, 'iphoneos', 'Debug wins over the first configuration')
  assert.deepEqual(app.packageProducts, ['Sparkle (https://e.x/sparkle)'])
  assert.ok(app.notes.includes('depends on "Other" in another project'))
  assert.ok(app.notes.includes('settings come partly from an .xcconfig file'))
  assert.equal(classic.targets[1].kind, 'other')
  assert.deepEqual(classic.packages, [
    { kind: 'remote', location: 'https://e.x/sparkle', identity: 'sparkle' },
    { kind: 'local', location: '../Kit', path: 'Kit', identity: 'kit' }
  ])
  assert.deepEqual(app.packageDependencies, [
    { product: 'Sparkle', package: 'https://e.x/sparkle' }
  ])
  assert.deepEqual(
    workspaceProjects(
      '<Workspace><FileRef location = "group:App.xcodeproj"/><FileRef location="group:../../Out.xcodeproj"/><FileRef location="container:Pods/Pods.xcodeproj"/><FileRef location="group:Kit"/></Workspace>',
      'ios/App.xcworkspace'
    ),
    ['ios/App.xcodeproj', 'ios/Pods/Pods.xcodeproj']
  )

  // --- Tools: scripted xcodebuild for "only the command-line tools", success, a hang ---
  const tools = join(temp, 'tools')
  const script = (name, body) => {
    write(join(tools, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(tools, name), 0o755)
    return join(tools, name)
  }
  const cltOnly = script(
    'xcodebuild-clt',
    `echo "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance" >&2; exit 1`
  )
  const project = join(temp, 'studio')
  cpSync(FIXTURE, project, { recursive: true })
  let graph = await nativeGraph(project, { ...graphOptions, xcodebuild: cltOnly })
  const studio = graph.containers[0]
  assert.equal(studio.kind, 'project')
  assert.deepEqual(studio.schemes, ['Studio'])
  assert.equal(studio.schemesFrom, 'scheme files', 'schemes come from the files without Xcode')
  assert.match(studio.errors[0], /needs Xcode, but only the command-line tools are selected/)
  assert.deepEqual(
    studio.targets.map((t) => [t.name, t.sources]),
    [
      ['Studio', ['Studio/ProjectHeader.swift', 'Studio/StudioApp.swift']],
      [
        'StudioKit',
        [
          'StudioKit/LevelMeterView.swift',
          'StudioKit/StatusBadge.swift',
          'StudioKit/StudioFormat.swift'
        ]
      ]
    ],
    'synchronized folders are listed from disk, Info.plist is an exception'
  )
  const listing = script(
    'xcodebuild-ok',
    `echo '{"project":{"name":"Studio","schemes":["Studio","StudioKit"],"targets":["Studio","StudioKit"]}}'`
  )
  graph = await nativeGraph(project, { ...graphOptions, xcodebuild: listing })
  assert.deepEqual(
    [graph.containers[0].schemes, graph.containers[0].schemesFrom, graph.containers[0].errors],
    [['Studio', 'StudioKit'], 'xcodebuild', []]
  )
  const hang = script('xcodebuild-hang', 'sleep 30')
  const started = Date.now()
  graph = await nativeGraph(project, { ...graphOptions, xcodebuild: hang, timeoutMs: 400 })
  assert.match(graph.containers[0].errors[0], /timed out after 0 s|timed out/)
  assert.ok(Date.now() - started < 10_000, 'a hanging tool is killed')
  graph = await nativeGraph(project, {
    ...graphOptions,
    xcodebuild: join(tools, 'none'),
    plutil: join(tools, 'no-plutil')
  })
  assert.match(graph.containers[0].errors.join(' '), /no-plutil is missing: install Xcode/)
  assert.match(graph.containers[0].errors.join(' '), /none is missing/)
  assert.deepEqual(graph.containers[0].schemes, ['Studio'], 'still the scheme files')
  assert.match(
    toolError('xcrun swift', 'xcrun: error: unable to find utility "swift", not a developer tool'),
    /developer tools are missing/
  )
  const none = await nativeGraph(join(temp, 'missing'), graphOptions)
  assert.deepEqual([none.structure, none.containers], [null, []])
  assert.match(none.errors[0], /No Xcode workspace, Xcode project or Package\.swift/)

  // --- A workspace references the project; its targets are read once ---
  write(
    join(project, 'Studio.xcworkspace/contents.xcworkspacedata'),
    '<?xml version="1.0"?><Workspace version="1.0"><FileRef location="group:Studio.xcodeproj"></FileRef></Workspace>'
  )
  graph = await nativeGraph(project, { ...graphOptions, xcodebuild: cltOnly })
  assert.deepEqual(
    graph.containers.map((c) => [c.kind, c.path, c.projects]),
    [
      ['workspace', 'Studio.xcworkspace', ['Studio.xcodeproj']],
      ['project', 'Studio.xcodeproj', []]
    ]
  )
  rmSync(join(project, 'Studio.xcworkspace'), { recursive: true })

  // --- A Swift package, read by `swift package describe` ---
  const pkg = join(temp, 'pkg')
  write(
    join(pkg, 'Package.swift'),
    `// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "Tools",
    platforms: [.macOS(.v14)],
    products: [.library(name: "ToolKit", targets: ["ToolKit"])],
    targets: [
        .target(name: "ToolKit"),
        .executableTarget(name: "tool", dependencies: ["ToolKit"]),
        .testTarget(name: "ToolKitTests", dependencies: ["ToolKit"])
    ]
)
`
  )
  write(join(pkg, 'Sources/ToolKit/Kit.swift'), 'public struct Kit { public init() {} }\n')
  write(join(pkg, 'Sources/tool/main.swift'), 'import ToolKit\n_ = Kit()\n')
  write(join(pkg, 'Tests/ToolKitTests/KitTests.swift'), 'import ToolKit\n')
  const described = await nativeGraph(pkg, graphOptions)
  const container = described.containers[0]
  assert.equal(container.kind, 'package', JSON.stringify(described))
  assert.deepEqual(
    // Only this environment's sandbox reasons: describe's (LKM-274) and dump-package's,
    // which LKM-275 never retries unsandboxed.
    container.errors.filter(
      (e) => !/could not sandbox|could not apply SwiftPM's manifest sandbox/.test(e)
    ),
    [],
    'describe ran'
  )
  assert.deepEqual(
    [container.schemes, container.schemesFrom],
    [['ToolKit', 'tool'], 'package products'],
    'SwiftPM adds an executable product for the executable target'
  )
  const byName = Object.fromEntries(container.targets.map((t) => [t.name, t]))
  assert.deepEqual(
    ['ToolKit', 'tool', 'ToolKitTests'].map((name) => byName[name]?.kind),
    ['library', 'executable', 'test']
  )
  assert.deepEqual(byName.tool.dependencies, ['ToolKit'])
  assert.deepEqual(byName.tool.sources, ['Sources/tool/main.swift'])
  const toolPlan = planTargetBuild(described, { target: 'tool' }, () => '')
  assert.deepEqual(
    toolPlan.modules.map((m) => [m.module, m.entries]),
    [
      ['ToolKit', []],
      ['tool', ['Sources/tool/main.swift']]
    ]
  )
  assert.ok(toolPlan.blockers.some((b) => /tool has no Swift sources left/.test(b)))
  assert.ok(
    planTargetBuild(described, { target: 'ToolKitTests' }, () => '').blockers.some((b) =>
      /is a test target/.test(b)
    )
  )
  assert.ok(!existsSync(join(pkg, '.build')), "SwiftPM's scratch stays in Trezi's cache")

  // --- The plan: entries out, dependency order, cycles, blockers, warnings ---
  assert.ok(isEntryFile('x/main.swift', ''))
  assert.ok(isEntryFile('a.swift', 'import SwiftUI\n@main\nstruct A: App {}'))
  assert.ok(isEntryFile('a.swift', '  @NSApplicationMain class D {}'))
  assert.ok(!isEntryFile('a.swift', '// @main is mentioned\nlet mainValue = 1'))
  const target = (name, fields = {}) => ({
    name,
    module: name,
    kind: 'framework',
    productType: '',
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
  const graphOf = (targets) => ({
    structure: null,
    errors: [],
    durationMs: 0,
    containers: [
      {
        kind: 'project',
        path: 'P.xcodeproj',
        schemes: [],
        schemesFrom: 'none',
        targets,
        packages: [],
        projects: [],
        errors: []
      }
    ]
  })
  const read = (file) => (file.includes('Entry') ? '@main struct E {}' : '#Preview { }')
  const deep = planTargetBuild(
    graphOf([
      target('App', {
        kind: 'app',
        dependencies: ['Feature', 'Core'],
        sources: ['App/Entry.swift', 'App/V.swift'],
        resources: ['App/Assets.xcassets']
      }),
      target('Feature', { dependencies: ['Core'] }),
      target('Core')
    ]),
    { target: 'App', exclude: ['App/V.swift'] },
    read
  )
  assert.deepEqual(
    deep.modules.map((m) => [m.module, m.dependencies]),
    [
      ['Core', []],
      ['Feature', ['Core']],
      ['App', ['Feature', 'Core']]
    ]
  )
  assert.deepEqual(deep.modules[2].entries, ['App/Entry.swift'])
  assert.ok(
    deep.blockers.some((b) => /App has no Swift sources left/.test(b)),
    'exclude applies'
  )
  assert.ok(deep.warnings.some((w) => /use #Preview/.test(w)))
  assert.deepEqual(deep.resources.catalogs, [{ module: 'App', path: 'App/Assets.xcassets' }])
  assert.throws(
    () =>
      planTargetBuild(
        graphOf([target('A', { dependencies: ['B'] }), target('B', { dependencies: ['A'] })]),
        { target: 'A' },
        read
      ),
    /depend on each other: A → B → A/
  )
  const blocked = planTargetBuild(
    graphOf([
      target('App', {
        dependencies: ['Gone'],
        packageProducts: ['Sparkle (https://e.x/sparkle)'],
        packageDependencies: [{ product: 'Sparkle', package: 'https://e.x/sparkle' }],
        settings: { SDKROOT: 'iphoneos' },
        notes: ['ClangTarget']
      })
    ]),
    { target: 'App' },
    () => 'struct V {}'
  )
  for (const pattern of [
    /"Gone", which is not in/,
    /package product Sparkle/,
    /iOS is Stage 8/,
    /ClangTarget/
  ])
    assert.ok(
      blocked.blockers.some((b) => pattern.test(b)),
      `${pattern}: ${blocked.blockers}`
    )
  assert.throws(() => findTarget(graphOf([target('A')]), 'Nope'), /No target "Nope".*Targets: A/)
  assert.throws(
    () => findTarget(graphOf([target('A')]), 'A', 'X.xcodeproj'),
    /"X.xcodeproj" was not found/
  )
  assert.ok(
    planTargetBuild(
      graphOf([target('TreziPreviewHost')]),
      { target: 'TreziPreviewHost' },
      read
    ).blockers.some((b) => /Two modules would be named TreziPreviewHost/.test(b))
  )

  // --- The manifest's target; the Trezi-side folder; the launch command ---
  assert.deepEqual(parseManifest('{"target":"Studio","previews":["Previews"]}'), {
    name: '',
    sources: [],
    previews: ['Previews'],
    exclude: [],
    libraries: [],
    target: 'Studio'
  })
  assert.equal(
    parseManifest('{"target":"A","project":"ios/A.xcodeproj/","previews":["p"]}').project,
    'ios/A.xcodeproj'
  )
  assert.throws(() => parseManifest('{"previews":["p"]}'), /"sources" must be a list/)
  assert.throws(() => parseManifest('{"target":3,"previews":["p"]}'), /"target" must be a name/)
  assert.throws(
    () => parseManifest('{"target":"A","project":"../x","previews":["p"]}'),
    /outside the project/
  )
  const dir = treziManifestDir('/Users/a/My App', '/data/Trezi')
  assert.match(dir, /^\/data\/Trezi\/swift-previews\/[0-9a-f]{16}$/)
  assert.equal(treziManifestDir('/Users/a/My App/', '/data/Trezi'), dir, 'keyed like projects')
  assert.notEqual(treziManifestDir('/Users/a/Other', '/data/Trezi'), dir)
  assert.equal(
    swiftPreviewCommand('/b/bun', '/d/driver.ts', "/data/Tre'zi/x"),
    `'/b/bun' '/d/driver.ts' --manifest-dir '/data/Tre'\\''zi/x'`
  )
  const info = await nativeProjectInfo(project, join(temp, 'userData'), undefined)
  assert.deepEqual(info.structure, { workspaces: [], projects: ['Studio.xcodeproj'], packages: [] })
  assert.deepEqual(
    [info.manifest.repoExists, info.manifest.treziExists, info.graph],
    [true, false, null]
  )
  assert.match(info.error, /driver is not running/)
  // A JS or mixed project's server is the user's own: it gets no request at all.
  const realFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async (url) => {
    requested.push(String(url))
    throw new Error('unexpected request')
  }
  try {
    const own = await nativeProjectInfo(project, join(temp, 'userData'), {
      url: 'http://127.0.0.1:5173',
      driver: false
    })
    assert.deepEqual(requested, [], "no GET /graph to the user's dev server")
    assert.equal(own.graph, null)
    assert.match(own.error, /own dev server, not Trezi's Swift preview driver/)
    assert.deepEqual(own.structure, info.structure, 'the structure and manifest still report')
    assert.equal(own.manifest.repoExists, true)
    await nativeProjectInfo(project, join(temp, 'userData'), {
      url: 'http://127.0.0.1:7777',
      driver: true
    })
    assert.deepEqual(requested, ['http://127.0.0.1:7777/graph'], 'the driver is asked')
  } finally {
    globalThis.fetch = realFetch
  }

  // --- Mixed repos: package.json next to native roots ---
  const tooling = join(temp, 'tooling')
  cpSync(FIXTURE, tooling, { recursive: true })
  write(
    join(tooling, 'package.json'),
    JSON.stringify({ name: 'studio-tools', scripts: { lint: 'biome check' } })
  )
  const tools1 = await detectProject(tooling)
  assert.deepEqual(
    [tools1.framework, tools1.name, tools1.devCommand, tools1.native?.projects],
    ['swift', 'studio-tools', '', ['Studio.xcodeproj']],
    'a tooling-only package.json does not hide the Xcode project'
  )
  const web = join(temp, 'web')
  cpSync(FIXTURE, web, { recursive: true })
  rmSync(join(web, 'trezi-previews.json'))
  write(
    join(web, 'package.json'),
    JSON.stringify({ name: 'site', scripts: { dev: 'vite' }, devDependencies: { vite: '5' } })
  )
  const site = await detectProject(web)
  assert.deepEqual(
    [site.framework, site.devCommand, site.previewKind, site.native?.projects],
    ['vite', 'npm run dev', 'web', ['Studio.xcodeproj']],
    'a runnable JS app keeps its launch; the native roots are still reported'
  )
  const bare = join(temp, 'bare')
  cpSync(FIXTURE, bare, { recursive: true })
  rmSync(join(bare, 'trezi-previews.json'))
  const opened = await detectProject(bare)
  assert.deepEqual(
    [opened.framework, opened.setupRequired, opened.native?.projects],
    ['swift', undefined, ['Studio.xcodeproj']],
    'an Xcode project without trezi-previews.json still opens as a Swift project'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
console.log('swift-preview-graph: ok')
