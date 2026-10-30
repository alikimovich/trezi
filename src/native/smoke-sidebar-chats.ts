import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubAgentSendForSmoke } from '../main/agent'
import type { AgentEvent } from '../shared/api'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { recentChats } from './sidebar-chats'
import { preparePreviewInput } from './smoke-input'
import { restoreSidebarFocus } from './smoke-sidebar'
import { checkMarqueeScroll } from './smoke-sidebar-marquee'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

/**
 * LKM-378 with the retired Electron rail's controls: the open project's chats nested in the
 * sidebar. Grows the project to more than five open chats, the first through the project row's
 * New chat button, and checks the outline lists every one under the selected project only. It
 * switches chats from the sidebar repeatedly (drafts and attachments kept, the row highlighted),
 * scrolls a long title on hover (but not under the Reduce Motion override), reads its pixels at
 * the scroll's start, middle and end (`smoke-sidebar-marquee.ts`), archives chats with the row's
 * Archive button and opens the History section that then lists them, three at a time
 * before "Show N more". Sidebar captures land in the artifacts folder. The running and unread
 * indicators are checked in `smoke-sidebar-status.ts`, where a real background turn runs.
 */
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Shell = any

let home = ''
let created: string[] = []
let reused: string[] = []
let collapsed = false
let sidebarWidth = 0
let stub: ReturnType<typeof stubAgentSendForSmoke> | undefined

const draft = (chat: string) => `Sidebar draft ${chat.slice(-6)}`
const LONG_TITLE = 'A sidebar chat whose title is much too long to fit in the sidebar row'

export async function checkSidebarChats(host: NativeBridge, artifacts: string) {
  const key = nativeWorkspace.state.activeKey
  assert.ok(key, 'Sidebar chats need an open project')
  const entry = () => nativeWorkspace.active!
  const past = () => nativeWorkspace.state.history[key] ?? []
  home = nativeChat.active
  created = []
  reused = []
  const shell = (): Promise<Shell> => host.request('shellInspect')
  const composer = () => host.request('composerInspect')
  const perform = (action: string, row?: string) =>
    host.request('shellPerform', row === undefined ? { action } : { action, row })
  const initial = await shell()
  collapsed = initial.sidebarCollapsed
  if (collapsed) await perform('toggle-sidebar')

  /** The outline shows every open chat, newest first, and a History toggle for the closed ones. */
  const settled = (state: Shell) => {
    const items: Shell[] = state.sidebarChats ?? []
    const chats = items.filter((item) => item.kind === 'chat')
    const toggle = items.filter((item) => item.kind === 'history-toggle')
    return (
      JSON.stringify(chats.map((item) => item.id)) ===
        JSON.stringify(recentChats(entry().sessionKeys).map((chat) => `chat:${chat}`)) &&
      toggle.length === (past().length ? 1 : 0) &&
      (!toggle.length || toggle[0].title === 'History') &&
      chats.some((item) => item.id === `chat:${nativeChat.active}` && item.selected) && {
        state,
        items,
        chats,
        toggle: toggle[0]
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
    const { state, items, chats, toggle } = shown
    assert.deepEqual(state.sidebarExpanded, [`project:${key}`], `${stage}: only the open project`)
    for (const item of items) {
      assert.equal(item.parent, `project:${key}`, `${stage}: ${item.id} is nested`)
      assert.equal(item.project, key)
      if (['chat', 'history'].includes(item.kind))
        assert.ok(Math.abs(item.textOffset) < 1, `${stage}: ${item.id} aligns with project titles`)
    }
    assert.equal(chats.filter((item: Shell) => item.selected).length, 1, `${stage}: one selected`)
    for (const item of chats) {
      assert.ok(item.selectable && item.label.startsWith(item.title), `${stage}: ${item.id} label`)
      // Archiving the last open chat would close the project: it has no Archive button.
      assert.equal(item.archive, chats.length > 1, `${stage}: ${item.id} Archive`)
      if (item.archive) assert.equal(item.archiveLabel, `Archive ${item.title}`)
      assert.deepEqual(
        item.menu,
        ['Rename Chat…', chats.length > 1 ? 'Archive Chat' : 'Archive Chat (disabled)'],
        `${stage}: ${item.id} context menu`
      )
    }
    if (toggle) {
      assert.equal(toggle.role, 'AXButton', 'VoiceOver reads the History toggle as a button')
      assert.equal(toggle.selectable, false, 'the arrow keys skip the History toggle')
      assert.equal(toggle.element, true, 'the History toggle is an accessibility element')
      assert.equal(toggle.press, true, 'the History toggle has a press action')
      const path = toggle.axPath.join(' > ')
      assert.ok(
        toggle.axPath[0] === 'AXWindow' && path.endsWith('AXOutline > AXRow > AXCell > AXButton'),
        `VoiceOver reaches the History toggle: AX path ${path || 'none'}`
      )
    }
    return shown
  }
  const capture = async (name: string, shown: Shell, prepare = true) => {
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(`Sidebar chats: background run, ${name} not captured.`)
      return
    }
    // A hover capture keeps the pointer state the check set: no focus or input preparation.
    if (prepare) {
      await preparePreviewInput(host, true)
      await restoreSidebarFocus(host, `${name} before capture`)
    }
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
  // The project row's trailing New chat button, a real AXButton labelled for its project.
  const button = (await shell()).sidebarNewChat?.find((row: Shell) => row.project === key)
  assert.ok(button, 'the project row has a New chat button')
  assert.equal(button.role, 'AXButton', 'VoiceOver reads New chat as a button')
  assert.equal(button.label, `New chat in ${entry().name}`)
  // Grow to more than five open chats; each gets a draft, so New chat never reuses it. Five new
  // chats: one takes the attachment, four get a prompt and fill History past "Show N more".
  for (let i = 0; i < 12 && (entry().sessionKeys.length < 6 || created.length < 5); i++) {
    const before = nativeChat.active,
      open = [...entry().sessionKeys]
    if (i === 0) assert.equal(await perform('sidebar-new-chat', key), true, 'New chat pressed')
    else host.emit('shell-action', { action: 'new-chat', project: key })
    await waitFor(() => nativeChat.active !== before, 'new chat active')
    const chat = nativeChat.active
    ;(open.includes(chat) ? reused : created).push(chat)
    await type(chat)
  }
  assert.ok(entry().sessionKeys.length > 5 && created.length >= 5, 'more than five open chats')
  const attached = created[0]
  let shown = await expectList('more than five')
  assert.equal(shown.chats.length, entry().sessionKeys.length, 'every open chat is listed')
  await capture('sidebar-chats-more', shown)

  // Switching from the sidebar, repeatedly, keeps every draft and the attachment.
  const dir = join(artifacts, 'sidebar-chats')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'note.svg')
  writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
  const pick = async (chat: string) => {
    assert.equal(await perform('select-row', `chat:${chat}`), true, `sidebar row for ${chat}`)
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

  // Hover: Archive shows and a long title scrolls; the Reduce Motion override keeps it still.
  const long = created[1]
  const renamed = await nativeChat.services.invoke('agent:rename-chat', long, LONG_TITLE)
  assert.ok(renamed.ok, 'renamed a chat to a long title')
  const live = nativeChat.chats.get(long)
  if (live) live.title = renamed.title
  nativeWorkspace.changed()
  const row = (state: Shell) => state.sidebarChats.find((item: Shell) => item.id === `chat:${long}`)
  await waitFor(async () => row(await shell())?.title === LONG_TITLE, 'long title in the sidebar')
  const hover = async (reduce: boolean) => {
    await perform('marquee-reduce-motion', reduce ? 'on' : 'off')
    await perform('sidebar-hover')
    assert.equal(await perform('sidebar-hover', `chat:${long}`), true, 'hovered the long row')
    return waitFor(
      async () => {
        const item = row(await shell())
        return item?.hovered && item.archiveVisible && item.marquee === !reduce && item
      },
      `hovered long row (Reduce Motion ${reduce})`,
      10000,
      async () => row(await shell())
    )
  }
  const scrolling = await hover(false)
  assert.ok(scrolling.travel > 1, `the long title overflows its row: ${scrolling.travel}`)
  await capture('sidebar-chats-hover', { state: await shell() }, false)
  const still = (await hover(true)).marqueeState
  assert.ok(still.offset === 0 && still.truncated, 'Reduce Motion keeps the title truncated')
  await perform('marquee-reduce-motion')
  await perform('sidebar-hover')
  assert.equal(row(await shell()).marquee, false, 'the title stops when the pointer leaves')

  // LKM-387: the text must paint the whole title on either kind of row, at any width, including
  // a width change around the start of the hover.
  const sized = async (width: number) => {
    assert.equal(await perform('sidebar-width', String(width)), true, `sidebar width ${width}`)
    await waitFor(
      async () => Math.abs((await shell()).sidebarWidth - width) <= 1,
      `sidebar at ${width}`
    )
  }
  const scroll = (stage: string, during?: () => Promise<void>) =>
    checkMarqueeScroll(host, artifacts, `chat:${long}`, stage, during)
  sidebarWidth = Math.round((await shell()).sidebarWidth)
  await scroll('unselected')
  await sized(180)
  await scroll('narrow-unselected')
  await pick(long)
  await scroll('narrow-selected')
  await sized(sidebarWidth)
  await scroll('selected')
  await scroll('resized', () => sized(200))
  await sized(sidebarWidth)
  sidebarWidth = 0

  // Only a chat with a prompt is saved to History (`closeChat`): one stubbed turn in four chats,
  // so History is long enough for "Show N more".
  const prompted = [...created.filter((chat) => ![attached, long].includes(chat)).slice(0, 3), long]
  assert.equal(prompted.length, 4, 'four chats get a prompt')
  for (const chat of prompted) {
    await pick(chat)
    const sent: unknown[] = []
    stub = stubAgentSendForSmoke(chat, (...args) => {
      sent.push(args)
    })
    await host.request('composerPerform', { text: 'Sidebar history turn' })
    await waitFor(async () => (await composer()).enabled, 'composer enabled')
    await host.request('composerPerform', { action: 'send' })
    await waitFor(() => sent.length === 1, 'history turn reached the provider stub')
    stub.emit({ type: 'done' } as AgentEvent)
    await waitFor(() => !nativeChat.get(chat).isRunning, 'history turn finished')
    stub.restore()
    stub = undefined
  }

  // Archive with the row's button: the row leaves the list and History lists it.
  const before = past().length
  const archived: string[] = []
  while (created.length) {
    const chat = created.pop()!
    assert.equal(await perform('sidebar-archive', `chat:${chat}`), true, `Archive ${chat}`)
    await waitFor(() => !entry().sessionKeys.includes(chat), `archived ${chat}`)
    archived.push(chat)
    shown = await expectList(`archived ${chat}`)
    assert.ok(!shown.chats.some((item: Shell) => item.id === `chat:${chat}`), 'archived chat left')
  }
  await waitFor(
    () => past().length >= before + prompted.length && past().some((r) => r.title === LONG_TITLE),
    'the archived chats with a prompt in history'
  )
  shown = await expectList('archived')
  assert.equal(shown.toggle.detail ?? '', '', 'the toggle row has no age')
  const count = past().length
  assert.ok(count > 3, `History needs four closed chats for "Show N more": ${count}`)
  assert.equal(
    shown.toggle.label,
    `History, ${count} closed chat${count === 1 ? '' : 's'}, collapsed`
  )

  // History: three closed chats, then "Show N more" and "Show less".
  const history = async (stage: string, all: boolean) => {
    const state = await waitFor(
      async () => {
        const state = await shell()
        const rows = state.sidebarChats.filter((item: Shell) => item.kind === 'history')
        return rows.length === (all ? count : 3) && state
      },
      `History ${stage}`,
      10000,
      async () => (await shell()).sidebarChats
    )
    const items: Shell[] = state.sidebarChats
    const rows = items.filter((item) => item.kind === 'history')
    for (const item of rows) {
      assert.equal(item.selectable, false, `${stage}: a closed chat is not selectable`)
      assert.ok(item.detail, `${stage}: ${item.id} shows its age`)
      assert.deepEqual(item.menu, ['Open Chat', 'Rename Chat…'], `${stage}: ${item.id} menu`)
    }
    const more = items.find((item) => item.kind === 'history-more')
    assert.equal(more?.title, all ? 'Show less' : `Show ${count - 3} more`, `${stage}: more`)
    assert.equal(more.role, 'AXButton', `${stage}: "Show more" is a button`)
    return { state, rows }
  }
  assert.equal(await perform('history-toggle'), true, 'History opened')
  let open = await history('open', false)
  assert.deepEqual(open.state.historyOpen, [key])
  await capture('sidebar-chats-history', open)
  assert.equal(await perform('history-more'), true, 'Show more pressed')
  open = await history('all', true)
  await capture('sidebar-chats-history-all', open)
  const closed = open.rows.find((item: Shell) => item.title === LONG_TITLE)
  assert.ok(closed, 'the archived long-title chat is in History')
  // A closed chat opens for review and does not change the selected chat.
  const reviewing = nativeChat.active
  assert.equal(await perform('history-open', closed.id), true, 'History row opened')
  await waitFor(async () => {
    const sheet = await host.request('sheetInspect')
    return sheet.visible && sheet.title === LONG_TITLE
  }, 'review sheet open on the closed chat')
  assert.equal(nativeChat.active, reviewing, 'reviewing a closed chat keeps the active chat')
  await host.request('sheetPerform', { action: 'cancel' })
  await waitFor(async () => !(await host.request('sheetInspect')).visible, 'review sheet closed')
  assert.equal(await perform('history-more'), true, 'Show less pressed')
  await history('less', false)
  assert.ok(
    open.state.sidebarChats.some(
      (item: Shell) => item.id === `chat:${nativeChat.active}` && item.selected
    ),
    'opening History kept the selected chat highlighted'
  )
  assert.equal(await perform('history-toggle'), true, 'History closed')
  await waitFor(
    async () => !(await shell()).sidebarChats.some((item: Shell) => item.kind === 'history'),
    'History closed'
  )
  await restoreSidebarChats(host)
  await expectList('restored')
}

/** Closes the chats the check created, clears its drafts in the others and returns home. */
export async function restoreSidebarChats(host: NativeBridge) {
  const perform = (action: string, row?: string) =>
    host.request('shellPerform', row === undefined ? { action } : { action, row }).catch(() => {})
  stub?.restore()
  stub = undefined
  await perform('marquee-reduce-motion')
  await perform('sidebar-hover')
  if (sidebarWidth) await perform('sidebar-width', String(sidebarWidth))
  sidebarWidth = 0
  const state = await host.request('shellInspect').catch(() => null)
  const key = nativeWorkspace.state.activeKey
  if (key && state?.historyOpen?.includes(key)) {
    if (state.historyAll?.includes(key)) await perform('history-more')
    await perform('history-toggle')
  }
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
  if (collapsed) await perform('toggle-sidebar')
  collapsed = false
}
