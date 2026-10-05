// LKM-144 rebuild loop for the Keychain helper (`src/native/Secrets.swift`, built as
// Helpers/TreziSecrets): does a Keychain approval survive a rebuild?
// - deterministic: two builds from different folders, with the build's own swiftc flags,
//   are byte-identical, so the signed helper keeps its code hash (what a `cdhash:`
//   partition and a code-hash access list name);
// - rebuild-read: on a temporary keychain, the item one build creates is read by the
//   rebuild with no prompt, and changed code is refused (it would need an approval).
// The helper always runs with `--keychain` (no UI: a would-be prompt is exit 1). Only
// temporary keychains made with a password are used: no login keychain, no search list
// or default keychain change, no `security` call that can ask anything. The same loop
// with "Trezi Local" on the login keychain is an operator step (docs/PROVIDERS.md,
// LKM-144). Where no keychain can be created (a sandbox) that part prints SKIP.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_MACOS } from '../scripts/requirements.mjs'
import { sign } from '../scripts/signing.mjs'
import { swiftCompile } from './helpers/swift-build.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'src/native/Secrets.swift')
const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx${MIN_MACOS}`
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-keychain-rebuild-')))
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const keychain = join(scratch, 'rebuild.keychain-db')
let created = false

// The same swiftc invocation as scripts/build-native.mjs, from a folder of its own.
// Never the binary cache (each build must really happen); the shared module cache
// keeps the three builds warm (LKM-167).
const build = (name, from = source) => {
  const dir = join(scratch, name)
  mkdirSync(dir)
  const out = join(dir, 'TreziSecrets')
  const built = swiftCompile(
    [
      '-O',
      '-target',
      target,
      '-suppress-warnings',
      from,
      '-framework',
      'Security',
      '-framework',
      'CryptoKit'
    ],
    out,
    { cwd: dir, timeout: 300_000 }
  )
  assert.equal(built.status, 0, built.stderr)
  return out
}
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const cdhash = (path) =>
  /CDHash=([0-9a-f]{40})/.exec(run('/usr/bin/codesign', ['-dvvv', path]).stderr)?.[1]
const copy = (from, name) => {
  const path = join(scratch, name)
  copyFileSync(from, path)
  return path
}
const crypto = (helper, operation, input) => {
  const result = spawnSync(helper, ['--crypto', operation, '--keychain', keychain], {
    input,
    timeout: 20_000
  })
  return { status: result.status, out: result.stdout }
}

try {
  const first = build('first')
  const second = build('second build') // another folder, with a space in it
  const changedSource = join(scratch, 'Secrets.swift')
  writeFileSync(
    changedSource,
    readFileSync(source, 'utf8').replace('usage: TreziSecrets', 'usage: TreziSecrets (changed)')
  )
  const changed = build('changed', changedSource)
  assert.equal(sha(second), sha(first), 'a rebuild from another folder is byte-identical')
  assert.notEqual(sha(changed), sha(first), 'the control build differs')
  for (const path of [first, second, changed])
    sign({ kind: 'adhoc' }, path, 'dev.trezi.secrets', run)
  assert.ok(cdhash(first), 'the helper has a code hash')
  assert.equal(cdhash(second), cdhash(first), 'a rebuild keeps the code hash')
  assert.notEqual(cdhash(changed), cdhash(first))
  console.log(`KEYCHAIN-REBUILD deterministic PASS (${cdhash(first)})`)

  // A password keeps create/unlock from ever asking; a hung security agent is bounded.
  const made = run('/usr/bin/security', ['create-keychain', '-p', 'trezi-test', keychain])
  if (made.status !== 0) {
    const reason = (
      made.stderr ||
      made.stdout ||
      (made.status === null ? 'timed out' : `exit ${made.status}`)
    ).trim()
    console.log(`KEYCHAIN-REBUILD rebuild-read SKIP (no temporary keychain here: ${reason})`)
  } else {
    created = true
    assert.equal(
      run('/usr/bin/security', ['unlock-keychain', '-p', 'trezi-test', keychain]).status,
      0
    )
    // build → write → rebuild (another folder) → read, never a prompt; changed code is refused.
    const sealed = crypto(copy(first, 'installed'), 'encrypt', Buffer.from('sk-rebuild'))
    assert.equal(sealed.status, 0)
    assert.equal(
      crypto(second, 'decrypt', sealed.out).out.toString('utf8'),
      'sk-rebuild',
      'the rebuild reads with no prompt'
    )
    assert.equal(
      crypto(second, 'decrypt', sealed.out).out.toString('utf8'),
      'sk-rebuild',
      'and again'
    )
    assert.equal(
      crypto(changed, 'decrypt', sealed.out).status,
      1,
      'changed code would need an approval'
    )
    console.log('KEYCHAIN-REBUILD rebuild-read PASS')
  }
  console.log('KEYCHAIN-REBUILD OK')
} finally {
  if (created) run('/usr/bin/security', ['delete-keychain', keychain])
  rmSync(scratch, { recursive: true, force: true })
}
