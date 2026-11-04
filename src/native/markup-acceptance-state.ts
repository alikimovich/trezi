import assert from 'node:assert/strict'

export type MarkupSemantic = {
  selectMode: boolean
  markupOpen: boolean
  selectAccent: boolean
  markupAccent: boolean
}

export const restingMarkupSemantic: MarkupSemantic = {
  selectMode: false,
  markupOpen: false,
  selectAccent: false,
  markupAccent: false
}

// The accent belongs to an active semantic state, never to focus or a stale image.
export function assertMarkupAppearance(
  label: string,
  segment: string,
  state: { prominent: boolean; focused: boolean; semantic: MarkupSemantic },
  focus = false
) {
  const { semantic } = state
  assert.equal(
    semantic.selectAccent,
    semantic.selectMode,
    `${label}: Select image follows selection`
  )
  assert.equal(
    semantic.markupAccent,
    semantic.markupOpen,
    `${label}: Mark up image follows overlay`
  )
  assert.equal(
    state.prominent,
    segment === 'select-object'
      ? semantic.selectMode
      : segment === 'markup'
        ? semantic.markupOpen
        : false,
    `${label}: accent follows the active segment`
  )
  if (focus) assert.equal(state.focused, true, `${label}: keyboard focus`)
}

export function assertMarkupBaseline(label: string, semantic: MarkupSemantic) {
  assert.deepEqual(semantic, restingMarkupSemantic, `${label}: exact resting baseline`)
}

export function assertPressedTransition(
  label: string,
  segment: string,
  before: { prominent: boolean; focused: boolean; semantic: MarkupSemantic },
  held: { prominent: boolean; focused: boolean; semantic: MarkupSemantic },
  after: { prominent: boolean; focused: boolean; semantic: MarkupSemantic }
) {
  assertMarkupBaseline(`${label} before down`, before.semantic)
  assertMarkupAppearance(`${label} held`, segment, held)
  assertMarkupAppearance(`${label} released`, segment, after)
  if (after.semantic.selectMode)
    assert.equal(segment, 'select-object', `${label}: Select action owner`)
  if (after.semantic.markupOpen) assert.equal(segment, 'markup', `${label}: Mark up action owner`)
  return after.semantic.selectMode ? 'select-object' : after.semantic.markupOpen ? 'markup' : 'none'
}
