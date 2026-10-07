// A scripted `gh` for the S13 workflow fixtures: pull requests and repositories live in
// a JSON state file ($FAKE_GH_STATE); "GitHub" repositories are bare repositories next
// to it, and a squash merge is performed in the bare remote. Nothing leaves the machine.
// `state.faults` holds one-shot faults: pr-create-lost / pr-merge-lost / repo-create-lost
// perform the effect and then exit 1 (the reply lost on its way back); leak fails with
// credentials in its message (redaction); `unauthed`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const file = process.env.FAKE_GH_STATE
const state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
state.prs ??= []; state.faults ??= []; state.counts ??= {}; state.calls ??= []
const save = () => { if (file) writeFileSync(file, JSON.stringify(state, null, 2)) }
const args = process.argv.slice(2)
state.calls.push(args.slice(0, 2).join(' '))
const count = name => { state.counts[name] = (state.counts[name] ?? 0) + 1 }
const fault = name => { const at = state.faults.indexOf(name); if (at < 0) return false; state.faults.splice(at, 1); return true }
const env = { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@example.com' }
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const fail = message => { save(); process.stderr.write(`${message}\n`); process.exit(1) }
const done = (out = '') => { save(); if (out) process.stdout.write(`${out}\n`); process.exit(0) }
const origin = () => git(process.cwd(), 'remote', 'get-url', 'origin').replace(/^file:\/\//, '')
const repoDir = slug => join(dirname(file), 'repos', `${slug}.git`)
const repoUrl = slug => `file://${join(dirname(file), 'repos', slug)}`
const find = selector => /^\d+$/.test(selector ?? '')
  ? state.prs.find(pr => pr.number === Number(selector))
  : state.prs.filter(pr => pr.head === selector).sort((a, b) => (a.state === 'OPEN' ? -1 : 0) - (b.state === 'OPEN' ? -1 : 0) || b.number - a.number)[0]
const select = (pr, fields, query) => {
  if (query === '.url') return pr.url
  if (query === '.state') return pr.state
  return JSON.stringify(Object.fromEntries(fields.split(',').map(key => [key, pr[key]])))
}

const [group, action] = args
if (group === '--version') done('gh version 2.99.0 (fake)')
if (group === 'auth' && action === 'status') { if (state.unauthed) fail('You are not logged into any GitHub hosts.'); done('Logged in (fake)') }

if (group === 'pr' && action === 'create') {
  if (fault('leak')) fail("remote: Invalid username or password.\nfatal: Authentication failed for 'https://x-access-token:s3cret-token@github.com/o/r.git' (token ghs_ABCDEFGHIJKLMNOPQRSTUV)")
  const head = flag('--head') ?? git(process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD')
  const base = flag('--base') ?? 'main'
  const remote = origin()
  if (!git(remote, 'for-each-ref', `refs/heads/${head}`)) fail(`pull request create failed: head branch "${head}" has not been pushed`)
  const open = state.prs.find(pr => pr.head === head && pr.state === 'OPEN')
  if (open) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${open.url}`)
  const number = state.prs.length + 1
  const pr = { number, head, base, title: flag('--title'), body: flag('--body'), state: 'OPEN', url: `https://github.com/fake/repo/pull/${number}`, remote }
  state.prs.push(pr); count('prCreate')
  if (fault('pr-create-lost')) fail('HTTP 502: Bad Gateway (https://api.github.com/graphql)')
  done(`Creating pull request for ${head} into ${base}\n\n${pr.url}`)
}
if (group === 'pr' && action === 'view') {
  const pr = find(args[2])
  if (!pr) fail(`no pull requests found for branch "${args[2]}"`)
  done(select(pr, flag('--json') ?? 'url', flag('-q')))
}
if (group === 'pr' && action === 'edit') {
  const pr = find(args[2])
  if (!pr || pr.state !== 'OPEN') fail('no open pull request')
  pr.title = flag('--title'); pr.body = flag('--body'); count('prEdit')
  done(pr.url)
}
if (group === 'pr' && action === 'merge') {
  const pr = find(args[2])
  if (!pr || pr.state !== 'OPEN') fail(`Pull request ${args[2]} is not mergeable: it is ${pr?.state ?? 'missing'}`)
  const tree = git(pr.remote, 'merge-tree', '--write-tree', `refs/heads/${pr.base}`, `refs/heads/${pr.head}`)
  const commit = git(pr.remote, 'commit-tree', tree.split('\n')[0], '-p', `refs/heads/${pr.base}`, '-m', flag('--subject') ?? pr.title)
  git(pr.remote, 'update-ref', `refs/heads/${pr.base}`, commit)
  if (args.includes('--delete-branch')) {
    // Like the real gh: the local checkout moves to the base (fast-forward pull) and the
    // head branch is force-deleted locally, then on GitHub.
    const cwd = process.cwd()
    if (git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') === pr.head) {
      git(cwd, 'checkout', pr.base)
      try { git(cwd, 'pull', '--ff-only', 'origin', pr.base) } catch {}
    }
    try { git(cwd, 'branch', '-D', pr.head); count('deleteLocalBranch') } catch {}
    git(pr.remote, 'update-ref', '-d', `refs/heads/${pr.head}`)
  }
  pr.state = 'MERGED'; pr.mergeSubject = flag('--subject'); count('prMerge')
  if (fault('pr-merge-lost')) fail('HTTP 504: Gateway Timeout')
  done(`Squashed and merged pull request #${pr.number}`)
}
if (group === 'repo' && action === 'create') {
  const slug = args[2], dir = repoDir(slug)
  if (existsSync(dir)) fail(`GraphQL: Name already exists on this account (createRepository)`)
  mkdirSync(dirname(dir), { recursive: true })
  git(dirname(dir), 'init', '--bare', '--initial-branch=main', dir)
  count('repoCreate')
  if (args.includes('--remote')) git(process.cwd(), 'remote', 'add', flag('--remote'), `${repoUrl(slug)}.git`)
  if (fault('repo-create-lost')) fail('HTTP 502: Bad Gateway')
  done(`✓ Created repository ${slug} on GitHub`)
}
if (group === 'repo' && action === 'view') {
  if (!existsSync(repoDir(args[2]))) fail(`GraphQL: Could not resolve to a Repository with the name '${args[2]}'.`)
  done(repoUrl(args[2]))
}
if (group === 'repo' && action === 'edit') {
  const branch = flag('--default-branch')
  if (branch) git(repoDir(args[2]), 'symbolic-ref', 'HEAD', `refs/heads/${branch}`)
  done()
}
// Issues (S15 feedback): `issue-create-lost` files the issue and then exits 1, like a reply lost after the effect.
state.issues ??= []
if (group === 'issue' && action === 'create') {
  if (state.unauthed) fail('To get started with GitHub CLI, please run:  gh auth login')
  if (fault('issue-create-fail')) fail('HTTP 500: Server Error (https://api.github.com/graphql)')
  const number = state.issues.length + 1
  const issue = { number, title: flag('--title'), body: flag('--body'), url: `https://github.com/fake/repo/issues/${number}` }
  state.issues.push(issue); count('issueCreate')
  if (fault('issue-create-lost')) fail('HTTP 502: Bad Gateway (https://api.github.com/graphql)')
  done(`\nCreating issue in fake/repo\n\n${issue.url}`)
}
if (group === 'issue' && action === 'list') {
  done(JSON.stringify(state.issues.slice().reverse().slice(0, Number(flag('--limit') ?? 30)).map(({ title, body, url }) => ({ title, body, url }))))
}
fail(`fake gh: unsupported command: ${args.join(' ')}`)
