import type { AgentEvent, ModelChoice, WorkspaceSnapshot } from '../shared/api'
import { isChatBusy, isResolveNeeded } from '../shared/chat-busy'
import {
  agentOptionsFor,
  type ChatAgentSettings,
  chatAgentSettingsFromOptions
} from '../shared/chat-settings'
import { migrateChatTitle } from '../shared/chat-title'
import { DevErrorReader, touchedFile } from '../shared/dev-error'
import type { NativeChatAction } from '../shared/native-chat'
import type {
  NativeChatCommand,
  NativeChatEffect,
  NativeChatLayout,
  NativeChatSnapshot
} from '../shared/native-chat-controller'
import type { NativeComposerAction } from '../shared/native-composer'
import { defaultChoiceFor, providerOptions, resolveSelection } from '../shared/provider-choices'
import { parseSlashToken } from '../shared/slash-token'
import { cardAction } from './chat-actions'
import { planAttachments } from './chat-attachments'
import { sendBlock } from './chat-queue'
import { matches, permissionModes, snapshot } from './chat-snapshot'
import {
  append,
  assistant,
  begin,
  type Chat,
  finish,
  hydrate,
  late,
  mirror,
  newChat,
  reduce,
  STOPPED_GROUP,
  type Submission
} from './chat-state'

export interface ChatServices {
  restoreIslands?: (chat: string, root: string, recordId: string) => void
  invoke: (channel: string, ...args: any[]) => Promise<any>
  render: (state: NativeChatSnapshot) => void
  effect: (effect: NativeChatEffect) => void
  /** A one-line status shown when a turn starts, e.g. the one-time network-volume note. */
  notice?: (settings: ChatAgentSettings) => string | undefined
}
/** Owns native conversation behavior. No browser, React, DOM or renderer stores. */
export class NativeChatController {
  readonly chats = new Map<string, Chat>()
  active = ''
  choices: ModelChoice[] = []
  layout: NativeChatLayout = { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }
  private streamUpdates = new Map<string, ReturnType<typeof setTimeout>>()
  private mirrors = new Map<string, string>()
  readonly closed = new Set<string>()
  private loading = new Map<string, { chat: Chat; promise: Promise<void> }>()
  private devErrors = new Map<string, DevErrorReader>()
  constructor(readonly services: ChatServices) {}
  get(key: string) {
    let chat = this.chats.get(key)
    if (!chat) {
      chat = newChat(key)
      this.chats.set(key, chat)
    }
    return chat
  }
  changed(chat = this.get(this.active)) {
    if (this.chats.get(chat.chat) !== chat) return
    clearTimeout(this.streamUpdates.get(chat.chat))
    this.streamUpdates.delete(chat.chat)
    const state = mirror(chat),
      signature = JSON.stringify(state)
    if (signature !== this.mirrors.get(chat.chat)) {
      this.mirrors.set(chat.chat, signature)
      this.services.effect({ type: 'mirror', state })
    }
    if (chat.chat === this.active)
      this.services.render({ ...snapshot(chat, this.choices), ...this.layout })
  }
  async refreshChoices() {
    try {
      this.choices = await this.services.invoke('providers:choices')
      this.changed()
    } catch (error) {
      this.fail(this.get(this.active), error)
    }
  }
  private fail(chat: Chat, error: unknown) {
    chat.error = String(error)
    this.changed(chat)
  }
  async initialize(chat: Chat) {
    if (chat.ready) return
    const pending = this.loading.get(chat.chat)
    if (pending?.chat === chat) return pending.promise
    const version = chat.version
    const operation = (async () => {
      const workspace: WorkspaceSnapshot = await this.services.invoke('agent:workspace-snapshot')
      const project = workspace.projects.find((project) =>
        project.chats.some((c) => c.sessionKey === chat.chat)
      )
      const live = project?.chats.find((c) => c.sessionKey === chat.chat)
      if (!live || this.chats.get(chat.chat) !== chat) return
      chat.root = project!.root
      chat.settings = chatAgentSettingsFromOptions(live.options)
      // Events can arrive while the snapshot request is in flight. Never replace
      // a newer stream with an older transcript.
      if (version === chat.version || !chat.messages.length) {
        chat.isRunning = live.isRunning
        if (live.turn) chat.turn = live.turn
        hydrate(chat, live.record.transcript)
        chat.title = migrateChatTitle(live.record.title)
        chat.isolation = live.isolation?.state ?? 'live'
        chat.stopped = live.isolation?.reason === 'interrupted' ? 'held' : undefined
        chat.landingError =
          live.isolation?.reason === 'failed'
            ? (live.isolation.error ?? 'The landing failed.')
            : undefined
        const stoppedMessage =
          chat.stopped && [...chat.messages].reverse().find((m) => m.role === 'assistant')
        if (stoppedMessage) stoppedMessage.revertGroup = `${STOPPED_GROUP}${chat.chat}`
      }
      if (live.record.id) this.services.restoreIslands?.(chat.chat, chat.root, live.record.id)
      chat.ready = true
      this.settingsChanged(chat)
      this.changed(chat)
    })()
      .catch((error) => this.fail(chat, error))
      .finally(() => {
        if (this.loading.get(chat.chat)?.chat === chat) this.loading.delete(chat.chat)
      })
    this.loading.set(chat.chat, { chat, promise: operation })
    return operation
  }
  async command(command: NativeChatCommand) {
    if (command.type === 'attach') {
      this.mirrors.clear()
      for (const chat of this.chats.values()) this.changed(chat)
      return
    }
    if (command.type === 'layout') {
      this.layout = command.layout
      this.changed()
      return
    }
    if (command.type === 'context') {
      const context = command.context
      const switched = this.active !== context.chat
      this.closed.delete(context.chat)
      this.active = context.chat
      const chat = this.get(context.chat)
      chat.context = context
      chat.needsReview = false
      // Refresh the active shell mirror when switching chats.
      if (switched) this.mirrors.delete(chat.chat)
      this.changed(chat)
      if (context.root) await this.initialize(chat)
      return
    }
    const chat = this.get(command.chat)
    if (command.type === 'seed') {
      chat.text = chat.text.trim() ? `${command.text} ${chat.text}` : command.text
      chat.caret = chat.text.length
      chat.dismissed = false
      this.changed(chat)
      this.services.effect({ type: 'focus' })
    } else await this.submit(chat, command.text)
  }
  event(event: AgentEvent) {
    if (event.sessionId) {
      this.services.effect({ type: 'spawn', event })
      // Detached agent output must never enter an interactive stream.
      if (event.type === 'spawn-finished') {
        this.services.effect({ type: 'history' })
        if (
          event.origin !== 'text-edit' &&
          event.projectKey &&
          !this.closed.has(event.projectKey)
        ) {
          const chat = this.get(event.projectKey)
          const outcome = event.outcome
          const title =
            outcome === 'applied'
              ? 'Comment applied.'
              : outcome === 'cancelled'
                ? 'Comment cancelled.'
                : outcome === 'failed'
                  ? 'Comment failed.'
                  : outcome === 'no-change'
                    ? 'Comment finished without changes.'
                    : event.branch
                      ? 'Comment finished — changes are ready for review.'
                      : 'Comment finished without a confirmed result.'
          const text =
            title +
            (event.branch && (outcome === 'failed' || outcome === 'cancelled')
              ? ' Partial changes are saved for review.'
              : '') +
            (event.summary ? `\n\n${event.summary}` : '')
          chat.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            at: Date.now(),
            text,
            statuses: [],
            segments: [{ kind: 'text', text }],
            ...(outcome === 'applied' ? { revertGroup: `comment:${event.sessionId}` } : {})
          })
          if (chat.chat !== this.active) chat.needsReview = true
          this.changed(chat)
        }
      }
      return
    }
    const key =
      event.type === 'permission-request' || event.type === 'question-request'
        ? event.request.sessionKey
        : event.projectKey
    if (!key || this.closed.has(key)) return
    const chat = this.get(key)
    // A late terminal (an earlier turn's, or one no send accounts for) completes nothing.
    if (late(chat, event)) return
    // A heartbeat racing the turn's end is not news (and must not flag review).
    if (event.type === 'progress' && !chat.isRunning) return
    const priorPhase = chat.phase
    reduce(chat, event)
    if (event.type === 'error' || (event.type === 'isolation' && event.state === 'parked')) {
      if (chat.setup || chat.awaitingLanding)
        this.services.effect({
          type: 'setup',
          chat: key,
          phase: 'failed',
          status:
            event.type === 'error'
              ? `the setup turn stopped with an error: ${event.message}`
              : 'the setup changes were held in the chat workspace instead of landing, so the preview was not restarted. Resolve or discard them, then retry.'
        })
      chat.setup = false
      chat.awaitingLanding = false
    }
    if (event.type === 'done' && chat.setup) {
      chat.setup = false
      if (chat.isolation === 'live')
        this.services.effect({ type: 'setup', chat: key, phase: 'landed' })
      else chat.awaitingLanding = true
    }
    if (event.type === 'isolation' && event.state === 'merged' && chat.awaitingLanding) {
      chat.awaitingLanding = false
      // A turn that changed nothing (e.g. the agent stopped to ask) is still checked: the
      // config may already be wired. If no stamps appear, this is the reason shown.
      this.services.effect({
        type: 'setup',
        chat: key,
        phase: 'landed',
        ...(event.files?.length === 0
          ? {
              status:
                'the setup turn finished without changing any file. Its reply in this chat says why.'
            }
          : {})
      })
    }
    if (!chat.isRunning && key !== this.active && event.type !== 'model') chat.needsReview = true
    if (event.type === 'delta' && priorPhase === 'writing') {
      if (!this.streamUpdates.has(key))
        this.streamUpdates.set(
          key,
          setTimeout(() => this.changed(chat), 33)
        )
    } else this.changed(chat)
    // Let paired terminal/error/isolation events settle before draining. A park that
    // clears (Resolve, Retry or Discard landed) releases the queue too (LKM-169).
    if (
      event.type === 'done' ||
      event.type === 'landing-finished' ||
      (event.type === 'isolation' && event.state !== 'parked')
    )
      queueMicrotask(() => void this.drain(chat))
  }
  async composer(action: NativeComposerAction) {
    if (action.chat !== this.active) return
    const chat = this.get(action.chat)
    try {
      switch (action.action) {
        case 'input': {
          if (action.revision < chat.revision) return
          const before = parseSlashToken(chat.text, chat.caret)?.query
          chat.text = action.text
          chat.caret = action.caret
          chat.revision = action.revision
          if (before !== parseSlashToken(chat.text, chat.caret)?.query) {
            chat.menuIndex = 0
            chat.dismissed = false
          }
          break
        }
        case 'key': {
          const items = matches(chat)
          if (items.length) {
            if (action.key === 'ArrowDown') chat.menuIndex = (chat.menuIndex + 1) % items.length
            else if (action.key === 'ArrowUp')
              chat.menuIndex = (chat.menuIndex + items.length - 1) % items.length
            else if (action.key === 'Escape') chat.dismissed = true
            else if (action.key === 'Enter' || action.key === 'Tab')
              this.complete(chat, chat.menuIndex)
          } else if (action.key === 'Enter') await this.submit(chat)
          break
        }
        case 'suggestion':
          this.complete(chat, action.index)
          break
        case 'send':
          if (chat.isRunning && !chat.text.trim() && !chat.attachments.length) await this.stop(chat)
          else await this.submit(chat)
          break
        case 'choice':
          await this.choice(chat, action.label, action.value)
          break
        case 'attachment-error':
          chat.error = action.message
          break
        case 'files':
          chat.attachments.push(
            ...action.files.map((file) => ({ ...file, id: crypto.randomUUID() }))
          )
          break
        case 'remove':
          chat.attachments = chat.attachments.filter((_, index) => index !== action.index)
          break
        case 'context':
          this.clearSelection(chat)
          break
        case 'layers':
          this.services.effect({ type: 'layers' })
          break
      }
    } catch (error) {
      this.fail(chat, error)
    }
    this.changed(chat)
  }
  complete(chat: Chat, index: number) {
    const item = matches(chat)[index],
      token = parseSlashToken(chat.text, chat.caret)
    if (!item || !token) return
    const insert = `/${item.name} `
    chat.text = chat.text.slice(0, token.start) + insert + chat.text.slice(chat.caret)
    chat.caret = token.start + insert.length
    chat.dismissed = true
    this.services.effect({ type: 'focus' })
  }
  clearSelection(chat: Chat) {
    chat.draftSelection = undefined
    const prompt = chat.context?.selection?.prompt
    if (chat.context) chat.context.selection = null
    this.services.effect({ type: 'selection-clear', chat: chat.chat, prompt })
  }
  async submit(chat: Chat, raw = chat.text) {
    if (!chat.ready) await this.initialize(chat)
    if (!chat.ready || chat.switching || (!raw.trim() && !chat.attachments.length)) return
    const submission: Submission = {
      id: crypto.randomUUID(),
      text: raw.trim(),
      attachments: chat.attachments,
      selection: chat.context?.selection ?? chat.draftSelection ?? null,
      turn: chat.context?.turn ?? {}
    }
    chat.text = ''
    chat.caret = 0
    chat.attachments = []
    chat.dismissed = true
    this.clearSelection(chat)
    // Anything that blocks sending queues the message with its reason (LKM-169).
    if (sendBlock(chat) || chat.queue.length) chat.queue.push(submission)
    else {
      chat.paused = false
      void this.run(chat, submission)
    }
    this.changed(chat)
  }
  async run(chat: Chat, submission: Submission) {
    begin(chat)
    chat.stopping = false
    chat.sending = true
    chat.isRunning = true
    chat.turnStartedAt = Date.now()
    chat.streamingId = null
    chat.turn = submission.id
    chat.last = submission
    chat.login = undefined
    // A new turn settles a reverted stopped turn for good and supersedes a preview error.
    if (chat.stopped === 'reverted') chat.stopped = undefined
    chat.previewError = undefined
    const cancellation = chat.cancellation
    const { text, attachments, selection, turn } = submission
    const userMessage = crypto.randomUUID()
    chat.messages.push({
      id: userMessage,
      role: 'user',
      at: Date.now(),
      text,
      statuses: [],
      segments: text ? [{ kind: 'text', text }] : [],
      selection: selection?.bubble,
      attachments: attachments.map((a) => ({
        id: a.id,
        kind: a.type.startsWith('image/') ? 'image' : 'file',
        name: a.name,
        path: a.path,
        ...(a.type.startsWith('image/') ? { url: `data:${a.type};base64,${a.data}` } : {})
      }))
    })
    const reply = assistant(chat).id
    const notice = this.services.notice?.(chat.settings)
    if (notice) {
      chat.activityDetail = notice
      append(chat, notice, true)
    }
    this.changed(chat)
    try {
      const plan = await planAttachments(attachments, (a) =>
        this.services.invoke('attachments:save', { mediaType: a.type, data: a.data }, a.name)
      )
      if (cancellation !== chat.cancellation || this.chats.get(chat.chat) !== chat)
        throw new Error('Message cancelled before sending.')
      const prompt = plan.header + (selection?.prompt ?? '') + text
      await this.services.invoke(
        'agent:send',
        prompt,
        plan.images.length ? plan.images : undefined,
        chat.chat,
        turn,
        submission.id
      )
    } catch (error) {
      // The backend still holds a turn this chat did not know about: the message waits
      // in the queue, never refused, and the chat shows what is running (LKM-165).
      // A chat the backend holds for Resolve (its park event may still be on the way)
      // queues the same way, with no error turn or duplicate (LKM-169).
      const resolve = isResolveNeeded(error)
      if ((resolve || isChatBusy(error)) && cancellation === chat.cancellation) {
        chat.messages = chat.messages.filter((m) => m.id !== userMessage && m.id !== reply)
        chat.queue.unshift(submission)
        chat.streamingId = null
        chat.turn = undefined
        chat.last = undefined
        chat.turnStartedAt = null
        chat.aliveAt = Date.now()
        if (resolve) {
          chat.isRunning = false
          chat.phase = 'thinking'
          chat.operation = undefined
          chat.isolation = 'parked'
          chat.stopped = undefined
          chat.landingError = undefined
        } else {
          chat.isRunning = true
          chat.phase = 'applying'
          chat.operation = 'waiting'
        }
      } else {
        chat.paused = true
        append(chat, `\n\nUnable to send: ${String(error)}`)
        finish(chat)
      }
    } finally {
      chat.sending = false
      this.changed(chat)
      void this.drain(chat)
    }
  }
  async drain(chat: Chat) {
    // Sends the next queued message once nothing blocks it (`sendBlock`): a stopped
    // turn's hold or a failed landing is no block, a park waiting for Resolve is.
    if (this.chats.get(chat.chat) !== chat || chat.paused || sendBlock(chat)) return
    const next = chat.queue.shift()
    if (next) await this.run(chat, next)
  }
  async stop(chat: Chat) {
    chat.paused = true
    chat.cancellation++
    chat.stopping = true
    this.changed(chat)
    if (chat.setup || chat.awaitingLanding)
      this.services.effect({
        type: 'setup',
        chat: chat.chat,
        phase: 'failed',
        status: 'it was stopped before it finished.'
      })
    chat.setup = false
    chat.awaitingLanding = false
    await this.services.invoke('agent:interrupt', chat.chat)
  }
  async choice(chat: Chat, label: string, value: string) {
    if (!chat.ready || chat.switching) return
    if (label === 'Permission mode') {
      if (!permissionModes.some((m) => m.value === value)) return
      chat.switching = true
      this.changed(chat)
      try {
        await this.services.invoke('agent:set-permission-mode', value, chat.chat)
        chat.settings = {
          ...chat.settings,
          permissionMode: value as ChatAgentSettings['permissionMode']
        }
        this.settingsChanged(chat)
      } finally {
        chat.switching = false
      }
      return
    }
    if (chat.isRunning || chat.sending) return
    const providers = providerOptions(this.choices)
    const selection = resolveSelection(providers, chat.settings)
    const choice = label === 'Provider' ? providers.find((p) => p.key === value) : undefined
    const model = choice
      ? defaultChoiceFor(choice)
      : label === 'Model'
        ? selection.option?.models.find((m) => m.value === value)
        : undefined
    if (!model) return
    const next = {
      ...chat.settings,
      model: model.value,
      modelId: model.modelId,
      provider: model.provider,
      connectionId: model.connectionId
    }
    if (chat.messages.some((m) => m.role === 'user')) chat.pendingModel = next
    else await this.changeModel(chat, next)
  }
  async changeModel(chat: Chat, settings: ChatAgentSettings) {
    if (chat.isRunning || chat.sending || chat.switching) return
    chat.switching = true
    // The restarted session reports its own model on its first turn (LKM-164).
    chat.resolvedModel = undefined
    this.changed(chat)
    try {
      const result = await this.services.invoke(
        'agent:restart-chat',
        chat.root,
        chat.chat,
        agentOptionsFor(settings)
      )
      if (!result.ok) throw new Error(result.error ?? 'Unable to start the selected model.')
      chat.settings = settings
      this.settingsChanged(chat)
    } finally {
      chat.switching = false
    }
  }
  /** LKM-151: a dev-server log line. A compile/parse error in a file the chat's last
   *  landed turn touched shows that chat's preview-error card; a rebuild clears it. */
  devServerLog(root: string, output: string) {
    let reader = this.devErrors.get(root)
    if (!reader) {
      reader = new DevErrorReader()
      this.devErrors.set(root, reader)
    }
    for (const line of output.split('\n')) {
      const result = reader.read(line)
      if (!result) continue
      for (const chat of this.chats.values()) {
        if (chat.root !== root) continue
        if ('recovered' in result) {
          const same =
            !result.recovered ||
            !chat.previewError ||
            touchedFile({ file: result.recovered, message: '' }, root, [chat.previewError.file])
          if (chat.previewError && same) {
            chat.previewError = undefined
            this.changed(chat)
          }
          continue
        }
        const file = chat.landed ? touchedFile(result, root, chat.landed.files) : null
        if (
          !file ||
          (chat.previewError?.file === file && chat.previewError.message === result.message)
        )
          continue
        chat.previewError = { file, message: result.message }
        this.changed(chat)
      }
    }
  }
  settingsChanged(chat: Chat) {
    this.services.effect({
      type: 'settings',
      chat: chat.chat,
      root: chat.root,
      settings: chat.settings
    })
  }
  async action(action: NativeChatAction) {
    if (action.chat !== this.active) return
    const chat = this.get(action.chat)
    try {
      await cardAction(this, chat, action)
    } catch (error) {
      this.fail(chat, error)
    }
    this.changed(chat)
  }
  close(key: string) {
    const chat = this.chats.get(key)
    clearTimeout(this.streamUpdates.get(key))
    this.streamUpdates.delete(key)
    this.closed.add(key)
    this.mirrors.delete(key)
    if (chat) {
      chat.cancellation++
      chat.queue = []
      this.chats.delete(key)
    }
  }
}
