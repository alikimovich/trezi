/**
 * LKM-276: Trezi-generated preview declarations for a native project with no manifest.
 * Pure: target choice (one, ambiguous, none, saved, stale, a local package an app uses),
 * the sidecar writer's refusals and pruning, Swift string escaping and the mapping of
 * compile errors to entries. With a full Xcode (SwiftSyntax): the scanner and catalog on
 * `test/fixtures/swift-preview-macros` (plain `#Preview`, `@Previewable`, environment
 * injection, traits, availability, `#if`, a private same-file overlay, unsupported cases
 * with reasons, inferred component samples) and the generated Swift, with the fixture's
 * hash unchanged; then a generated session on a copy of `swift-multi-module` that renders
 * a private component from an overlay and maps an error in it to the original file.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_CACHE, SWIFT_CACHE } from './helpers/swift-build.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MACROS = join(ROOT, 'test/fixtures/swift-preview-macros')
const { chooseTarget } = await import('../src/swift-preview/targets.ts')
const { SidecarWriter } = await import('../src/swift-preview/sidecar.ts')
const { failedEntries, swiftString } = await import('../src/swift-preview/generate.ts')
const { generatePreviews } = await import('../src/swift-preview/generate.ts')
const { buildCatalog } = await import('../src/swift-preview/catalog.ts')
const { PreviewScanner, syntaxLibraries } = await import('../src/swift-preview/scanner.ts')
const { GeneratedPreviews } = await import('../src/swift-preview/generated.ts')
const { selectToolchain } = await import('../src/swift-preview/toolchain.ts')
const { PreviewSession } = await import('../src/swift-preview/session.ts')

const temp = mkdtempSync(join(tmpdir(), 'swift-generate-'))
const skipped = []
const pass = (name) => console.log(`SWIFT-PREVIEW-GENERATE ${name} PASS`)

/** Every file's content hash under `dir`, so a test proves it changed nothing there. */
function treeHash(dir) {
  const hash = createHash('sha256')
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name)
      if (statSync(child).isDirectory()) visit(child)
      else hash.update(`${relative(dir, child)}\0`).update(readFileSync(child))
    }
  }
  visit(dir)
  return hash.digest('hex')
}

// --- Target choice ---------------------------------------------------------------
const target = (name, kind, dependencies = [], settings = {}) => ({
  name,
  module: name,
  kind,
  productType: '',
  dependencies,
  packageProducts: [],
  packageDependencies: [],
  binaries: [],
  sources: [`${name}/${name}.swift`],
  resources: [],
  settings,
  notes: []
})
const container = (kind, path, targets, packages = []) => ({
  kind,
  path,
  schemes: [],
  schemesFrom: 'none',
  targets,
  packages,
  projects: [],
  errors: []
})
const graph = (...containers) => ({ structure: null, containers, errors: [], durationMs: 0 })

const studio = container('project', 'Studio.xcodeproj', [
  target('Studio', 'app', ['StudioKit']),
  target('StudioKit', 'framework'),
  target('StudioTests', 'test', ['Studio']),
  target('PhoneApp', 'app', [], { SDKROOT: 'iphoneos' })
])
const one = chooseTarget(graph(studio), {})
assert.equal(one.status, 'chosen')
assert.equal(one.reason, 'the only previewable target')
assert.deepEqual(one.choice, {
  project: 'Studio.xcodeproj',
  target: 'Studio',
  kind: 'app',
  module: 'Studio',
  includes: ['StudioKit']
})
const tools = container('project', 'Tools/Tools.xcodeproj', [target('Inspector', 'app')])
const two = chooseTarget(graph(studio, tools), {})
assert.equal(two.status, 'ambiguous', 'two apps: the user chooses')
assert.deepEqual(
  two.choices.map((c) => c.target),
  ['Studio', 'Inspector']
)
assert.match(two.reason, /^Choose what to preview: Studio \(Studio\.xcodeproj\), Inspector/)
const saved = chooseTarget(graph(studio, tools), {
  project: 'Tools/Tools.xcodeproj',
  target: 'Inspector'
})
assert.deepEqual(
  [saved.status, saved.reason, saved.choice?.target],
  ['chosen', 'your choice', 'Inspector']
)
const stale = chooseTarget(graph(studio, tools), { target: 'Gone' })
assert.equal(stale.status, 'ambiguous')
assert.match(stale.reason, /The saved choice Gone no longer exists\./)
assert.equal(chooseTarget(graph(studio), { target: 'Gone' }).reason, 'the only previewable target')
const none = chooseTarget(graph(container('project', 'P.xcodeproj', [target('T', 'test')])), {})
assert.deepEqual(
  [none.status, none.reason],
  ['none', 'No macOS Swift target to preview (found T (test)).']
)
// A local package the app's project uses is built with the app, not offered on its own.
const app = container(
  'project',
  'App.xcodeproj',
  [target('App', 'app')],
  [{ kind: 'local', location: 'Kit', path: 'Kit' }]
)
const kit = container('package', 'Kit/Package.swift', [target('KitUI', 'library')])
assert.deepEqual(
  chooseTarget(graph(app, kit, container('workspace', 'App.xcworkspace', [])), {}).choices.map(
    (c) => c.target
  ),
  ['App']
)
assert.equal(chooseTarget(graph(kit), {}).choice?.target, 'KitUI', 'a package alone is offered')
pass('targets')

// --- The sidecar writer ------------------------------------------------------------
const repo = join(temp, 'repo')
mkdirSync(repo)
const sidecarDir = join(temp, 'trezi')
assert.throws(
  () => new SidecarWriter(join(repo, '.trezi-gen'), repo),
  /never written inside the project/
)
assert.throws(() => new SidecarWriter(temp, repo), /never written inside the project/)
assert.throws(() => new SidecarWriter('relative/dir', repo), /must be absolute/)
const writer = new SidecarWriter(sidecarDir, repo)
assert.equal(writer.dir, join(realpathSync(temp), 'trezi'))
assert.throws(() => writer.path('../escape.swift'), /must stay in Trezi's folder/)
assert.throws(() => writer.path('/etc/passwd'), /must stay in Trezi's folder/)
assert.equal(writer.write('a/one.swift', 'one'), true)
assert.equal(writer.write('a/one.swift', 'one'), false, 'unchanged content is not rewritten')
const before = statSync(join(writer.dir, 'a/one.swift')).mtimeMs
assert.equal(writer.read('a/one.swift'), 'one')
assert.equal(writer.read('missing.swift'), null)
symlinkSync(repo, join(writer.dir, 'link'))
assert.throws(() => writer.write('link/inside.swift', 'x'), /symlink/)
assert.deepEqual(readdirSync(repo), [], 'nothing reached the repo through the symlink')
assert.deepEqual(writer.writeSet('set', { 'm/a.swift': 'a', 'm/b.swift': 'b' }), [
  'm/a.swift',
  'm/b.swift'
])
assert.deepEqual(writer.writeSet('set', { 'm/a.swift': 'a', 'n/c.swift': 'c' }), ['n/c.swift'])
assert.deepEqual(readdirSync(join(writer.dir, 'set/m')), ['a.swift'], 'a dropped file is removed')
assert.equal(statSync(join(writer.dir, 'a/one.swift')).mtimeMs, before)
pass('sidecar writer')

// --- Swift strings and error mapping ----------------------------------------------
assert.equal(swiftString('a "b" \\ c\n\t\u0001'), '"a \\"b\\" \\\\ c\\n\\t\\u{1}"')
const generatedDir = join(temp, 'generated')
const original = join(repo, 'Kit/Card.swift')
const build = {
  files: {},
  overlays: {},
  support: {},
  host: 'TreziPreviews.swift',
  lines: {
    'modules/Kit/Card+TreziPreviews-1.swift': [{ from: 5, to: 9, id: 'component:Kit.Card' }]
  }
}
const factories = [
  {
    id: 'preview:Kit/Card.swift#1',
    file: original,
    body: { type: 'preview', preview: { line: 20, endLine: 24 } }
  },
  { id: 'component:Kit.Card', file: original, body: { type: 'value' } }
]
const output = [
  `${join(generatedDir, 'modules/Kit/Card+TreziPreviews-1.swift')}:7:3: error: missing argument for parameter 'title'`,
  `${original}:22:9: error: cannot find 'sample' in scope`,
  `${original}:3:1: error: an error outside any preview`,
  `${original}:21:1: warning: a warning is not a failure`
].join('\n')
assert.deepEqual(failedEntries(output, build, generatedDir, factories), {
  rejected: {
    'component:Kit.Card': "it did not compile: missing argument for parameter 'title'",
    'preview:Kit/Card.swift#1': "it did not compile: cannot find 'sample' in scope"
  },
  unmapped: 1
})
pass('error mapping')

// --- The synthesized memberwise initializer (LKM-277, Scraib's ShortcutRecorderView) --
const { memberwise } = await import('../src/swift-preview/samples.ts')
const property = (name, type, more = {}) => ({
  name,
  type,
  wrapper: '',
  wrapperArgs: '',
  hasDefault: false,
  isLet: false,
  isStatic: false,
  computed: false,
  access: 'internal',
  ...more
})
const shape = (properties) => {
  const init = memberwise({ kind: 'struct', properties, line: 1 })
  return [init.access, init.params.map((p) => `${p.label}${p.hasDefault ? '=' : ''}`)]
}
// `let title: String; @Binding var keyCode: Int; @State private var isRecording = false;
// @State private var monitor: Any?`: swiftc's init is `init(title:keyCode:)`, internal.
assert.deepEqual(
  shape([
    property('title', 'String', { isLet: true }),
    property('keyCode', 'Int', { wrapper: 'Binding' }),
    property('isRecording', '', { wrapper: 'State', hasDefault: true, access: 'private' }),
    property('monitor', 'Any?', { wrapper: 'State', access: 'private' })
  ]),
  ['internal', ['title', 'keyCode']]
)
// `var note: String?; @State var level: Int?; let id: Int?; var plain: Optional<Int>`.
assert.deepEqual(
  shape([
    property('note', 'String?'),
    property('level', 'Int?', { wrapper: 'State' }),
    property('id', 'Int?', { isLet: true }),
    property('plain', 'Optional<Int>')
  ]),
  ['internal', ['note=', 'level=', 'id', 'plain']]
)
// A private stored property makes the initializer private, with or without a value.
assert.deepEqual(shape([property('p', '', { hasDefault: true, access: 'private' })]), [
  'fileprivate',
  ['p=']
])
assert.deepEqual(shape([property('m', 'Int', { wrapper: 'State', access: 'private' })]), [
  'fileprivate',
  ['m']
])
pass('memberwise initializer')

// --- The generated folder and the saved choice -----------------------------------
const generated = new GeneratedPreviews({
  root: repo,
  dir: join(temp, 'choice'),
  toolsDir: join(temp, 'tools'),
  moduleCache: join(temp, 'scanner-cache'),
  log: () => {}
})
assert.equal(generated.manifest(graph(studio, tools)), null, 'ambiguous: nothing to build yet')
assert.equal(generated.catalog?.target, '')
assert.equal(generated.catalog?.choices.length, 2)
generated.select({ project: 'Tools/Tools.xcodeproj', target: 'Inspector' })
assert.deepEqual(generated.selection(), { project: 'Tools/Tools.xcodeproj', target: 'Inspector' })
const chosen = generated.manifest(graph(studio, tools))
assert.equal(chosen?.manifest.target, 'Inspector')
assert.deepEqual(
  [generated.catalog?.target, generated.catalog?.project, generated.catalog?.chosenBy],
  ['Inspector', 'Tools/Tools.xcodeproj', 'your choice']
)
assert.equal(generated.catalog?.dir, join(realpathSync(temp), 'choice', 'generated'))
assert.deepEqual(readdirSync(repo), [], 'the choice is stored outside the repo')
pass('selection')

// --- Scanner, catalog and generated Swift on the macros fixture -------------------
mkdirSync(SWIFT_CACHE, { recursive: true })
const toolchain = await selectToolchain({
  cacheFile: join(SWIFT_CACHE, 'toolchains.json'),
  workDir: join(SWIFT_CACHE, 'toolchain-probe')
})
const developerDir = toolchain.toolchain?.developerDir ?? ''
if (!developerDir || !syntaxLibraries(developerDir)) {
  skipped.push(`scanner (no full Xcode with SwiftSyntax: ${toolchain.message})`)
} else {
  const fixtureHash = treeHash(MACROS)
  const scanner = new PreviewScanner({
    toolsDir: join(SWIFT_CACHE, 'tools'),
    moduleCache: join(MODULE_CACHE, 'scanner'),
    log: () => {}
  })
  const files = (dir, names) => names.map((n) => join(MACROS, dir, `${n}.swift`))
  const modules = [
    {
      module: 'NotesKit',
      sources: files('NotesKit', ['NoteCard', 'TagCounter', 'WordMeterView']),
      entries: []
    },
    {
      module: 'Notes',
      sources: files('Notes', ['NoteList', 'Sidebar', 'Conditional', 'Unsupported']),
      entries: files('Notes', ['NotesApp'])
    }
  ]
  const scans = await scanner.scan(
    modules.flatMap((m) => [...m.sources, ...m.entries]),
    toolchain
  )
  for (const [path, scan] of scans) assert.equal(scan.error, undefined, `${path} scans`)
  const { entries, factories } = buildCatalog({ root: MACROS, modules, scans })
  const entry = (id) => {
    const found = entries.find((e) => e.id === id)
    assert.ok(found, `${id} is listed (${entries.map((e) => e.id).join(', ')})`)
    return found
  }
  const plain = entry('preview:NotesKit/NoteCard.swift#1')
  assert.deepEqual(
    [plain.title, plain.kind, plain.supported, plain.line],
    ['NoteCard', '#Preview', true, 39]
  )
  assert.deepEqual(entry('preview:NotesKit/NoteCard.swift#2').notes, ['fixed size 280×80'])
  assert.deepEqual(entry('preview:NotesKit/TagCounter.swift#1').notes, [
    'sized to fit',
    '@Previewable state'
  ])
  assert.deepEqual(entry('preview:Notes/Conditional.swift#1').notes, ['needs macOS 15.0'])
  assert.deepEqual(entry('preview:Notes/Conditional.swift#2').notes, ['only where #if (DEBUG)'])
  assert.match(
    entry('preview:Notes/Sidebar.swift#1').notes[0],
    /private declarations .*isolated copy/
  )
  const unsupported = Object.fromEntries(
    entries.filter((e) => !e.supported).map((e) => [e.title, e.reason])
  )
  assert.deepEqual(Object.keys(unsupported).sort(), [
    'App window',
    'NibController',
    'Shared store',
    'Tagged'
  ])
  assert.match(unsupported['Shared store'], /preview modifier trait/)
  assert.match(unsupported['App window'], /app entry file \(@main\)/)
  assert.match(unsupported.Tagged, /generic/)
  assert.match(unsupported.NibController, /nib or storyboard/)
  assert.equal(
    entry('component:NotesKit.NoteCard').sample,
    'NoteCard(note: Note(id: 1, title: "Title"))'
  )
  assert.equal(
    entry('component:NotesKit.TagCounter').sample,
    'TagCounter(count: .constant(1), label: "Label")'
  )
  assert.equal(
    entry('component:Notes.NoteList').sample,
    'NoteList().environment(NoteStore()).environmentObject(ListSettings())',
    'environment injection: @Environment(Store.self) and @EnvironmentObject'
  )
  assert.equal(entry('component:NotesKit.WordMeterView').kind, 'AppKit view')
  assert.equal(entry('component:Notes.SummaryViewController').kind, 'AppKit view controller')

  const out = generatePreviews({
    root: MACROS,
    modules,
    factories,
    scans,
    read: (p) => readFileSync(p, 'utf8')
  })
  const file = (pattern) => {
    const path = Object.keys(out.files).find((p) => pattern.test(p))
    assert.ok(path, `a generated file matches ${pattern}`)
    return out.files[path]
  }
  const counter = file(/^modules\/NotesKit\/TagCounter\+TreziPreviews-/)
  assert.match(counter, /private struct __TreziPreviewable_\w+: SwiftUI\.View/)
  assert.match(counter, /@State var count = 3/)
  assert.ok(
    counter.includes(
      `#sourceLocation(file: ${swiftString(join(MACROS, 'NotesKit/TagCounter.swift'))}, line: 24)`
    )
  )
  const registry = file(/^modules\/Notes\/__TreziPreviews_Notes\.swift$/)
  assert.match(registry, /if #available\(macOS 15\.0, \*\)/)
  assert.match(registry, /#if \(DEBUG\)/)
  assert.match(file(/^modules\/Notes\/NoteList\+/), /\.environment\(NoteStore\(\)\)/)
  const overlayPath = out.overlays[join(MACROS, 'Notes/Sidebar.swift')]
  assert.match(overlayPath, /^overlays\/Notes\/Sidebar-\w+\.swift$/)
  assert.ok(
    out.files[overlayPath].startsWith(
      `#sourceLocation(file: ${swiftString(join(MACROS, 'Notes/Sidebar.swift'))}, line: 1)`
    )
  )
  assert.equal(treeHash(MACROS), fixtureHash, 'the fixture is unchanged')
  pass('scanner and catalog')

  // --- A generated session: a private component from an overlay, errors mapped -----
  const project = join(temp, 'Studio')
  cpSync(join(ROOT, 'test/fixtures/swift-multi-module'), project, { recursive: true })
  rmSync(join(project, 'trezi-previews.json'))
  rmSync(join(project, 'Previews'), { recursive: true })
  const secret =
    'import SwiftUI\n\nprivate let secretTitle = "Hidden"\n\nprivate struct SecretCard: View {\n    var body: some View { Text(secretTitle).padding() }\n}\n'
  writeFileSync(join(project, 'StudioKit/Secret.swift'), secret)
  const projectHash = treeHash(project)
  const logs = []
  const session = new PreviewSession({
    root: project,
    cacheDir: join(temp, 'cache'),
    hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
    moduleCache: MODULE_CACHE,
    manifestDir: join(temp, 'studio-trezi'),
    log: (line) => logs.push(line),
    pollMs: 150,
    graph: { xcodebuild: join(temp, 'no-xcodebuild') }
  })
  const settled = async (builds) => {
    const end = Date.now() + 240_000
    while (
      !(
        ['ready', 'failed', 'error', 'setup'].includes(session.state.status) &&
        session.state.builds >= builds
      )
    ) {
      if (Date.now() > end) throw new Error(`Timed out: ${logs.slice(-5).join(' | ')}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return session.state
  }
  try {
    session.start()
    const state = await settled(1)
    assert.equal(state.status, 'ready', `${state.message}\n${state.output.slice(-2000)}`)
    assert.equal(state.manifest.source, 'none')
    assert.equal(state.catalog?.chosenBy, 'the only previewable target')
    const ids = state.previews.map((p) => p.id)
    assert.ok(
      ids.includes('component:StudioKit.SecretCard'),
      `the private component renders: ${ids}`
    )
    assert.ok(ids.includes('component:StudioKit.StatusBadge'))
    const shot = await session.frame('component:StudioKit.SecretCard')
    assert.ok(shot.width > 0 && shot.height > 0)
    assert.equal(treeHash(project), projectHash, 'the build changed nothing in the project')
    writeFileSync(
      join(project, 'StudioKit/Secret.swift'),
      secret.replace('.padding() }', '.padding().notAModifier() }')
    )
    const failed = await settled(state.builds + 1)
    assert.equal(failed.status, 'failed')
    const error = failed.diagnostics.find((d) => d.severity === 'error')
    assert.deepEqual(
      [error?.file, error?.line, error?.module],
      ['StudioKit/Secret.swift', 6, 'StudioKit'],
      `the overlay's error points at the original: ${JSON.stringify(failed.diagnostics)}`
    )
    pass('generated session')
  } finally {
    await session.stop()
  }
}

rmSync(temp, { recursive: true, force: true })
if (skipped.length) console.log(`SWIFT-PREVIEW-GENERATE SKIP — ${skipped.join('; ')}`)
