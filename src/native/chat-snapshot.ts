import type { ModelChoice } from '../shared/api'
import { shortPaths } from '../shared/display-path'
import type {
  NativeChatActivity,
  NativeChatCard,
  NativeChatMessage,
  NativeChatState
} from '../shared/native-chat'
import { providerOptions, resolveSelection } from '../shared/provider-choices'
import { formatTokens, isEmptyUsage, type TokenUsage } from '../shared/run-stats'
import { rankSlashMatches } from '../shared/slash-menu'
import { parseSlashToken } from '../shared/slash-token'
import { loginCard } from './chat-login'
import { queueNote, recoveryCards } from './chat-recovery'
import type { Chat } from './chat-state'
import { displayContext } from './display-paths'
export const permissionModes = [
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Allow edits' },
  { value: 'default', label: 'Ask always' }
]
export function matches(chat: Chat) {
  const token = parseSlashToken(chat.text, chat.caret)
  return token && !chat.dismissed ? rankSlashMatches(chat.commands, token.query) : []
}
/** Collapsed paths for every surface the chat shows; the full text stays alongside. */
function collapse(chat: Chat, cards: NativeChatCard[], current: NativeChatActivity | null) {
  const ctx = displayContext(chat.root ? [chat.root] : [])
  const short = (text: string) => shortPaths(text, ctx)
  const messages: NativeChatMessage[] = chat.messages.map((message) =>
    message.segments.some((s) => s.kind === 'tools')
      ? {
          ...message,
          segments: message.segments.map((s) =>
            s.kind === 'tools' ? { ...s, labels: s.statuses.map(short) } : s
          )
        }
      : message
  )
  const shortCards = cards.map((card) => {
    const detail = card.detail && short(card.detail)
    return detail === card.detail ? card : { ...card, detail, fullDetail: card.detail }
  })
  const label = current && short(current.label)
  const shortActivity =
    current && label !== current.label
      ? { ...current, label: label!, detail: current.label }
      : current
  return { messages, cards: shortCards, activity: shortActivity }
}
function activity(chat: Chat): NativeChatActivity | null {
  if (!chat.isRunning) return null
  const counter = turnUsage(chat)
  const live = <T extends NativeChatActivity>(state: T): T => ({
    ...state,
    ...(counter && !isEmptyUsage(counter) ? { tokens: tokens(counter, chat.usage) } : {})
  })
  if (chat.stopping) return live({ kind: 'stopping', label: 'Stopping…', animated: false })
  if (chat.permissions.length)
    return live({ kind: 'waiting', label: 'Waiting for approval', animated: false })
  if (chat.questions.length)
    return live({ kind: 'waiting', label: 'Waiting for your answer', animated: false })
  if (chat.phase === 'applying')
    return live({ kind: 'applying', label: 'Applying changes…', animated: true })
  // The model's own steps: the host ticks their elapsed time and, when events and
  // heartbeats stop, says how long nothing arrived (LKM-147).
  const clock = {
    ...(chat.stepAt ? { since: chat.stepAt } : {}),
    ...(chat.aliveAt ? { aliveAt: chat.aliveAt } : {})
  }
  if (chat.phase === 'writing')
    return live({ kind: 'writing', label: 'Writing…', animated: true, ...clock })
  if (chat.phase === 'working' && !chat.progressStep)
    return live({
      kind: 'working',
      label: chat.activityDetail.trim() || 'Working…',
      animated: true,
      ...clock
    })
  return live({
    kind: 'thinking',
    label: chat.progressStep || 'Thinking…',
    animated: true,
    ...clock
  })
}
/** The running turn's usage: on its response, or still waiting for one. */
function turnUsage(chat: Chat) {
  return chat.messages.find((m) => m.id === chat.streamingId)?.usage ?? chat.pendingUsage
}
/** The running turn's counter, on its own line under the live status (LKM-145/147). */
export function tokens(turn: TokenUsage, total: TokenUsage) {
  const n = (v: number) => v.toLocaleString('en-US')
  return {
    label: `↑ ${formatTokens(turn.input)}  ↓ ${formatTokens(turn.output)}`,
    detail: `Tokens across this turn’s model calls, not current context size.\nInput: ${n(turn.input)}\nCached input (included above): ${n(turn.cached)}\nOutput: ${n(turn.output)}\nThis chat so far: ${n(total.input)} input, ${n(total.output)} output`
  }
}
export function snapshot(chat: Chat, choices: ModelChoice[]): NativeChatState {
  const providers = providerOptions(choices)
  const selection = resolveSelection(providers, chat.settings)
  const { provider, model, permissionMode } = chat.settings
  const cards: NativeChatCard[] = []
  if (chat.error)
    cards.push({
      id: 'error',
      title: 'Unable to complete action',
      detail: chat.error,
      actions: [{ label: 'Dismiss', action: 'error-dismiss' }]
    })
  const login = loginCard(chat)
  if (login) cards.push(login)
  if (chat.pendingModel)
    cards.push({
      id: 'model-confirm',
      title: 'Change model for this chat?',
      detail: 'The conversation will be preserved and the agent restarted with the selected model.',
      actions: [
        { label: 'Cancel', action: 'model-cancel' },
        { label: 'Change model', action: 'model-confirm' }
      ]
    })
  const context = chat.context
  const lost = context?.setup.lost && !context.setup.failed
  if (context?.setup.needed && !context.setup.dismissed)
    cards.push({
      id: 'setup',
      title: lost ? 'Source links stopped working' : 'Connect this project to Trezi',
      detail: context.setup.status ?? undefined,
      actions: [
        { label: 'Not now', action: 'setup-dismiss', disabled: chat.setup },
        {
          label: chat.setup
            ? 'Stop'
            : context.setup.failed
              ? 'Retry'
              : lost
                ? 'Reconnect'
                : 'Set up',
          action: chat.setup ? 'stop' : 'setup',
          disabled: chat.isRunning && !chat.setup
        }
      ]
    })
  if (!context?.setup.needed && context?.tokens.needed && !context.tokens.dismissed)
    cards.push({
      id: 'tokens',
      title: 'Add a starter design-token palette?',
      actions: [
        { label: 'Not now', action: 'tokens-dismiss' },
        { label: 'Add tokens', action: 'tokens' }
      ]
    })
  cards.push(...recoveryCards(chat))
  // LKM-165: an unlandable turn says so, with why and a way out — never "pending".
  if (chat.isolation === 'parked' && chat.stopped !== 'held')
    cards.push({
      id: 'conflict',
      title: 'This turn’s changes didn’t land',
      detail: [
        chat.landingError
          ? `Trezi couldn’t apply them to the project: ${chat.landingError}`
          : 'The project changed under them, so Trezi held them instead of overwriting.',
        ...(chat.isolationFiles ?? [])
      ].join('\n'),
      actions: [
        { label: 'Discard', action: 'discard', disabled: chat.isRunning },
        { label: 'Retry', action: 'landing-retry', disabled: chat.isRunning },
        { label: 'Resolve', action: 'resolve', disabled: chat.isRunning }
      ]
    })
  for (const p of chat.permissions)
    cards.push({
      id: p.id,
      title: p.title,
      detail: p.detail,
      actions: [
        { label: 'Deny', action: 'permission', value: 'deny' },
        { label: 'Allow', action: 'permission', value: 'allow' }
      ]
    })
  for (const n of context?.notes ?? [])
    cards.push({
      id: n.id,
      title: 'Note',
      detail: n.text,
      actions: [{ label: 'Remove', action: 'remove-note' }]
    })
  if (context?.notes.length)
    cards.push({
      id: 'notes-publish',
      title: 'Publish notes as a PR',
      actions: [{ label: 'Publish PR', action: 'publish-notes' }]
    })
  for (const spawn of context?.spawns ?? [])
    cards.push({
      id: spawn.id,
      title: spawn.status === 'queued' ? 'Queued agent' : 'Background agent',
      detail: [spawn.label, spawn.activity].filter(Boolean).join('\n\n'),
      actions: [{ label: 'Cancel', action: 'spawn-stop' }]
    })
  const currentActivity = activity(chat)
  const thinking = !!currentActivity?.animated && currentActivity.kind !== 'applying'
  const stop = chat.isRunning && !chat.text.trim() && !chat.attachments.length
  const shown = collapse(chat, cards, currentActivity)
  return {
    activity: shown.activity,
    streamingId: chat.streamingId,
    chat: chat.chat,
    running: chat.isRunning,
    cards: shown.cards,
    questions: chat.questions,
    messages: shown.messages,
    composer: {
      queue: chat.queue.map((q) => ({
        id: `queued-${q.id}`,
        text: q.text,
        attachments: q.attachments.length
      })),
      queuePaused: chat.paused,
      ...queueNote(chat),
      text: chat.text,
      caret: chat.caret,
      revision: chat.revision,
      stop,
      ready: chat.ready && !chat.switching,
      running: chat.isRunning,
      thinking,
      enabled:
        chat.ready &&
        (stop || (!chat.switching && (!!chat.text.trim() || !!chat.attachments.length))),
      sendLabel: stop ? 'Stop' : chat.isRunning ? 'Queue message' : 'Send message',
      context: context?.selection?.label ?? '',
      attachments: chat.attachments.map((a) => ({
        id: a.id,
        name: a.name || 'Image',
        type: a.type,
        data: a.data
      })),
      suggestions: matches(chat).map((command, index) => ({
        title: `/${command.name}`,
        description: command.description ?? '',
        active: index === chat.menuIndex
      })),
      choices: [
        {
          label: 'Provider',
          value: selection.option?.key ?? provider,
          disabled: !chat.ready || chat.isRunning || chat.switching,
          options: providers.length
            ? providers.map((p) => ({ value: p.key, label: p.label }))
            : [{ value: provider, label: provider === 'codex' ? 'Codex' : 'Claude' }]
        },
        {
          label: 'Model',
          value: selection.choice?.value ?? model,
          disabled: !chat.ready || chat.isRunning || chat.switching,
          options: selection.option?.models.map((c) => ({ value: c.value, label: c.label })) ?? [
            { value: model, label: model === 'default' ? 'Default' : model }
          ]
        },
        {
          label: 'Permission mode',
          value: permissionMode,
          disabled: !chat.ready || chat.switching,
          options: permissionModes
        }
      ]
    }
  }
}
