import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_MACOS } from '../scripts/requirements.mjs'
import { swiftFrontend } from './helpers/swift-build.mjs'

// LKM-436: the release build's Swift warnings stay gone. The real TreziHost source list from
// scripts/build-native.mjs is type-checked with the four files as primary inputs, so this reads
// the compiler's own diagnostics for them. Their warnings are all reported at this stage: on
// 5b5356f it found the eight a fresh release build printed. Uncached, so no old binary can pass.
// A canary with the same mistakes shows the check would still see them, and the host's
// compile keeps its warnings: no suppressing flag, and the four files stay in the build.
if (process.platform !== 'darwin') {
  console.log('HOST-WARNINGS SKIP — macOS Swift toolchain required')
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const guarded = [
    'src/native/SidebarVerification.swift',
    'src/native/ToolbarAnchorVerification.swift',
    'src/native/BranchStatusView.swift',
    'src/native/ComposerQueue.swift',
    // LKM-441: the sidebar menu run moved here from SidebarVerification.swift.
    'src/native/SidebarMenuCapture.swift',
    // LKM-444: the code editor pop-out's full-screen-aware hide and its test hook.
    'src/native/SourcePopout.swift',
    'src/native/SourcePopoutVerification.swift',
    // LKM-447: the opt-in Dreamer acceptance's host steps.
    'src/native/DreamerAcceptance.swift',
    // LKM-453: the opt-in chat recovery acceptance's host steps.
    'src/native/ChatRecoveryAcceptance.swift',
    // LKM-456: the opt-in fullscreen-popout-close-native acceptance's host steps.
    'src/native/SourcePopoutAcceptance.swift'
  ]

  const script = readFileSync(join(root, 'scripts/build-native.mjs'), 'utf8')
  const start = script.indexOf("const host = compile(\n  'TreziHost',")
  const end = script.indexOf('// The Keychain helper', start)
  assert.ok(start >= 0 && end > start, 'scripts/build-native.mjs: the TreziHost compile was found')
  const host = script.slice(start, end)
  const sources = [...host.matchAll(/join\(root, '(src\/[\w/]+\.swift)'\)/g)].map((m) => m[1])
  for (const file of guarded)
    assert.ok(sources.includes(file), `${file} stays in the production TreziHost build`)
  assert.doesNotMatch(
    host,
    /-suppress-warnings|-Xfrontend|-swift-version|-strict-concurrency|-minimal/,
    "TreziHost's compile keeps the project's warning policy"
  )

  const canary = [
    'import AppKit',
    'func title(_ button: NSPopUpButton) -> String { button.itemTitle(at: 0) ?? "" }',
    'func header(_ gap: [String: Double]?, _ measured: [String: Double], _ paused: Bool) -> Any {',
    '    var value: Any = NSNull()',
    '    value = ["frame": measured, "glyph": gap ?? NSNull(), "resume": gap ?? NSNull(), "paused": paused]',
    '    return value',
    '}',
    'func mutation() {',
    '    var shot = 0',
    '    _ = Timer(timeInterval: 1, repeats: false) { _ in Task { @MainActor in shot = 1 } }',
    '    _ = shot',
    '}',
    '@MainActor func capture(_ menu: NSMenu) {',
    '    _ = Timer(timeInterval: 1, repeats: false) { _ in menu.cancelTracking() }',
    '}',
    ''
  ]

  const warnings = (text) =>
    text
      .split('\n')
      .filter((line) => /^\S.*:\d+:\d+: (warning|error):/.test(line))
      .map((line) => line.replace(root, ''))

  const temp = mkdtempSync(join(tmpdir(), 'trezi-host-warnings-'))
  try {
    // build-native.mjs compiles Host.swift as main.swift, which makes its top-level code legal.
    const main = join(temp, 'main.swift')
    copyFileSync(join(root, 'src/native/Host.swift'), main)
    const sdk = spawnSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).stdout.trim()
    assert.ok(sdk, 'an SDK path')
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
    // `swiftc -frontend` skips the driver's plugin search: SwiftUI's @State is a macro in this
    // SDK, so without the platform's host plugins ComposerQueue.swift fails to expand it.
    const platform = spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-platform-path'], {
      encoding: 'utf8'
    }).stdout.trim()
    const plugins = platform
      ? ['-plugin-path', join(platform, 'Developer/usr/lib/swift/host/plugins')]
      : []
    const check = (primary, others) =>
      swiftFrontend([
        '-typecheck',
        '-module-name',
        'TreziHost',
        '-sdk',
        sdk,
        '-target',
        `${arch}-apple-macosx${MIN_MACOS}`,
        ...plugins,
        ...primary.flatMap((file) => ['-primary-file', file]),
        ...others
      ])

    const paths = sources.filter((file) => !guarded.includes(file)).map((f) => join(root, f))
    const result = check(
      guarded.map((file) => join(root, file)),
      [main, ...paths]
    )
    assert.equal(result.error, undefined, `swiftc: ${result.error}`)
    assert.equal(result.status, 0, `swiftc: ${result.stderr}`)
    assert.deepEqual(warnings(result.stderr), [], 'the guarded files compile with no warning')
    for (const file of guarded)
      assert.doesNotMatch(
        readFileSync(join(root, file), 'utf8'),
        /@preconcurrency|@unchecked\s+Sendable|nonisolated\(unsafe\)/,
        `${file} reaches the main actor for real, it does not switch the check off`
      )

    const mistakes = join(temp, 'Canary.swift')
    writeFileSync(mistakes, canary.join('\n'))
    const seen = check([mistakes], [])
    assert.equal(seen.status, 0, `canary: ${seen.stderr}`)
    const lines = new Set(warnings(seen.stderr).map((line) => Number(line.match(/:(\d+):\d+:/)[1])))
    for (const [text, what] of [
      ['itemTitle', "the unreachable '??'"],
      ['"resume"', 'the implicit Any? coercion'],
      ['shot = 1', 'mutation of a captured var in a Task'],
      ['menu.cancelTracking', 'a non-Sendable capture in a Timer']
    ])
      assert.ok(
        lines.has(canary.findIndex((line) => line.includes(text)) + 1),
        `the check still sees ${what}: ${seen.stderr}`
      )
    console.log('HOST-WARNINGS PASS')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
