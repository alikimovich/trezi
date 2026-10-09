import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUMPS, bumpVersion, releaseChangelog, setPackageVersion } from './version.mjs'

/**
 * `bun run release <major|minor|patch>` (LKM-143): on main with a clean tree, bumps
 * package.json, moves CHANGELOG.md's Unreleased entries into a dated version section
 * under a fresh Unreleased, commits "Release vX.Y.Z" and creates the annotated tag
 * vX.Y.Z. It never pushes; it prints the push command. Runs in the repository of the
 * current directory.
 */
const fail = message => { console.error(`release: ${message}`); process.exit(1) }
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' })
const must = (...args) => {
  const result = git(...args)
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

const part = process.argv[2]
if (!BUMPS.includes(part) || process.argv.length > 3) fail(`usage: bun run release <${BUMPS.join('|')}>`)
const root = must('rev-parse', '--show-toplevel')
process.chdir(root)
// `symbolic-ref --quiet` exits 1, silently, only for a detached HEAD. Any other result
// (git failed, was killed or never ran) is reported as itself, never as "detached" (LKM-209).
const head = git('symbolic-ref', '--quiet', '--short', 'HEAD')
const branch = head.status === 0 ? (head.stdout ?? '').trim() : ''
if (head.status !== 1 && !branch) fail(`git symbolic-ref HEAD failed (status ${head.status ?? head.signal}): ${(head.error?.message ?? head.stderr ?? '').trim() || 'no output'}`)
if (branch !== 'main') fail(`releases are cut from main; this is ${branch ? `branch ${branch}` : 'a detached HEAD'}.`)
const dirty = must('status', '--porcelain', '--untracked-files=all')
if (dirty) fail(`the working tree is not clean; commit or remove these first:\n${dirty}`)

const packagePath = join(root, 'package.json'), changelogPath = join(root, 'CHANGELOG.md')
const packageText = readFileSync(packagePath, 'utf8')
let version, changelog
try {
  version = bumpVersion(JSON.parse(packageText).version, part)
  changelog = releaseChangelog(readFileSync(changelogPath, 'utf8'), version, localDate(new Date()))
} catch (error) { fail(error.message) }
const tag = `v${version}`
if (git('rev-parse', '--quiet', '--verify', `refs/tags/${tag}`).status === 0) fail(`tag ${tag} already exists.`)

writeFileSync(packagePath, setPackageVersion(packageText, version))
writeFileSync(changelogPath, changelog)
must('add', '--', 'package.json', 'CHANGELOG.md')
must('commit', '--quiet', '-m', `Release ${tag}`)
must('tag', '--annotate', tag, '-m', `Trezi ${version}`)
console.log(`Released Trezi ${version}: committed "Release ${tag}" and tagged ${tag}. Nothing was pushed.`)
console.log(`Push it with: git push origin main ${tag}`)

function localDate(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
