import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleBun } from '../scripts/bundle-bun.mjs'
import { defaultProfile, launchBun, nativeServiceLaunchSpec } from '../scripts/start-native.mjs'
import { swiftBuild } from './helpers/swift-build.mjs'

const directory = mkdtempSync(join(tmpdir(), 'trezi-launch-'))
try {
  const env = { TREZI_USER_DATA: join(directory, 'profile') }
  const current = nativeServiceLaunchSpec('/checkout', ['--project', '/repo'], env, '/bun')
  assert.equal(current.command, '/checkout/out/native/Trezi.app/Contents/MacOS/TreziHost')
  assert.deepEqual(current.args, [
    '/checkout/out/native',
    'persistent',
    '--service',
    '--bun',
    '/bun',
    '--backend',
    '/checkout/out/native/Trezi.app/Contents/Resources/backend/index.cjs',
    '--profile',
    env.TREZI_USER_DATA,
    '--',
    '--project',
    '/repo'
  ])
  assert.equal(current.env.TREZI_USER_DATA, env.TREZI_USER_DATA)
  // The launcher prefers the Bun the build copied into Trezi.app.
  mkdirSync(join(directory, 'out/Trezi.app/Contents/Helpers'), { recursive: true })
  assert.equal(launchBun(join(directory, 'out'), '/installed-bun'), '/installed-bun')
  writeFileSync(join(directory, 'out/Trezi.app/Contents/Helpers/bun'), '')
  assert.equal(
    launchBun(join(directory, 'out'), '/installed-bun'),
    join(directory, 'out/Trezi.app/Contents/Helpers/bun')
  )
  const test = nativeServiceLaunchSpec('/checkout', ['--test'], env, '/bun', directory)
  assert.equal(test.profile, join(directory, 'profile'))
  assert.equal(test.env.TREZI_NATIVE_TEST_DIR, directory)
  assert.equal(test.env.TREZI_LOG_DIR, join(directory, 'logs'))
  assert.equal(current.env.TREZI_LOG_DIR, env.TREZI_LOG_DIR)
  assert.equal(test.args[1], 'ephemeral')
  if (process.platform === 'darwin') {
    const main = join(directory, 'main.swift')
    writeFileSync(
      main,
      `import Security
let graphic = SessionAttributeBits.sessionHasGraphicAccess
precondition(HostLaunch.graphicSessionProblem(status: errSecSuccess, attributes: graphic) == nil)
precondition(HostLaunch.graphicSessionProblem(status: -1, attributes: SessionAttributeBits(rawValue: 0)) == nil)
precondition(HostLaunch.graphicSessionProblem(status: errSecSuccess, attributes: SessionAttributeBits(rawValue: 0))?.contains("graphical login session") == true)
if CommandLine.arguments.contains("deny") { HostLaunch.fail("Trezi needs a macOS graphical login session.", showAlert: false, exitStatus: 78) }
if CommandLine.arguments.contains("other") { HostLaunch.fail("Incomplete test bundle", showAlert: false) }
`
    )
    const probe = swiftBuild('host-launch-preflight', [
      main,
      'src/native/HostLaunch.swift',
      '-framework',
      'AppKit',
      '-framework',
      'Security'
    ])
    const good = spawnSync(probe, [], { encoding: 'utf8' })
    assert.equal(good.status, 0, good.stderr)
    const denied = spawnSync(probe, ['deny'], { encoding: 'utf8' })
    assert.equal(denied.signal, null, 'startup refusal must not abort')
    assert.equal(denied.status, 78)
    assert.match(denied.stderr, /Trezi needs a macOS graphical login session/)
    const other = spawnSync(probe, ['other'], { encoding: 'utf8' })
    assert.equal(other.signal, null)
    assert.equal(other.status, 1, 'unrelated startup errors keep their exit status')
    assert.match(other.stderr, /Incomplete test bundle/)
    // A byte-identical cached Bun with a broken signature must be replaced and
    // signed before the app bundle is signed. Work only on disposable copies.
    const source = join(directory, 'unsigned-bun')
    const contents = join(directory, 'Trezi.app/Contents')
    const cached = join(contents, 'Helpers/bun')
    mkdirSync(join(contents, 'Helpers'), { recursive: true })
    copyFileSync(process.execPath, source)
    const unsigned = spawnSync('codesign', ['--remove-signature', source], { encoding: 'utf8' })
    assert.equal(unsigned.status, 0, unsigned.stderr)
    copyFileSync(source, cached)
    assert.notEqual(spawnSync('codesign', ['--verify', '--strict', cached]).status, 0)
    assert.equal(bundleBun(contents, { signer: { kind: 'adhoc' }, source }).copied, true)
    assert.equal(spawnSync('codesign', ['--verify', '--strict', cached]).status, 0)
  }
  // The default profile comes from the service, which makes the `Praxis Native` alias.
  assert.throws(() => defaultProfile(join(directory, 'no-build'), directory), /run bun run build/)
  const out = fileURLToPath(new URL('../out/native', import.meta.url))
  if (existsSync(join(out, 'TreziService'))) {
    const support = join(directory, 'support')
    mkdirSync(join(support, 'Praxis Native'), { recursive: true })
    assert.equal(defaultProfile(out, support), join(support, 'Trezi Native'))
    assert.equal(readlinkSync(join(support, 'Trezi Native')), 'Praxis Native')
    const collision = join(directory, 'collision')
    mkdirSync(join(collision, 'Praxis Native'), { recursive: true })
    mkdirSync(join(collision, 'Trezi Native'))
    assert.throws(
      () => defaultProfile(out, collision),
      /Separate Trezi Native and Praxis Native profiles exist/
    )
  } else console.log('SKIP defaultProfile against the service: no build')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
console.log(
  'NATIVE SERVICE LAUNCH PASS — the XPC launch spec keeps the profile identity and prefers the bundled Bun'
)
