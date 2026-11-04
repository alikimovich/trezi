import assert from 'node:assert/strict'
import {
  assertMarkupAppearance,
  assertMarkupBaseline,
  assertPressedTransition,
  restingMarkupSemantic
} from '../src/native/markup-acceptance-state.ts'

const rest = { ...restingMarkupSemantic }
assertMarkupBaseline('rest', rest)
assertMarkupAppearance(
  'focus',
  'select-object',
  { prominent: false, focused: true, semantic: rest },
  true
)
const active = { ...rest, selectMode: true, selectAccent: true }
assertMarkupAppearance('active Select', 'select-object', {
  prominent: true,
  focused: false,
  semantic: active
})
const before = { prominent: false, focused: false, semantic: rest }
const selected = { prominent: true, focused: false, semantic: active }
assert.equal(
  assertPressedTransition('Select release', 'select-object', before, before, selected),
  'select-object'
)
assert.equal(
  assertPressedTransition('focus release', 'select-object', before, before, before),
  'none'
)
assert.throws(
  () =>
    assertPressedTransition('stale release', 'select-object', before, before, {
      prominent: true,
      focused: false,
      semantic: rest
    }),
  /accent follows the active segment/
)
assert.throws(
  () =>
    assertMarkupAppearance(
      'stale focus',
      'select-object',
      { prominent: true, focused: true, semantic: rest },
      true
    ),
  /accent follows the active segment/
)
assert.throws(
  () =>
    assertMarkupAppearance('stale image', 'select-object', {
      prominent: true,
      focused: false,
      semantic: { ...rest, selectAccent: true }
    }),
  /image follows selection/
)
assert.throws(() => assertMarkupBaseline('after release', active), /exact resting baseline/)
console.log('markup acceptance semantic state PASS')
