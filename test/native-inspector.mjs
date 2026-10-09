import assert from 'node:assert/strict'
import { NativeInspectorController } from '../src/native/inspector-controller.ts'

const calls = [],
  sent = [],
  renders = [],
  agents = []
let resolveWrite
let classRule = null
const invoke = async (channel, ...args) => {
  calls.push([channel, ...args])
  if (channel === 'props:inspect')
    return {
      hasSchema: true,
      source: args[1],
      component: 'Card',
      fields: [{ name: 'count', kind: 'number', value: 1 }]
    }
  if (channel === 'styles:read')
    return {
      values: { opacity: '1', display: 'block', 'font-size': '16px' },
      specified: {},
      declaredVars: {}
    }
  if (channel === 'tokens:detect')
    return {
      source: 'css',
      groups: [{ name: 'colors', tokens: [{ name: '--blue', value: '#0000ff' }] }]
    }
  if (channel === 'controls:list' || channel === 'controls:get') return []
  if (channel === 'props:apply') return { needsAgent: true, agentPrompt: 'set count' }
  if (channel === 'styles:apply') return { applied: true }
  if (channel === 'styles:resolve-class') return classRule
  if (channel === 'styles:apply-class') return { applied: true }
}
const controller = new NativeInspectorController(
  invoke,
  async (...args) => sent.push(args),
  (state) => renders.push(structuredClone(state)),
  async (...args) => agents.push(args),
  async () => {}
)
const element = {
  tag: 'div',
  id: null,
  classes: [],
  source: 'a.tsx:3',
  componentSource: null,
  styles: { opacity: '1' },
  selector: 'div',
  text: null,
  rect: { x: 0, y: 0, width: 10, height: 10 }
}
await controller.activate('/a')
await controller.select(element)
assert.equal(controller.state.visible, false, 'Picking an element must not open the sidebar')
controller.state.visible = true
await controller.select({ ...element, id: 'next' })
assert.equal(controller.state.visible, true, 'An explicitly opened inspector follows selection')
const action = (action, extra = {}) =>
  controller.action({ root: '/a', generation: controller.state.generation, action, ...extra })
assert.ok(controller.state.fields.find((f) => f.id === 'style:opacity'))
await action('apply', { field: 'style:opacity', value: '0.7' })
assert.equal(calls.find((c) => c[0] === 'styles:apply')[2].source, 'a.tsx:3')
await action('token', { field: 'style:color', value: '0' })
assert.deepEqual(calls.filter((c) => c[0] === 'styles:apply').at(-1)[2].token, {
  name: '--blue',
  group: 'colors'
})
await action('tab', { value: 'props' })
await action('apply', { field: 'prop:count', value: '4' })
assert.deepEqual(agents.at(-1), ['/a', 'set count'])
const old = controller.state.generation
await controller.select({ ...element, source: 'b.tsx:2' })
const length = calls.length
await controller.action({
  root: '/a',
  generation: old,
  action: 'apply',
  field: 'prop:count',
  value: '9'
})
assert.equal(calls.length, length)
await controller.select({ ...element, source: null })
await action('tab', { value: 'styles' })
assert.equal(controller.state.fields.find((f) => f.id === 'style:opacity').disabled, true)
assert.equal(controller.state.notice.title, "Trezi can't find this element's source code.")
assert.ok(controller.state.actions.some((a) => a.label === 'Connect project to Trezi'))
assert.ok(controller.state.actions.some((a) => a.label === 'Ask the agent'))
const before = calls.length
await action('apply', { field: 'style:opacity', value: '.3' })
assert.equal(calls.length, before)
await action('ask-agent')
assert.match(agents.at(-1)[1], /selected the <div>/)
classRule = { file: 'src/themer-admin/Account.module.css', className: 'accountAvatar' }
await controller.select({ ...element, source: null, classes: ['_accountAvatar_vc9o5_17'] })
assert.equal(controller.state.fields.find((f) => f.id === 'style:opacity').disabled, false)
await action('apply', { field: 'style:opacity', value: '.3' })
assert.equal(calls.filter((c) => c[0] === 'styles:apply-class').length, 1)
classRule = null
await action('close')
assert.equal(controller.state.visible, false)
await controller.select(element)
await controller.refresh()
assert.equal(
  controller.state.visible,
  false,
  'Selection and refresh must not reopen a closed inspector'
)
controller.state.visible = true
await controller.select(null)
assert.equal(controller.state.visible, false, 'Clearing selection dismisses the inspector')
// LKM-172: a project switch hides the island at once, before any read settles, and a
// refresh still in flight for the old element cannot bring its fields back.
await controller.select(element)
controller.state.visible = true
controller.publish()
const pending = controller.refresh()
const published = renders.length
controller.clear()
assert.equal(renders.length, published + 1, 'Clearing publishes synchronously')
assert.equal(renders.at(-1).visible, false, 'Clearing hides the island')
assert.equal(renders.at(-1).title, 'Project controls', 'Clearing drops the element')
assert.equal(controller.element, null)
assert.deepEqual(sent.at(-1), ['styles:clear-preview', {}])
await pending
assert.equal(renders.length, published + 1, 'The old element refresh is discarded')
assert.equal(
  controller.state.fields.some((f) => f.id === 'style:opacity'),
  false
)
console.log(
  'Native inspector: source targeting, schema fields, token references, agent fallback and stale/uninstrumented write guards passed'
)

const missingStyles = new NativeInspectorController(
  async (channel) => (channel === 'controls:list' || channel === 'controls:get' ? [] : null),
  async () => {},
  () => {},
  async () => {},
  async () => {}
)
await missingStyles.activate('/a')
await missingStyles.select({ ...element, styles: undefined })
assert.ok(missingStyles.state.fields.find((f) => f.id === 'style:opacity'))
assert.equal(missingStyles.state.error, '')

const animationControls = new NativeInspectorController(
  async (channel) =>
    channel === 'controls:get'
      ? [{ manifest: { presentation: 'animation', id: 'motion' }, params: [] }]
      : channel === 'controls:list'
        ? [{ presentation: 'animation', file: 'a.tsx' }]
        : null,
  async () => {},
  () => {},
  async () => {},
  async () => {}
)
await animationControls.activate('/a')
assert.equal(
  animationControls.state.visible,
  false,
  'Discovering animation controls must not open the inspector'
)
