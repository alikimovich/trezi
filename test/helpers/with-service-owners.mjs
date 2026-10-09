// Import first in a suite that runs chats through agent.ts, writes chat History, or
// uses chat islands, project sidecars (controls, notes, tokens) or the project's
// other `.trezi/` files: installs the real Swift conversation,
// editing, repository and source owners (the only ones since LKM-111 removed the Bun
// twins) from one fixture process on a scratch profile (`serviceProfile`; History
// lives in `<profile>/trezi/sessions`). Worktrees may live anywhere under the temp
// dir. The suite decides when the process ends; the fixture never holds it open.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setConversationOwner } from '../../src/main/conversation-owner.ts'
import { setEditingOwner } from '../../src/main/editing-owner.ts'
import { setRepositoryOwner } from '../../src/main/repository-owner.ts'
import { setSourceOwner } from '../../src/main/source-owner.ts'
import { compileEditingFixture, startEditingFixture } from './editing-fixture.mjs'

export const serviceProfile = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-editing-profile-')))
export const serviceFixture = await startEditingFixture(compileEditingFixture(), serviceProfile, {
  REPOSITORY_WORKTREES_ROOT: realpathSync(tmpdir())
})
const { conversation, repository, source, editing } = serviceFixture.owners()
setConversationOwner(conversation)
setRepositoryOwner(repository)
setSourceOwner(source)
setEditingOwner(editing)
serviceFixture.child.unref()
for (const stream of [
  serviceFixture.child.stdin,
  serviceFixture.child.stdout,
  serviceFixture.child.stderr
])
  stream.unref?.()
process.on('exit', () => {
  try {
    serviceFixture.child.kill('SIGKILL')
  } catch {}
  rmSync(serviceProfile, { recursive: true, force: true })
})
