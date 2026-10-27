import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LKM-366: the temp Git project the `changes-panel` smoke (`smoke-changes-panel.ts`) lists,
 * and the Git state viewing it must keep. Pure, so `test/native-changes-fixture.mjs` checks
 * the same project against the real `branchDiff` and `openDiff` without a desktop.
 */
export const lines = (prefix: string, count: number) =>
  `${Array.from({ length: count }, (_, i) => `${prefix} line ${i + 1}`).join('\n')}\n`

// Git for the fixture only, with its own identity and no user/system config.
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@local', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim()

/** A project on `feature`, branched from `main`: committed edits, a rename, a delete
 *  and a binary file, then one staged, one unstaged and one untracked change. */
export function writeChangesProject(project: string) {
  rmSync(project, { recursive: true, force: true })
  mkdirSync(project, { recursive: true })
  const write = (file: string, text: string | Buffer) => writeFileSync(join(project, file), text)
  write('index.html', '<h1 id="changes-project">Changes project</h1>\n')
  write('app.css', lines('.app', 10))
  write('old-name.txt', lines('renamed', 6))
  write('remove-me.txt', lines('removed', 4))
  write('staged.txt', lines('staged', 5))
  write('unstaged.txt', lines('unstaged', 5))
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'add', '-A')
  git(project, 'commit', '-qm', 'Base')
  git(project, 'checkout', '-q', '-b', 'feature')
  const app = lines('.app', 10).split('\n')
  app[4] = '.app line 5 { changed }'
  app[5] = '.app line 6 { changed }'
  write('app.css', app.join('\n'))
  write('feature.css', lines('.feature', 3))
  write('logo.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 4]))
  git(project, 'mv', 'old-name.txt', 'new-name.txt')
  git(project, 'rm', '-q', 'remove-me.txt')
  git(project, 'add', '-A')
  git(project, 'commit', '-qm', 'Feature')
  const staged = lines('staged', 5).split('\n')
  staged[2] = 'staged line 3 (staged)'
  write('staged.txt', staged.join('\n'))
  git(project, 'add', 'staged.txt')
  const unstaged = lines('unstaged', 5).split('\n')
  unstaged[3] = 'unstaged line 4 (unstaged)'
  write('unstaged.txt', unstaged.join('\n'))
  write('untracked.txt', lines('untracked', 3))
}

/** The rows the Changes list shows for that project, per section, as
 *  `status title added removed` sorted (SourceDiffList's row text). */
export const CHANGES_ROWS = {
  committed: [
    'A feature.css +3 −0',
    'A logo.bin binary ',
    'D remove-me.txt +0 −4',
    'M app.css +2 −2',
    'R old-name.txt → new-name.txt +0 −0'
  ],
  staged: ['M staged.txt +1 −1'],
  unstaged: ['M unstaged.txt +1 −1'],
  untracked: ['U untracked.txt +3 −0']
}

/** What viewing must not change: HEAD, the branches, the index entries and every work-tree
 *  file (top-level dot folders aside: `.git` itself and Trezi's own sidecars). Read with
 *  `--no-optional-locks`, so taking it never refreshes the index. */
export function gitState(project: string) {
  const read = (...args: string[]) => git(project, '--no-optional-locks', ...args)
  const files: Record<string, string> = {}
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!rel && entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const name = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path, name)
      else files[name] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(project, '')
  return {
    head: read('symbolic-ref', 'HEAD'),
    headSha: read('rev-parse', 'HEAD'),
    branches: read(
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads/main',
      'refs/heads/feature'
    ),
    index: read('ls-files', '--stage'),
    files
  }
}
