import assert from 'node:assert/strict'

export type MarkupSemantic = {
  selectMode: boolean
  markupOpen: boolean
  selectAccent: boolean
  markupAccent: boolean
  overlayPanel: boolean
  codeOpen: boolean
  sourceVisible: boolean
  layersVisible: boolean
  viewport: string
  chatHidden: boolean
  speed: number
}

export const restingMarkupSemantic: MarkupSemantic = {
  selectMode: false,
  markupOpen: false,
  selectAccent: false,
  markupAccent: false,
  overlayPanel: false,
  codeOpen: false,
  sourceVisible: false,
  layersVisible: false,
  viewport: 'desktop',
  chatHidden: false,
  speed: 1
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
  after: { prominent: boolean; focused: boolean; semantic: MarkupSemantic },
  settled = after.semantic
) {
  assertMarkupBaseline(`${label} before down`, before.semantic)
  assertMarkupAppearance(`${label} held`, segment, held)
  assertMarkupAppearance(`${label} released`, segment, after)
  assert.equal(
    after.semantic.selectAccent,
    after.semantic.selectMode,
    `${label}: Select release accent`
  )
  assert.equal(
    after.semantic.markupAccent,
    after.semantic.markupOpen,
    `${label}: Mark up release accent`
  )
  assert.equal(settled.selectAccent, settled.selectMode, `${label}: settled Select accent`)
  assert.equal(settled.markupAccent, settled.markupOpen, `${label}: settled Mark up accent`)
  const owners: Partial<Record<keyof MarkupSemantic, string>> = {
    selectMode: 'select-object',
    markupOpen: 'markup',
    codeOpen: 'code',
    sourceVisible: 'code',
    layersVisible: 'layers',
    viewport: 'device',
    chatHidden: 'expand',
    speed: 'speed'
  }
  const changes = (Object.keys(owners) as (keyof MarkupSemantic)[]).filter(
    (key) =>
      before.semantic[key] !== held.semantic[key] ||
      before.semantic[key] !== after.semantic[key] ||
      before.semantic[key] !== settled[key]
  )
  for (const key of changes) assert.equal(segment, owners[key], `${label}: ${key} action owner`)
  if (held.semantic.overlayPanel || after.semantic.overlayPanel || settled.overlayPanel)
    assert.equal(segment, 'overlay', `${label}: overlay panel action owner`)
  return {
    observedAction:
      changes.length ||
      held.semantic.overlayPanel ||
      after.semantic.overlayPanel ||
      settled.overlayPanel
        ? segment
        : 'none',
    changes
  }
}
