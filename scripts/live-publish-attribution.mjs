// LKM-255 operator tool: one live Publish in PR-only mode through the real service code
// (src/service/WorkflowPublish.swift in the workflow-owner fixture, driven by Bun's
// serviceWorkflows client, as the app does). It pushes the clone's checked-out test
// branch with the real `git` and opens one PR with the real `gh`: run it on the host,
// never in CI. It refuses the default branch, an unexpected origin, a tip that is not
// authored by trezi@local, and a missing or internal Git identity. It changes no config.
//
//   bun scripts/live-publish-attribution.mjs <clone> --origin alikimovich/lkmv.ch \
//     --confirm <branch> [--title '[TEST – DO NOT MERGE] LKM-255 Publish attribution check']
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
const tipAuthor = git('show', '-s', '--format=%ae', 'HEAD')
if (tipAuthor.toLowerCase() !== 'trezi@local')
  fail(`the tip is authored by ${tipAuthor}, not trezi@local`)
const name = maybe('config', '--get', 'user.name')
const email = maybe('config', '--get', 'user.email')
if (!name || !email || email.toLowerCase() === 'trezi@local')
  fail('set the user Git identity first')
if (git('status', '--porcelain')) fail('the clone has uncommitted changes')
// Publish refuses a branch whose content equals the base unless its remote branch exists
// at another commit, so an empty automated tip needs the test branch seeded on origin.
const seeded = maybe('ls-remote', 'origin', `refs/heads/${branch}`)
if (
  !seeded &&
  maybe('rev-parse', 'HEAD^{tree}') === maybe('rev-parse', `refs/remotes/origin/${base}^{tree}`)
)
  fail(`origin has no ${branch} and HEAD has no content change; seed it at origin/${base} first`)

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
      final: show(head),
      parent: show(`${head}^`)
    },
    null,
    2
  )
)
process.exit(result?.ok && remote === head ? 0 : 1)
