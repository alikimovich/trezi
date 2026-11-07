import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { islandSource, sourceHash } from '../main/chat-island-source'
import { runChatIslandTool } from '../main/chat-islands'
import type { NativeBridge } from './bridge'
import { nativeChat, nativeIslands } from './chat-runtime'
import { serviceEvents } from './platform'
import { parseSmokeGroups } from './smoke-groups'
import { checkIslandStatus } from './smoke-island-status'
import { checkShadowIsland } from './smoke-shadow-island'

/** Real Swift decoding/actions and source writes; no provider or Jev network call.
 *  Runs the generic island check and/or Shadow Light as `--only` selects (smoke-groups'
 *  `islands` / `shadow-light`; both by default); they share this fixture and restoration scope. */
export async function checkChatIslands(host: NativeBridge, fixture: string, artifacts: string) {
  const groups = parseSmokeGroups(process.argv)
  const parts = { islands: groups.has('islands'), shadow: groups.has('shadow-light') }
  const chat = nativeChat.get(nativeChat.active)
  const messages = chat.messages
  const context = chat.context
  if (context)
    chat.context = { ...context, tokens: { ...context.tokens, needed: false }, notes: [] }
  const session = nativeIslands.sessions.get(chat.chat)
  assert.ok(session, 'Chat islands registered against the durable session record')
  // Replace only the provider turn in this fixture. It still exercises the
  // island's one-Apply request, source owner write, terminal reconciliation and
  // the rendered page; no real provider or desktop login is required.
  const agentPort = nativeIslands as unknown as {
    applyDraft: (key: string, prompt: string) => Promise<string>
    confirmRendered?: (
      key: string,
      record: unknown,
      values: Record<string, number>,
      revision: string
    ) => Promise<boolean>
  }
  const originalApply = agentPort.applyDraft
  const productionConfirm = agentPort.confirmRendered
  assert.ok(productionConfirm, 'production chat runtime installs the rendered-value probe')
  let applyTurn = 0
  let pendingApplyTurn = ''
  agentPort.applyDraft = async (key, prompt) => {
    const active = nativeIslands.sessions.get(key)
    const entry = [...(active?.drafts.entries() ?? [])].find(([id]) => active?.views.has(id))
    assert.ok(entry, 'Apply has a source-bound draft')
    const [id, draft] = entry
    const view = active?.views.get(id)
    assert.ok(view)
    assert.ok(prompt.includes(view.sourceRevision), 'agent request carries exact source revision')
    await nativeIslands.interact({
      chat: key,
      id,
      revision: view.revision,
      sourceRevision: view.sourceRevision,
      action: 'commit',
      operation: randomUUID(),
      values: draft.values
    })
    pendingApplyTurn = `smoke-island-apply-${++applyTurn}`
    return pendingApplyTurn
  }
  const settleApply = async () => {
    assert.ok(pendingApplyTurn, 'exactly one agent source operation was requested')
    const turn = pendingApplyTurn
    pendingApplyTurn = ''
    await nativeIslands.settle(chat.chat, true, turn)
  }
  // Smoke islands go to scratch histories, so the chat's own history (and every later
  // check) never sees them; the owner writes each history, so nothing is reset by hand.
  const { root: islandRoot, recordId, turn } = session
  const scratch = () =>
    nativeIslands.register(chat.chat, islandRoot, `smoke-islands-${randomUUID()}`, turn)
  scratch()
  const file = join(fixture, 'island-light.js')
  const indexFile = join(fixture, 'index.html')
  const originalIndex = readFileSync(indexFile, 'utf8')
  const page = (code: string) => host.request('evaluate', { view: 'preview', code })
  let initialShadow = ''
  const revisionStamp = (text: string) => {
    const normalized = text.includes('data-trezi-revision')
      ? text.replace(
          /data-trezi-revision', '[a-f0-9]{64}/,
          `data-trezi-revision', '${'0'.repeat(64)}`
        )
      : text.replace(
          /(card\.setAttribute\('data-trezi-source', '[^\n]+\n)/,
          `$1card.setAttribute('data-trezi-revision', '${'0'.repeat(64)}');\n`
        )
    return normalized.replace('0'.repeat(64), sourceHash(normalized))
  }
  const code = revisionStamp(
    'const LIGHT_X = 0;\nconst LIGHT_Y = -0.5;\nconst SOFTNESS = 20;\nconst EASING = [0.25, 0.1, 0.25, 1];\nconst OPACITY = 1;\n' +
      `
const card = document.createElement('div');
card.id = 'island-shadow-demo'; card.textContent = 'Light-driven shadow';
card.setAttribute('data-trezi-source', 'island-light.js:7:1');
card.style.opacity = OPACITY;
card.style.boxShadow = (LIGHT_X * -12) + 'px ' + (LIGHT_Y * -12) + 'px ' + SOFTNESS + 'px rgba(0,0,0,0.12)';
document.body.append(card);
`
  )
  writeFileSync(file, code)
  writeFileSync(indexFile, originalIndex + '<script src="/island-light.js"></script>')
  const wait = async (check: () => Promise<boolean> | boolean, label = 'unlabelled') => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    const islands = await host
      .request('chatInspect')
      .then((s: { islands?: unknown }) => JSON.stringify(s.islands))
      .catch((error: unknown) => `unavailable: ${String(error)}`)
    // Short facts first: the failure report truncates a long message.
    const controls = await Promise.all(
      ['Light X', 'Light Y'].map((name) =>
        host
          .request('islandControlInspect', { label: name })
          .then(
            (c: { value?: string; visible?: boolean; scanned?: number }) =>
              `${name}=${c.value}/${c.visible}/scanned:${c.scanned}`
          )
          .catch((error: unknown) => `${name}=unavailable: ${String(error)}`)
      )
    )
    throw new Error(
      `Native chat island did not update at [${label}]; controls ${controls.join(' ')}; preview=${JSON.stringify(await page("({ready:document.readyState, demo:!!document.querySelector('#island-shadow-demo')})"))}; islands=${islands}; page=${JSON.stringify(await page("({url:location.href, ready:document.readyState, scripts:Array.from(document.scripts,s=>s.src), demo:!!document.querySelector('#island-shadow-demo')})"))}`
    )
  }
  try {
    if (parts.islands) {
      chat.messages = [
        {
          id: 'island-request',
          role: 'user',
          text: 'Let me tune the light and shadow layers.',
          statuses: [],
          segments: [{ kind: 'text', text: 'Let me tune the light and shadow layers.' }]
        },
        {
          id: 'island-answer',
          role: 'assistant',
          text: 'Move the light or adjust the shadow softness.',
          statuses: [],
          segments: [{ kind: 'text', text: 'Move the light or adjust the shadow softness.' }]
        }
      ]
      await wait(
        async () => await page("!!document.querySelector('#island-shadow-demo')"),
        'preview shows the island demo'
      )
      initialShadow = await page("document.querySelector('#island-shadow-demo').style.boxShadow")
      const result = (await runChatIslandTool(chat.chat, fixture, {
        action: 'define',
        engine: 'agent',
        manifest: {
          file: 'island-light.js',
          component: 'Card',
          title: 'Card shadows',
          params: [
            ...['X', 'Y'].map((axis) => ({
              id: axis.toLowerCase(),
              label: `Light ${axis}`,
              kind: 'number',
              min: -1,
              max: 1,
              step: 0.01,
              apply: { strategy: 'literal', anchor: `const LIGHT_${axis} = ` }
            })),
            {
              id: 'blur',
              label: 'Softness',
              kind: 'number',
              min: 0,
              max: 100,
              unit: 'px',
              apply: { strategy: 'literal', anchor: 'const SOFTNESS = ' }
            },
            {
              id: 'ease',
              label: 'Entrance easing',
              kind: 'bezier',
              apply: { strategy: 'literal', anchor: 'const EASING = ' }
            }
          ]
        },
        blocks: [
          { id: 'light', title: 'Light position', kind: 'point', params: ['x', 'y'] },
          { id: 'layers', title: 'Shadow layers', kind: 'group', params: ['blur'] },
          { id: 'motion', title: 'Motion', kind: 'group', params: ['ease'] }
        ]
      })) as any
      assert.ok(result.id, JSON.stringify(result))
      await wait(
        async () =>
          (await host.request('chatInspect')).islands.some(
            (i: any) => i.id === result.id && i.status === 'waiting'
          ),
        'island waiting for the turn to land'
      )
      serviceEvents.emit('event', 'agent:event', {
        projectKey: chat.chat,
        type: 'done',
        landingPending: false
      })
      await wait(
        async () =>
          (await host.request('chatInspect')).islands.some(
            (i: any) => i.id === result.id && i.status === 'ready'
          ),
        'island ready after the turn lands'
      )
      await host.request('revealChatIsland', { island: result.id })
      await host.request('islandPerform', {
        island: result.id,
        action: 'draft',
        values: { x: 0.75, y: -0.25 }
      })
      assert.equal(readFileSync(file, 'utf8'), code, 'island draft does not write source')
      await wait(
        async () =>
          (await host.request('chatInspect')).islands.some(
            (i: any) => i.id === result.id && i.draftCount === 2 && i.draftPreview === false
          ),
        'island draft of two values staged'
      )
      await wait(
        async () =>
          (await host.request('islandControlInspect', { label: 'Light X' })).value === '0.75',
        'Light X control shows the drafted 0.75'
      )
      await host.request('islandPerform', { island: result.id, action: 'undo-draft' })
      await wait(
        async () =>
          !(await host.request('chatInspect')).islands.some(
            (i: any) => i.id === result.id && i.draftCount !== 0
          ),
        'island draft cleared by undo-draft'
      )
      await wait(
        async () =>
          (await host.request('islandControlInspect', { label: 'Light X' })).value === '0' &&
          (await host.request('islandControlInspect', { label: 'Light Y' })).value === '-0.5',
        'Light X/Y controls restored to source values after undo-draft'
      )
      await host.request('islandPerform', {
        island: result.id,
        action: 'draft',
        values: { x: 0.75, y: -0.25 }
      })
      await host.request('islandPerform', { island: result.id, action: 'apply-draft' })
      await wait(
        async () =>
          (await host.request('chatInspect')).islands.some(
            (i: any) => i.id === result.id && i.draftSubmitted === true
          ),
        'island draft submitted by Apply'
      )
      await settleApply()
      assert.ok(
        nativeIslands.sessions.get(chat.chat)?.drafts.has(result.id),
        'unmapped literal source cannot clear a draft without rendered confirmation'
      )
      assert.match(
        nativeIslands.sessions.get(chat.chat)?.views.get(result.id)?.notice ?? '',
        /no rendered-value check/
      )
      assert.equal(
        nativeIslands.sessions.get(chat.chat)?.views.get(result.id)?.draft?.conflict,
        false,
        'unsupported readback remains retryable after its source change'
      )
      await wait(
        () =>
          readFileSync(file, 'utf8').includes('LIGHT_X = 0.75') &&
          readFileSync(file, 'utf8').includes('LIGHT_Y = -0.25'),
        'island Apply wrote the drafted light values to source'
      )
      await wait(async () => {
        try {
          return (
            (await page("document.querySelector('#island-shadow-demo')?.style.boxShadow")) !==
              initialShadow && !!(await page("document.querySelector('#island-shadow-demo')"))
          )
        } catch {
          return false
        }
      }, 'preview shadow changed after the island Apply')
      await host.request('islandPerform', { island: result.id, action: 'revert-draft' })
      assert.equal(
        nativeIslands.sessions.get(chat.chat)?.views.get(result.id)?.draft,
        undefined,
        'unsupported source edit leaves a draft the user can explicitly dismiss'
      )
      await new Promise((r) => setTimeout(r, 150))
      await host.request('islandPerform', { island: result.id, action: 'undo' })
      await wait(
        () => readFileSync(file, 'utf8') === code,
        'island Undo restored the original source'
      )
      writeFileSync(
        join(artifacts, 'chat-island.png'),
        Buffer.from(await host.request('captureShell'), 'base64')
      )
      assert.deepEqual(await host.request('webViews'), ['preview'])
      await checkIslandStatus(host, chat.chat, result.id, file, code, artifacts, wait)
      // Exercise the production callback and real WebKit transport. A literal's
      // source hash alone cannot pass this check.
      const record = nativeIslands.sessions
        .get(chat.chat)
        ?.records.find((item) => item.id === result.id)
      assert.ok(record)
      const opacityRecord = {
        ...record,
        manifest: {
          ...record.manifest,
          params: [
            {
              id: 'opacity',
              label: 'Opacity',
              kind: 'number' as const,
              min: 0,
              max: 1,
              apply: { strategy: 'literal' as const, anchor: 'const OPACITY = ' },
              rendered: {
                kind: 'computed-style' as const,
                selector: '#island-shadow-demo',
                property: 'opacity' as const
              }
            }
          ]
        },
        blocks: [{ id: 'opacity', title: 'Opacity', kind: 'group' as const, params: ['opacity'] }]
      }
      const oldRevision = (await islandSource(fixture, opacityRecord)).revision
      const updatedCode = revisionStamp(code.replace('const OPACITY = 1;', 'const OPACITY = 0.5;'))
      writeFileSync(file, updatedCode)
      await wait(async () => {
        const loaded = (await page(
          "({opacity:getComputedStyle(document.querySelector('#island-shadow-demo')).opacity, revision:document.querySelector('#island-shadow-demo').getAttribute('data-trezi-revision')})"
        )) as { opacity?: string; revision?: string } | null
        return (
          loaded?.opacity === '0.5' &&
          loaded.revision === updatedCode.match(/data-trezi-revision', '([a-f0-9]{64})/)?.[1]
        )
      }, 'preview reloads the source-stamped opacity 0.5 revision')
      const newRevision = (await islandSource(fixture, opacityRecord)).revision
      assert.equal(
        await productionConfirm(chat.chat, opacityRecord, { opacity: 0.5 }, oldRevision),
        false,
        'a stale source revision cannot confirm a rendered value'
      )
      assert.equal(
        await productionConfirm(chat.chat, opacityRecord, { opacity: 0.5 }, newRevision),
        true,
        'the actual source-stamped preview frame confirms the new rendered value'
      )
      scratch()
      await nativeIslands.refresh(chat.chat)
    }
    if (parts.shadow) await checkShadowIsland(host, fixture, artifacts, settleApply)
    if (parts.islands)
      console.log(
        'NATIVE ISLANDS PASS — Swift rendering, typed point action, source batch/Undo, landing gate, disabled/hidden states; no live model calls.'
      )
  } finally {
    agentPort.applyDraft = originalApply
    writeFileSync(indexFile, originalIndex)
    // Restoring the page reloads the preview; let that finish so the next check (in a
    // filtered run, shell-layout directly) never styles a document about to be replaced.
    try {
      await wait(async () => {
        try {
          return (
            (await page(
              "document.readyState === 'complete' && !document.querySelector('#island-shadow-demo')"
            )) === true
          )
        } catch {
          return false
        }
      }, 'preview restored without the island demo')
    } catch {}
    chat.context = context
    chat.messages = messages
    nativeIslands.register(chat.chat, islandRoot, recordId, turn)
    await nativeIslands.refresh(chat.chat)
    nativeChat.changed(chat)
  }
}
