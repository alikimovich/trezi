// Import first in a suite that starts in-process provider sessions (a stubbed adapter):
// installs the real Swift provider owner (the only one since LKM-111 removed the Bun
// twin) on a scratch profile. The suite decides when the process ends; the fixture
// never holds it open.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setProviderOwner } from '../../src/main/provider-owner.ts'
import { compileProviderFixture, startProviderFixture } from './provider-fixture.mjs'

const profile = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-provider-profile-')))
export const providerFixture = await startProviderFixture(compileProviderFixture(), profile)
setProviderOwner(providerFixture.owner())
providerFixture.child.unref()
for (const stream of [
  providerFixture.child.stdin,
  providerFixture.child.stdout,
  providerFixture.child.stderr
])
  stream.unref?.()
process.on('exit', () => {
  try {
    providerFixture.child.kill('SIGKILL')
  } catch {}
  rmSync(profile, { recursive: true, force: true })
})
