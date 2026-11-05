import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appInfoPlist, serviceInfoPlist } from '../scripts/service-info.mjs'
import { NativeSheetController } from '../src/native/sheets-runtime.ts'
import { NativeUpdateController, verifyUpdatedArtifact } from '../src/native/update-controller.ts'
import { updatePhaseStatus } from '../src/native/workflow-service.ts'

const verbose =
  'bun run build:native\nCompiler diagnostic: /private/source/file.swift:99\nSigning output'
for (const [steps, expected] of [
  [[{ name: 'pull', state: 'intent' }], 'Downloading changes…'],
  [
    [
      { name: 'pull', state: 'done' },
      { name: 'install', state: 'intent' }
    ],
    'Installing dependencies…'
  ],
  [
    [
      { name: 'pull', state: 'done' },
      { name: 'install', state: 'done' },
      { name: 'build', state: 'intent' }
    ],
    'Building Trezi…'
  ],
  [[{ name: 'pull', state: 'done' }], 'Preparing update…']
]) {
  const displayed = updatePhaseStatus({
    kind: 'update',
    state: 'running',
    steps,
    progress: verbose
  })
  assert.equal(displayed, expected)
  assert.doesNotMatch(displayed, /Compiler|Signing|bun run/)
}

const sheets = new NativeSheetController({ send() {} }, {}, {}, async () => {})
let answer = { ok: true },
  blocked = null,
  restarts = 0
const calls = []
// The workflow owner's update (WorkflowSetup.swift): it refuses local changes itself.
const owner = {
  updateCheck: async (root) => {
    calls.push(['check', root])
    return { status: 'available', behind: 1, subject: 'Fixture update' }
  },
  update: async (root, progress) => {
    calls.push(['update', root])
    progress('pulling')
    return answer
  }
}
const update = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  owner,
  () => blocked,
  () => null
)
const action = async (name) =>
  sheets.action({ id: sheets.current.state.id, action: name, values: {} })
await update.open()
await action('check')
assert.ok(sheets.current.state.actions.some((a) => a.id === 'apply'))
assert.match(sheets.current.state.detail, /1 new change available/)
answer = {
  ok: false,
  error: 'Your Trezi installation has local changes. Commit or stash them before updating.'
}
await action('apply')
assert.match(sheets.current.state.detail, /local changes/)
assert.equal(restarts, 0)
blocked = 'Save source drafts'
await action('retry')
assert.match(sheets.current.state.detail, /Save source drafts/)
assert.equal(
  calls.filter((c) => c[0] === 'update').length,
  1,
  'a blocked restart never starts the update'
)
blocked = null
answer = { ok: true }
await action('retry')
assert.equal(restarts, 1)
assert.deepEqual(calls, [
  ['check', '/fixture'],
  ['update', '/fixture'],
  ['update', '/fixture']
])
let checks = 0
const changingDraft = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  owner,
  () => (++checks === 1 ? null : 'New unsaved content draft'),
  () => null
)
await changingDraft.apply()
assert.equal(restarts, 1)
assert.equal(sheets.current.state.title, 'Update could not finish')
assert.match(sheets.current.state.detail, /New unsaved content draft/)
let proofRestarted = false
const invalidArtifact = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    proofRestarted = true
  },
  owner,
  () => null,
  () => 'The built application does not match the updated version and commit.'
)
await invalidArtifact.apply()
assert.equal(proofRestarted, false, 'an unproved build cannot restart')
assert.match(sheets.current.state.detail, /does not match/)
let releaseUpdate
let started = 0
const pending = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  {
    updateCheck: owner.updateCheck,
    update: async (_root, progress) => {
      started++
      progress(
        updatePhaseStatus({
          kind: 'update',
          state: 'running',
          steps: [
            { name: 'pull', state: 'done' },
            { name: 'install', state: 'done' },
            { name: 'build', state: 'intent' }
          ],
          progress: verbose
        })
      )
      return new Promise((resolve) => {
        releaseUpdate = resolve
      })
    }
  },
  () => null,
  () => null
)
const first = pending.apply()
assert.equal(sheets.current.state.title, 'Updating Trezi')
assert.equal(sheets.current.state.message, 'Building Trezi…')
assert.doesNotMatch(sheets.current.state.message, /Compiler|Signing|bun run/)
await pending.apply()
assert.equal(started, 1, 'duplicate Update cannot start another owner workflow')
releaseUpdate({ ok: true })
await first
assert.equal(restarts, 2)
const current = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  { updateCheck: async () => ({ status: 'idle', behind: 0 }), update: owner.update },
  () => null,
  () => null
)
current.open()
await action('check')
assert.equal(sheets.current.state.title, 'No update found')
assert.deepEqual(
  sheets.current.state.actions.map((entry) => entry.id),
  ['cancel']
)
const failedCheck = new NativeUpdateController(
  sheets,
  '/fixture',
  () => {
    restarts++
  },
  {
    updateCheck: async () => ({ status: 'error', behind: 0, error: 'Network unavailable' }),
    update: owner.update
  },
  () => null,
  () => null
)
failedCheck.open()
await action('check')
assert.match(sheets.current.state.detail, /Network unavailable/)
assert.equal(restarts, 2)
await action('retry')
assert.equal(sheets.current.state.title, 'Trezi updates', 'check retry returns to the check action')

// Real artifact proof in an isolated source checkout; no installed app or signing is touched.
const source = mkdtempSync(join(tmpdir(), 'trezi-update-proof-'))
try {
  const git = (...args) => {
    const result = spawnSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: source,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
      }
    )
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git(
    '-c',
    'user.name=Trezi Test',
    '-c',
    'user.email=test@trezi.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture'
  )
  const info = {
    version: '0.13.24',
    build: git('rev-list', '--count', 'HEAD'),
    commit: git('rev-parse', '--short=7', 'HEAD')
  }
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: info.version }))
  const contents = join(source, 'out/native/Trezi.app/Contents')
  const service = join(contents, 'XPCServices/dev.trezi.service.xpc/Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(service, 'MacOS'), { recursive: true })
  const hostPlist = join(contents, 'Info.plist')
  const servicePlist = join(service, 'Info.plist')
  const hostExe = join(contents, 'MacOS/TreziHost')
  const serviceExe = join(service, 'MacOS/TreziService')
  writeFileSync(hostPlist, appInfoPlist(info))
  writeFileSync(servicePlist, serviceInfoPlist(info))
  writeFileSync(hostExe, 'fixture')
  writeFileSync(serviceExe, 'fixture')
  assert.equal(verifyUpdatedArtifact(source), null, 'matching source and both app bundles pass')
  let artifactRestarts = 0
  const proofSheets = new NativeSheetController({ send() {} }, {}, {}, async () => {})
  const proofUpdate = new NativeUpdateController(
    proofSheets,
    source,
    () => {
      artifactRestarts++
    },
    { updateCheck: owner.updateCheck, update: async () => ({ ok: true }) },
    () => null
  )
  await proofUpdate.apply()
  assert.equal(artifactRestarts, 1, 'matching artifact reaches restart callback')
  writeFileSync(servicePlist, readFileSync(servicePlist, 'utf8').replace(info.version, '0.0.0'))
  assert.match(verifyUpdatedArtifact(source), /does not match/)
  await proofUpdate.apply()
  assert.equal(artifactRestarts, 1, 'mismatched service stamp blocks restart')
  assert.match(proofSheets.current.state.detail, /does not match/)
  writeFileSync(servicePlist, serviceInfoPlist(info))
  rmSync(serviceExe)
  assert.match(verifyUpdatedArtifact(source), /incomplete/)
  await proofUpdate.apply()
  assert.equal(artifactRestarts, 1, 'missing service executable blocks restart')
  assert.match(proofSheets.current.state.detail, /incomplete/)
} finally {
  rmSync(source, { recursive: true, force: true })
}
console.log('Native updates: owner-run update, draft guards, failure recovery and restart passed')
