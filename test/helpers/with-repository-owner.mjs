// Import first in a suite whose code paths take the repository lane or make Git effects:
// installs the real Swift repository owner (the only one since LKM-111 removed the Bun
// fallback) on a scratch profile. Worktrees may live anywhere under the temp dir. The
// suite decides when the process ends; the fixture never holds it open.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setRepositoryOwner } from '../../src/main/repository-owner.ts'
import { compileRepositoryFixture, startRepositoryFixture } from './repository-fixture.mjs'

const profile = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-repository-profile-')))
export const repositoryFixture = await startRepositoryFixture(compileRepositoryFixture(), profile, {
  REPOSITORY_WORKTREES_ROOT: realpathSync(tmpdir())
})
setRepositoryOwner(repositoryFixture.owner())
repositoryFixture.child.unref()
for (const stream of [
  repositoryFixture.child.stdin,
  repositoryFixture.child.stdout,
  repositoryFixture.child.stderr
])
  stream.unref?.()
process.on('exit', () => {
  try {
    repositoryFixture.child.kill('SIGKILL')
  } catch {}
  rmSync(profile, { recursive: true, force: true })
})
