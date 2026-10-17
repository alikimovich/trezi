// LKM-255 operator tool: one live Publish in PR-only mode through the real service code
// (src/service/WorkflowPublish.swift in the workflow-owner fixture, driven by Bun's
// serviceWorkflows client, as the app does). It pushes the clone's checked-out test
// branch with the real `git` and opens one PR with the real `gh`: run it on the host,
// never in CI. On a local test branch cut from origin's default branch it makes one
// throwaway commit by Trezi <trezi@local> (a tiny non-rendering file), so Publish has a
// real change, creates the remote branch itself and appends the user-identity commit.
// It refuses the default branch, an unexpected origin, a test branch already on origin
// and a missing or internal Git identity. It changes no config.
//
//   bun scripts/live-publish-attribution.mjs <clone> --origin alikimovich/lkmv.ch \
//     --confirm <branch> [--title '[TEST – DO NOT MERGE] LKM-255 Publish attribution check']
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compileWorkflowFixture, startWorkflowFixture } from '../test/helpers/workflow-fixture.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}
const fail = (message) => {
  console.error(`live-publish-attribution: ${message}`)
  process.exit(1)
}
const clone =
  args[0] && !args[0].startsWith('--')
    ? resolve(args[0])
    : fail('usage: <clone> --origin <owner/repo> --confirm <branch>')
const slug = flag('--origin') ?? fail('--origin <owner/repo> is required')
const title = flag('--title') ?? '[TEST – DO NOT MERGE] LKM-255 Publish attribution check'
const git = (...rest) =>
  execFileSync('git', rest, {
    cwd: clone,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
const maybe = (...rest) => {
  try {
    return git(...rest)
  } catch {
    return ''
  }
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const base =
  maybe('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '') || 'main'
if (['HEAD', 'main', 'master', base].includes(branch)) fail(`refusing to publish from ${branch}`)
if (flag('--confirm') !== branch) fail(`pass --confirm ${branch} to publish this branch`)
const origin = git('remote', 'get-url', 'origin')
const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
if (!new RegExp(`(^|[:/])${escaped}(\\.git)?/?$`).test(origin))
  fail(`origin ${origin} is not ${slug}`)
const name = maybe('config', '--get', 'user.name')
const email = maybe('config', '--get', 'user.email')
if (!name || !email || email.toLowerCase() === 'trezi@local')
  fail('set the user Git identity first')
if (git('status', '--porcelain')) fail('the clone has uncommitted changes')
// Nothing reaches GitHub except through Publish: the test branch must not exist on origin,
// and its only local work is one throwaway commit by Trezi <trezi@local> (no website file).
if (maybe('ls-remote', 'origin', `refs/heads/${branch}`)) fail(`origin already has ${branch}`)
const throwaway = '.trezi-publish-verify.txt'
const internal = {
  GIT_AUTHOR_NAME: 'Trezi',
  GIT_AUTHOR_EMAIL: 'trezi@local',
  GIT_COMMITTER_NAME: 'Trezi',
  GIT_COMMITTER_EMAIL: 'trezi@local'
}
const baseRef = `refs/remotes/origin/${base}`
const ahead = maybe('rev-list', `${baseRef}..HEAD`).split('\n').filter(Boolean)
const onlyThrowaway = (sha) =>
  git('show', '--format=', '--name-only', sha) === throwaway &&
  git('show', '-s', '--format=%ae', sha).toLowerCase() === 'trezi@local'
if (ahead.length === 0) {
  writeFileSync(
    join(clone, throwaway),
    `LKM-255 Publish attribution check ${new Date().toISOString()}\n`
  )
  git('add', '--', throwaway)
  execFileSync('git', ['commit', '-q', '-m', 'LKM-255 throwaway Publish check'], {
    cwd: clone,
    env: { ...process.env, ...internal },
    stdio: ['ignore', 'pipe', 'pipe']
  })
} else if (ahead.length !== 1 || !onlyThrowaway(ahead[0])) {
  fail(`${branch} must be ${base} plus at most the throwaway commit; found ${ahead.length} commits`)
}

const before = git('rev-parse', 'HEAD')
const profile = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-live-publish-')))
const fixture = await startWorkflowFixture(compileWorkflowFixture(), profile)
let result
try {
  result = await fixture.workflows().publish(clone, 'pr', async (from) => ({
    title,
    body: `LKM-255 live check of the LKM-251 publication commit against ${from}. Do not merge; this PR is closed after the Preview evidence is captured.`
  }))
} finally {
  await fixture.stop()
  rmSync(profile, { recursive: true, force: true })
}
const head = git('rev-parse', 'HEAD')
const remote = maybe('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]
const show = (sha) => git('show', '-s', '--format=%H%n%an <%ae>%n%cn <%ce>%n%s', sha).split('\n')
console.log(
  JSON.stringify(
    {
      result,
      branch,
      base,
      automatedTip: before,
      finalLocal: head,
      finalRemote: remote,
      remoteBase: maybe('ls-remote', 'origin', `refs/heads/${base}`).split(/\s/)[0],
      final: show(head),
      parent: show(`${head}^`)
    },
    null,
    2
  )
)
process.exit(result?.ok && remote === head ? 0 : 1)
