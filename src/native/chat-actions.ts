import { setLandingProblem } from '../main/landing-context'
import type { ChatUiRecord } from '../shared/chat-ui'
import type { NativeChatAction } from '../shared/native-chat'
import { setupPrompt } from '../shared/setup-prompt'
import { requestTarget } from './chat-agent-card'
import type { NativeChatController } from './chat-controller'
import { loginAction } from './chat-login'
import { editQueued, sendBlock } from './chat-queue'
import { recoveryAction } from './chat-recovery'
import { assistant, begin, type Chat, placeUi, type Submission } from './chat-state'
import { landingFixPrompt } from './landing-check'

/** Card actions call application services directly; shell effects only refresh web panels. */
export async function cardAction(
  controller: NativeChatController,
  chat: Chat,
  action: NativeChatAction
) {
  const { invoke, effect } = controller.services
  if (await recoveryAction(controller, chat, action.action, action.id)) return
  switch (action.action) {
    case 'error-dismiss':
      chat.error = undefined
      break
    case 'login-dismiss':
    case 'login-check':
    case 'login-retry':
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
      sendReply(controller, chat, reply.message)
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
    case 'queue-remove':
      chat.queue = chat.queue.filter((q) => `queued-${q.id}` !== action.id)
      break
    case 'queue-edit':
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
    case 'resolve': {
      if (chat.isRunning || chat.sending) return
      chat.paused = false
      const result = await invoke('agent:resolve-conflict', chat.chat)
      if (!result.ok) throw new Error(result.error ?? 'Unable to resolve changes.')
      if (result.prompt && result.conflicted.length)
        await controller.run(chat, {
          id: crypto.randomUUID(),
          text: result.prompt,
          attachments: [],
          selection: null,
          turn: {}
        })
      break
    }
    case 'discard':
      if (chat.isRunning || chat.sending) return
      chat.paused = false
      await invoke('agent:discard-conflict', chat.chat)
      break
    case 'landing-retry': {
      // The outcome arrives as an isolation event: merged, or this card with the reason.
      if (chat.isRunning || chat.sending) return
      chat.paused = false
      const result = await invoke('agent:retry-landing', chat.chat)
      if (!result.ok) throw new Error(result.error ?? 'Unable to retry the landing.')
      break
    }
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
function sendReply(controller: NativeChatController, chat: Chat, text: string) {
  const submission: Submission = {
    id: crypto.randomUUID(),
    text,
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
