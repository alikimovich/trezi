import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChatIslandTool } from '../main/chat-islands'
import { type ShadowLightInput, shadowLight } from '../main/shadows'
import type { NativeBridge } from './bridge'
import { nativeChat, nativeIslands } from './chat-runtime'
import { serviceEvents } from './platform'
import { captureForegroundChat } from './smoke-input'
import { missingShadowCaptureSemantics } from './smoke-shadow-semantics'

/** Called inside smoke-islands' disposable fixture and restoration scope. */
export async function checkShadowIsland(host: NativeBridge, fixture: string, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const file = join(fixture, 'island-light.js')
  const initial: ShadowLightInput = {
    x: 0.72,
    y: -0.28,
    distance: 12,
    blur: 24,
    layers: 3,
    decay: 0.6,
    color: 'rgba(0, 0, 0, 0.35)'
  }
  const keys = Object.keys(initial) as (keyof ShadowLightInput)[]
  const code =
    keys.map((key) => `const SHADOW_${key} = ${JSON.stringify(initial[key])};`).join('\n') +
    `
const SHADOW_CSS = ${JSON.stringify(shadowLight(initial).css)};
const card = document.createElement('div');
card.id = 'island-shadow-demo'; card.textContent = 'Shadow Light';
card.style.cssText = 'margin:80px;padding:40px;background:white;border-radius:20px;width:180px';
card.style.boxShadow = SHADOW_CSS;
document.body.append(card);
`
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  const wait = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 160; i++) {
      try {
        if (await check()) return
      } catch {
        /* Reload/HMR can replace the document mid-read. */
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Shadow Light native fixture did not reach the expected source/preview state.')
  }
  const previewMatches = async (values: ShadowLightInput) =>
    !!(await page(`(() => {
    const card = document.querySelector('#island-shadow-demo');
    if (!card || card.textContent !== 'Shadow Light') return false;
    const probe = document.createElement('div');
    probe.style.boxShadow = ${JSON.stringify(shadowLight(values).css)};
    document.body.append(probe);
    const expected = getComputedStyle(probe).boxShadow;
    probe.remove();
    return expected !== 'none' && getComputedStyle(card).boxShadow === expected;
  })()`))
  writeFileSync(file, code)
  await wait(() => previewMatches(initial))
  chat.messages = [
    {
      id: 'shadow-request',
      role: 'user',
      text: 'Surface Shadow Light controls.',
      statuses: [],
      segments: [{ kind: 'text', text: 'Surface Shadow Light controls.' }]
    },
    {
      id: 'shadow-answer',
      role: 'assistant',
      text: 'Adjust the light and layered shadow.',
      statuses: [],
      segments: [{ kind: 'text', text: 'Adjust the light and layered shadow.' }]
    }
  ]
  const bounds = [
    [-1, 1],
    [-1, 1],
    [0, 64],
    [0, 80],
    [1, 8],
    [0, 1]
  ]
  const result = (await runChatIslandTool(chat.chat, fixture, {
    action: 'define',
    engine: 'agent',
    manifest: {
      file: 'island-light.js',
      component: 'Card',
      title: 'Shadow Light',
      params: [
        ...keys.map((key, i) => ({
          id: key,
          label: key[0].toUpperCase() + key.slice(1),
          kind: i === 6 ? 'color' : 'number',
          ...(i < 6
            ? {
                min: bounds[i][0],
                max: bounds[i][1],
                step: i === 4 ? 1 : 0.01,
                ...(['distance', 'blur'].includes(key) ? { unit: 'px' } : {})
              }
            : {}),
          apply: { strategy: 'literal', anchor: `const SHADOW_${key} = ` }
        })),
        {
          id: 'output',
          label: 'CSS',
          kind: 'text',
          apply: { strategy: 'literal', anchor: 'const SHADOW_CSS = ' }
        }
      ]
    },
    blocks: [
      {
        id: 'shadow',
        title: 'Shadow Light',
        kind: 'shadow',
        output: 'css',
        params: [...keys, 'output']
      }
    ]
  })) as any
  assert.ok(result.id, JSON.stringify(result))
  serviceEvents.emit('event', 'agent:event', {
    projectKey: chat.chat,
    type: 'done',
    landingPending: false
  })
  await wait(async () =>
    (await host.request('chatInspect')).islands.some(
      (i: any) => i.id === result.id && i.status === 'ready'
    )
  )
  const view = () => nativeIslands.sessions.get(chat.chat)!.views.get(result.id)!
  assert.equal(view().blocks[0].kind, 'shadow')
  assert.equal(view().fields.length, 8)
  const swiftReady = async () =>
    (await host.request('chatInspect')).islands.some(
      (i: any) =>
        i.id === result.id &&
        i.sourceRevision === view().sourceRevision &&
        i.blockKinds?.[0] === 'shadow' &&
        i.fields === 8
    )
  await wait(swiftReady)
  const capture = async (name: string) => {
    const recognized: string[][] = []
    // Tall panels need two viewport captures; both come from the real window.
    for (const bottom of [false, true]) {
      const revealed = await host.request('revealChatIsland', { island: result.id, bottom })
      const layout = await host.request('chatInspect')
      assert.equal(
        layout.revealAppliedRevision,
        revealed.revision,
        'SwiftUI applied the acknowledged island reveal'
      )
      const image = await captureForegroundChat(host)
      assert.ok(image.width > 200 && image.height > 200, 'Nonempty visible chat viewport')
      const stem = `shadow-light-${name}${bottom ? '-bottom' : ''}`
      writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
      writeFileSync(
        join(artifacts, `${stem}.json`),
        JSON.stringify(
          {
            text: image.text,
            width: image.width,
            height: image.height,
            reveal: revealed,
            islandPositions: layout.islandPositions
          },
          null,
          2
        )
      )
      recognized.push(image.text)
    }
    const missing = missingShadowCaptureSemantics(recognized[0], recognized[1])
    assert.deepEqual(
      missing,
      [],
      `Visible Shadow Light capture is missing ${missing.join(', ')}; title and Light Source must be visible at the top with no Preview box, while controls, output and Undo may span shadow-light-${name}*.png`
    )
  }
  await capture('initial')
  // Each independently adjustable control must change the actual computed shadow.
  const edits: Partial<ShadowLightInput>[] = [
    { x: -0.8, y: 0.4 },
    { distance: 40 },
    { blur: 60 },
    { layers: 6 },
    { decay: 0.2 },
    { color: 'rgba(60, 90, 160, 0.6)' }
  ]
  for (const [index, values] of edits.entries()) {
    const expected = { ...initial, ...values }
    await host.request('islandPerform', { island: result.id, action: 'commit', values })
    await wait(() =>
      Object.entries(values).every(([key, value]) =>
        readFileSync(file, 'utf8').includes(`const SHADOW_${key} = ${JSON.stringify(value)};`)
      )
    )
    await wait(() => previewMatches(expected))
    await wait(
      () => view().fields.find((f) => f.id === 'output')?.value === shadowLight(expected).css
    )
    await wait(swiftReady)
    if (index === 0) await capture('adjusted')
    await host.request('islandPerform', { island: result.id, action: 'undo' })
    await wait(() => readFileSync(file, 'utf8') === code)
    await wait(() => previewMatches(initial))
    await wait(swiftReady)
  }
  const drag = await checkShadowDrag(
    host,
    result.id,
    file,
    code,
    initial,
    page,
    wait,
    previewMatches,
    artifacts
  )
  await host.request('islandPerform', { island: result.id, action: 'undo' })
  await wait(() => readFileSync(file, 'utf8') === code)
  await wait(() => previewMatches(initial))
  await wait(swiftReady)
  await capture('restored')
  console.log(
    `NATIVE SHADOW LIGHT PASS — visible window captures contain Shadow Light controls and no Preview box; all six controls update computed preview CSS; a ${drag.steps}-step drag shows every frame through the preview override (${drag.samples} sampled frames, ${drag.gaps} gaps, ${drag.outOfOrder} out of order, ${drag.foreign} foreign) with no source write until the release, and one Undo restores source and preview. Layout fidelity still requires inspection of shadow-light-*.png against the approved mockup.`
  )
}

/**
 * A live drag of the light (LKM-140): each frame goes through Swift with one gesture id and is
 * shown at once through the preview override, with no source write (so no reload or HMR)
 * until the release. A page-world sampler records the card's computed box-shadow every
 * animation frame; each must be the derived value of the current or previous step.
 */
async function checkShadowDrag(
  host: NativeBridge,
  island: string,
  file: string,
  code: string,
  initial: ShadowLightInput,
  page: (code: string) => Promise<any>,
  wait: (check: () => Promise<boolean> | boolean) => Promise<void>,
  previewMatches: (values: ShadowLightInput) => Promise<boolean>,
  artifacts: string
) {
  const gesture = `smoke-drag-${Date.now()}`
  const path = [
    [-0.5, 0.2],
    [-0.45, 0.26],
    [-0.4, 0.32],
    [-0.3, 0.4],
    [-0.2, 0.5],
    [0, 0.6],
    [0.15, 0.7],
    [0.3, 0.8]
  ]
  const steps = [initial, ...path.map(([x, y]) => ({ ...initial, x, y }))].map(
    (values) => shadowLight(values).css
  )
  await page(`(() => {
    const card = document.querySelector('#island-shadow-demo');
    window.__shadowStep = 0; window.__shadowFrames = [];
    const tick = () => { if (!card.isConnected) return; window.__shadowFrames.push([window.__shadowStep, getComputedStyle(card).boxShadow]); requestAnimationFrame(tick) };
    requestAnimationFrame(tick);
    return true;
  })()`)
  for (const [index, [x, y]] of path.entries()) {
    await page(`window.__shadowStep = ${index + 1}`)
    await host.request('islandPerform', {
      island,
      action: 'commit',
      values: { x, y },
      gesture,
      ended: false
    })
    await wait(() => previewMatches({ ...initial, x, y }))
    assert.equal(readFileSync(file, 'utf8'), code, 'A drag frame is shown without a source write')
  }
  // [step sent, index of the derived step shown, gap] per sampled frame.
  const sampled: [number, number, boolean][] = await page(`(() => {
    const probe = document.createElement('div'); document.body.append(probe);
    const computed = ${JSON.stringify(steps)}.map(css => { probe.style.boxShadow = css; return getComputedStyle(probe).boxShadow });
    probe.remove();
    return window.__shadowFrames.map(([step, shown]) => [step, computed.lastIndexOf(shown), shown === 'none']);
  })()`)
  let last = -1,
    gaps = 0,
    outOfOrder = 0,
    foreign = 0
  for (const [step, index, none] of sampled) {
    if (none) gaps++
    else if (index < 0 || index < step - 1) foreign++
    else if (index < last) outOfOrder++
    last = Math.max(last, index)
  }
  const shell = async (name: string) =>
    writeFileSync(
      join(artifacts, `shadow-light-${name}.png`),
      Buffer.from(await host.request('captureShell'), 'base64')
    )
  await shell('drag')
  // The release writes the source once; the static fixture then reloads with the final value.
  const [x, y] = path.at(-1)!
  await host.request('islandPerform', {
    island,
    action: 'commit',
    values: { x, y },
    gesture,
    ended: true
  })
  await wait(() =>
    readFileSync(file, 'utf8').includes(`const SHADOW_x = ${x};\nconst SHADOW_y = ${y};`)
  )
  await wait(() => previewMatches({ ...initial, x, y }))
  await wait(
    async () =>
      (await page(
        `document.querySelector('#island-shadow-demo')?.style.getPropertyPriority('box-shadow') === ''`
      )) === true
  )
  await shell('released')
  const report = {
    steps: path.length,
    samples: sampled.length,
    gaps,
    outOfOrder,
    foreign,
    sourceWritesDuringDrag: 0
  }
  writeFileSync(join(artifacts, 'shadow-light-drag.json'), JSON.stringify(report, null, 2))
  if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1')
    assert.ok(sampled.length > 0, 'The drag sampler recorded animation frames')
  assert.deepEqual(
    [gaps, outOfOrder, foreign],
    [0, 0, 0],
    `Every sampled frame shows the current or previous step: ${JSON.stringify(report)}`
  )
  return report
}
