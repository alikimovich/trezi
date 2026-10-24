import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ControlPanelManifest } from '../shared/api'
import type { NativeBridge } from './bridge'
import type { NativeInspectorController } from './inspector-controller'
import { waitFor } from './smoke-wait'

export interface CustomSmoke {
  host: NativeBridge
  fixture: string
  artifacts: string
  inspector: NativeInspectorController
  invoke: (channel: string, ...args: any[]) => Promise<any>
  /** Stamps the preview heading with `source` and selects it. */
  select: (source: string) => Promise<void>
  open: () => Promise<void>
}

const FILE = 'native-custom.tsx'
const SOURCE =
  'const RADIUS_PX = 12\nconst SHADOW = true\nexport function Card() { return <div style={{ borderRadius: RADIUS_PX, boxShadow: SHADOW ? "0 1px 2px black" : "none" }}>Card</div> }\n'
const radius = (max: number) => ({
  id: 'radius',
  label: 'Corner radius',
  kind: 'number',
  unit: 'px',
  min: 0,
  max,
  step: 1,
  apply: { strategy: 'literal', anchor: 'const RADIUS_PX = ' }
})
const shadow = {
  id: 'shadow',
  label: 'Shadow',
  kind: 'toggle',
  apply: { strategy: 'literal', anchor: 'const SHADOW = ' }
}

/**
 * LKM-323: the Custom tab shows its request field; a request (sent with Return in the
 * native field) is answered by a stubbed agent and its panel renders live controls; a
 * comment on one control revises it in place and keeps the other; Remove Control and
 * Remove Panel delete them. The agent turn is stubbed: no provider is called.
 */
export async function checkInspectorCustom(s: CustomSmoke) {
  const { host, inspector, invoke } = s
  writeFileSync(join(s.fixture, FILE), SOURCE)
  const answers: unknown[] = [],
    prompts: string[] = []
  const generate = inspector.custom.generate
  inspector.custom.generate = async (_root, prompt, id) => {
    prompts.push(prompt)
    return `Done.\n\`\`\`trezi-controls\n${JSON.stringify({ request: id, manifest: answers.shift() })}\n\`\`\``
  }
  const custom = (c: Record<string, unknown> = {}) => host.request('inspectorCustom', c)
  const perform = async (action: string, extra: { field?: string; value?: string } = {}) => {
    const state = await host.request('inspectorInspect')
    await host.request('inspectorPerform', {
      action: { root: s.fixture, generation: state.generation, action, ...extra }
    })
  }
  const panel = async (): Promise<ControlPanelManifest | undefined> =>
    ((await invoke('controls:list', s.fixture)) as ControlPanelManifest[]).find(
      (p) => p.file === FILE
    )
  try {
    await s.select(`${FILE}:3:26`)
    await s.open()
    await perform('tab', { value: 'custom' })
    const empty = await waitFor(
      async () => {
        const state = await custom()
        return state.tab === 'custom' && state.request.found && state.request.editable && state
      },
      'Custom tab request field',
      10000,
      () => custom()
    )
    assert.equal(empty.placeholder, 'Ask for controls…')
    assert.ok(empty.request.visible && empty.request.height >= 30, JSON.stringify(empty.request))

    // A request typed into the field and sent with Return becomes a live panel.
    answers.push({ file: FILE, component: 'Card', title: 'Card', params: [radius(48), shadow] })
    await custom({ submit: 'Corner radius and a shadow toggle' })
    const shown = await waitFor(
      async () => {
        const state = await custom()
        return (
          state.controls.includes('custom:card:radius') &&
          state.controls.includes('custom:card:shadow') &&
          !state.pending &&
          state
        )
      },
      'requested panel renders its controls',
      15000,
      () => custom()
    )
    assert.equal(shown.error, '', shown.error)
    assert.equal(shown.request.text, '', 'the sent request clears the field')
    assert.match(prompts[0], /Inspector Custom tab request r/)
    assert.match(prompts[0], /Corner radius and a shadow toggle/)
    assert.match(prompts[0], new RegExp(FILE.replace('.', '\\.')))
    assert.equal((await host.request('inspectorInspect')).values['custom:card:radius'], '12')
    writeFileSync(
      join(s.artifacts, 'inspector-custom.png'),
      Buffer.from((await host.request('captureShell')) as string, 'base64')
    )

    // A comment on one control revises only it; the other control stays.
    await perform('comment-control', { field: 'custom:card:radius' })
    await waitFor(
      async () => (await custom()).target === 'Card › Corner radius',
      'comment target',
      5000,
      () => custom()
    )
    answers.push({ file: FILE, component: 'Card', title: 'Card', params: [radius(64)] })
    await perform('custom-request', { value: 'Allow up to 64' })
    const revised = await waitFor(
      async () => {
        const p = await panel()
        return p?.revision === 2 && p
      },
      'commented control revised',
      15000,
      () => custom()
    )
    assert.deepEqual(
      revised.params.map((p: any) => [p.id, p.max ?? null]),
      [
        ['radius', 64],
        ['shadow', null]
      ]
    )
    assert.match(prompts[1], /Change only the control `radius`/)

    await perform('remove-control', { field: 'custom:card:shadow' })
    await waitFor(
      async () => {
        const state = await custom()
        return !state.controls.includes('custom:card:shadow') && state.controls.length === 1
      },
      'control removed',
      10000,
      () => custom()
    )
    assert.equal((await panel())?.revision, 3)

    await perform('remove:card')
    await waitFor(
      async () => !(await panel()) && (await custom()).controls.length === 0,
      'panel removed',
      10000,
      () => custom()
    )

    // A request whose turn cannot run shows its error and leaves the field usable again.
    inspector.custom.generate = async () => {
      throw new Error('The chat is stopped, so the request was not sent.')
    }
    await perform('custom-request', { value: 'anything' })
    const failed = await waitFor(
      async () => {
        const state = await custom()
        return !state.pending && state.error && state
      },
      'failed request shows its error',
      10000,
      () => custom()
    )
    assert.match(failed.error, /request was not sent/)
    assert.ok(failed.request.editable, 'the field is usable after a failed request')
  } finally {
    inspector.custom.generate = generate
  }
}

export async function restoreInspectorCustom(s: CustomSmoke) {
  for (const p of (await s
    .invoke('controls:list', s.fixture)
    .catch(() => [])) as ControlPanelManifest[])
    if (p.file === FILE) await s.invoke('controls:remove', s.fixture, p.id)
  rmSync(join(s.fixture, FILE), { force: true })
  const state = await s.host.request('inspectorInspect')
  if (state.visible)
    await s.host.request('inspectorPerform', {
      action: { root: s.fixture, generation: state.generation, action: 'tab', value: 'styles' }
    })
}
