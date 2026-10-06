import { currentTurn } from '../main/agent'
import { editingOwner } from '../main/editing-owner'
import type { LayersSnapshot, SelectedElement } from '../shared/api'
import { backgroundAgentOptions } from '../shared/background-model'
import { agentOptionsFor } from '../shared/chat-settings'
import { projectRelative } from '../shared/project-path'
import { describeSelectionForPrompt, oneLine } from '../shared/selection-context'
import type { NativeBridge } from './bridge'
import type { NativeChatController } from './chat-controller'
import { turnBoundaries } from './chat-runtime'
import type { NativeContextController } from './context-controller'
import { NativeInspectorController } from './inspector-controller'
import { NavigationController } from './navigation-controller'
import { dispatchIPC, serviceEvents } from './platform'
import type { NativeWorkspaceController } from './workspace-controller'
export function installNativeInspector(
  host: NativeBridge,
  workspace: NativeWorkspaceController,
  chat: NativeChatController,
  context: NativeContextController,
  visualEdit: (root: string, prompt: string) => Promise<void>,
  openSource: (source?: string) => void,
  report: (error: unknown) => void
) {
  const send = (channel: string, ...args: any[]) =>
    dispatchIPC('main', { type: 'send', channel, args })
  const controller = new NativeInspectorController(
    workspace.services.invoke,
    send,
    (state) => host.send('inspectorState', { state }),
    async (root, prompt, submit) => {
      const entry = workspace.state.projects.find((p) => p.root === root)
      if (!entry) return
      if (submit) await chat.command({ type: 'submit', chat: entry.activeSessionKey, text: prompt })
      else await visualEdit(root, prompt)
    },
    () => chat.action({ chat: chat.active, action: 'setup' }),
    () => chat.chats.get(chat.active)?.settings.provider ?? 'claude'
  )
  // Deferred preview navigation (S12): the editing owner holds an agent's request
  // until its turn lands; this only loads it in the chat and project that asked.
  const navigation = new NavigationController(
    editingOwner(),
    {
      active: () => {
        const entry = workspace.active,
          status = workspace.state.status
        if (!entry) return null
        const url =
          status.kind === 'running' && entry.previewKind !== 'simulator' ? status.url : null
        return { root: entry.root, chat: entry.activeSessionKey, url }
      },
      load: (url) => workspace.services.invoke('preview:load', url)
    },
    currentTurn,
    report
  )
  turnBoundaries.add((key, kind, turn) => {
    void navigation.boundary(key, kind, turn).catch(report)
  })
  const render = workspace.services.render
  workspace.services.render = (state) => {
    render(state)
    navigation.poke()
  }
  host.on('inspector-action', (action) => {
    void controller.action(action).catch(report)
  })
  const activate = workspace.services.activate
  workspace.services.activate = async (entry) => {
    await controller.activate(entry?.root ?? '')
    await activate(entry)
    if (entry) void restoreSelection(entry.root).catch(report)
  }
  // LKM-172: the selection, its chat chip, the editing island and the page's selection
  // and hover boxes belong to one project and one page.
  let page = '',
    pickedOn: string | null = null
  const pickedPages = new Map<string, string>()
  let restoreSequence = 0
  let switchStartedAt = 0
  let readyRoot = ''
  let restorePick: { root: string; saved: SelectedElement; sequence: number } | null = null
  let missingTimer: ReturnType<typeof setTimeout> | null = null
  const cancelMissing = () => {
    if (missingTimer) clearTimeout(missingTimer)
    missingTimer = null
  }
  const pageOf = (url: string) => {
    try {
      const parsed = new URL(url)
      return parsed.origin + parsed.pathname + parsed.search
    } catch {
      return url
    }
  }
  const dropSelection = () => {
    cancelMissing()
    ++restoreSequence
    restorePick = null
    const root = workspace.active?.root
    if (root) {
      controller.forget(root)
      pickedPages.delete(root)
    }
    pickedOn = null
    context.selection(null)
    void controller.select(null).catch(report)
  }
  const restoreSelection = async (root: string) => {
    const saved = controller.savedElement(root)
    if (!saved || workspace.active?.root !== root || controller.state.root !== root) return
    const status = workspace.state.status
    if (status.kind !== 'running' || readyRoot !== root || page !== pageOf(status.url)) return
    const savedPage = pickedPages.get(root)
    if (savedPage && pageOf(status.url) !== savedPage) {
      context.forgetSelection(root)
      controller.forget(root)
      return
    }
    const sequence = restoreSequence
    const snapshot = (await workspace.services.invoke('layers:read')) as LayersSnapshot | null
    if (
      sequence !== restoreSequence ||
      workspace.active?.root !== root ||
      controller.savedElement(root) !== saved ||
      !snapshot
    )
      return
    const matches = snapshot.nodes.filter(
      (node) => node.tag === saved.tag && node.source === saved.source && node.id === saved.id
    )
    if (matches.length === 1) {
      cancelMissing()
      const node = matches[0]
      restorePick = { root, saved, sequence }
      await send('layers:select', {
        path: node.path,
        fingerprint: { tag: node.tag, source: node.source }
      })
    } else if (
      !snapshot.truncated &&
      snapshot.nodes.length &&
      matches.length === 0 &&
      !missingTimer
    ) {
      // Let hydration settle before deciding that a returning element was removed.
      missingTimer = setTimeout(() => {
        missingTimer = null
        if (
          sequence !== restoreSequence ||
          workspace.active?.root !== root ||
          controller.savedElement(root) !== saved
        )
          return
        void workspace.services
          .invoke('layers:read')
          .then((again: LayersSnapshot | null) => {
            if (
              sequence !== restoreSequence ||
              workspace.active?.root !== root ||
              controller.savedElement(root) !== saved ||
              !again ||
              again.truncated
            )
              return
            if (
              again.nodes.some(
                (node) =>
                  node.tag === saved.tag && node.source === saved.source && node.id === saved.id
              )
            )
              void restoreSelection(root).catch(report)
            else {
              context.forgetSelection(root)
              controller.forget(root)
            }
          })
          .catch(report)
      }, 1200)
    }
  }
  workspace.switching = () => {
    cancelMissing()
    restorePick = null
    const root = controller.state.root
    if (root && pickedOn !== null) pickedPages.set(root, pickedOn)
    ++restoreSequence
    switchStartedAt = Date.now()
    readyRoot = ''
    page = ''
    pickedOn = null
    context.hideSelections()
    controller.suspend()
    void workspace.services.invoke('preview:set-select-mode', false).catch(report)
  }
  const effect = chat.services.effect
  chat.services.effect = (value) => {
    const selection = chat.chats.get(chat.active)?.context?.selection
    effect(value)
    if (
      value.type === 'selection-clear' &&
      value.chat === chat.active &&
      selection?.prompt === value.prompt
    )
      void controller.select(null).catch(report)
  }
  serviceEvents.on('event', (channel, value) => {
    if (channel === 'preview:open') {
      void navigation.request(value).catch(report)
      return
    }
    if (channel === 'preview:url-changed') {
      const next = pageOf(value),
        root = workspace.active?.root
      // A pick made before the page reported its address belongs to that first address.
      if (pickedOn === '') pickedOn = next
      const selected = !!controller.element || !!(root && context.projects.get(root)?.selection)
      // A reload of the same page keeps the selection: its element re-resolves by stamp.
      if (pickedOn !== null && next !== pickedOn && selected) {
        dropSelection()
        void send('preview:clear-selected').catch(report)
      }
      page = next
      if (root && controller.savedElement(root)) void restoreSelection(root).catch(report)
      return
    }
    if (channel === 'preview:readiness') {
      if (
        workspace.active?.root &&
        typeof value?.documentStartedAt === 'number' &&
        value.documentStartedAt >= switchStartedAt &&
        typeof value.url === 'string' &&
        workspace.state.status.kind === 'running' &&
        pageOf(value.url) === pageOf(workspace.state.status.url)
      ) {
        readyRoot = workspace.active.root
        page = pageOf(value.url)
      }
      if (workspace.active?.root) void restoreSelection(workspace.active.root).catch(report)
    } else if (channel === 'layers:changed') {
      if (workspace.active?.root) void restoreSelection(workspace.active.root).catch(report)
    }
    const entry = workspace.active
    if (!entry) return
    if (channel === 'preview:element-picked') {
      cancelMissing()
      pickedOn = page
      const root = entry.root
      const saved = controller.savedElement(root)
      const restore = restorePick
      restorePick = null
      if (
        saved &&
        restore?.root === root &&
        restore.saved === saved &&
        restore.sequence === restoreSequence &&
        value.tag === saved.tag &&
        value.source === saved.source &&
        value.id === saved.id
      ) {
        void controller.restore(root, value).catch(report)
        controller.forget(root)
      } else {
        controller.forget(root)
        void controller.select(value).catch(report)
      }
    } else if (channel === 'preview:selection-lost') dropSelection()
    else if (channel === 'preview:select-cancelled') {
      context.selection(null)
      void controller.select(null).catch(report)
    } else if (channel === 'preview:toolbar-action') {
      if (value === 'props') {
        controller.state.visible = !controller.state.visible
        controller.publish()
      } else if (value === 'code' && controller.element?.source)
        openSource(controller.element.source)
      else if (value === 'delete' && controller.element)
        void chat
          .command({
            type: 'submit',
            chat: entry.activeSessionKey,
            text:
              describeSelectionForPrompt(controller.element, entry.root) +
              'Delete the selected element(s) from the source. Remove wrappers, imports, and styles that exist only for them.'
          })
          .catch(report)
    } else if (channel === 'preview:text-edit') {
      void workspace.services
        .invoke('text:apply', entry.root, value)
        .then((result) => {
          if (!result.applied)
            return visualEdit(
              entry.root,
              result.agentPrompt ??
                `In ${projectRelative(value.source, entry.root)}, change only the selected element's text to ${JSON.stringify(value.text)}.`
            )
        })
        .catch(report)
    } else if (channel === 'preview:comment') {
      if (value.kind === 'annotate')
        void workspace.services
          .invoke('annotations:add', entry.root, {
            source: value.el.source,
            selector: value.el.selector,
            tag: value.el.tag,
            text: value.text
          })
          .catch(report)
      else {
        const parent = entry.activeSessionKey
        const prompt = describeSelectionForPrompt(value.el, entry.root) + oneLine(value.text, 2000),
          current = chat.chats.get(parent)
        void workspace.services
          .invoke(
            'agent:spawn-comment',
            entry.root,
            prompt,
            parent,
            backgroundAgentOptions(current ? agentOptionsFor(current.settings) : {}, 'comment'),
            'comment'
          )
          .then((result) => {
            if (!result.ok && ['not-a-repo', 'unsupported-backend'].includes(result.reason))
              return chat.command({ type: 'submit', chat: parent, text: prompt })
            if (!result.ok) report(result.reason ?? 'Could not start the comment agent.')
          })
          .catch(report)
      }
    } else if (
      (channel === 'controls:updated' && (value?.root ?? value) === entry.root) ||
      (channel === 'agent:event' &&
        ['done', 'landing-finished', 'spawn-finished'].includes(value.type))
    )
      void controller.refresh().catch(report)
    else if (channel === 'controls:open' && value.root === entry.root) {
      controller.requestedFile = value.file ?? null
      controller.state.tab = value.tab
      controller.publish()
      void controller.refresh().catch(report)
    }
  })
  return { inspector: controller, navigation }
}
