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
      await host.request('islandPerform', {
        island: result.id,
        action: 'commit',
        values: { x: 0.75, y: -0.25 }
      })
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
    if (parts.shadow) await checkShadowIsland(host, fixture, artifacts)
    if (parts.islands)
      console.log(
        'NATIVE ISLANDS PASS — Swift rendering, typed point action, source batch/Undo, landing gate, disabled/hidden states; no live model calls.'
      )
  } finally {
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
