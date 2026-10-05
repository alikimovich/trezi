import { currentTurn } from '../main/agent'
import { editingOwner } from '../main/editing-owner'
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
    void controller.activate(entry?.root ?? '').catch(report)
    await activate(entry)
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
    const entry = workspace.active
    if (!entry) return
    if (channel === 'preview:element-picked') void controller.select(value).catch(report)
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
