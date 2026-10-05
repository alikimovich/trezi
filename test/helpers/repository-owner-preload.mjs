// Preload for the Git suite runs in test/repository-owner.mjs: installs the real Swift
// repository owner, with the editing, source and conversation owners it works with
// (editing fixture binary REPOSITORY_FIXTURE, profile REPOSITORY_PROFILE), before a
// Git suite runs, so the suite's own assertions exercise the Swift effects through the
// unchanged TS entry points. Worktrees may live anywhere under the temp dir there.
// Prints how many repository frames the suite sent.
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setConversationOwner } from '../../src/main/conversation-owner.ts'
import { setEditingOwner } from '../../src/main/editing-owner.ts'
import { setRepositoryOwner } from '../../src/main/repository-owner.ts'
import { setSourceOwner } from '../../src/main/source-owner.ts'
import { startEditingFixture } from './editing-fixture.mjs'

const fixture = await startEditingFixture(
  process.env.REPOSITORY_FIXTURE,
  realpathSync(process.env.REPOSITORY_PROFILE),
  { REPOSITORY_WORKTREES_ROOT: realpathSync(tmpdir()) }
)
const send = fixture.link.sendService
let frames = 0
fixture.link.sendService = (frame) => {
  if (frame.service === 'repository') frames++
  send(frame)
}
const { conversation, repository, source, editing } = fixture.owners()
setConversationOwner(conversation)
setRepositoryOwner(repository)
setSourceOwner(source)
setEditingOwner(editing)
// The suite decides when the process ends; the fixture never holds it open.
fixture.child.unref()
for (const stream of [fixture.child.stdin, fixture.child.stdout, fixture.child.stderr])
  stream.unref?.()
process.on('exit', () => {
  console.log(`REPOSITORY-PARITY frames=${frames}`)
  try {
    fixture.child.kill('SIGKILL')
  } catch {}
})
