import assert from 'node:assert/strict'
import {
  packAtlas,
  THREE_D_LIMITS,
  threeDActionAllowed,
  threeDStateAllowed
} from '../src/shared/three-d-contract.ts'

const session = 'document-1/scene-2'
const accepts = (action) => threeDActionAllowed(action, session, 8, 3, 2)
assert.equal(accepts({ session, revision: 7, action: 'close' }), true, 'close survives a refresh')
assert.equal(accepts({ session, revision: 8, action: 'layer', value: 2 }), true)
assert.equal(accepts({ session, revision: 8, action: 'code' }), true)
assert.equal(accepts({ session, revision: 8, action: 'paint', value: -1 }), true)
assert.equal(accepts({ session, revision: 8, action: 'paint', value: 3 }), true)
for (const action of [
  { session: 'old', revision: 8, action: 'close' },
  { session, revision: 7, action: 'layer', value: 0 },
  { session, revision: 7, action: 'code' },
  { session, revision: 7, action: 'paint', value: 0 },
  { session, revision: 8, action: 'paint', value: 4 },
  { session, revision: 8, action: 'paint', value: -2 },
  { session, revision: 8, action: 'layer', value: 3 },
  { session, revision: 8, action: 'layer', value: -1 },
  // The camera and spacing are native now; the page no longer accepts them.
  { session, revision: 8, action: 'front' },
  { session, revision: 8, action: 'reset' },
  { session, revision: 8, action: 'separation', value: 40 },
  { session, revision: -1, action: 'close' },
  { session, revision: 8, action: 'unknown' },
  null
])
  assert.equal(accepts(action), false, JSON.stringify(action))

const layer = (id, page = 0) => ({
  id,
  label: `div#l${id}`,
  depth: id,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  page,
  ax: 2,
  ay: 2 + id * 44
})
const state = {
  session,
  revision: 8,
  title: 'div#l0',
  layers: [layer(0), layer(1)],
  width: 100,
  height: 84,
  scale: 1,
  pages: 1,
  selected: 0,
  hasSource: false,
  limited: false,
  simplified: false,
  invalid: false
}
assert.equal(threeDStateAllowed(state), true)
for (const bad of [
  { ...state, layers: [layer(0, 1)] },
  { ...state, layers: [layer(1)] },
  { ...state, pages: THREE_D_LIMITS.pages + 1 },
  { ...state, scale: 2 },
  { ...state, selected: 2 },
  { ...state, layers: [{ ...layer(0), depth: THREE_D_LIMITS.depth + 1 }] },
  { ...state, layers: [{ ...layer(0), label: 'x'.repeat(THREE_D_LIMITS.label + 1) }] },
  { ...state, layers: Array.from({ length: THREE_D_LIMITS.layers + 1 }, (_, i) => layer(i)) },
  { ...state, width: Number.NaN },
  { ...state, invalid: 'no' }
])
  assert.equal(threeDStateAllowed(bad), false, JSON.stringify(bad).slice(0, 120))

// Atlas: every surface lands inside a page at one shared scale, without overlap.
const viewport = { width: 800, height: 600 }
const check = (sizes, packed) => {
  const boxes = []
  sizes.forEach((s, i) => {
    const slot = packed.slots[i]
    if (!slot) return
    const box = {
      page: slot.page,
      x: slot.x,
      y: slot.y,
      w: Math.ceil(s.width * packed.scale),
      h: Math.ceil(s.height * packed.scale)
    }
    assert.ok(box.x >= 0 && box.x + box.w <= viewport.width, `slot ${i} fits horizontally`)
    assert.ok(box.y >= 0 && box.y + box.h <= viewport.height, `slot ${i} fits vertically`)
    assert.ok(box.page >= 0 && box.page < packed.pages)
    for (const other of boxes)
      assert.ok(
        other.page !== box.page ||
          other.x + other.w <= box.x ||
          box.x + box.w <= other.x ||
          other.y + other.h <= box.y ||
          box.y + box.h <= other.y,
        `slot ${i} does not overlap`
      )
    boxes.push(box)
  })
  return boxes.length
}
const small = [
  { width: 320, height: 160 },
  { width: 300, height: 40 },
  { width: 200, height: 24 }
]
const packedSmall = packAtlas(small, viewport)
assert.equal(packedSmall.scale, 1, 'small components keep full resolution')
assert.equal(packedSmall.pages, 1)
assert.equal(check(small, packedSmall), 3)
const huge = [{ width: 1600, height: 3000 }, ...small]
const packedHuge = packAtlas(huge, viewport)
assert.ok(packedHuge.scale < 1 && packedHuge.scale > 0, 'oversized surfaces scale down')
assert.equal(check(huge, packedHuge), huge.length)
const many = Array.from({ length: THREE_D_LIMITS.layers }, () => ({ width: 780, height: 580 }))
const packedMany = packAtlas(many, viewport)
assert.ok(packedMany.pages <= THREE_D_LIMITS.pages, 'the page budget holds')
assert.equal(check(many, packedMany), packedMany.fitted)
assert.equal(packAtlas([], viewport).pages, 0)

// The capture dialog paints nothing except an atlas page on black or white.
const { THREE_D_CSS } = await import('../src/preview/three-d-styles.ts')
assert.match(THREE_D_CSS, /dialog::backdrop\s*\{\s*background:\s*transparent;?\s*\}/)
assert.match(THREE_D_CSS, /dialog\[data-tone="0"\]\s*\{\s*background:#000/)
assert.match(THREE_D_CSS, /dialog\[data-tone="1"\]\s*\{\s*background:#fff/)
assert.doesNotMatch(THREE_D_CSS, /perspective|preserve-3d|\.scene|\.stage/, 'no in-page scene')
assert.doesNotMatch(THREE_D_CSS, /color-scheme/, 'the site owns the colour scheme')
const { readFileSync } = await import('node:fs')
const source = readFileSync(new URL('../src/preview/three-d.ts', import.meta.url), 'utf8')
const dialogStyle = source.match(/dialog\.style\.cssText =\s*'([^']*)'/)?.[1]
assert.ok(dialogStyle, 'the dialog sets an inline style')
assert.match(dialogStyle, /background:transparent/, 'the dialog itself is transparent')
assert.match(source, /captureSurfaces/, 'the capture path is retained')
assert.doesNotMatch(source, /pointerdown|wheel|perspective/, 'no in-page camera')

console.log('three-d-contract: ok')
