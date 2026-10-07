import type { SessionToolHost } from './backends/types'
import { agentGitTool } from './chat-agent-git'
import { runChatIslandTool } from './chat-islands'
import {
  agentWorkspaceEvidence,
  agentWorkspaceState,
  reconcilePark,
  resolveParkedChat
} from './chat-isolation'
import { openAgentCode } from './code-tools'
import { isPreviewObserver, observeAgentPreview } from './preview-observation-tools'
import { reloadAgentPreview, restartAgentDevServer } from './preview-refresh-tools'
import { openAgentPreview } from './preview-tools'
import { runProjectUiTool } from './project-ui'
import { ProviderError, providerOwner } from './provider-owner'
import { findPack } from './skill-packs'
import type { TreziAgentToolAction } from './trezi-agent-tools'
import { workflowOwner } from './workflow-owner'

/**
 * Trezi's session-scoped agent tools that act on app state (the preview, islands,
 * the editor, workspace landing, skill installs), run in Bun for one chat. The
 * Codex MCP bridge and helper-hosted sessions dispatch here; Claude's in-process
 * tools call the same functions. Pure calculators are not here: they need nothing
 * from Bun and run wherever the provider runs.
 */
export interface ToolScope {
  /** The session's working directory (a chat worktree, or the live root). */
  root: string
  liveRoot: string
  emitKey: string
  background: boolean
  connectionId?: string
  notify: (channel: string, payload: unknown) => void
}

/** Every tool that needs main's state; `runTreziTool` runs exactly these (LKM-131). */
export type SessionTool = TreziAgentToolAction | 'install_skills'
export const SESSION_TOOLS: readonly SessionTool[] = [
  'workspace_state',
  'prepare_conflict_resolution',
  'git_sync_base',
  'git_merge_continue',
  'git_merge_abort',
  'pr_status',
  'publish_update',
  'chat_island',
  'open_code',
  'open_preview',
  'reload_preview',
  'restart_dev_server',
  'preview_location',
  'preview_screenshot',
  'preview_inspect',
  'preview_evaluate',
  'preview_console',
  'preview_viewport',
  'project_ui_catalog',
  'compose_project_ui',
  'install_skills'
]

export async function runTreziTool(
  action: SessionTool,
  args: unknown,
  s: ToolScope
): Promise<unknown> {
  // The owner grants more names than run here (the calculators run in the provider).
  if (!SESSION_TOOLS.includes(action))
    return { error: `${String(action)} is not one of Trezi's session tools.` }
  if (action === 'preview_viewport' && s.background)
    return { error: 'Background edits cannot resize the user preview.' }
  if (isPreviewObserver(action)) return observeAgentPreview(action, args)
  if (action === 'project_ui_catalog' || action === 'compose_project_ui')
    return runProjectUiTool(s.root, s.emitKey, action, args as never, s.connectionId)
  if (action === 'chat_island')
    return s.background
      ? { error: 'Background edits cannot create chat islands.' }
      : runChatIslandTool(s.emitKey, s.root, args as never, s.connectionId)
  if (action === 'open_preview')
    return openAgentPreview(s.liveRoot, s.emitKey, args as never, s.notify, s.background)
  if (action === 'reload_preview')
    return reloadAgentPreview(s.liveRoot, s.emitKey, args, s.notify, s.background)
  if (action === 'restart_dev_server')
    return restartAgentDevServer(s.liveRoot, s.emitKey, args, s.notify, s.background)
  if (action === 'open_code')
    return s.background
      ? { error: 'Background edits cannot navigate the user editor.' }
      : openAgentCode(s.root, s.liveRoot, s.emitKey, args as never, s.notify)
  if (action === 'install_skills') return installSkills(args, s)
  if (s.background)
    return {
      ok: false,
      guidance: 'This background edit lands automatically. Do not change the parent chat workspace.'
    }
  // LKM-196: one consistent status, never "parked" with no batch behind it.
  if (action === 'workspace_state' || action === 'prepare_conflict_resolution')
    await reconcilePark(s.emitKey, 'agent-tool')
  if (action === 'workspace_state') return agentWorkspaceEvidence(s.emitKey, s.liveRoot)
  if (
    [
      'git_sync_base',
      'git_merge_continue',
      'git_merge_abort',
      'pr_status',
      'publish_update'
    ].includes(action)
  )
    return agentGitTool(s.emitKey, s.root, s.liveRoot, action, args)
  const before = agentWorkspaceState(s.emitKey)
  if (before.state === 'live' || before.state === 'isolated') {
    return { ok: false, ...before, guidance: 'There is no parked Trezi batch to prepare.' }
  }
  const prepared = await resolveParkedChat(s.emitKey)
  const state = agentWorkspaceState(s.emitKey)
  return {
    ...prepared,
    ...state,
    guidance: prepared.ok
      ? prepared.conflicted.length
        ? 'Resolve every conflict marker in the listed files, then finish the turn normally.'
        : 'Trezi combined and landed both sides without requiring manual resolution.'
      : `Trezi could not prepare the conflict: ${prepared.error ?? 'unknown error'}`
  }
}

/**
 * A curated skill pack into the project or user scope, through the workflow owner. The
 * pack id is checked against the allowlist before anything runs, and skills land in the
 * live root, not the chat worktree.
 */
async function installSkills(
  raw: unknown,
  s: ToolScope
): Promise<{ ok: boolean; message: string }> {
  const args = (raw ?? {}) as { packId?: unknown; scope?: unknown }
  const pack = typeof args.packId === 'string' ? findPack(args.packId) : undefined
  if (!pack) {
    return {
      ok: false,
      message: `install_skills failed: '${String(args.packId)}' is not in the curated skill-pack allowlist. Call list_recommended_skills and use one of its ids.`
    }
  }
  if (args.scope !== undefined && args.scope !== 'project' && args.scope !== 'user')
    return { ok: false, message: "install_skills failed: scope must be 'project' or 'user'." }
  const result = await workflowOwner().installSkills({
    packId: pack.id,
    scope: args.scope ?? pack.recommendedScope,
    liveRoot: s.liveRoot
  })
  return { ok: result.ok, message: result.message }
}

/**
 * How an adapter runs a session tool. Inside a provider helper (`ctx.tools` set) the call
 * leaves as a `tool` frame: the Swift owner checks it against the helper's grant, Bun runs
 * it here with main's state and the session's scope, and the result comes back. The helper
 * itself holds none of that state, so a local call there would only find missing services
 * (LKM-131). A refusal or failure comes back as the tool's `{ error }`. In Bun, `run` runs.
 */
export function sessionTool(
  host: SessionToolHost | undefined,
  run: (action: SessionTool, args: unknown) => Promise<unknown>
) {
  return (action: SessionTool, args: unknown): Promise<unknown> =>
    host
      ? host.invoke(action, args ?? {}).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
      : run(action, args)
}

/**
 * Runs a tool only if the provider owner grants it to this session (S10). A refusal
 * (a tool outside the grant, a closed session, oversized arguments) comes back as the
 * tool's `{ error }` result, like any other tool failure the model can read.
 */
export async function authorizedTool<T>(
  grant: string | undefined,
  tool: string,
  args: unknown,
  run: () => Promise<T>
): Promise<T | { error: string }> {
  if (grant) {
    try {
      await providerOwner().authorize(grant, tool, args)
    } catch (error) {
      return {
        error:
          error instanceof ProviderError || error instanceof Error ? error.message : String(error)
      }
    }
  }
  return run()
}
