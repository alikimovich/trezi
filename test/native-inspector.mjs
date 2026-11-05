import assert from 'node:assert/strict'
import { setSourceOwner } from '../src/main/source-owner.ts'
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
  if (channel === 'styles:apply-pair' || channel === 'styles:apply-class-pair')
    return { applied: true }
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
assert.deepEqual(
  controller.state.fields.filter((f) => f.layout === 'size').map((f) => f.id),
  ['style:width', 'style:height']
)
assert.equal(controller.state.fields.find((f) => f.id === 'style:padding-horizontal').mixed, false)
assert.equal(
  controller.state.actions.some((a) => a.id.startsWith('link:')),
  false
)
const beforeMode = calls.length
await action('spacing:padding')
assert.equal(calls.length, beforeMode, 'View toggle cannot change source')
assert.ok(controller.state.fields.find((f) => f.id === 'style:padding-left'))
assert.equal(
  controller.state.fields.some((f) => f.id === 'style:padding-horizontal'),
  false
)
await action('spacing:padding')
const previewStart = sent.length
await action('preview', { field: 'style:padding-horizontal', value: '14' })
assert.deepEqual(sent.slice(previewStart), [
  ['styles:preview', { prop: 'padding-left', value: '14px' }],
  ['styles:preview', { prop: 'padding-right', value: '14px' }]
])
await action('cancel-preview', { field: 'style:padding-horizontal' })
assert.deepEqual(sent.at(-1), ['styles:clear-preview', {}])
await action('apply', { field: 'style:padding-horizontal', value: '17' })
assert.deepEqual(calls.filter((c) => c[0] === 'styles:apply-pair').at(-1)[2].props, [
  'padding-left',
  'padding-right'
])
assert.equal(calls.filter((c) => c[0] === 'styles:apply-pair').at(-1)[2].value, '17px')
await action('apply', { field: 'style:margin-vertical', value: '-9' })
assert.deepEqual(calls.filter((c) => c[0] === 'styles:apply-pair').at(-1)[2].props, [
  'margin-top',
  'margin-bottom'
])
await action('spacing:margin')
await action('apply', { field: 'style:margin-left', value: 'auto' })
assert.equal(calls.filter((c) => c[0] === 'styles:apply').at(-1)[2].prop, 'margin-left')
await action('spacing:margin')
await action('apply', { field: 'style:opacity', value: '0.7' })
assert.equal(calls.find((c) => c[0] === 'styles:apply')[2].source, 'a.tsx:3')
await action('token', { field: 'style:color', value: '0' })
assert.deepEqual(calls.filter((c) => c[0] === 'styles:apply').at(-1)[2].token, {
  name: '--blue',
  group: 'colors'
})
assert.equal(agents.length, 0, 'eligible Styles edits never start an agent turn')
await action('tab', { value: 'props' })
assert.equal(controller.state.tab, 'props')
assert.ok(controller.state.fields.some((f) => f.id === 'prop:count'))
assert.ok(!controller.state.actions.some((a) => a.id === 'controls'))
await action('tab', { value: 'custom' })
assert.equal(controller.state.tab, 'styles', 'Legacy Custom action falls back to Styles')
assert.ok(controller.state.fields.some((f) => f.id === 'style:opacity'))
assert.equal(controller.state.root, '/a')
assert.equal(controller.element?.id, 'next')
assert.equal(controller.state.visible, true)
controller.state.tab = 'custom'
controller.publish()
assert.equal(controller.state.tab, 'styles', 'Legacy saved state falls back at publication')
assert.ok(controller.state.fields.some((f) => f.id === 'style:opacity'))
for (const retired of [
  'controls',
  'custom-request',
  'comment-control',
  'custom-cancel',
  'remove:card'
]) {
  await action(retired, { value: 'stale request' })
  assert.equal(controller.state.tab, 'styles', `${retired} cannot reopen Custom`)
}
assert.equal(controller.state.custom, undefined, 'No request composer is published')
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

// Layout fields follow the selected element and the active authored declaration.
let layoutRead = {
  values: {
    display: 'flex',
    gap: '8px 16px',
    'row-gap': '8px',
    'column-gap': '16px',
    'flex-direction': 'column',
    'flex-wrap': 'wrap',
    'justify-content': 'space-between',
    'align-items': 'center',
    'align-content': 'normal'
  },
  specified: {
    gap: 'var(--space) calc(1rem + 2px)',
    'flex-direction': 'column',
    'align-content': 'normal'
  },
  origins: {
    gap: { kind: 'rule', selector: '.card', href: '/src/card.css' },
    'flex-direction': { kind: 'inline' },
    'align-content': { kind: 'rule', selector: '.card', href: '/src/card.css' }
  },
  declaredVars: {},
  parentDisplay: 'block'
}
const layout = new NativeInspectorController(
  async (channel) =>
    channel === 'styles:read'
      ? layoutRead
      : channel === 'controls:list' || channel === 'controls:get'
        ? []
        : null,
  async () => {},
  () => {},
  async () => {},
  async () => {}
)
await layout.activate('/a')
await layout.select(element)
const field = (prop) => layout.state.fields.find((f) => f.id === `style:${prop}`)
assert.equal(field('gap').value, 'var(--space) calc(1rem + 2px)')
assert.equal(field('gap').disabled, true, 'unresolved CSS source remains read-only')
assert.equal(field('row-gap').value, '8px')
assert.equal(field('column-gap').value, '16px')
assert.equal(field('flex-direction').value, 'column')
assert.equal(field('flex-wrap').value, 'wrap')
assert.equal(field('align-content').value, 'normal', 'explicit normal stays visible')
assert.equal(field('align-self'), undefined, 'container does not show child alignment')
layoutRead = {
  values: { display: 'block', 'align-self': 'auto', gap: '0px' },
  specified: { 'align-self': 'auto', gap: '0' },
  origins: { 'align-self': { kind: 'inline' }, gap: { kind: 'inline' } },
  declaredVars: {},
  parentDisplay: 'grid'
}
await layout.select({ ...element, id: 'child' })
assert.equal(field('align-self').value, 'auto')
assert.equal(field('gap').value, '0', 'explicit zero stays authored')
assert.equal(field('flex-direction'), undefined, 'selection removes stale flex controls')

const moduleInspector = new NativeInspectorController(
  async (channel) => {
    if (channel === 'styles:read')
      return {
        values: { display: 'grid', 'row-gap': '12px' },
        specified: { 'row-gap': '0' },
        origins: {
          'row-gap': { kind: 'rule', selector: '._card_a1b2c_1', href: '/src/Card.module.css' }
        },
        declaredVars: {},
        parentDisplay: 'block'
      }
    if (channel === 'styles:resolve-class')
      return { file: 'src/Card.module.css', className: 'card' }
    if (channel === 'styles:apply-class') return { applied: true }
    if (channel === 'controls:list' || channel === 'controls:get') return []
    return null
  },
  async () => {},
  () => {},
  async () => {},
  async () => {}
)
await moduleInspector.activate('/a')
await moduleInspector.select({ ...element, classes: ['_card_a1b2c_1'] })
assert.equal(moduleInspector.state.fields.find((f) => f.id === 'style:row-gap').disabled, false)
moduleInspector.styles.origins['row-gap'].conditional = true
moduleInspector.build()
assert.equal(moduleInspector.state.fields.find((f) => f.id === 'style:row-gap').disabled, true)

const utilityInspector = new NativeInspectorController(
  async (channel) => {
    if (channel === 'styles:read')
      return {
        values: { display: 'block', width: '100px', 'padding-left': '16px' },
        specified: { width: '100%', 'padding-left': '1rem' },
        origins: {
          width: { kind: 'rule', selector: '.w-full' },
          'padding-left': { kind: 'rule', selector: '.p-4' }
        },
        declaredVars: {}
      }
    if (channel === 'controls:list' || channel === 'controls:get') return []
    return null
  },
  async () => {},
  () => {},
  async () => {},
  async () => {}
)
await utilityInspector.activate('/a')
await utilityInspector.select({ ...element, classes: ['w-full', 'p-4'] })
assert.equal(utilityInspector.state.fields.find((f) => f.id === 'style:width').disabled, false)
await utilityInspector.action({
  root: '/a',
  generation: utilityInspector.state.generation,
  action: 'spacing:padding'
})
assert.equal(
  utilityInspector.state.fields.find((f) => f.id === 'style:padding-left').disabled,
  false
)
assert.equal(
  utilityInspector.state.fields.find((f) => f.id === 'style:padding-right').disabled,
  false
)

// Tailwind v4 emits every utility inside `@layer utilities`: a layered origin is still the
// element's own utility rule, so its fields stay editable. Media-conditional and
// !important origins are not, and an arbitrary-value class matches its CSS-escaped selector.
const v4Reads = {
  layered: { kind: 'rule', selector: '.gap-4', layer: 'utilities' },
  escaped: { kind: 'rule', selector: '.gap-\\[12px\\]', layer: 'utilities' },
  conditional: { kind: 'rule', selector: '.gap-4', layer: 'utilities', conditional: true },
  important: { kind: 'rule', selector: '.gap-4', layer: 'utilities', important: true },
  unlayeredRival: { kind: 'rule', selector: '.card', href: '/src/card.css' }
}
for (const [name, origin] of Object.entries(v4Reads)) {
  const v4 = new NativeInspectorController(
    async (channel) =>
      channel === 'styles:read'
        ? {
            values: { display: 'flex', gap: '12px' },
            specified: { gap: name === 'escaped' ? '12px' : '1rem' },
            origins: { gap: origin },
            declaredVars: {},
            parentDisplay: 'block'
          }
        : channel === 'controls:list' || channel === 'controls:get'
          ? []
          : null,
    async () => {},
    () => {},
    async () => {},
    async () => {}
  )
  await v4.activate('/a')
  await v4.select({ ...element, classes: [name === 'escaped' ? 'gap-[12px]' : 'gap-4'] })
  assert.equal(
    v4.state.fields.find((f) => f.id === 'style:gap').disabled,
    !['layered', 'escaped'].includes(name),
    `${name} utility gap editability`
  )
}

let previewing = false
const asymmetric = new NativeInspectorController(
  async (channel) => {
    if (channel === 'styles:read')
      return {
        values: {
          'padding-left': '8px',
          'padding-right': '18px',
          'padding-top': '4px',
          'padding-bottom': '4px',
          'margin-left': 'auto',
          'margin-right': '-6px',
          'margin-top': '-2px',
          'margin-bottom': '0px'
        },
        specified: {
          'padding-left': previewing ? '14px' : 'var(--space)',
          'padding-right': '18px',
          'margin-left': 'auto',
          'margin-right': '-6px'
        }
      }
    if (channel === 'controls:list' || channel === 'controls:get') return []
    return null
  },
  async (channel) => {
    if (channel === 'styles:preview') previewing = true
    if (channel === 'styles:clear-preview') previewing = false
  },
  () => {},
  async () => {},
  async () => {}
)
await asymmetric.activate('/a')
await asymmetric.select(element)
const spacingFields = (group) => asymmetric.state.fields.filter((field) => field.layout === group)
const spacingSnapshot = (group) =>
  Object.fromEntries(spacingFields(group).map((field) => [field.id, field.value]))
assert.deepEqual(
  spacingFields('padding').map((field) => field.axis),
  ['horizontal', 'vertical']
)
assert.deepEqual(
  spacingFields('margin').map((field) => field.axis),
  ['horizontal', 'vertical']
)
const collapsedPadding = spacingSnapshot('padding')
const collapsedMargin = spacingSnapshot('margin')
assert.equal(asymmetric.state.fields.find((f) => f.id === 'style:padding-horizontal').mixed, true)
assert.equal(asymmetric.state.fields.find((f) => f.id === 'style:margin-horizontal').mixed, true)
assert.equal(asymmetric.state.fields.find((f) => f.id === 'style:padding-vertical').mixed, false)
await asymmetric.action({
  root: '/a',
  generation: asymmetric.state.generation,
  action: 'spacing:padding'
})
assert.deepEqual(
  spacingFields('padding').map((field) => field.axis),
  ['right', 'left', 'top', 'bottom']
)
assert.deepEqual(spacingSnapshot('margin'), collapsedMargin)

// Styles gestures stay frontend-only until one Apply submits their accumulated intent.
let authoredHash = 'base'
let authoredOpacity = '1'
let authoredWidth = '10px'
const draftCalls = []
const draftAgent = []
setSourceOwner({
  read: async () => ({ path: 'a.tsx', hash: authoredHash, binary: false, size: 10 })
})
const drafts = new NativeInspectorController(
  async (channel) => {
    draftCalls.push(channel)
    if (channel === 'styles:read')
      return {
        values: { opacity: authoredOpacity, width: authoredWidth, display: 'block' },
        specified: { opacity: authoredOpacity, width: authoredWidth }
      }
    if (channel === 'props:inspect') return null
    if (channel === 'controls:list' || channel === 'controls:get') return []
    if (channel === 'styles:resolve-class') return null
    if (channel === 'styles:apply') return { applied: true }
    return null
  },
  async (...args) => draftCalls.push(args),
  () => {},
  async (...args) => draftAgent.push(args),
  async () => {}
)
await drafts.activate('/a')
await drafts.select(element)
const draftAction = (action, extra = {}) =>
  drafts.action({
    root: '/a',
    generation: drafts.state.generation,
    action,
    ...extra
  })
const beforeDraft = draftCalls.filter((call) => call === 'styles:apply').length
await draftAction('apply', { field: 'style:opacity', value: '0.6' })
await draftAction('apply', { field: 'style:width', value: '12px' })
assert.equal(drafts.state.draft.count, 2)
await draftAction('close')
assert.equal(drafts.state.draft.preview, false, 'closed inspector cannot claim a cleared preview')
assert.equal(drafts.state.draft.count, 2, 'closing retains pending edits')
await drafts.select(element)
assert.equal(drafts.state.draft.preview, true, 'reselecting projects the pending preview again')
assert.equal(draftCalls.filter((call) => call === 'styles:apply').length, beforeDraft)
assert.equal(draftAgent.length, 0, 'no model turn per small Styles adjustment')
await draftAction('undo-draft')
assert.equal(drafts.state.draft.count, 1)
await draftAction('apply', { field: 'style:width', value: '12px' })
authoredHash = 'external'
await draftAction('apply-drafts')
assert.equal(draftAgent.length, 0, 'stale source is refused before agent submission')
assert.equal(drafts.state.draft.count, 2, 'failed Apply retains draft')
authoredHash = 'base'
await draftAction('revert-draft')
await draftAction('apply', { field: 'style:opacity', value: '0.6' })
await draftAction('apply', { field: 'style:width', value: '12px' })
await draftAction('apply-drafts')
assert.equal(draftAgent.length, 1, 'one agent operation submits all values')
assert.equal(drafts.state.draft.submitted, true)
await drafts.settleDraftTurn(true)
assert.equal(
  drafts.state.draft.submitted,
  false,
  'a landed turn without source edits unlocks the draft'
)
assert.equal(drafts.state.draft.count, 2, 'unconfirmed edits stay pending')
await draftAction('undo-draft')
assert.equal(drafts.state.draft.count, 1, 'unconfirmed draft remains actionable')
await draftAction('apply', { field: 'style:width', value: '12px' })
await draftAction('apply-drafts')
assert.equal(draftAgent.length, 2, 'pending draft can be submitted again')
authoredHash = 'applied'
authoredOpacity = '0.6'
authoredWidth = '12px'
await drafts.settleDraftTurn(true)
assert.equal(drafts.state.draft, undefined, 'source and rendered values confirm Apply')
await draftAction('apply', { field: 'style:opacity', value: '0.4' })
await draftAction('revert-draft')
assert.equal(drafts.state.draft, undefined)
const sourceWrites = draftCalls.filter((call) => call === 'styles:apply').length
await draftAction('apply', { field: 'style:opacity', value: '0.3' })
assert.equal(draftCalls.filter((call) => call === 'styles:apply').length, sourceWrites)
await draftAction('apply-drafts')
assert.equal(draftCalls.filter((call) => call === 'styles:apply').length, sourceWrites + 1)
authoredHash = 'single-applied'
authoredOpacity = '0.3'
await drafts.invalidated()
assert.equal(drafts.state.draft, undefined, 'single edit confirms source and rendered value')
setSourceOwner(null)
assert.deepEqual(spacingSnapshot('padding'), {
  'style:padding-right': '18px',
  'style:padding-left': 'var(--space)',
  'style:padding-top': '4',
  'style:padding-bottom': '4'
})
assert.equal(
  asymmetric.state.fields.find((f) => f.id === 'style:padding-left').value,
  'var(--space)'
)
await asymmetric.action({
  root: '/a',
  generation: asymmetric.state.generation,
  action: 'preview',
  field: 'style:padding-left',
  value: '14'
})
await asymmetric.invalidated()
assert.equal(asymmetric.state.fields.find((f) => f.id === 'style:padding-left').value, '14px')
await asymmetric.action({
  root: '/a',
  generation: asymmetric.state.generation,
  action: 'cancel-preview',
  field: 'style:padding-left'
})
assert.equal(
  asymmetric.state.fields.find((f) => f.id === 'style:padding-left').value,
  'var(--space)'
)
await asymmetric.action({
  root: '/a',
  generation: asymmetric.state.generation,
  action: 'spacing:padding'
})
assert.deepEqual(
  spacingFields('padding').map((field) => field.axis),
  ['horizontal', 'vertical']
)
assert.deepEqual(spacingSnapshot('padding'), collapsedPadding)
assert.equal(asymmetric.state.fields.find((f) => f.id === 'style:padding-horizontal').mixed, true)
await asymmetric.action({
  root: '/a',
  generation: asymmetric.state.generation,
  action: 'spacing:margin'
})
assert.deepEqual(
  spacingFields('margin').map((field) => field.axis),
  ['right', 'left', 'top', 'bottom']
)
assert.deepEqual(spacingSnapshot('margin'), {
  'style:margin-right': '-6px',
  'style:margin-left': 'auto',
  'style:margin-top': '-2',
  'style:margin-bottom': '0'
})
await asymmetric.action({
  root: '/a',
  generation: asymmetric.state.generation,
  action: 'spacing:margin'
})
assert.deepEqual(spacingSnapshot('margin'), collapsedMargin)
