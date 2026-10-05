import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultProfile, launchBun, nativeServiceLaunchSpec } from '../scripts/start-native.mjs'

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
  assert.equal(test.args[1], 'ephemeral')
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
