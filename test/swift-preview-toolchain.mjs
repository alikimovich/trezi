/**
 * LKM-274: which developer directory builds Swift previews. With scripted toolchains
 * (a fake `xcrun` that runs each developer directory's own script, a fake
 * `xcode-select`, fake `Xcode*.app` folders and command-line tools): the newest full
 * Xcode wins over a CLT `xcode-select`; CLT only, a broken plugin and an environment
 * failure give actionable messages; an explicit setting beats `DEVELOPER_DIR`, which
 * beats discovery; the `#Preview` probe is cached and re-run when the toolchain
 * changes; the graph's tools get `DEVELOPER_DIR`; the manifest's `developerDir` and
 * the plan's `#Preview` warning. Then, when a full Xcode is installed, an intact
 * `#Preview` is built through the driver with process-local `DEVELOPER_DIR`, and
 * `xcode-select -p` is unchanged before and after.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(ROOT, 'test/fixtures/swift-multi-module')
const {
  selectToolchain,
  toolchainInfo,
  toolchainStamp,
  developerDirOf,
  inspectToolchain,
  probePreview
} = await import('../src/swift-preview/toolchain.ts')
const { PreviewSession } = await import('../src/swift-preview/session.ts')
const { parseManifest } = await import('../src/swift-preview/manifest.ts')
const { nativeGraph } = await import('../src/swift-preview/graph.ts')
const { planTargetBuild } = await import('../src/swift-preview/plan.ts')
const { SWIFT_PREVIEW_DRIVER } = await import('../src/main/swift-preview.ts')

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'swift-toolchain-')))
const write = (path, text, mode) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  if (mode) chmodSync(path, mode)
}
const log = join(temp, 'tools.log')
const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
const compiles = () => lines().filter((line) => line.includes(' swiftc -parse-as-library'))

// --- Scripted tools ---
const bin = join(temp, 'bin')
const xcrun = join(bin, 'xcrun')
write(xcrun, '#!/bin/sh\nexec "$DEVELOPER_DIR/fake-xcrun" "$@"\n', 0o755)
const globalFile = join(temp, 'xcode-select.txt')
const xcodeSelect = join(bin, 'xcode-select')
write(
  xcodeSelect,
  `#!/bin/sh\necho "select:$DEVELOPER_DIR" >> '${log}'\ncat '${globalFile}'\n`,
  0o755
)
const OUTPUT = {
  ok: '',
  missing:
    "Probe.swift:6:1: error: external macro implementation type 'PreviewsMacros.SwiftUIView' could not be found for macro 'Preview(_:body:)'; plugin for module 'PreviewsMacros' not found",
  broken:
    "Probe.swift:6:1: error: external macro implementation type 'PreviewsMacros.SwiftUIView' could not be found; compiler plugin 'libPreviewsMacros.dylib' could not be loaded: incompatible architecture",
  sandbox: 'Probe.swift:6:1: error: swift-plugin-server produced malformed response'
}
const setMode = (dir, mode) => write(join(dir, 'mode'), mode)
function developerDir(dir, swift, sdk, mode) {
  write(
    join(dir, 'fake-xcrun'),
    `#!/bin/sh
echo "$DEVELOPER_DIR $*" >> '${log}'
case "$*" in
  "swiftc --version") echo "Apple Swift version ${swift} (swiftlang-${swift})"; exit 0 ;;
  "--sdk macosx --show-sdk-version") echo "${sdk}"; exit 0 ;;
  "--sdk macosx --show-sdk-path") echo "$DEVELOPER_DIR/SDKs/MacOSX${sdk}.sdk"; exit 0 ;;
esac
mode=$(cat "$DEVELOPER_DIR/mode")
case "$mode" in
  ok) exit 0 ;;
${Object.entries(OUTPUT)
  .filter(([name]) => name !== 'ok')
  .map(([name, text]) => `  ${name}) echo "${text.replaceAll('"', '\\"')}" >&2; exit 1 ;;`)
  .join('\n')}
esac
exit 3
`,
    0o755
  )
  setMode(dir, mode)
}
const PLUGIN =
  'Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins/libPreviewsMacros.dylib'
const plist = (version, build) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>ProductBuildVersion</key><string>${build}</string>
</dict></plist>
`
function xcode(apps, name, version, build, swift, sdk) {
  const app = join(apps, name)
  write(join(app, 'Contents/version.plist'), plist(version, build))
  const dir = join(app, 'Contents/Developer')
  developerDir(dir, swift, sdk, 'ok')
  write(join(dir, PLUGIN), 'plugin')
  return { app, dir }
}
const apps = join(temp, 'Applications')
const x265 = xcode(apps, 'Xcode-26.5.0.app', '26.5', '17F42', '6.3.2', '26.5')
const x164 = xcode(apps, 'Xcode-16.4.app', '16.4', '16F6', '6.1.2', '15.5')
mkdirSync(join(apps, 'Xcode-beta.app/Contents'), { recursive: true }) // no Developer folder
mkdirSync(join(apps, 'Other.app/Contents/Developer'), { recursive: true })
const clt = join(temp, 'CommandLineTools')
developerDir(clt, '6.3.1', '26.4.1', 'missing')
write(globalFile, `${clt}\n`)
const noApps = join(temp, 'NoApplications')
mkdirSync(noApps)

let scenario = 0
const options = (extra = {}) => ({
  applications: [apps],
  commandLineTools: clt,
  xcodeSelect,
  xcrun,
  environment: '',
  cacheFile: join(temp, `cache-${++scenario}`, 'toolchains.json'),
  workDir: join(temp, 'probe'),
  timeoutMs: 20_000,
  ...extra
})
const HOW = /install or select full Xcode/
const MACHINE = /the machine default stays as it is/

try {
  // --- CLT global, two Xcodes installed: the newest Xcode, and #Preview works ---
  const first = options()
  let selection = await selectToolchain(first)
  assert.equal(selection.toolchain.developerDir, x265.dir)
  assert.equal(selection.toolchain.kind, 'xcode')
  assert.equal(selection.toolchain.label, 'Xcode 26.5 (17F42)')
  assert.deepEqual(
    [selection.toolchain.swiftVersion, selection.toolchain.sdkVersion],
    ['6.3.2', '26.5']
  )
  assert.equal(selection.toolchain.previewsMacros, join(x265.dir, PLUGIN))
  assert.deepEqual(selection.toolchain.foundBy, [apps])
  assert.equal(selection.capability.status, 'supported')
  assert.equal(selection.capability.cached, false)
  assert.match(selection.reason, /newest full Xcode with PreviewsMacros that expands #Preview/)
  assert.ok(selection.reason.includes(`xcode-select points at ${clt}`), selection.reason)
  assert.deepEqual(selection.env, { DEVELOPER_DIR: x265.dir })
  assert.equal(selection.systemDefault, clt)
  assert.equal(selection.key.length, 16)
  assert.deepEqual(
    selection.candidates.map((c) => [c.developerDir, c.kind, Boolean(c.previewsMacros)]),
    [
      [x164.dir, 'xcode', true],
      [x265.dir, 'xcode', true],
      [clt, 'clt', false]
    ],
    'Xcode*.app with a Developer folder, then the CLT that xcode-select points at'
  )
  assert.deepEqual(selection.candidates[2].foundBy, ['xcode-select', 'command-line tools'])
  assert.deepEqual(
    compiles().map((line) => line.split(' ')[0]),
    [x265.dir],
    'only the newest Xcode is probed'
  )
  assert.ok(lines().includes('select:'), 'xcode-select -p runs without DEVELOPER_DIR')
  assert.deepEqual(toolchainInfo(selection), {
    developerDir: x265.dir,
    label: 'Xcode 26.5 (17F42)',
    swiftVersion: '6.3.2',
    sdkVersion: '26.5',
    reason: selection.reason,
    preview: 'supported',
    message: selection.message,
    systemDefault: clt
  })

  // The probe is cached by path, versions and SDK.
  selection = await selectToolchain(first)
  assert.equal(selection.capability.status, 'supported')
  assert.equal(selection.capability.cached, true)
  assert.equal(compiles().length, 1, 'a cached probe compiles nothing')
  const key265 = selection.key

  // --- CLT only: an actionable "unsupported" ---
  selection = await selectToolchain(options({ applications: [noApps] }))
  assert.equal(selection.toolchain.developerDir, clt)
  assert.equal(selection.toolchain.label, 'Command Line Tools')
  assert.match(selection.reason, /xcode-select -p/)
  assert.equal(selection.capability.status, 'unsupported')
  assert.match(
    selection.message,
    /^Command Line Tools lack PreviewsMacros, so #Preview cannot expand/
  )
  assert.match(selection.message, HOW)
  assert.match(selection.message, MACHINE)
  assert.deepEqual(toolchainInfo(selection).preview, 'unsupported')

  // xcode-select gives nothing: the command-line tools folder still is a candidate.
  write(globalFile, '')
  selection = await selectToolchain(options({ applications: [noApps] }))
  assert.equal(selection.toolchain.developerDir, clt)
  assert.match(selection.reason, /command-line tools/)
  assert.equal(selection.systemDefault, '')
  // Nothing at all.
  selection = await selectToolchain(
    options({ applications: [noApps], commandLineTools: join(temp, 'none') })
  )
  assert.equal(selection.toolchain, null)
  assert.deepEqual([selection.env, selection.key], [{}, ''])
  assert.match(selection.message, /No Xcode or command-line tools were found/)
  write(globalFile, `${clt}\n`)

  // --- A broken or incompatible plugin ---
  setMode(x265.dir, 'broken')
  selection = await selectToolchain(options())
  assert.equal(selection.toolchain.developerDir, x164.dir, 'the next newest Xcode that works')
  assert.equal(selection.capability.status, 'supported')
  assert.match(
    selection.message,
    /PreviewsMacros plugin of Xcode 26\.5 \(17F42\) is broken or incompatible/
  )
  setMode(x164.dir, 'broken')
  selection = await selectToolchain(options())
  assert.equal(selection.toolchain.developerDir, clt, 'no Xcode works: xcode-select')
  assert.equal(selection.capability.status, 'unsupported')
  assert.match(selection.message, /Xcode 16\.4 \(16F6\) is broken or incompatible/)
  selection = await selectToolchain(
    options({ override: { path: x265.app, from: 'The test setting' } })
  )
  assert.equal(selection.toolchain.developerDir, x265.dir)
  assert.equal(selection.capability.status, 'broken')
  assert.match(
    selection.message,
    /broken or incompatible \(.*incompatible architecture\): reinstall that Xcode or select another one/
  )
  setMode(x164.dir, 'ok')

  // --- The compiler's plugin server cannot start here: an environment failure ---
  setMode(x265.dir, 'sandbox')
  const sandboxed = options()
  selection = await selectToolchain(sandboxed)
  assert.equal(selection.toolchain.developerDir, x265.dir, 'not the toolchain’s fault')
  assert.equal(selection.capability.status, 'unavailable')
  assert.match(selection.message, /plugin server could not start .* in this environment/)
  assert.match(selection.reason, /newest full Xcode with PreviewsMacros \(/)
  const before = compiles().length
  selection = await selectToolchain(sandboxed)
  assert.equal(selection.capability.cached, false, 'environment failures are not cached')
  assert.equal(compiles().length, before + 1)
  setMode(x265.dir, 'ok')

  // --- Precedence: setting, then DEVELOPER_DIR, then discovery ---
  selection = await selectToolchain(
    options({ override: { path: x164.app, from: 'The test setting' }, environment: x265.dir })
  )
  assert.equal(selection.toolchain.developerDir, x164.dir, 'an explicit setting wins')
  assert.equal(selection.reason, `The test setting selects ${x164.dir}.`)
  assert.deepEqual(selection.toolchain.foundBy, ['setting', apps])
  assert.equal(selection.capability.status, 'supported')
  selection = await selectToolchain(options({ environment: x164.dir }))
  assert.equal(selection.toolchain.developerDir, x164.dir, 'DEVELOPER_DIR beats the newest')
  assert.match(selection.reason, /DEVELOPER_DIR is set to/)
  selection = await selectToolchain(options({ environment: clt }))
  assert.equal(selection.capability.status, 'unsupported', 'even when it cannot expand #Preview')
  selection = await selectToolchain(
    options({ override: { path: join(temp, 'Xcode-gone.app'), from: 'The test setting' } })
  )
  assert.equal(selection.toolchain.developerDir, join(temp, 'Xcode-gone.app/Contents/Developer'))
  assert.equal(selection.capability.status, 'broken')
  assert.equal(selection.key, '', 'nothing is built with it')
  assert.match(selection.message, /does not exist\. Install Xcode or select another/)
  assert.equal(
    developerDirOf('/Applications/Xcode.app/'),
    '/Applications/Xcode.app/Contents/Developer'
  )

  // --- The cache follows the toolchain: a new version or plugin probes again ---
  const changing = options()
  selection = await selectToolchain(changing)
  assert.equal(selection.key, key265, 'the key depends on the toolchain, not the cache file')
  const stamp = toolchainStamp(changing)
  let count = compiles().length
  write(join(x265.app, 'Contents/version.plist'), plist('26.5.1', '17F50'))
  assert.notEqual(toolchainStamp(changing), stamp, 'an Xcode update changes the stamp')
  selection = await selectToolchain(changing)
  assert.equal(selection.toolchain.label, 'Xcode 26.5.1 (17F50)')
  assert.notEqual(selection.key, key265)
  assert.equal(selection.capability.cached, false)
  assert.equal(compiles().length, ++count)
  const key2651 = selection.key
  write(join(x265.dir, PLUGIN), 'a different plugin build')
  selection = await selectToolchain(changing)
  assert.notEqual(selection.key, key2651, 'a changed plugin is probed again')
  assert.equal(selection.capability.cached, false)
  assert.equal(compiles().length, ++count)
  selection = await selectToolchain(changing)
  assert.equal(selection.capability.cached, true)
  selection = await selectToolchain({
    ...changing,
    override: { path: x164.dir, from: 'The test setting' }
  })
  assert.notEqual(selection.key, key2651, 'another toolchain has another key')
  assert.equal(compiles().length, ++count)

  // The probe uses the compiler's normal flags only: no sandbox is ever disabled.
  for (const line of lines()) assert.doesNotMatch(line, /disable-sandbox/, line)
  assert.ok(compiles().every((line) => line.includes('-c ') && line.includes('Probe.swift')))

  // --- Metadata queries retry a timeout once, and nothing else (CI: a stalled xcrun) ---
  // A scripted xcrun counts each query per developer directory and can hang (`hang-<key>`:
  // how many first attempts never answer) or fail (`fail-<key>`). The cap is 0.6 s, not 20 s.
  const stalled = (name) => {
    const dir = join(temp, name, 'Developer')
    write(
      join(dir, 'fake-xcrun'),
      `#!/bin/sh
echo "$DEVELOPER_DIR $*" >> '${log}'
case "$*" in
  "swiftc --version") key=swift ;;
  "--sdk macosx --show-sdk-version") key=sdkv ;;
  "--sdk macosx --show-sdk-path") key=sdkp ;;
  *) key=compile ;;
esac
n=$(cat "$DEVELOPER_DIR/n-$key" 2>/dev/null || echo 0)
n=$((n + 1))
echo $n > "$DEVELOPER_DIR/n-$key"
hangs=$(cat "$DEVELOPER_DIR/hang-$key" 2>/dev/null || echo 0)
[ "$n" -le "$hangs" ] && exec sleep 30
if [ -f "$DEVELOPER_DIR/fail-$key" ]; then echo "error: scripted failure" >&2; exit 1; fi
case $key in
  swift) echo "Apple Swift version 6.3.2 (swiftlang-6.3.2)" ;;
  sdkv) echo "26.5" ;;
  sdkp) echo "$DEVELOPER_DIR/SDKs/MacOSX26.5.sdk" ;;
esac
exit 0
`,
      0o755
    )
    return dir
  }
  const script = (dir, key, kind, value) => write(join(dir, `${kind}-${key}`), `${value}\n`)
  const attempts = (dir, key) => Number(readFileSync(join(dir, `n-${key}`), 'utf8'))
  const KEYS = ['swift', 'sdkv', 'sdkp']
  const quick = options({ timeoutMs: 600 })
  const inspect = (dir) => inspectToolchain(dir, ['setting'], quick)

  // One stalled first attempt per query: each retries once and the toolchain is complete.
  const slow = stalled('slow')
  for (const key of KEYS) script(slow, key, 'hang', 1)
  let started = Date.now()
  let inspected = await inspect(slow)
  assert.deepEqual(inspected.errors, [], 'a recovered stall leaves no error')
  assert.deepEqual(
    [inspected.swiftVersion, inspected.sdkVersion, inspected.sdkPath],
    ['6.3.2', '26.5', `${slow}/SDKs/MacOSX26.5.sdk`]
  )
  assert.deepEqual(
    KEYS.map((key) => attempts(slow, key)),
    [2, 2, 2]
  )
  assert.ok(Date.now() - started < 5000, 'one cap plus the answer, not 20 s sleeps')
  assert.ok(
    lines().filter((line) => line.startsWith(`${slow} `)).length === 6,
    'every attempt kept the same DEVELOPER_DIR'
  )

  // Always stalled: exactly two attempts per query, then the timeout is reported as before.
  const dead = stalled('dead')
  for (const key of KEYS) script(dead, key, 'hang', 99)
  started = Date.now()
  inspected = await inspect(dead)
  const elapsed = Date.now() - started
  assert.deepEqual(
    KEYS.map((key) => attempts(dead, key)),
    [2, 2, 2],
    'bounded: never more than two attempts'
  )
  assert.ok(elapsed >= 1100 && elapsed < 5000, `two caps run concurrently, took ${elapsed} ms`)
  assert.equal(inspected.swiftVersion, '')
  assert.match(inspected.errors[0], /^xcrun swiftc --version timed out after 1 s\./)
  assert.ok(inspected.errors.some((error) => /has no macOS SDK/.test(error)))

  // A non-zero exit (a diagnostic) is an answer: one attempt, the same message as before.
  const failing = stalled('failing')
  for (const key of KEYS) script(failing, key, 'fail', 1)
  inspected = await inspect(failing)
  assert.deepEqual(
    KEYS.map((key) => attempts(failing, key)),
    [1, 1, 1],
    'no retry for a non-zero exit'
  )
  assert.match(inspected.errors[0], /^xcrun swiftc --version failed: error: scripted failure/)
  // A missing tool is not retried either: spawn fails, nothing runs twice.
  const missing = await inspectToolchain(failing, ['setting'], {
    ...quick,
    xcrun: join(temp, 'bin/no-such-xcrun')
  })
  assert.match(missing.errors[0], /no-such-xcrun is missing/)
  assert.deepEqual(
    KEYS.map((key) => attempts(failing, key)),
    [1, 1, 1],
    'the missing tool never ran'
  )

  // The probe compile is not a metadata query: a stalled compile is reported once.
  const building = stalled('building')
  script(building, 'compile', 'hang', 99)
  const intact = await inspect(building)
  assert.deepEqual(intact.errors, [])
  const probed = await probePreview(intact, quick)
  assert.equal(probed.status, 'broken')
  assert.match(probed.message, /could not compile a #Preview: xcrun --sdk macosx timed out/)
  assert.equal(attempts(building, 'compile'), 1, 'builds and the probe compile never retry')

  // --- The manifest's developerDir ---
  const manifest = (fields) =>
    parseManifest(JSON.stringify({ name: 'X', target: 'App', previews: ['Previews'], ...fields }))
  assert.equal(
    manifest({ developerDir: '/Applications/Xcode.app/' }).developerDir,
    '/Applications/Xcode.app/'
  )
  assert.equal(manifest({}).developerDir, undefined)
  assert.throws(
    () => manifest({ developerDir: 'Xcode.app' }),
    /"developerDir" must be an absolute path/
  )

  // --- The session: every graph tool runs with the selected DEVELOPER_DIR ---
  const project = join(temp, 'Studio')
  cpSync(FIXTURE, project, { recursive: true })
  write(
    join(project, 'StudioKit/ProbeCard.swift'),
    `import SwiftUI

public struct ProbeCard: View {
    public init() {}
    public var body: some View { Text("Probe card") }
}

#Preview { ProbeCard() }
`
  )
  const xcodebuild = join(bin, 'xcodebuild')
  write(xcodebuild, `#!/bin/sh\necho "xcodebuild:$DEVELOPER_DIR" >> '${log}'\nexit 1\n`, 0o755)
  const sessionLog = []
  const session = new PreviewSession({
    root: project,
    cacheDir: join(temp, 'session-cache/project'),
    hostSource: join(ROOT, 'src/swift-preview/PreviewHost.swift'),
    log: (line) => sessionLog.push(line),
    moduleCache: join(temp, 'session-modules'),
    developerDir: x164.app,
    graph: { xcodebuild, timeoutMs: 20_000 },
    toolchain: { applications: [apps], commandLineTools: clt, xcodeSelect, xcrun, environment: '' }
  })
  const graph = await session.nativeGraph()
  assert.equal(session.state.toolchain.toolchain.developerDir, x164.dir, 'the app setting')
  assert.equal(session.state.toolchain.reason, `TREZI_DEVELOPER_DIR selects ${x164.dir}.`)
  assert.ok(lines().includes(`xcodebuild:${x164.dir}`), 'xcodebuild got DEVELOPER_DIR')
  assert.ok(!lines().some((line) => line === 'xcodebuild:'), 'never without it')
  assert.ok(sessionLog.some((line) => line.startsWith(`Swift previews: toolchain ${x164.dir}`)))
  assert.equal(graph.containers[0].targets.length, 2)

  // --- The plan's #Preview warning names the real requirement ---
  const plan = (preview) =>
    planTargetBuild(graph, { target: 'Studio', preview }, (file) =>
      readFileSync(join(project, file), 'utf8')
    )
  const warning = (preview) => plan(preview).warnings.find((w) => w.includes('#Preview')) ?? ''
  assert.match(
    warning({ status: 'supported', message: '' }),
    /^StudioKit: 1 file use #Preview; they compile with the selected Xcode, but with a manifest only its "previews" are shown \(without one, Trezi lists and renders #Preview blocks itself\): StudioKit\/ProbeCard\.swift$/
  )
  // Without a manifest (LKM-276) the #Preview blocks are the previews: no warning.
  assert.equal(
    planTargetBuild(
      graph,
      { target: 'Studio', preview: { status: 'supported', message: '' }, generated: true },
      (file) => readFileSync(join(project, file), 'utf8')
    ).warnings.filter((w) => w.includes('#Preview')).length,
    0
  )
  const unsupported = warning({ status: 'unsupported', message: 'Command Line Tools lack it.' })
  assert.match(
    unsupported,
    /needs PreviewsMacros from a full Xcode selected for Trezi's processes \(Command Line Tools lack it\.\)/
  )
  assert.match(warning(undefined), /no toolchain was checked/)
  for (const text of [warning({ status: 'supported', message: '' }), unsupported])
    assert.doesNotMatch(text, /bare swiftc|strip/i)
  await session.stop()
  rmSync(join(temp, 'session-modules'), { recursive: true, force: true })

  // --- The real toolchain: an intact #Preview through the driver ---
  await realToolchain(project)
} finally {
  rmSync(temp, { recursive: true, force: true })
}

function systemDeveloperDir() {
  const env = { ...process.env }
  delete env.DEVELOPER_DIR
  const result = spawnSync('/usr/bin/xcode-select', ['-p'], { env, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : `exit ${result.status}`
}

async function realToolchain(project) {
  if (process.platform !== 'darwin')
    return console.log('swift-preview-toolchain: real check skipped (not macOS)')
  const globalBefore = systemDeveloperDir()
  const env = { ...process.env }
  delete env.DEVELOPER_DIR
  delete env.TREZI_DEVELOPER_DIR
  const real = await selectToolchain({
    environment: '',
    cacheFile: join(temp, 'real/toolchains.json'),
    workDir: join(temp, 'real/probe')
  })
  if (real.toolchain?.kind !== 'xcode' || !real.toolchain.previewsMacros) {
    console.log(
      `swift-preview-toolchain: no full Xcode with PreviewsMacros is installed; real #Preview check not run (${real.message})`
    )
    assert.equal(systemDeveloperDir(), globalBefore)
    return
  }
  if (real.capability.status === 'unavailable') {
    // This process runs inside a sandbox that stops the compiler's plugin server.
    console.log(
      `swift-preview-toolchain: ENVIRONMENT: real #Preview check not run: ${real.capability.message}`
    )
    assert.equal(systemDeveloperDir(), globalBefore)
    return
  }
  assert.equal(real.capability.status, 'supported', real.message)
  const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  const output = []
  const driver = spawn(process.execPath, [SWIFT_PREVIEW_DRIVER, project], {
    cwd: project,
    env: {
      ...env,
      PORT: String(port),
      HOST: '127.0.0.1',
      TREZI_SWIFT_PREVIEW_CACHE: join(temp, 'driver-cache')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  driver.stdout.on('data', (chunk) => output.push(String(chunk)))
  driver.stderr.on('data', (chunk) => output.push(String(chunk)))
  const base = `http://127.0.0.1:${port}`
  try {
    const end = Date.now() + 240_000
    let state
    for (;;) {
      state = await fetch(`${base}/state`)
        .then((response) => response.json())
        .catch(() => null)
      if (state && (state.status === 'ready' || state.status === 'failed')) break
      if (Date.now() > end) throw new Error(`Timed out: driver build (${output.join('')})`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(
      state.status,
      'ready',
      `${state.message}\n${state.output ?? ''}\n${output.join('')}`
    )
    assert.equal(state.toolchain.toolchain.developerDir, real.toolchain.developerDir)
    assert.equal(state.toolchain.env.DEVELOPER_DIR, real.toolchain.developerDir)
    assert.equal(state.toolchain.capability.status, 'supported')
    assert.ok(state.plan.modules.some((m) => m.sources.includes('StudioKit/ProbeCard.swift')))
    assert.ok(state.plan.warnings.some((w) => w.includes('compile with the selected Xcode')))
    const { toolchain } = await (await fetch(`${base}/graph`)).json()
    assert.equal(toolchain.preview, 'supported')
    assert.equal(toolchain.developerDir, real.toolchain.developerDir)
    assert.equal(toolchain.systemDefault, globalBefore === 'exit 2' ? '' : globalBefore)
    console.log(
      `swift-preview-toolchain: real #Preview built with ${real.toolchain.label} (DEVELOPER_DIR=${real.toolchain.developerDir}); xcode-select stays ${globalBefore}`
    )
  } finally {
    driver.kill('SIGTERM')
    await new Promise((resolve) => {
      if (driver.exitCode !== null || driver.signalCode !== null) return resolve()
      driver.on('exit', resolve)
    })
  }
  assert.equal(systemDeveloperDir(), globalBefore, 'xcode-select -p is unchanged')
}
console.log('swift-preview-toolchain: ok')
