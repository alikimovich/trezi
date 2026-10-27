import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codeLinkHref, codeLinkMarkdown } from '../shared/code-link'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MESSAGE = 'code-link-click'
const FILTER = codeLinkHref('filter.html', 8, 10)
const INDEX = codeLinkHref('index.html', 3)
const ESCAPES = {
  outside: 'trezi-code:../outside.css#L1',
  symlink: 'trezi-code:code-link-escape.css#L1',
  absolute: 'trezi-code:/etc/hosts#L1'
}
const OTHER = '../Code Link Other'
const DRAFT = '\n<!-- code link draft -->'
/** The project and conversation the check started in, and the conversation step's extra
 *  chat, until the check is restored. */
let started: { key: string; home: string } | undefined
let freshChat: string | undefined

/**
 * LKM-366: an assistant answer's `trezi-code:` candidate links (LKM-364), clicked in the
 * running app's chat as AppKit delivers a link click. Each opens Trezi's own editor at
 * the exact range, selected, banded and in view; nothing reaches AppKit's link handling
 * (NSWorkspace) or another app; links that leave the project (`..`, a symlink, an
 * absolute path) are refused in chat and open nothing; repeated and alternating clicks
 * re-reveal; a stale link from another conversation or project reveals nothing in the
 * one now shown; the editor's draft is kept and no file is written.
 */
export async function checkCodeLinkClick(host: NativeBridge, fixture: string, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const key = nativeWorkspace.state.activeKey!
  started = { key, home: chat.chat }
  const outside = join(fixture, '../outside.css')
  const other = join(fixture, OTHER)
  const read = (file: string) => readFileSync(join(fixture, file), 'utf8')
  const editor = (root = fixture) => host.request('sourceInspect', { root })
  const navigation = (params: Record<string, unknown> = {}, root = fixture) =>
    host.request('sourceNavigation', { root, ...params })
  const perform = (action: Record<string, unknown>) =>
    host.request('sourcePerform', { action: { root: fixture, ...action } })
  const cards = async () => (await host.request('chatInspect')).cardStates as CardState[]
  const click = async (href: string) => {
    const result = await host.request('chatText', { message: MESSAGE, click: href })
    assert.equal(result.appKitLinks, 0, `${href} never reaches AppKit's link handling`)
    return result
  }
  const filterLines = read('filter.html').split('\n').slice(7, 10).join('\n')
  const evidence: Record<string, unknown> = {}
  const capture = async (stem: string, region: 'editor' | 'window', state: unknown) => {
    evidence[stem] = state
    writeFileSync(join(artifacts, `${stem}.json`), JSON.stringify(state, null, 2))
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(`SKIP foreground ${stem} capture: TREZI_NATIVE_BACKGROUND_TEST (offscreen shell)`)
      const png = await host.request('captureShell')
      writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(png, 'base64'))
      return
    }
    const image = await navigation({ capture: region })
    writeFileSync(join(artifacts, `${stem}.png`), Buffer.from(image.png, 'base64'))
  }
  // The exact range, selected (its whole lines) and banded, its first line in view.
  // biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
  const revealedAt = (file: RegExp, start: number, end: number, after: number) => (s: any) =>
    s.visible &&
    file.test(s.source) &&
    s.revealed?.startLine === start &&
    s.revealed?.endLine === end &&
    s.revealed?.bandLength > 0 &&
    s.revealed?.bandMatchesSelection &&
    s.revealed?.firstLineVisible &&
    s.reveal > after
  const reveal = async (href: string, file: RegExp, start: number, end: number) => {
    const before = (await navigation()).reveal
    const clicked = await click(href)
    const state = await waitFor(async () => {
      const s = { ...(await editor()), ...(await navigation()) }
      return revealedAt(file, start, end, before)(s) && s
    }, `${href} revealed lines ${start}-${end}`)
    return { clicked, state }
  }

  writeFileSync(outside, '.outside { color: red; }\n')
  rmSync(join(fixture, 'code-link-escape.css'), { force: true })
  symlinkSync('../outside.css', join(fixture, 'code-link-escape.css'))
  const text = [
    'Two candidates; neither is certain:',
    '',
    `- ${codeLinkMarkdown({ file: 'filter.html', startLine: 8, endLine: 10 })} (class rule)`,
    `- ${codeLinkMarkdown({ file: 'index.html', startLine: 3, endLine: 3 })} (element)`,
    '',
    `Not project files: [outside](${ESCAPES.outside}), [symlink](${ESCAPES.symlink}), [absolute](${ESCAPES.absolute}).`
  ].join('\n')
  chat.messages.push({
    id: MESSAGE,
    role: 'assistant',
    at: Date.now(),
    text,
    statuses: [],
    segments: [{ kind: 'text', text }]
  })
  nativeChat.changed(chat)
  try {
    await waitFor(
      async () =>
        (await host.request('chatInspect')).messages.some((m: { id: string }) => m.id === MESSAGE),
      'code link message shown'
    )
    await host.request('chatAcceptance', { prepare: true })

    // A draft in the editor before any link is followed.
    await perform({ action: 'open', source: 'index.html' })
    await waitFor(
      async () => (await editor()).visible && (await editor()).source === 'index.html',
      'index.html open'
    )
    const { text: shown } = await editor()
    await perform({ action: 'edit', source: 'index.html', revision: 1_000, text: shown + DRAFT })
    await waitFor(async () => (await editor()).dirty, 'index.html draft')
    const disk = { index: read('index.html'), filter: read('filter.html'), outside: '' }
    disk.outside = readFileSync(outside, 'utf8')

    // 1. The first candidate: filter.html 8–10, exactly that code selected.
    const first = await reveal(FILTER, /^filter\.html/, 8, 10)
    assert.equal(first.state.selectedText, filterLines, 'The selection is the linked lines')
    await capture('code-link-reveal', 'editor', first)

    // 2. The same link again, after the caret moved away: it re-selects and scrolls back.
    await navigation({ collapse: true })
    await waitFor(
      async () => !(await editor()).revealed?.bandMatchesSelection,
      'caret moved off the range'
    )
    const repeat = await reveal(FILTER, /^filter\.html/, 8, 10)
    assert.equal(repeat.state.selectedText, filterLines)

    // 3. The other candidate, then back: each click reveals its own range. index.html
    //    opens over its draft, which is kept rather than replaced by the disk text.
    const second = await reveal(INDEX, /^index\.html/, 3, 3)
    assert.ok(
      second.state.dirty && second.state.text.includes(DRAFT.trim()),
      'Following a link keeps the draft'
    )
    const back = await reveal(FILTER, /^filter\.html/, 8, 10)
    await capture('code-link-repeat', 'editor', { repeat, second, back })

    // 4. Links that leave the project: refused in chat with the reason; nothing opens.
    const refused: Record<string, unknown> = {}
    for (const [name, href] of Object.entries(ESCAPES)) {
      const before = { ...(await editor()), ...(await navigation()) }
      const clicked = await click(href)
      const card = await waitFor(
        async () => (await cards()).find((c) => c.id === 'error'),
        `${name} link refused in chat`
      )
      assert.match(card.detail, /^Not opened in the editor: \S/, `${name}: ${card.detail}`)
      await delay(400)
      const after = { ...(await editor()), ...(await navigation()) }
      assert.equal(after.reveal, before.reveal, `${name}: nothing was revealed`)
      assert.equal(after.source, before.source, `${name}: the editor kept its file`)
      assert.ok(!after.text.includes('.outside'), `${name}: the outside file was never read in`)
      refused[name] = { href, clicked, card, source: after.source }
      if (name === 'symlink') await capture('code-link-refused', 'window', refused)
      await host.request('chatPerform', { action: 'error-dismiss', card: 'error' })
      await waitFor(async () => !(await cards()).some((c) => c.id === 'error'), 'error dismissed')
    }
    writeFileSync(join(artifacts, 'code-link-refused.json'), JSON.stringify(refused, null, 2))
    evidence['code-link-refused'] = refused
    await delay(600)
    const front = await host.request('chatText', { frontmost: true })
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST !== '1')
      assert.equal(front.frontmost, front.pid, 'Trezi stayed frontmost: no other app opened')

    // 5. Another conversation: a link action from the old one reveals nothing and puts
    //    no message in the new one.
    const home = nativeChat.active
    const stale = async (label: string, check: () => Promise<void>) => {
      const before = (await navigation()).reveal
      await nativeChat.action({ chat: home, action: 'code-link', id: MESSAGE, value: INDEX })
      await delay(500)
      assert.equal((await navigation()).reveal, before, `${label}: nothing was revealed`)
      assert.ok(!(await cards()).some((c) => c.id === 'error'), `${label}: no message leaked`)
      await check()
    }
    host.emit('shell-action', { action: 'new-chat', project: key })
    await waitFor(() => nativeChat.active !== home, 'new conversation')
    const fresh = nativeChat.active
    freshChat = fresh
    await stale('new conversation', async () => {
      assert.match((await editor()).source, /^filter\.html/, 'The editor kept its file')
    })
    await nativeWorkspace.command({ type: 'chat', key, session: home })
    await waitFor(() => nativeChat.active === home, 'back to the first conversation')
    await nativeWorkspace.command({ type: 'close-chat', key, session: fresh })
    freshChat = undefined

    // 6. Another project: a click still resolving when it comes to the front, and a stale
    //    link after it, reveal nothing in its editor; nothing of the first project shows.
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'index.html'), '<h1 id="code-link-other">Other project</h1>\n')
    void nativeChat.action({ chat: home, action: 'code-link', id: MESSAGE, value: INDEX })
    await nativeWorkspace.command({ type: 'open', root: other })
    const otherKey = nativeWorkspace.state.activeKey!
    assert.notEqual(otherKey, key)
    await waitFor(() => nativeChat.active !== home, 'other project chat active')
    await delay(500)
    await stale('other project', async () => {
      const there = await editor(other)
      assert.ok(
        !there.visible && !/filter\.html|index\.html/.test(there.source) && !there.text,
        `The other project's editor shows nothing of the first: ${JSON.stringify({ visible: there.visible, source: there.source })}`
      )
    })
    evidence['code-link-switch'] = {
      conversation: { from: home, to: fresh },
      project: { from: key, to: otherKey, editor: await editor(other) }
    }
    await capture('code-link-switch', 'window', evidence['code-link-switch'])
    await host.request('shellPerform', { action: 'select-row', row: `project:${key}` })
    await waitFor(() => nativeWorkspace.active?.key === key, 'first project selected')
    await nativeWorkspace.command({ type: 'close', key: otherKey })

    // 7. Nothing was written, and the draft survived every click.
    await perform({ action: 'open', source: 'index.html' })
    const draft = await waitFor(async () => {
      const s = await editor()
      return s.source === 'index.html' && s
    }, 'index.html reopened')
    assert.ok(draft.dirty && draft.text.includes(DRAFT.trim()), 'The draft is kept across links')
    assert.deepEqual(
      {
        index: read('index.html'),
        filter: read('filter.html'),
        outside: readFileSync(outside, 'utf8')
      },
      disk,
      'Following links writes no file'
    )
    evidence.draft = { dirty: draft.dirty, kept: true, written: false, front }
    writeFileSync(join(artifacts, 'code-link-click.json'), JSON.stringify(evidence, null, 2))
    console.log(
      'Code link click: candidates open the exact range in Trezi’s editor, never AppKit/NSWorkspace; .., symlink and absolute links refused in chat; repeat and alternate clicks re-reveal; stale links from another conversation or project reveal nothing; draft kept, no file written.'
    )
  } finally {
    await restoreCodeLinkClick(host, fixture)
  }
}

interface CardState {
  id: string
  title: string
  detail: string
  actions: string[]
}

/** Drops the answer, the error card, the escape files, the draft and the other project. */
export async function restoreCodeLinkClick(host: NativeBridge, fixture: string) {
  if (!started) return
  const { key, home } = started
  started = undefined
  const other = nativeWorkspace.state.projects.find((p) => p.root.endsWith('/Code Link Other'))
  if (nativeWorkspace.active?.key !== key) {
    await host.request('shellPerform', { action: 'select-row', row: `project:${key}` })
    await waitFor(() => nativeWorkspace.active?.key === key, 'first project selected')
  }
  if (other) await nativeWorkspace.command({ type: 'close', key: other.key })
  if (nativeChat.active !== home)
    await nativeWorkspace.command({ type: 'chat', key, session: home })
  if (freshChat) await nativeWorkspace.command({ type: 'close-chat', key, session: freshChat })
  freshChat = undefined
  await host.request('chatPerform', { action: 'error-dismiss', card: 'error' })
  const chat = nativeChat.get(home)
  const index = chat.messages.findIndex((m) => m.id === MESSAGE)
  if (index >= 0) chat.messages.splice(index, 1)
  nativeChat.changed(chat)
  await host.request('chatText', { restore: true })
  if ((await host.request('sourceInspect', { root: fixture })).dirty)
    await host.request('sourcePerform', { action: { root: fixture, action: 'reload' } })
  if ((await host.request('sourceInspect', { root: fixture })).visible)
    await host.request('sourcePerform', { action: { root: fixture, action: 'hide' } })
  rmSync(join(fixture, 'code-link-escape.css'), { force: true })
  rmSync(join(fixture, '../outside.css'), { force: true })
  rmSync(join(fixture, OTHER), { recursive: true, force: true })
}
