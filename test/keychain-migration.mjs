// LKM-137 Keychain helper (`src/native/Secrets.swift`, built as Helpers/TreziSecrets): the
// master key under the earlier service name moves to `dev.trezi.native.secrets` exactly
// once, with no data loss, and the old item goes only after the new one is written.
// Runs the real helper against a temporary keychain (`--keychain`, no prompts); the
// login keychain and the search list are never touched. Where no keychain can be
// created (a sandbox, a headless runner) the test says SKIP instead of passing.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { swiftBuild } from './helpers/swift-build.mjs'

const SERVICE = 'dev.trezi.native.secrets'
const LEGACY = 'dev.praxis.native.secrets' // the earlier name, read once
// Bounded: a hung security agent must not eat the unit budget (LKM-144). Every call here
// works on a temporary keychain made with a password, and none can show a prompt.
const security = (...args) =>
  spawnSync('/usr/bin/security', args, { encoding: 'utf8', timeout: 30_000 })

// CryptoKit's AES.GCM combined form: 12-byte nonce, ciphertext, 16-byte tag.
const seal = (key, text) => {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}
const open = (key, blob) => {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
  decipher.setAuthTag(blob.subarray(blob.length - 16))
  return Buffer.concat([
    decipher.update(blob.subarray(12, blob.length - 16)),
    decipher.final()
  ]).toString('utf8')
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-keychain-')))
const keychains = []
try {
  const helper = join(scratch, 'TreziSecrets')
  swiftBuild(
    'keychain-secrets',
    [
      '-O',
      '-suppress-warnings',
      'src/native/Secrets.swift',
      '-framework',
      'Security',
      '-framework',
      'CryptoKit'
    ],
    { out: helper }
  )
  const crypto = (keychain, op, input) => {
    const result = spawnSync(helper, ['--crypto', op, '--keychain', keychain], {
      input,
      timeout: 20_000
    })
    return { status: result.status, out: result.stdout }
  }
  const has = (keychain, service) =>
    security('find-generic-password', '-s', service, '-a', 'master-key', keychain).status
  const keychain = (name) => {
    const path = join(scratch, `${name}.keychain-db`)
    const made = security('create-keychain', '-p', 'trezi-test', path)
    if (made.status !== 0) return { skip: made.status === null ? 'timed out' : made.stderr.trim() }
    keychains.push(path)
    security('unlock-keychain', '-p', 'trezi-test', path)
    return { path }
  }

  const first = keychain('migrate')
  if (first.skip) {
    console.log(`KEYCHAIN-MIGRATION SKIP (no temporary keychain here: ${first.skip})`)
  } else {
    const kc = first.path
    // A profile from before the rename: the key under the earlier name and a connection
    // key encrypted with it.
    const legacyKey = randomBytes(32)
    assert.equal(
      security(
        'add-generic-password',
        '-s',
        LEGACY,
        '-a',
        'master-key',
        '-X',
        legacyKey.toString('hex'),
        '-A',
        kc
      ).status,
      0
    )
    const saved = seal(legacyKey, 'sk-saved-before-the-rename')
    assert.equal(has(kc, SERVICE), 44, 'no new item yet')

    // First run migrates: the old ciphertext still opens, the new item exists, the old one is gone.
    const migrated = crypto(kc, 'decrypt', saved)
    assert.equal(migrated.status, 0)
    assert.equal(migrated.out.toString('utf8'), 'sk-saved-before-the-rename', 'no data loss')
    assert.equal(has(kc, SERVICE), 0, 'the key is under the new name')
    assert.equal(has(kc, LEGACY), 44, 'the old item is deleted after the write')

    // Later runs read the new item: the same key both ways.
    assert.equal(crypto(kc, 'decrypt', saved).out.toString('utf8'), 'sk-saved-before-the-rename')
    const sealed = crypto(kc, 'encrypt', Buffer.from('sk-after'))
    assert.equal(sealed.status, 0)
    assert.equal(open(legacyKey, sealed.out), 'sk-after', 'new ciphertext uses the migrated key')

    // Exactly once: an item that reappears under the old name is never migrated again.
    assert.equal(
      security(
        'add-generic-password',
        '-s',
        LEGACY,
        '-a',
        'master-key',
        '-X',
        randomBytes(32).toString('hex'),
        '-A',
        kc
      ).status,
      0
    )
    assert.equal(crypto(kc, 'decrypt', saved).out.toString('utf8'), 'sk-saved-before-the-rename')
    assert.equal(has(kc, LEGACY), 0, 'the reappeared old item is left alone')
    console.log('KEYCHAIN-MIGRATION migrate PASS')

    // A new profile: decrypt never creates a key; encrypt creates one under the new name only.
    const fresh = keychain('fresh').path
    assert.equal(crypto(fresh, 'decrypt', saved).status, 1)
    assert.equal(has(fresh, SERVICE), 44, 'a decrypt does not create a key')
    const created = crypto(fresh, 'encrypt', Buffer.from('sk-new'))
    assert.equal(created.status, 0)
    assert.equal(has(fresh, SERVICE), 0)
    assert.equal(has(fresh, LEGACY), 44)
    assert.equal(crypto(fresh, 'decrypt', created.out).out.toString('utf8'), 'sk-new')
    assert.equal(crypto(fresh, 'decrypt', saved).status, 1, 'another key does not open it')
    console.log('KEYCHAIN-MIGRATION fresh PASS')

    // A key of the wrong size under the old name is refused and kept, never copied.
    const odd = keychain('odd').path
    assert.equal(
      security(
        'add-generic-password',
        '-s',
        LEGACY,
        '-a',
        'master-key',
        '-X',
        randomBytes(16).toString('hex'),
        '-A',
        odd
      ).status,
      0
    )
    assert.equal(crypto(odd, 'encrypt', Buffer.from('x')).status, 1)
    assert.equal(has(odd, LEGACY), 0)
    assert.equal(has(odd, SERVICE), 44)
    console.log('KEYCHAIN-MIGRATION invalid PASS')

    // LKM-144: the first launch after updating runs one helper per saved key, one at a
    // time (`ProviderData.crypto`). Each later run reads the new item, never the old one.
    const repeat = keychain('repeat').path
    const repeatKey = randomBytes(32)
    assert.equal(
      security(
        'add-generic-password',
        '-s',
        LEGACY,
        '-a',
        'master-key',
        '-X',
        repeatKey.toString('hex'),
        '-A',
        repeat
      ).status,
      0
    )
    const keys = ['sk-one', 'sk-two', 'sk-three'].map((text) => seal(repeatKey, text))
    assert.deepEqual(
      keys.map((blob) => crypto(repeat, 'decrypt', blob).out.toString('utf8')),
      ['sk-one', 'sk-two', 'sk-three']
    )
    assert.equal(has(repeat, SERVICE), 0)
    assert.equal(has(repeat, LEGACY), 44, 'migrated by the first, then left alone')
    console.log('KEYCHAIN-MIGRATION repeated PASS')

    // Misuse: no operation is a usage error.
    assert.equal(spawnSync(helper, []).status, 2)
    console.log('KEYCHAIN-MIGRATION OK')
  }
} finally {
  for (const path of keychains) security('delete-keychain', path)
  rmSync(scratch, { recursive: true, force: true })
}
