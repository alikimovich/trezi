import { conflictTitle, fixInstallPrompt, resolveConflictPrompt } from '../shared/dependency-issue'
import type { NativeChatCard } from '../shared/native-chat'
import type { NativeChatController } from './chat-controller'
import { type Chat, STOPPED_GROUP } from './chat-state'

/**
 * LKM-151: recovery after Stop or a broken preview, in Trezi's own chat UI.
 *  - A stopped turn's work is held, never landed: revert it (undoable until the next
 *    turn), keep it, or ask the agent to finish it.
 *  - A dev-server compile/parse error in a file the last landed turn touched offers
 *    "Revert last turn" and "Fix with agent".
 *  - A paused queue says why it is not sending and can be sent now (`chat-queue.ts`).
 */

const FINISH_PROMPT =
  'I pressed Stop while you were partway through the last change. Finish it now, ' +
  'and make sure every file you touched is complete and parses (balanced JSX tags, brackets and imports).'

export const fixPrompt = (error: { file: string; message: string }): string =>
  `The preview fails to compile after your last change. The dev server reports this error in ${error.file}:\n\n` +
  `${error.message}\n\nFix the error so the file parses and the page builds again. Keep the intended change.`

const fileList = (files?: string[]) => (files?.length ? `\n\n${files.join('\n')}` : '')

export function recoveryCards(chat: Chat): NativeChatCard[] {
  const cards: NativeChatCard[] = []
  const busy = chat.isRunning || chat.sending
  if (chat.stopped === 'held' && chat.isolation === 'parked')
    cards.push({
      id: 'stopped',
      title: 'Stopped — this turn’s changes are on hold',
      detail: `Your project still has the files it had before this turn. Nothing was applied.${fileList(chat.isolationFiles)}`,
      actions: [
        { label: 'Revert this turn’s changes', action: 'stopped-revert', disabled: busy },
        { label: 'Keep changes', action: 'stopped-keep', disabled: busy },
        { label: 'Ask agent to finish', action: 'stopped-finish', disabled: busy }
      ]
    })
  if (chat.stopped === 'reverted')
    cards.push({
      id: 'stopped-reverted',
      title: 'Reverted this turn’s changes',
      detail: `Your project is exactly as it was before the stopped turn.${fileList(chat.isolationFiles)}`,
      actions: [
        { label: 'Dismiss', action: 'stopped-dismiss' },
        { label: 'Undo', action: 'stopped-undo', disabled: busy }
      ]
    })
  const error = chat.previewError
  if (error)
    cards.push({
      id: 'preview-error',
      title: `Preview error in ${error.file}`,
      detail: error.message,
      actions: [
        { label: 'Dismiss', action: 'preview-dismiss' },
        {
          label: 'Revert last turn',
          action: 'preview-revert',
          disabled: busy || !chat.landed?.group
        },
        { label: 'Fix with agent', action: 'preview-fix', disabled: busy }
      ]
    })
  cards.push(...dependencyCards(chat, busy))
  return cards
}

/** LKM-194: the turn started without dependencies; say why and offer the way out. */
function dependencyCards(chat: Chat, busy: boolean): NativeChatCard[] {
  const issue = chat.dependencies
  const conflict = issue?.conflict
  if (conflict) {
    const version = conflict.version
    return [
      {
        id: 'dependency-conflict',
        title: conflictTitle(conflict),
        detail: [
          'Unresolved Git conflict markers came in from the project.',
          conflict.manifests ? 'Dependencies were not installed.' : '',
          version
            ? `Both sides changed the version (${version.ours} and ${version.theirs}): keep ${version.keep}, the higher one.`
            : '',
          conflict.files.length > 1 ? conflict.files.join('\n') : ''
        ]
          .filter(Boolean)
          .join('\n'),
        actions: [
          { label: 'Show conflict', action: 'dependency-show' },
          { label: 'Resolve with agent', action: 'dependency-resolve', disabled: busy }
        ]
      }
    ]
  }
  if (issue?.install)
    return [
      {
        id: 'dependency-install',
        title: 'Dependencies aren’t installed',
        detail: issue.install,
        actions: [
          { label: 'Dismiss', action: 'dependency-dismiss' },
          { label: 'Fix with agent', action: 'dependency-fix', disabled: busy }
        ]
      }
    ]
  return []
}

/** A recovery card action; false when `action` is not one. */
export async function recoveryAction(
  controller: NativeChatController,
  chat: Chat,
  action: string,
  id?: string
): Promise<boolean> {
  const { invoke } = controller.services
  const busy = chat.isRunning || chat.sending
  const follow = (text: string) =>
    controller.run(chat, {
      id: crypto.randomUUID(),
      text,
      attachments: [],
      selection: null,
      turn: {}
    })
  switch (action) {
    case 'stopped-revert': {
      if (busy) return true
      const result = await invoke('agent:revert-stopped', chat.chat)
      if (!result.ok) throw new Error(result.error ?? 'Unable to revert this turn’s changes.')
      return true
    }
    case 'stopped-undo': {
      if (busy) return true
      const result = await invoke('agent:undo-revert-stopped', chat.chat)
      if (!result.ok) throw new Error(result.error ?? 'Unable to undo the revert.')
      return true
    }
    case 'stopped-keep': {
      if (busy) return true
      const result = await invoke('agent:keep-stopped', chat.chat)
      if (!result.ok) throw new Error(result.error ?? 'Unable to keep this turn’s changes.')
      return true
    }
    case 'stopped-finish':
      if (!busy) {
        chat.paused = false
        await follow(FINISH_PROMPT)
      }
      return true
    case 'stopped-dismiss':
      chat.stopped = undefined
      return true
    case 'preview-dismiss':
      chat.previewError = undefined
      return true
    case 'preview-revert': {
      const group = chat.landed?.group
      if (busy || !group) return true
      const result = await invoke('edit:revert', chat.root, group)
      if (!result.ok)
        throw new Error('Unable to revert the last turn because its files have changed since.')
      for (const message of chat.messages)
        if (message.revertGroup === group) message.revertGroup = undefined
      chat.landed = undefined
      chat.previewError = undefined
      return true
    }
    case 'preview-fix': {
      const error = chat.previewError
      if (busy || !error) return true
      chat.previewError = undefined
      chat.paused = false
      await follow(fixPrompt(error))
      return true
    }
    case 'dependency-show': {
      const conflict = chat.dependencies?.conflict
      if (conflict)
        controller.services.effect({
          type: 'source',
          source: `${conflict.files[0]}:${conflict.line}`
        })
      return true
    }
    case 'dependency-resolve':
    case 'dependency-fix': {
      const issue = chat.dependencies
      if (busy || !issue) return true
      const prompt = issue.conflict
        ? resolveConflictPrompt(issue.conflict)
        : issue.install
          ? fixInstallPrompt(issue.install)
          : null
      if (!prompt) return true
      chat.paused = false
      await follow(prompt)
      return true
    }
    case 'dependency-dismiss':
      chat.dependencies = undefined
      return true
    case 'revert': {
      // The hover Revert of a stopped turn's message drops its held work.
      const message = chat.messages.find((m) => m.id === id)
      if (!message?.revertGroup?.startsWith(STOPPED_GROUP)) return false
      if (busy) return true
      const result = await invoke('agent:revert-stopped', chat.chat)
      if (!result.ok) throw new Error(result.error ?? 'Unable to revert this turn’s changes.')
      message.revertGroup = undefined
      return true
    }
  }
  return false
}
