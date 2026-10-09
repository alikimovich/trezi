import assert from 'node:assert/strict'
import { threeDActionAllowed } from '../src/shared/three-d-contract.ts'

const session = 'document-1/scene-2'
const accepts = (action) => threeDActionAllowed(action, session, 8, 3)
for (const action of ['close', 'front', 'reset']) {
  assert.equal(accepts({ session, revision: 7, action }), true, `${action} survives a refresh`)
}
assert.equal(accepts({ session, revision: 7, action: 'separation', value: 100 }), true)
assert.equal(accepts({ session, revision: 7, action: 'separation', value: 0 }), true)
assert.equal(accepts({ session, revision: 8, action: 'layer', value: 2 }), true)
assert.equal(accepts({ session, revision: 8, action: 'code' }), true)
for (const action of [
  { session: 'old', revision: 8, action: 'close' },
  { session, revision: 7, action: 'layer', value: 0 },
  { session, revision: 7, action: 'code' },
  { session, revision: 8, action: 'layer', value: 3 },
  { session, revision: 8, action: 'layer', value: -1 },
  { session, revision: 8, action: 'separation', value: 101 },
  { session, revision: 8, action: 'separation', value: 1.5 },
  { session, revision: -1, action: 'close' },
  { session, revision: 8, action: 'unknown' },
  null
])
  assert.equal(accepts(action), false, JSON.stringify(action))

// Nothing opaque may paint before the native palette arrives (no white flash in dark mode).
const { THREE_D_CSS } = await import('../src/preview/three-d-styles.ts')
assert.match(THREE_D_CSS, /dialog::backdrop\s*\{\s*background:\s*transparent;?\s*\}/)
assert.doesNotMatch(THREE_D_CSS, /color-scheme/, 'the site and palette own the colour scheme')
const { readFileSync } = await import('node:fs')
const dialogStyle = readFileSync(
  new URL('../src/preview/three-d.ts', import.meta.url),
  'utf8'
).match(/dialog\.style\.cssText =\s*'([^']*)'/)?.[1]
assert.ok(dialogStyle, 'the dialog sets an inline style')
assert.match(dialogStyle, /background:transparent/, 'the dialog itself is transparent')

console.log('three-d-contract: ok')
