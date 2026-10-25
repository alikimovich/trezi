// LKM-336: the Send Feedback invite code in the real Swift ProviderOwner (compiled fixture),
// through Bun's real client, with the fake Keychain helper (never the real Keychain):
// saved encrypted at mode 0600 with no plaintext on disk, read back, refused when it is not
// a code, when the Keychain is locked or when there is no credential store, and removed.
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileProviderFixture, startProviderFixture } from './helpers/provider-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-feedback-code-')))
const CRYPTO = join(root, 'test/fixtures/provider-owner/fake-crypto.mjs')
const binary = compileProviderFixture()
const fixtures = []

async function start(name, crypto = `${process.execPath}\u001f${CRYPTO}`) {
  const home = join(scratch, name)
  mkdirSync(home)
  const started = await startProviderFixture(binary, home, { PROVIDER_CRYPTO: crypto })
  fixtures.push(started)
  return { data: started.owner().data, file: join(home, 'trezi/feedback-code.json') }
}

try {
  const { data, file } = await start('keychain')
  assert.deepEqual(await data.feedbackCodeStatus(), { hasCode: false })
  assert.equal(await data.feedbackCode(), null)

  assert.equal(await data.saveFeedbackCode('  code-1 \n'), true)
  assert.deepEqual(await data.feedbackCodeStatus(), { hasCode: true })
  const stored = readFileSync(file, 'utf8')
  assert.ok(!stored.includes('code-1'), 'Only the ciphertext is on disk')
  assert.equal(JSON.parse(stored).version, 1)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(await data.feedbackCode(), 'code-1', 'Trimmed, then decrypted for Bun')

  await assert.rejects(data.saveFeedbackCode('two words'), /invite code/)
  await assert.rejects(data.saveFeedbackCode('x'.repeat(513)), /invite code/)
  await assert.rejects(data.saveFeedbackCode('locked-code'), /Keychain/)
  assert.equal(await data.feedbackCode(), 'code-1', 'A refused code keeps the saved one')

  assert.equal(await data.saveFeedbackCode(''), false)
  assert.ok(!existsSync(file), 'Removing the code deletes its file')
  assert.deepEqual(await data.feedbackCodeStatus(), { hasCode: false })
  assert.equal(await data.saveFeedbackCode(''), false, 'Removing twice is fine')

  const none = await start('no-keyring', '')
  await assert.rejects(none.data.saveFeedbackCode('code-2'), /credential store/)
  assert.ok(!existsSync(none.file))
} finally {
  for (const fixture of fixtures) await fixture.stop()
  rmSync(scratch, { recursive: true, force: true })
}
console.log('Provider feedback code: encrypted invite code saved, read, refused and removed passed')
