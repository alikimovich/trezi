import { sourceOwner } from '../main/source-owner'
import { STATES_RECORDS_PREFERENCE } from '../shared/states-records'
import { chatRoot, workbenchReference, workbenchReferenceText } from '../shared/states-workbench'
import type { NativeActivityController } from './activity-controller'
import type { NativeBridge } from './bridge'
import { addReference, setReferenceDetails } from './chat-island-refs'
import { nativeChat, turnBoundaries } from './chat-runtime'
import type { NativeGitController } from './git-controller'
import { dispatchIPC, type NativeView, serviceEvents } from './platform'
import type { NativePreferences } from './preferences'
import type { NativeSheetController } from './sheets-runtime'
import { StatesCanvasController } from './states-canvas-controller'
import { setCanvasController } from './states-canvas-registry'
import { NativeStatesController, type StatesAction } from './states-controller'
import type { NativeWorkspaceController } from './workspace-controller'

/** The running app's states workbench controller (the native smoke drives it). */
export let nativeStates: NativeStatesController | null = null
export let nativeCanvas: StatesCanvasController | null = null

const PAGE = '({ href: location.href, title: document.title, x: scrollX, y: scrollY })'

/**
 * LKM-207: the host's States island and the toolbar's States menu send `states-action`;
 * H in a workbench page arrives as `preview:states-key`; every preview URL change
 * re-syncs; Publish asks first while a workbench exists. LKM-220: the records live in a
 * preference, and Back, Continue in chat and Rebuild reach the preview and the chats here.
 */
export function installStatesWorkbench(options: {
  host: NativeBridge
  preview: NativeView
  workspace: NativeWorkspaceController
  sheets: NativeSheetController
  log: NativeActivityController
  git: NativeGitController
  preferences: NativePreferences
}) {
  const { host, workspace, log, preferences } = options
  const report = (error: unknown) => log.append(String(error), 'error')
  const evaluate = (code: string) => options.preview.webContents.evaluateIn(code, 'preview', 2000)
  const project = (root: string) => workspace.state.projects.find((p) => p.root === root)
  const focus = async (root: string, chat: string) => {
    const entry = project(root)
    if (!entry?.sessionKeys.includes(chat)) return false
    await workspace.command({ type: 'chat', key: entry.key, session: chat })
    workspace.services.focusComposer?.()
    return true
  }
  let legacyItems: unknown[] = []
  const canvas = new StatesCanvasController({
    preferences,
    active: () => workspace.active ?? null,
    pageUrl: () => options.preview.webContents.getURL(),
    preview: (channel, payload) => options.preview.webContents.send(channel, payload),
    send: (command, payload) => host.send(command, payload as Record<string, unknown>),
    legacyItems: () => legacyItems,
    sheets: options.sheets,
    chatTitle: (chat) => nativeChat.chats.get(chat)?.title || undefined,
    submit: async (root, text, chat) => {
      const entry = project(root)
      if (!entry) return
      const key = (await focus(root, chat)) ? chat : entry.activeSessionKey
      await nativeChat.command({ type: 'submit', chat: key, text })
    },
    focusChat: focus,
    report
  })
  nativeCanvas = canvas
  setCanvasController(canvas)
  const states = new NativeStatesController({
    send: (command, payload) => {
      if (command === 'workbenches') {
        legacyItems = (payload as { items?: unknown[] })?.items ?? []
        canvas.sync()
      } else if (!canvas.view) host.send(command, payload as Record<string, unknown>)
    },
    preview: (channel, payload) => options.preview.webContents.send(channel, payload),
    active: () => workspace.active ?? null,
    load: (url) => workspace.services.invoke('preview:load', url),
    sheets: options.sheets,
    log: (text, kind) => log.append(text, kind),
    remove: (root, folder, seams) => sourceOwner().removeWorkbench(root, folder, seams),
    records: {
      read: () => preferences.get(STATES_RECORDS_PREFERENCE),
      write: (update) =>
        preferences.apply((values) => [
          [STATES_RECORDS_PREFERENCE, update(values[STATES_RECORDS_PREFERENCE] ?? null)]
        ])
    },
    page: async () => {
      const page = (await evaluate(PAGE)) as {
        href?: unknown
        title?: unknown
        x?: unknown
        y?: unknown
      } | null
      return page && typeof page.href === 'string'
        ? {
            href: page.href,
            title: typeof page.title === 'string' ? page.title : '',
            x: Number(page.x) || 0,
            y: Number(page.y) || 0
          }
        : null
    },
    scrollTo: (x, y) => evaluate(`scrollTo(${Math.round(x)}, ${Math.round(y)})`),
    back: async (url) => (await host.request('statesBack', { url })) === true,
    layers: () => workspace.services.invoke('layers:read'),
    pick: (path, fingerprint) =>
      dispatchIPC('main', {
        type: 'send',
        channel: 'layers:select',
        args: [{ path, fingerprint }]
      }),
    focusChat: focus,
    newChat: async (root, bench) => {
      const entry = project(root)
      if (!entry) return
      await workspace.command({ type: 'new-chat', key: entry.key })
      const chat = nativeChat.get(entry.activeSessionKey)
      addReference(chat, workbenchReference(bench))
      nativeChat.changed(chat)
    },
    submit: async (root, text, chat) => {
      const entry = project(root)
      if (!entry) return
      const key = chat && (await focus(root, chat)) ? chat : entry.activeSessionKey
      await nativeChat.command({ type: 'submit', chat: key, text })
    },
    chatTitle: (chat) => nativeChat.chats.get(chat)?.title || undefined,
    canvasSelection: (root, element) => canvas.expect(root, element),
    openCanvasForSelection: (root, element) => canvas.openForSelection(root, element)
  })
  nativeStates = states
  // A workbench chip tells the agent where the workbench is when the message is sent.
  setReferenceDetails((chat, name) => {
    if (!name.startsWith('#states-')) return undefined
    const root = chat.root || workspace.active?.root
    const bench = states.workbenches(root).find((b) => workbenchReference(b) === name)
    return bench && workbenchReferenceText(bench)
  })
  options.git.beforePublish = (root) => states.beforePublish(root)
  serviceEvents.on('event', (channel: string, value: unknown) => {
    if (channel === 'preview:url-changed') {
      // A reload of the same document redraws the canvas; any other URL disposes it.
      canvas.pageLoaded(typeof value === 'string' ? value : '')
      states.url(typeof value === 'string' ? value : null)
    } else if (channel === 'preview:styles-updated') canvas.stylesUpdated()
    else if (channel === 'preview:states-canvas-result') canvas.result(value)
    else if (channel === 'preview:states-key') {
      if (canvas.view) {
        const id = typeof value === 'string' ? value : ''
        void canvas
          .action(id === 'close' ? 'back' : id === 'hide' ? 'hide' : 'select', id)
          .catch(report)
      } else void states.action({ action: 'hide' }).catch(report)
    }
  })
  // A landed turn may have written a workbench into any project, open or not: rescan its
  // root so the island and the Publish guard see it without a path change. `key` is the
  // chat's session key, which is the project's own only for its first chat.
  turnBoundaries.add((key, kind) => {
    if (kind !== 'landed') return
    const root = chatRoot(
      key,
      workspace.state.projects,
      (k) => nativeChat.chats.get(k)?.root || undefined
    )
    if (root) states.landed(root)
  })
  host.on('states-action', (action: StatesAction) => {
    if (action && typeof action.action === 'string')
      void canvas
        .action(action.action, action.id)
        .then((handled) => {
          if (!handled) return states.action(action)
        })
        .catch(report)
  })
  return states
}
