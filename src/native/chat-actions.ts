import { codeLinkTarget } from '../main/code-tools'
import { setLandingProblem } from '../main/landing-context'
import type { ChatUiRecord } from '../shared/chat-ui'
import type { NativeChatAction } from '../shared/native-chat'
import { setupPrompt } from '../shared/setup-prompt'
import { requestTarget } from './chat-agent-card'
import type { NativeChatController, SendAdmission } from './chat-controller'
import { loginAction } from './chat-login'
import { editQueued, sendBlock } from './chat-queue'
import { recoveryAction } from './chat-recovery'
import { writeRecoveryReport } from './chat-recovery-report'
import { assistant, begin, type Chat, placeUi, type Submission } from './chat-state'
import { landingFixPrompt } from './landing-check'

const RECOVERY_REQUEST_MS = 120_000
let recoveryRequestMs = RECOVERY_REQUEST_MS
/** A short deterministic deadline for the deferred-request fixture. */
export function setRecoveryRequestDeadlineForTests(ms: number | null) {
  recoveryRequestMs = ms ?? RECOVERY_REQUEST_MS
}

/** Resolve for a chat whose changes are held: the agent fixes the conflict markers in a turn. */
export async function resolveHeld(controller: NativeChatController, chat: Chat) {
  return recoveryRequest(controller, chat, 'resolve', async () => {
    chat.paused = false
    const result = await controller.services.invoke('agent:resolve-conflict', chat.chat)
    if (!result.ok) throw new Error(result.error ?? 'Unable to resolve changes.')
    if (chat.recoveryTimedOut) return
    if (result.prompt && result.conflicted.length) {
      const prompt = result.prompt
      // The agent turn is not a request in flight: it starts after the request ends,
      // outside the deadline, and the running-turn lock takes over from the busy state.
      return () =>
        controller.run(chat, {
          id: crypto.randomUUID(),
          text: prompt,
          attachments: [],
          selection: null,
          turn: {}
        })
    }
    if (chat.isolation === 'parked')
      chat.recoveryProblem = result.error ?? 'The changes are still held. Review the reason below.'
  })
}

/** A request's follow-up that outlives the request (an agent turn); it gets no deadline. */
type Handover = () => Promise<SendAdmission>

async function recoveryRequest(
  controller: NativeChatController,
  chat: Chat,
  kind: NonNullable<Chat['recovery']>,
  request: () => Promise<Handover | void>
) {
  if (chat.isRunning || chat.sending || chat.recovery) return
  chat.recovery = kind
  chat.recoveryTimedOut = false
  // The prior failed attempt remains part of this incident until a real landing or
  // discard settles it. Its card is shown as progress while the request owns it.
  chat.recoverySettled = undefined
  chat.recoveryOutcome = undefined
  chat.recoveryId = crypto.randomUUID()
  const id = chat.recoveryId
  if (chat.heldIncident) {
    chat.heldIncident.operation = id
    chat.heldIncident.attention = 'owned'
  }
  chat.recoveryStartedAt = Date.now()
  controller.changed(chat)
  let requestPromise: Promise<Handover | void> | undefined
  let handover: Handover | undefined
  let timedOut = false
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      requestPromise = request()
      handover =
        (await Promise.race([
          requestPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              reject(
                new Error(
                  'The recovery request did not answer within two minutes. The changes remain held.'
                )
              )
            }, recoveryRequestMs)
          })
        ])) || undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!handover && !chat.isRunning && chat.recoverySettled && chat.recoverySettled !== 'parked') {
      chat.heldIncident = undefined
      chat.recoveryId = undefined
      chat.recoveryProblem = undefined
      chat.recoveryReport = undefined
      chat.recoveryOutcome =
        kind === 'discard'
          ? 'Held changes discarded.'
          : chat.recoverySettled === 'merged'
            ? 'Changes applied to the project.'
            : 'No changes remained to apply.'
    }
    // Acknowledged handover starts its agent turn immediately. The prior report is
    // already available; a fresh report cannot be allowed to delay or abort the turn.
    if (!handover && chat.recoveryProblem) {
      try {
        const path = await writeRecoveryReport(chat, kind, chat.recoveryProblem)
        if (path && chat.recoveryId === id) chat.recoveryReport = path
      } catch {
        if (chat.recoveryId === id) {
          chat.recoveryReport = undefined
          chat.recoveryProblem += ' The support report could not be written.'
        }
      }
    }
  } catch (error) {
    chat.recoveryTimedOut = timedOut
    chat.recoveryProblem = `Problem: ${error instanceof Error ? error.message : String(error)}`
    try {
      const path = await writeRecoveryReport(chat, kind, chat.recoveryProblem)
      if (path && chat.recoveryId === id) chat.recoveryReport = path
    } catch {
      chat.recoveryReport = undefined
      chat.recoveryProblem += ' The support report could not be written.'
    }
    if (chat.heldIncident) chat.heldIncident.attention = 'terminal'
    if (kind === 'resolve') throw error
  } finally {
    if (chat.recoveryTimedOut && requestPromise) {
      // The request can still mutate the owner after the visible deadline. Keep
      // every card mutation locked until its actual IPC settles, without a spinner.
      void requestPromise
        .finally(() => {
          if (chat.recoveryId === id) {
            chat.recovery = undefined
            chat.recoveryTimedOut = false
            controller.changed(chat)
          }
        })
        .catch(() => {})
    } else {
      chat.recovery = undefined
      chat.recoveryTimedOut = false
      // A handover starts its turn right away, which renders the running state itself.
      if (!handover) {
        if (chat.heldIncident && chat.isolation === 'parked')
          chat.heldIncident.attention = 'terminal'
        controller.changed(chat)
      }
    }
  }
  if (handover) {
    const admission = await handover()
    if (admission.state === 'cancelled') {
      if (chat.autoResolved === 'tried') chat.autoResolved = undefined
      controller.changed(chat)
      return
    }
    if (admission.state === 'admitted' || (admission.state === 'queued' && chat.isRunning)) return
    if (chat.recoveryId !== id || chat.isolation !== 'parked') return
    if (admission.state === 'queued')
      chat.queue = chat.queue.filter((item) => item.id !== admission.id)
    const reason =
      admission.state === 'failed'
        ? `The resolution turn could not start: ${admission.reason}`
        : 'The resolution turn could not start while this chat still needs Resolve.'
    chat.recoveryProblem = `Problem: ${reason}`
    try {
      const path = await writeRecoveryReport(chat, 'resolve handover', reason)
      if (path && chat.recoveryId === id) chat.recoveryReport = path
    } catch {
      if (chat.recoveryId === id && chat.isolation === 'parked') {
        chat.recoveryReport = undefined
        chat.recoveryProblem += ' The support report could not be written.'
      }
    }
    if (chat.recoveryId !== id || chat.isolation !== 'parked') return
    if (chat.heldIncident) chat.heldIncident.attention = 'terminal'
    controller.changed(chat)
    throw new Error(reason)
  }
}

/** Card actions call application services directly; shell effects only refresh web panels. */
export async function cardAction(
  controller: NativeChatController,
  chat: Chat,
  action: NativeChatAction
) {
  const { invoke, effect } = controller.services
  if (action.action === 'recovery-outcome-dismiss') {
    chat.recoveryOutcome = undefined
    return
  }
  if (action.action === 'recovery-report') {
    if (chat.recoveryReport) {
      const result = await invoke('recovery:copy-report', chat.chat)
      if (!result.ok)
        chat.recoveryProblem = `Problem: ${result.error ?? 'Could not copy the report.'}`
    }
    return
  }
  // Handle these before the general asynchronous card dispatcher. A double click
  // cannot reach the backend while the first request is still in flight.
  if (action.action === 'resolve') return resolveHeld(controller, chat).catch(() => {})
  if (action.action === 'discard')
    return recoveryRequest(controller, chat, 'discard', async () => {
      chat.paused = false
      const result = await invoke('agent:discard-conflict', chat.chat)
      if (!result.ok && result.error) throw new Error(result.error)
    })
  if (action.action === 'landing-retry')
    return recoveryRequest(controller, chat, 'retry', async () => {
      chat.paused = false
      const result = await invoke('agent:retry-landing', chat.chat)
      if (!result.ok) throw new Error(result.error ?? 'Unable to retry the landing.')
      if (result.state === 'parked' && chat.isolation === 'parked')
        chat.recoveryProblem =
          result.error ?? 'The changes are still held. Review the reason below.'
    })
  if (await recoveryAction(controller, chat, action.action, action.id)) return
  switch (action.action) {
    case 'error-dismiss':
      chat.error = undefined
      break
    case 'login-dismiss':
    case 'login-check':
    case 'login-retry':
    case 'sign-in-claude':
    case 'sign-in-codex':
    case 'sign-in-cancel':
      await loginAction(controller, chat, action.action)
      break
    case 'model-cancel':
      chat.pendingModel = undefined
      break
    case 'model-confirm': {
      const settings = chat.pendingModel
      chat.pendingModel = undefined
      if (settings) await controller.changeModel(chat, settings)
      break
    }
    case 'permission':
      if (
        !chat.permissions.some((p) => p.id === action.id) ||
        (action.value !== 'allow' && action.value !== 'deny')
      )
        return
      await invoke('agent:respond-permission', action.id, action.value)
      chat.permissions = chat.permissions.filter((p) => p.id !== action.id)
      break
    case 'question': {
      // A background agent's question (LKM-193) takes the same answer path as the chat's.
      const spawn = chat.context?.spawns.find((s) => s.question?.id === action.id)
      if (!spawn && !chat.questions.some((q) => q.id === action.id)) return
      const reply = (await invoke('agent:respond-question', action.id, action.answers ?? null)) as
        | { message?: string }
        | undefined
      chat.questions = chat.questions.filter((q) => q.id !== action.id)
      // An ask_user answer (LKM-199) is the user's next message, queued while a turn runs.
      if (reply?.message) sendReply(controller, chat, reply.message)
      if (spawn)
        effect({
          type: 'spawn',
          event: {
            type: 'question-resolved',
            id: action.id!,
            projectKey: chat.chat,
            sessionId: spawn.id
          }
        })
      break
    }
    case 'chat-ui': {
      // LKM-208: a pick or a form's values; the conversation saves them with the
      // component and they go back to the agent as the user's next message.
      if (!action.id) return
      let answer: unknown
      try {
        answer = JSON.parse(action.value ?? '')
      } catch {
        return
      }
      const reply = (await invoke('agent:chat-ui-answer', chat.chat, action.id, answer)) as
        | { record: ChatUiRecord; message: string }
        | { error: string }
      if ('error' in reply) {
        chat.error = reply.error
        break
      }
      placeUi(chat, reply.record)
      sendReply(controller, chat, reply.message, action.id)
      break
    }
    // LKM-210: a post-landing check's warning row.
    case 'landing-fix': {
      const check = chat.messages.find((m) => m.id === action.id)?.landingCheck
      if (!check) return
      // The message names the problem: the pending context would only repeat it.
      setLandingProblem(chat.chat, null)
      sendReply(controller, chat, landingFixPrompt(check))
      break
    }
    case 'landing-preview':
      effect({ type: 'preview' })
      break
    case 'spawn-open-target': {
      const spawn = chat.context?.spawns.find((s) => s.id === action.id)
      const target = spawn && requestTarget(spawn.label)
      if (target) effect({ type: 'source', source: target.source })
      break
    }
    // LKM-364: a code link in an answer (an open_code candidate) opens only in Trezi's
    // editor, through open_code's project checks; a refused one says why.
    case 'code-link': {
      const target = await codeLinkTarget(chat.root, action.value)
      if ('error' in target) chat.error = `Not opened in the editor: ${target.error}`
      else effect({ type: 'code', ...target })
      break
    }
    case 'queue-remove':
      for (const q of chat.queue)
        if (`queued-${q.id}` === action.id && q.chatUiId)
          await invoke('agent:chat-ui-delivery', chat.chat, q.chatUiId, 'cancelled').catch(() => {})
      chat.queue = chat.queue.filter((q) => `queued-${q.id}` !== action.id)
      break
    case 'queue-edit':
      for (const q of chat.queue)
        if (`queued-${q.id}` === action.id && q.chatUiId)
          await invoke('agent:chat-ui-delivery', chat.chat, q.chatUiId, 'cancelled').catch(() => {})
      editQueued(chat, action.id)
      effect({ type: 'focus' })
      break
    case 'queue-resume':
      chat.paused = false
      void controller.drain(chat)
      break
    case 'stop':
      await controller.stop(chat)
      break
    case 'spawn-stop':
      if (chat.context?.spawns.some((s) => s.id === action.id))
        await invoke('agent:spawn-interrupt', action.id)
      break
    case 'revert': {
      const message = chat.messages.find((m) => m.id === action.id)
      if (!message?.revertGroup) return
      const result = await invoke('edit:revert', chat.root, message.revertGroup)
      if (!result.ok)
        throw new Error('Unable to revert edits because files have changed since this turn.')
      if (chat.landed?.group === message.revertGroup) {
        chat.landed = undefined
        chat.previewError = undefined
      }
      message.revertGroup = undefined
      break
    }
    // Resolve, Discard and Retry are the user's way out: the queue follows once the held
    // changes land or go (the isolation event drains it, LKM-169).
    case 'setup-dismiss':
      if (chat.setup) return
      if (chat.context) chat.context.setup.dismissed = true
      effect({ type: 'setup', chat: chat.chat, phase: 'dismissed' })
      break
    case 'setup': {
      if (!chat.ready || chat.setup || chat.isRunning || chat.sending) return
      chat.setup = true
      chat.sending = true
      controller.changed(chat)
      const cancellation = chat.cancellation
      try {
        // With the chat key Trezi copies the helpers into the chat's worktree first (LKM-153).
        const result = await invoke('setup:scaffold', chat.root, chat.chat)
        if (!result.ok) throw new Error(result.error ?? 'Trezi could not write its setup helpers.')
        const prompt = setupPrompt(result)
        if (!prompt)
          throw new Error(
            `Automatic source mapping is unavailable for ${result.framework ?? 'this framework'}.`
          )
        if (chat.cancellation !== cancellation || controller.chats.get(chat.chat) !== chat) return
        begin(chat)
        chat.isRunning = true
        chat.turnStartedAt = Date.now()
        assistant(chat)
        chat.turn = crypto.randomUUID()
        effect({ type: 'setup', chat: chat.chat, phase: 'configuring' })
        controller.changed(chat)
        await invoke('agent:send', prompt, undefined, chat.chat, undefined, chat.turn)
      } catch (error) {
        // The setup card shows the exact reason with a retry, so no separate error card.
        chat.setup = false
        chat.isRunning = false
        effect({
          type: 'setup',
          chat: chat.chat,
          phase: 'failed',
          status: error instanceof Error ? error.message : String(error)
        })
      } finally {
        chat.sending = false
        void controller.drain(chat)
      }
      break
    }
    case 'tokens': {
      const result = await invoke('tokens:scaffold', chat.root)
      if (!result.ok) throw new Error(result.error ?? 'Unable to add tokens.')
      if (chat.context) chat.context.tokens.needed = false
      effect({ type: 'tokens', root: chat.root })
      break
    }
    case 'tokens-dismiss':
      if (chat.context) chat.context.tokens.dismissed = true
      effect({ type: 'tokens', root: chat.root })
      break
    case 'remove-note':
      if (!chat.context?.notes.some((n) => n.id === action.id)) return
      await invoke('annotations:remove', chat.root, action.id)
      chat.context.notes = chat.context.notes.filter((n) => n.id !== action.id)
      effect({ type: 'notes', root: chat.root })
      break
    case 'publish-notes': {
      const result = await invoke('publish:to-pr', chat.root, { title: 'trezi: design handoff' })
      if (!result.ok) throw new Error(result.error ?? 'Publish failed.')
      if (result.url) await invoke('agent:tag-session', chat.root, { prUrl: result.url })
      break
    }
  }
}

/** Sends `text` as the user's next message, leaving their composer draft alone. */
function sendReply(controller: NativeChatController, chat: Chat, text: string, chatUiId?: string) {
  if (chat.chat === controller.start.planningKey) {
    void controller.submit(chat, text)
    return
  }
  const submission: Submission = {
    id: chatUiId ?? crypto.randomUUID(),
    text,
    ...(chatUiId ? { chatUiId } : {}),
    attachments: [],
    selection: null,
    turn: chat.context?.turn ?? {}
  }
  if (sendBlock(chat) || chat.queue.length) chat.queue.push(submission)
  else {
    chat.paused = false
    void controller.run(chat, submission)
  }
}
