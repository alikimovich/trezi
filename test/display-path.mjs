// The shared path formatter (src/shared/display-path.ts) and the surfaces that use it:
// collapsed paths in chat tool rows, the activity label, chat cards, Activity and the
// preview status, with the full text kept for expanded rows, Copy and tooltips.
import assert from 'node:assert/strict'
import { NativeActivityController } from '../src/native/activity-controller.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { newChat } from '../src/native/chat-state.ts'
import { displayContext, setDisplayProfile } from '../src/native/display-paths.ts'
import {
  CHAT_WORKSPACE,
  RECOVERY_COPY,
  shortPath,
  shortPaths,
  TEMPORARY_PATCH,
  TREZI_DATA
} from '../src/shared/display-path.ts'

const support = '/Users/me/Library/Application Support'
const profile = `${support}/Trezi Native`
const physical = `${support}/Praxis Native`
const project = '/Users/me/dev/shop'
const ctx = { projects: [project], profiles: [profile, physical, `${support}/Praxis`] }
const worktree = `${profile}/trezi/worktrees/3f9a1c2e`

// Paths on their own.
assert.equal(
  shortPath(`${worktree}/src/App.tsx`, ctx),
  'src/App.tsx',
  'worktree path → project-relative'
)
assert.equal(
  shortPath(`${physical}/praxis/worktrees/3f9a1c2e/src/App.tsx`, ctx),
  'src/App.tsx',
  'physical (legacy-named) worktree path'
)
assert.equal(
  shortPath(`${project}/src/components/Button.tsx`, ctx),
  'src/components/Button.tsx',
  'project path → relative'
)
assert.equal(shortPath(project, ctx), 'shop', 'the project root is its folder name')
assert.equal(
  shortPath(`${profile}/service/repository/scratch/apply-1b2c.patch`, ctx),
  TEMPORARY_PATCH
)
assert.equal(
  shortPath('refs/trezi/recovery/20260930-101500-land-abc123-def456-idle', ctx),
  RECOVERY_COPY
)
assert.equal(shortPath(worktree, ctx), CHAT_WORKSPACE, 'a worktree folder itself')
assert.equal(shortPath(`${worktree}/`, ctx), CHAT_WORKSPACE)
assert.equal(shortPath(`${profile}/trezi/sessions/abc.json`, ctx), TREZI_DATA)
assert.equal(shortPath(`${profile}/service/repository/journal.json`, ctx), TREZI_DATA)
assert.equal(
  shortPath(`${support}/Praxis/praxis/worktrees/df29a5cb/a.ts`, ctx),
  'a.ts',
  'Electron-era profile worktree'
)
assert.equal(
  shortPath('/usr/local/bin/node', ctx),
  '/usr/local/bin/node',
  'unknown paths unchanged'
)
assert.equal(
  shortPath('/Users/me/dev/shop-two/a.ts', ctx),
  '/Users/me/dev/shop-two/a.ts',
  'a sibling with a shared prefix is not the project'
)
assert.equal(shortPath('src/App.tsx', ctx), 'src/App.tsx', 'relative paths unchanged')

// Paths inside free text: each replaced whole, never cut mid-path.
assert.equal(shortPaths(`Edit ${worktree}/src/App.tsx`, ctx), 'Edit src/App.tsx')
assert.equal(
  shortPaths(`Read ${project}/README.md and ${worktree}/package.json.`, ctx),
  'Read README.md and package.json.'
)
assert.equal(
  shortPaths(`git apply ${profile}/service/repository/scratch/apply-1b2c.patch failed`, ctx),
  `git apply ${TEMPORARY_PATCH} failed`
)
assert.equal(
  shortPaths(
    'its work is kept at refs/trezi/recovery/20260930-101500-land-abc-def, refs/praxis/recovery/x.',
    ctx
  ),
  `its work is kept at ${RECOVERY_COPY}, ${RECOVERY_COPY}.`
)
assert.equal(
  shortPaths(`Bash: cd "${worktree}" && bun test`, ctx),
  `Bash: cd "${CHAT_WORKSPACE}" && bun test`
)
assert.equal(shortPaths(`error in ${project}/src/a.ts:12:4`, ctx), 'error in src/a.ts:12:4')
assert.equal(
  shortPaths('Run /usr/bin/git status', ctx),
  'Run /usr/bin/git status',
  'unknown text unchanged'
)
assert.equal(
  shortPaths(`/x${project}/a.ts`, ctx),
  `/x${project}/a.ts`,
  'a root inside a longer path is not matched'
)
for (const text of [
  `Edit ${worktree}/src/App.tsx`,
  `A damaged chat checkpoint was moved aside to ${profile}/trezi/checkpoints/a.json.`
])
  assert.ok(
    !shortPaths(text, ctx).includes(support),
    `no collapsed form shows a profile path: ${text}`
  )

// The native context: the running profile, its physical target and every earlier name beside it.
setDisplayProfile(profile)
const native = displayContext([project])
for (const name of ['Trezi Native', 'Praxis Native', 'Praxis', 'dsgn'])
  assert.ok(native.profiles.includes(`${support}/${name}`), name)
assert.ok(native.projects.includes(project))

// Chat surfaces: collapsed labels with the full text kept beside them.
const chat = newChat('chat-1')
chat.root = project
chat.isRunning = true
chat.phase = 'working'
chat.activityDetail = `Edit ${worktree}/src/App.tsx`
chat.messages = [
  {
    id: 'a',
    role: 'assistant',
    text: '',
    statuses: [chat.activityDetail],
    segments: [{ kind: 'tools', statuses: [chat.activityDetail, `Read ${project}/README.md`] }]
  }
]
chat.error = `Could not apply ${profile}/service/repository/scratch/apply-1b2c.patch`
chat.isolation = 'parked'
chat.isolationFiles = [`${worktree}/src/App.tsx`, 'src/b.ts']
const state = snapshot(chat, [])
const tools = state.messages[0].segments[0]
assert.deepEqual(tools.labels, ['Edit src/App.tsx', 'Read README.md'], 'collapsed tool rows')
assert.deepEqual(
  tools.statuses,
  [chat.activityDetail, `Read ${project}/README.md`],
  'expanded rows keep the full path'
)
assert.equal(chat.messages[0].segments[0].labels, undefined, 'the chat itself is not rewritten')
assert.equal(state.activity.label, 'Edit src/App.tsx')
assert.equal(state.activity.detail, chat.activityDetail, 'tooltip keeps the full path')
const error = state.cards.find((card) => card.id === 'error')
assert.equal(error.detail, `Could not apply ${TEMPORARY_PATCH}`)
assert.equal(error.fullDetail, chat.error, 'Copy keeps the full path')
const conflict = state.cards.find((card) => card.id === 'conflict')
assert.equal(conflict.detail, 'src/App.tsx\nsrc/b.ts')
assert.equal(conflict.fullDetail, chat.isolationFiles.join('\n'))
assert.equal(
  state.cards.find((card) => card.id === 'tokens'),
  undefined
)
const plain = snapshot(
  { ...chat, error: 'Plain failure', isolation: 'live', activityDetail: 'Thinking' },
  []
)
assert.equal(plain.cards[0].fullDetail, undefined, 'unchanged text carries no second copy')
assert.equal(plain.activity.detail, undefined)
assert.ok(
  !JSON.stringify([state.cards.map((c) => c.detail), state.activity.label, tools.labels]).includes(
    support
  ),
  'no collapsed chat surface shows an absolute profile path'
)

// Activity: shown collapsed, kept full for its tooltip and Copy All.
const sent = []
const activity = new NativeActivityController(
  (method, value) => sent.push([method, value]),
  (text) => shortPaths(text, ctx)
)
activity.append(
  `An earlier land in ${project} was interrupted; its work is kept at refs/trezi/recovery/2026-x.`,
  'error'
)
activity.render()
const [line] = sent.at(-1)[1].lines
assert.equal(
  line.display,
  `An earlier land in shop was interrupted; its work is kept at ${RECOVERY_COPY}.`
)
assert.ok(line.text.includes('refs/trezi/recovery/2026-x'), 'Copy All keeps the full text')
console.log(
  'DISPLAY PATH OK — worktree/project relative, internal labels, unknown unchanged, full text for expanded/copy'
)
