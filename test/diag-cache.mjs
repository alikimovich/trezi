/**
 * Unit test for the diagnosis memory's key (no electron). The memory itself is the
 * service's workflow owner's (test/workflow-owner.mjs). Run via bun:
 * bun run test:diag-cache
 */
import assert from 'node:assert'
import { signatureFor } from '../src/main/diag-cache.ts'

// Signature normalizes volatile bits: same error class → same key despite paths.
const a = signatureFor(
  "Cannot find module '@ai-sdk/xai' imported from /Users/x/dev/lkmv.ch/chat.ts"
)
const b = signatureFor("Cannot find module '@ai-sdk/xai' imported from /Users/y/other/chat.ts")
assert.equal(a, b, 'same error class → same signature despite different paths')
assert.notEqual(
  a,
  signatureFor("Cannot find module '@ai-sdk/openai' imported from /Users/x/chat.ts"),
  'different module → different signature'
)
assert.equal(
  signatureFor('Port 3000 in use'),
  signatureFor('Port 5173 in use'),
  'numbers are normalized'
)
assert.equal(
  signatureFor('session 0f8fad5b-d9cb-469f-a165-70867728950e failed'),
  signatureFor('session 7c9e6679-7425-40de-944b-e07fc1f90ae7 failed'),
  'ids are normalized'
)

console.log('DIAG-CACHE OK — signature normalization')
