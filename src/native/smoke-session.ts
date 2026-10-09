import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { NativeBridge } from './bridge'

/** LKM-125: a process started under the XPC service is in the host's security session.
 *  This smoke runs in Bun, the service's child, at `<app>/Contents/Resources/backend`; it
 *  starts `TreziHost --session` the way the service starts the `TreziSecrets` Keychain helper
 *  and provider helpers, and compares that report with the host's own. Without
 *  `JoinExistingSession` the session ids differ and the keychain exit codes can too. */
export async function checkSecuritySession(host: NativeBridge, artifacts: string) {
  const hostReport = await host.request('securitySession')
  const treziHost = resolve(dirname(process.argv[1]), '../../MacOS/TreziHost')
  const probe = spawnSync(treziHost, ['--session'], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(
    probe.status,
    0,
    `TreziHost --session failed: ${probe.error?.message ?? probe.stderr}`
  )
  const service = JSON.parse(probe.stdout)
  writeFileSync(
    join(artifacts, 'security-session.json'),
    JSON.stringify({ host: hostReport, service }, null, 2)
  )
  assert.ok(
    Number.isInteger(hostReport.session) && hostReport.session >= 0,
    'the host reads its session'
  )
  assert.deepEqual(
    service,
    hostReport,
    'processes under the service share the host’s security session'
  )
  console.log(
    `Native security session: host and service children share session ${hostReport.session} (keychain exits ${hostReport.listKeychains}/${hostReport.defaultKeychain}).`
  )
}
