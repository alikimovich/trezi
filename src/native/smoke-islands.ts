import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  }
  const originalApply = agentPort.applyDraft
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
  const code =
    'const LIGHT_X = 0;\nconst LIGHT_Y = -0.5;\nconst SOFTNESS = 20;\nconst EASING = [0.25, 0.1, 0.25, 1];\n' +
    `
const card = document.createElement('div');
card.id = 'island-shadow-demo'; card.textContent = 'Light-driven shadow';
card.style.cssText = 'margin:80px;padding:40px;background:white;border-radius:20px;width:180px';
card.style.boxShadow = [-1,-2,-3].map((n,i) => (LIGHT_X*n*12)+'px '+(LIGHT_Y*n*12)+'px '+(SOFTNESS*(i+1))+'px rgba(0,0,0,0.12)').join(',');
document.body.append(card);
`
  writeFileSync(file, code)
  writeFileSync(indexFile, originalIndex + '<script src="/island-light.js"></script>')
  const wait = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(
      `Native chat island did not update; preview=${JSON.stringify(await page("({url:location.href, ready:document.readyState, scripts:Array.from(document.scripts,s=>s.src), demo:!!document.querySelector('#island-shadow-demo')})"))}`
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
      await wait(async () => await page("!!document.querySelector('#island-shadow-demo')"))
      const initialShadow = await page(
        "document.querySelector('#island-shadow-demo').style.boxShadow"
      )
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
      await wait(async () =>
        (await host.request('chatInspect')).islands.some(
          (i: any) => i.id === result.id && i.status === 'waiting'
        )
      )
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
      await host.request('revealChatIsland', { island: result.id })
      await host.request('islandPerform', {
        island: result.id,
        action: 'draft',
        values: { x: 0.75, y: -0.25 }
      })
      assert.equal(readFileSync(file, 'utf8'), code, 'island draft does not write source')
      await wait(async () =>
        (await host.request('chatInspect')).islands.some(
          (i: any) => i.id === result.id && i.draftCount === 2 && i.draftPreview === false
        )
      )
      await wait(
        async () =>
          (await host.request('islandControlInspect', { label: 'Light X' })).value === '0.75'
      )
      await host.request('islandPerform', { island: result.id, action: 'undo-draft' })
      await wait(
        async () =>
          !(await host.request('chatInspect')).islands.some(
            (i: any) => i.id === result.id && i.draftCount !== 0
          )
      )
      await wait(
        async () =>
          (await host.request('islandControlInspect', { label: 'Light X' })).value === '0' &&
          (await host.request('islandControlInspect', { label: 'Light Y' })).value === '-0.5'
      )
      await host.request('islandPerform', {
        island: result.id,
        action: 'draft',
        values: { x: 0.75, y: -0.25 }
      })
      await host.request('islandPerform', { island: result.id, action: 'apply-draft' })
      await wait(async () =>
        (await host.request('chatInspect')).islands.some(
          (i: any) => i.id === result.id && i.draftSubmitted === true
        )
      )
      await settleApply()
      await wait(
        () =>
          readFileSync(file, 'utf8').includes('LIGHT_X = 0.75') &&
          readFileSync(file, 'utf8').includes('LIGHT_Y = -0.25')
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
      })
      assert.equal(
        nativeIslands.sessions.get(chat.chat)?.views.get(result.id)?.draft,
        undefined,
        'source-backed island value clears the submitted draft'
      )
      await new Promise((r) => setTimeout(r, 150))
      await host.request('islandPerform', { island: result.id, action: 'undo' })
      await wait(() => readFileSync(file, 'utf8') === code)
      writeFileSync(
        join(artifacts, 'chat-island.png'),
        Buffer.from(await host.request('captureShell'), 'base64')
      )
      assert.deepEqual(await host.request('webViews'), ['preview'])
      await checkIslandStatus(host, chat.chat, result.id, file, code, artifacts, wait)
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
      })
    } catch {}
    chat.context = context
    chat.messages = messages
    nativeIslands.register(chat.chat, islandRoot, recordId, turn)
    await nativeIslands.refresh(chat.chat)
    nativeChat.changed(chat)
  }
}
