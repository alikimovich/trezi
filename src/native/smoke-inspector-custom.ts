import assert from 'node:assert/strict'
import type { NativeBridge } from './bridge'
import type { NativeInspectorController } from './inspector-controller'
import { waitFor } from './smoke-wait'

export interface CustomSmoke {
  host: NativeBridge
  fixture: string
  inspector: NativeInspectorController
  select: (source: string) => Promise<void>
  open: () => Promise<void>
}

/** The native inspector offers only Props and Styles, including after a legacy tab action. */
export async function checkInspectorCustom(s: CustomSmoke) {
  await s.select('native-style.tsx:1:36')
  await s.open()
  const perform = async (action: string, value?: string) => {
    const state = await s.host.request('inspectorInspect')
    await s.host.request('inspectorPerform', {
      action: { root: s.fixture, generation: state.generation, action, value }
    })
  }
  for (const [requested, expected] of [
    ['props', 'props'],
    ['styles', 'styles'],
    ['custom', 'styles']
  ]) {
    await perform('tab', requested)
    const state = await waitFor(async () => {
      const shown = await s.host.request('inspectorInspect')
      return shown.tab === expected && shown.fields > 0 && shown
    }, `${requested} resolves to ${expected}`)
    assert.equal(state.root, s.fixture)
    const view = await s.host.request('inspectorCustom')
    assert.equal(view.request.found, false, 'No custom request composer exists')
    assert.deepEqual(view.sections, ['Props', 'Styles'], 'Only Props and Styles segments exist')
    assert.equal(view.tab, expected)
  }
  assert.equal(s.inspector.element?.source, 'native-style.tsx:1:36')
  assert.ok(!s.inspector.state.actions.some((a) => a.id === 'controls'))
}

export async function restoreInspectorCustom(s: CustomSmoke) {
  const state = await s.host.request('inspectorInspect')
  if (state.visible)
    await s.host.request('inspectorPerform', {
      action: { root: s.fixture, generation: state.generation, action: 'close' }
    })
  await waitFor(
    async () => !(await s.host.request('inspectorInspect')).visible,
    'editing island closed'
  )
}
