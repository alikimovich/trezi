// LKM-364: the editor's read-only Changes list renders the real `branchDiff` of temp
// repositories: labelled base and sections, +/- counts, rename/delete/binary rows, clicks
// that open the editor, Refresh as its only control, and no rows kept across projects.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchDiff } from '../src/main/branch-diff.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('NATIVE-DIFF-LIST SKIP — macOS Swift toolchain required')
} else {
  const temp = mkdtempSync(join(tmpdir(), 'trezi-diff-list-'))
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Trezi Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Trezi Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid'
  }
  try {
    writeFileSync(env.GIT_CONFIG_GLOBAL, '')
    const project = (name) => {
      const dir = join(temp, name)
      mkdirSync(dir)
      const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim()
      const write = (file, text) => writeFileSync(join(dir, file), text)
      return { dir, git, write }
    }
    const a = project('a')
    a.git('init', '-q', '-b', 'main')
    a.write('a.txt', 'one\ntwo\nthree\nfour\n')
    a.write('old.txt', 'kept\nkept\nkept\n')
    a.write('gone.txt', 'gone\n')
    a.write('b.txt', 'b\n')
    a.write('c.txt', 'c\n')
    a.git('add', '-A')
    a.git('commit', '-qm', 'base')
    const fork = a.git('rev-parse', '--short=7', 'HEAD')
    a.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    a.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    a.git('checkout', '-qb', 'feature')
    a.write('a.txt', 'one\ntwo\nTHREE\nthree b\nfour\n')
    a.git('mv', 'old.txt', 'new.txt')
    a.git('rm', '-q', 'gone.txt')
    writeFileSync(join(a.dir, 'img.bin'), Buffer.from([0, 1, 0, 2]))
    a.git('add', '-A')
    a.git('commit', '-qm', 'work')
    a.write('b.txt', 'b\nstaged\n')
    a.git('add', 'b.txt')
    a.write('c.txt', 'c changed\n')
    a.write('new-file.txt', '1\n2\n3\n')
    const b = project('b')
    b.git('init', '-q', '-b', 'trunk')
    b.write('t.txt', 't\n')
    b.git('add', '-A')
    b.git('commit', '-qm', 't')
    b.write('t.txt', 't\nu\n')
    const plain = join(temp, 'plain')
    mkdirSync(plain)
    const files = []
    for (const [name, root] of [
      ['a', a.dir],
      ['b', b.dir],
      ['plain', plain]
    ]) {
      const file = join(temp, `${name}.json`)
      writeFileSync(file, JSON.stringify(await branchDiff(root)))
      files.push(file)
    }
    const binary = swiftBuild('diff-list', [
      'test/fixtures/diff-list/main.swift',
      'src/native/SourceDiffList.swift'
    ])
    console.log(runFixture(binary, [...files, fork]).trim())
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
