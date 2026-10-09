// S15 distribution checks: the supported platform has one source
// (scripts/requirements.mjs) that the build stamps into both bundles and every entry
// point enforces; the launch spec points at the package layout the build produces.
// Pure, plus a read of out/native when a build exists.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareVersions,
  MIN_BUN,
  MIN_MACOS,
  MIN_SDK,
  platformProblems
} from '../scripts/requirements.mjs'
import { nativeServiceLaunchSpec } from '../scripts/start-native.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')

// Version comparison and the problems each machine gets.
assert.equal(compareVersions('13.3', '13.3.0'), 0)
assert.equal(compareVersions('13.10', '13.3'), 1)
assert.equal(compareVersions('12.7.6', '13.3'), -1)
assert.equal(compareVersions('26.0.1', '26'), 1)
assert.deepEqual(
  platformProblems({ platform: 'darwin', macos: '13.3', sdk: '26.0', bun: '1.3.0' }),
  []
)
assert.deepEqual(
  platformProblems({ platform: 'darwin', macos: '26.4.1' }),
  [],
  'a launch does not need the SDK'
)
assert.match(
  platformProblems({ platform: 'linux', macos: null })[0],
  /requires macOS 13\.3 or later/
)
assert.match(platformProblems({ platform: 'darwin', macos: '13.2.1' })[0], /this Mac runs 13\.2\.1/)
assert.match(platformProblems({ platform: 'darwin', macos: null })[0], /unknown version/)
assert.match(
  platformProblems({ platform: 'darwin', macos: '14.0', sdk: '15.5' })[0],
  /macOS 26\.0 SDK/
)
assert.match(
  platformProblems({ platform: 'darwin', macos: '14.0', sdk: null, bun: '1.2.9' })[0],
  /Bun 1\.3\.0/
)
assert.equal(
  platformProblems({ platform: 'darwin', macos: '12.0', sdk: '15.0', bun: '1.0.0' }).length,
  3,
  'every problem is reported'
)

// One source: the build stamps it, package.json agrees, every entry point enforces it.
const build = read('scripts/build-native.mjs')
const plists = read('scripts/service-info.mjs')
assert.doesNotMatch(
  build + plists,
  /macosx1\d\.\d|<string>1\d\.\d<\/string>/,
  'no literal deployment target left in the build'
)
assert.match(build, /apple-macosx\$\{MIN_MACOS\}/)
assert.match(plists, /LSMinimumSystemVersion<\/key><string>\$\{MIN_MACOS\}/)
assert.match(build, /appInfoPlist\(info\)/, 'the build writes the app plist with the minimum')
assert.match(
  build,
  /requireSupportedPlatform\(\{ sdk: true \}\)/,
  'the build checks the SDK before compiling'
)
assert.equal(JSON.parse(read('package.json')).engines.bun, `>=${MIN_BUN}`)
for (const entry of ['scripts/start-native.mjs', 'scripts/dev-native.mjs', 'bin/trezi.mjs'])
  assert.match(read(entry), /requireSupportedPlatform\(\)/, `${entry} checks the platform`)
const install = read('install.sh')
assert.ok(install.indexOf('scripts/requirements.mjs --build') > 0, 'install.sh checks the platform')
assert.ok(
  install.indexOf('scripts/requirements.mjs --build') < install.indexOf('"$PM" install'),
  '…before installing anything'
)
const doc = read('docs/SWIFT-BACKEND-RETIREMENT.md')
for (const text of [
  `macOS ${MIN_MACOS} or later`,
  `macOS ${MIN_SDK} SDK`,
  `Bun ${MIN_BUN} or later`
])
  assert.ok(doc.includes(text), `the doc states ${text}`)

// The launch spec points at the layout the build produces.
const spec = nativeServiceLaunchSpec(
  root,
  [],
  { TREZI_USER_DATA: '/tmp/trezi-distribution-profile' },
  '/bun'
)
const out = join(root, 'out/native')
assert.equal(spec.command, join(out, 'Trezi.app/Contents/MacOS/TreziHost'))
assert.ok(spec.args.includes(join(out, 'Trezi.app/Contents/Resources/backend/index.cjs')))
// The retained JS ships inside the app, beside the Bun that runs it.
assert.match(build, /Resources\/backend/)
assert.match(build, /XPCServices\/dev\.trezi\.service\.xpc\/Contents/)
assert.match(
  build,
  /copyFileSync\(join\(serviceContents, 'MacOS\/TreziService'\), join\(out, 'TreziService'\)\)/
)
// Trezi.app carries the Bun it runs, so `open -a Trezi` needs no installed Bun.
assert.ok(
  build.indexOf('bundleBun(contents, { signer: current })') > 0,
  'the build bundles Bun into Trezi.app'
)
assert.match(
  build,
  /signWithFallback\(signingIdentity\(/,
  'a failing identity falls back to ad hoc instead of failing the build'
)
assert.match(build, /src\/native\/HostLaunch\.swift/)
// LKM-137: one signer for the whole app; the Keychain helper is its own binary.
assert.match(
  build,
  /src\/native\/Secrets\.swift'\), '-o', join\(contents, 'Helpers\/TreziSecrets'\)/
)
assert.ok(
  build.indexOf('signingIdentity(') < build.indexOf('bundleBun(contents'),
  'the signer is chosen before anything is signed'
)
assert.doesNotMatch(build, /'--sign', '-'/, 'no hard-coded ad hoc signature left in the build')
assert.match(read('src/service/ServiceRuntime.swift'), /Contents\/Helpers\/TreziSecrets/)

// A present build carries the same values (skipped, and said so, when there is none).
const plist = join(out, 'Trezi.app/Contents/Info.plist')
if (existsSync(plist)) {
  assert.match(
    readFileSync(plist, 'utf8'),
    new RegExp(`LSMinimumSystemVersion</key><string>${MIN_MACOS.replace('.', '\\.')}</string>`)
  )
  for (const path of [
    'Trezi.app/Contents/MacOS/TreziHost',
    'Trezi.app/Contents/Helpers/bun',
    'Trezi.app/Contents/Helpers/TreziSecrets',
    'Trezi.app/Contents/XPCServices/dev.trezi.service.xpc/Contents/MacOS/TreziService',
    'TreziService',
    'Trezi.app/Contents/Resources/backend/index.cjs',
    'Trezi.app/Contents/Resources/backend/provider-helper.cjs'
  ])
    assert.ok(existsSync(join(out, path)), `the build contains ${path}`)
  // An upgrade leaves no service registered under an earlier identifier.
  assert.deepEqual(readdirSync(join(out, 'Trezi.app/Contents/XPCServices')), [
    'dev.trezi.service.xpc'
  ])
  console.log(
    'DISTRIBUTION OK — one platform source, enforced at build/launch/CLI/install; build layout matches the launch spec'
  )
} else {
  console.log(
    'DISTRIBUTION OK — one platform source, enforced at build/launch/CLI/install (no build present: layout check SKIPPED)'
  )
}
