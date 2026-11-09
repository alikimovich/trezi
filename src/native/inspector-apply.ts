// LKM-599: the inspector's Apply runs as its own background agent (a worktree spawn).
// What its rail row says, what the inspector says when it did not land, and the native
// smoke's seam for a simulated agent.
import type { AppAction } from '../shared/app-action'
import { backgroundAgentOptions } from '../shared/background-model'
import { agentOptionsFor } from '../shared/chat-settings'
import { oneLine } from '../shared/selection-context'
import type { NativeChatController } from './chat-controller'
import type { InspectorDraftTurns } from './inspector-controller'
import type { NativeWorkspaceController } from './workspace-controller'

type ApplyDispatch = (
  root: string,
  prompt: string,
  parent: string,
  label: string,
  action?: AppAction
) => Promise<{ ok: boolean; spawnId?: string; reason?: string } | null>
let override: ApplyDispatch | null = null
/** The native smoke's simulated background agent for Apply; null restores the real spawn. */
export function setInspectorApplyDispatch(dispatch: ApplyDispatch | null): void {
  override = dispatch
}
/**
 * LKM-600: what the user sees for an Apply, from the draft itself (never parsed from the
 * instruction): "font-weight: 400 on <span> in PresetPreview.tsx:82". No selector, hash
 * or workspace path; the full instruction stays with the worker and the row's detail.
 */
export function applySummary(
  element: { tag?: string; source?: string | null } | null,
  changes: { prop: string; value: string }[]
): string {
  const shown = changes
    .slice(0, 3)
    .map((change) => `${oneLine(change.prop, 40)}: ${oneLine(change.value, 60)}`)
    .join(', ')
  const more = changes.length > 3 ? ` and ${changes.length - 3} more` : ''
  const tag = element?.tag ? ` on <${oneLine(element.tag, 32)}>` : ''
  const file = /([^/\\]+?)(?::(\d+))?(?::\d+)?$/.exec(element?.source ?? '')
  const where = file ? ` in ${oneLine(file[1], 60)}${file[2] ? `:${file[2]}` : ''}` : ''
  return `${shown || 'Styles draft'}${more}${tag}${where}`
}
/** The rail row's one line for a background Apply (LKM-599, LKM-600: the change, not the selector). */
export function applyLabel(action: AppAction): string {
  return `Apply ${action.summary}`
}
/** What the inspector says when a background Apply did not land (LKM-599). */
export function applyOutcome(event: {
  outcome?: string
  branch?: string | null
  summary?: string
  decision?: string
}): { success: boolean; reason?: string } {
  if (event.outcome === 'applied') return { success: true }
  const detail = event.summary ? ` ${oneLine(event.summary, 240)}` : ''
  const pending = ' The draft is still pending.'
  if (event.outcome === 'cancelled')
    return { success: false, reason: `Apply was cancelled.${pending}` }
  if (event.outcome === 'no-change')
    return { success: false, reason: `Apply finished without changing source.${detail}${pending}` }
  if (event.outcome === 'review' || event.decision)
    return {
      success: false,
      reason: `Apply could not land safely${event.branch ? `; its change is kept on ${event.branch} for review` : ''}.${detail}${pending}`
    }
  return { success: false, reason: `Apply failed.${detail}${pending}` }
}

/** The old chat-turn Apply, kept only for projects that cannot run a background agent. */
async function applyThroughChat(
  workspace: NativeWorkspaceController,
  chat: NativeChatController,
  draftTurns: InspectorDraftTurns,
  root: string,
  prompt: string,
  action: AppAction | undefined,
  why: string
): Promise<string> {
  const entry = workspace.state.projects.find((p) => p.root === root)
  if (!entry) throw new Error('The project is no longer open. The draft is still pending.')
  const key = entry.activeSessionKey
  const session = chat.chats.get(key)
  if (
    !session ||
    chat.active !== key ||
    !session.ready ||
    session.root !== root ||
    session.isRunning ||
    session.queue.length
  )
    throw new Error(`${why} Finish the current chat turn to apply this draft through the chat.`)
  const previousTurn = session.turn
  // LKM-600: the chat shows Trezi's own row (the change), not the instruction as user text.
  await chat.command({ type: 'submit', chat: key, text: prompt, ...(action ? { action } : {}) })
  if (!session.turn || session.turn === previousTurn)
    throw new Error('The chat could not start the Apply turn. The draft is still pending.')
  draftTurns.add(key, session.turn)
  return session.turn
}

/**
 * Starts one Apply as a background agent in its own worktree (the spawn comments and text
 * edits use: bounded per project, landed through the repository owner with its checks and
 * conflict handling). The active chat is never submitted to, stopped or steered. Returns
 * the operation id the draft is locked to; `applies` maps it to its project until its
 * `spawn-finished` arrives.
 */
export async function startApply(
  workspace: NativeWorkspaceController,
  chat: NativeChatController,
  draftTurns: InspectorDraftTurns,
  applies: Map<string, string>,
  root: string,
  prompt: string,
  action?: AppAction
): Promise<string> {
  const entry = workspace.state.projects.find((p) => p.root === root)
  if (!entry) throw new Error('The project is no longer open. The draft is still pending.')
  const parent = entry.activeSessionKey
  const current = chat.chats.get(parent)
  const label = action ? applyLabel(action) : 'Apply Styles draft'
  const result = override
    ? await override(root, prompt, parent, label, action)
    : await workspace.services.invoke(
        'agent:spawn-comment',
        root,
        prompt,
        parent,
        backgroundAgentOptions(current ? agentOptionsFor(current.settings) : {}, 'text-edit'),
        'text-edit',
        label,
        undefined,
        action
      )
  if (result?.ok && typeof result.spawnId === 'string') {
    applies.set(result.spawnId, root)
    return result.spawnId
  }
  // Only a project that cannot run a background agent falls back to the chat.
  if (result?.reason === 'not-a-repo')
    return applyThroughChat(
      workspace,
      chat,
      draftTurns,
      root,
      prompt,
      action,
      'This project is not a Git repository, so Apply cannot run in the background.'
    )
  if (result?.reason === 'unsupported-backend')
    return applyThroughChat(
      workspace,
      chat,
      draftTurns,
      root,
      prompt,
      action,
      "This chat's provider cannot run Apply in the background."
    )
  throw new Error(
    `Could not start Apply: ${oneLine(String(result?.reason ?? 'no answer'), 200)} The draft is still pending.`
  )
}
