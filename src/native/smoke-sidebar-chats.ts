import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { recentChats } from './sidebar-chats'
import { preparePreviewInput } from './smoke-input'
import { restoreSidebarFocus } from './smoke-sidebar'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/**
 * LKM-378: the open project's recent chats nested in the sidebar. Grows the project to more than
 * five open chats (each with its own draft, one with an attachment), checks the outline shows
 * exactly Bun's pick (`sidebar-chats.ts`) under the selected project only, with "View all chats"
 * as a non-selectable button that opens the history menu, switches chats from the sidebar
 * repeatedly (drafts and attachments kept, the row highlighted) and archives chats (Close chat).
 * Sidebar captures land in the artifacts folder. The running indicator is checked in
 * `smoke-history-menu.ts`, where a real background turn runs.
 */
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Shell = any

let home = ''
let created: string[] = []
let reused: string[] = []
let collapsed = false

const draft = (chat: string) => `Sidebar draft ${chat.slice(-6)}`

export async function checkSidebarChats(host: NativeBridge, artifacts: string) {
  const key = nativeWorkspace.state.activeKey
  assert.ok(key, 'Sidebar chats need an open project')
  const entry = () => nativeWorkspace.active!
  home = nativeChat.active
  created = []
  reused = []
  const shell = (): Promise<Shell> => host.request('shellInspect')
  const composer = () => host.request('composerInspect')
  const initial = await shell()
  collapsed = initial.sidebarCollapsed
  if (collapsed) await host.request('shellPerform', { action: 'toggle-sidebar' })

  /** The outline shows Bun's pick, under the selected project only, with the right roles. */
  const settled = (state: Shell) => {
    const pick = recentChats(entry().sessionKeys, entry().activeSessionKey)
    const items: Shell[] = state.sidebarChats ?? []
    const chats = items.filter((item) => item.kind === 'chat')
    const all = items.filter((item) => item.kind === 'all-chats')
    return (
      JSON.stringify(chats.map((item) => item.id)) ===
        JSON.stringify(pick.keys.map((chat) => `chat:${chat}`)) &&
      all.length === (pick.more ? 1 : 0) &&
      chats.some((item) => item.id === `chat:${nativeChat.active}` && item.selected) && {
        state,
        chats,
        all,
        pick
      }
    )
  }
  const expectList = async (stage: string) => {
    const shown = await waitFor(
      async () => settled(await shell()),
      `sidebar chats ${stage}`,
      10000,
      async () => ({ shell: (await shell()).sidebarChats, keys: entry().sessionKeys })
    )
    const { state, chats, all, pick } = shown
    assert.deepEqual(state.sidebarExpanded, [`project:${key}`], `${stage}: only the open project`)
    for (const item of [...chats, ...all]) {
      assert.equal(item.parent, `project:${key}`, `${stage}: ${item.id} is nested`)
      assert.equal(item.project, key)
    }
    assert.equal(chats.length, Math.min(5, entry().sessionKeys.length), `${stage}: row count`)
    assert.equal(chats.filter((item: Shell) => item.selected).length, 1, `${stage}: one selected`)
    for (const item of chats) {
      assert.ok(item.selectable && item.label.startsWith(item.title), `${stage}: ${item.id} label`)
      assert.ok(Math.abs(item.textOffset) < 1, `${stage}: chat titles align with project titles`)
    }
    if (pick.more) {
      const [button] = all
      assert.equal(button.label, 'View all chats')
      assert.equal(button.role, 'AXButton', 'VoiceOver reads "View all chats" as a button')
      assert.equal(button.selectable, false, 'the arrow keys skip "View all chats"')
      // LKM-379: role and label come from the element VoiceOver gets (the button's cell), and
      // every ancestor from the window lists it.
      assert.equal(button.element, true, '"View all chats" is an accessibility element')
      assert.equal(button.press, true, '"View all chats" has a press action')
      const path = button.axPath.join(' > ')
      assert.ok(
        button.axPath[0] === 'AXWindow' && path.endsWith('AXOutline > AXRow > AXCell > AXButton'),
        `VoiceOver reaches "View all chats": AX path ${path || 'none'}`
      )
    }
    return shown
  }
  const capture = async (name: string, shown: Shell) => {
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(`Sidebar chats: background run, ${name} not captured.`)
      return
    }
    await preparePreviewInput(host, true)
    await restoreSidebarFocus(host, `${name} before capture`)
    const state = await host.request('sidebarVerification')
    const image = await host.request('captureVisibleSidebar')
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(image.png, 'base64'))
    writeFileSync(
      join(artifacts, `${name}.json`),
      JSON.stringify(
        { sidebarChats: shown.state.sidebarChats, keys: entry().sessionKeys, ...state },
        null,
        2
      ),
      'utf8'
    )
  }
  const drafts = new Map<string, string>()
  const type = async (chat: string) => {
    const text = draft(chat)
    await host.request('composerPerform', { text })
    await waitFor(async () => (await composer()).text === text, `draft "${text}"`)
    drafts.set(chat, text)
  }

  // A draft keeps the home chat from being reused by New chat, and must survive the switches.
  await expectList('at start')
  await type(home)
  // Grow to more than five open chats; each gets a draft, so New chat never reuses it.
  for (let i = 0; i < 12 && (entry().sessionKeys.length < 6 || created.length < 2); i++) {
    const before = nativeChat.active,
      open = [...entry().sessionKeys]
    host.emit('shell-action', { action: 'new-chat', project: key })
    await waitFor(() => nativeChat.active !== before, 'new chat active')
    const chat = nativeChat.active
    ;(open.includes(chat) ? reused : created).push(chat)
    await type(chat)
  }
  assert.ok(entry().sessionKeys.length > 5 && created.length >= 2, 'more than five open chats')
  const attached = created[0]
  let shown = await expectList('more than five')
  await capture('sidebar-chats-more', shown)

  // Pressing "View all chats" (its accessibility element's press) opens the chat header's
  // history menu, which lists every open chat.
  assert.equal(await host.request('shellPerform', { action: 'view-all-chats' }), true)
  const menu = await waitFor(
    async () => (await shell()).historyTracking && (await shell()),
    '"View all chats" opened the history menu'
  )
  for (const chat of entry().sessionKeys)
    assert.ok(
      menu.historyRows.some((row: Shell) => row.id === `chat:${chat}`),
      `the all-chats menu lists ${chat}`
    )
  await host.request('historyMenu', { op: 'close' })
  await waitFor(async () => !(await shell()).historyTracking, 'history menu dismissed')

  // Switching from the sidebar, repeatedly, keeps every draft and the attachment.
  const dir = join(artifacts, 'sidebar-chats')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'note.svg')
  writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
  const pick = async (chat: string) => {
    assert.equal(
      await host.request('shellPerform', { action: 'select-row', row: `chat:${chat}` }),
      true,
      `sidebar row for ${chat}`
    )
    await waitFor(() => nativeChat.active === chat, `sidebar switched to ${chat}`)
    // Chats this check did not type in keep whatever draft they had.
    const text = drafts.get(chat) ?? nativeChat.get(chat).text
    return waitFor(async () => {
      const state = await composer()
      return state.chat === chat && state.text === text && state
    }, `draft kept in ${chat}`)
  }
  await pick(attached)
  await host.request('composerPerform', { files: [file] })
  await waitFor(
    async () => (await composer()).attachmentPreviews.count === 1,
    'attachment added to a sidebar chat'
  )
  // The attached chat is one of the newest five, so every pick below is a visible row.
  const ids = (shown: Shell) => shown.chats.map((item: Shell) => item.id.slice(5))
  const visible = ids(await expectList('switching'))
  for (let round = 0; round < 3; round++)
    for (const chat of [visible[0], attached, visible.at(-1)!]) {
      const state = await pick(chat)
      if (chat === attached) assert.equal(state.attachmentPreviews.count, 1, 'attachment kept')
      const now = await expectList(`switch ${round} to ${chat}`)
      assert.deepEqual(ids(now), visible, 'switching chats does not reorder the list')
    }
  assert.equal(nativeChat.get(home).text, draft(home), 'the home chat kept its draft')
  shown = await expectList('after switching')
  await capture('sidebar-chats-selected', shown)

  // Archive (Close chat): the row leaves the list, and at five chats "View all chats" goes too.
  while (created.length && entry().sessionKeys.length > 5) {
    const chat = created.pop()!
    await nativeWorkspace.command({ type: 'close-chat', key, session: chat })
    shown = await expectList(`archived ${chat}`)
    assert.ok(!shown.chats.some((item: Shell) => item.id === `chat:${chat}`), 'archived chat left')
  }
  if (entry().sessionKeys.length === 5) {
    assert.equal(shown.all.length, 0, 'exactly five chats: no "View all chats"')
    await capture('sidebar-chats-five', shown)
  } else console.log('Sidebar chats: the project kept more than five other chats; no five capture.')
  await restoreSidebarChats(host)
  await expectList('restored')
}

/** Closes the chats the check created, clears its drafts in the others and returns home. */
export async function restoreSidebarChats(host: NativeBridge) {
  await host.request('historyMenu', { op: 'close' }).catch(() => {})
  const key = nativeWorkspace.state.activeKey
  if (key) {
    for (const chat of created.splice(0))
      await nativeWorkspace.command({ type: 'close-chat', key, session: chat }).catch(() => {})
    for (const chat of [...reused.splice(0), home].filter(Boolean)) {
      if (!nativeWorkspace.active?.sessionKeys.includes(chat)) continue
      await nativeWorkspace.command({ type: 'chat', key, session: chat }).catch(() => {})
      await waitFor(() => nativeChat.active === chat, `restore ${chat}`).catch(() => {})
      await host.request('composerPerform', { text: '' }).catch(() => {})
    }
  }
  if (collapsed) await host.request('shellPerform', { action: 'toggle-sidebar' }).catch(() => {})
  collapsed = false
}
