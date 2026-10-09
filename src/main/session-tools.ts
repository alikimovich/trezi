import { bridge } from '../native/bridge'
import { previewPath } from '../shared/preview-navigation'
import { projectKey } from '../shared/projectKey'
import { agentBrowser } from './agent-browser'
import type { SessionToolHost } from './backends/types'
import { agentGitTool } from './chat-agent-git'
import { runChatIslandTool } from './chat-islands'
import {
  agentWorkspaceEvidence,
  agentWorkspaceState,
  landNow,
  reconcilePark,
  resolveParkedChat
} from './chat-isolation'
import { chatUiTool } from './chat-ui'
import { openAgentCode } from './code-tools'
import { noteServedRevision } from './landing-context'
import { treziLiveEffect } from './live-change-watch'
import { type PreviewToolResult, runPreviewAgentTool } from './preview-agent-tools'
import { previewServers } from './preview-evidence'
import { identityText, isPreviewObserver, observeAgentPreview } from './preview-observation-tools'
import { agentPreviewOverlay } from './preview-overlay'
import { reloadAgentPreview, restartAgentDevServer } from './preview-refresh-tools'
import { parseSpeed } from './preview-speed'
import { getPreviewUrl } from './preview-state'
import { openAgentPreview } from './preview-tools'
import { runProjectUiTool } from './project-ui'
import { ProviderError, providerOwner } from './provider-owner'
import { askUser } from './question-tool'
import { findPack } from './skill-packs'
import { timedToolCall } from './tool-timing'
import type { TreziAgentToolAction } from './trezi-agent-tools'
import { turnTimings } from './turn-timing'
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
  'publish_merge',
  'land_now',
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
  'preview_speed',
  'project_ui_catalog',
  'compose_project_ui',
  'ask_user',
  'chat_ui',
  'install_skills'
]

/** Native host is the gate; tests may supply a deterministic clock/result. */
let revealGate = () => bridge().request('previewRevealAllowed') as Promise<boolean>
export function setPreviewRevealGateForTests(gate: (() => Promise<boolean>) | null): void {
  revealGate = gate ?? (() => bridge().request('previewRevealAllowed') as Promise<boolean>)
}

/** Tools that change the live checkout themselves: what they change is Trezi's own
 *  effect, never an outside change in the turn's report (LKM-215). */
export const LIVE_EFFECT_TOOLS: ReadonlySet<SessionTool> = new Set<SessionTool>([
  'land_now',
  'publish_update',
  'publish_merge',
  'git_sync_base',
  'git_merge_continue',
  'git_merge_abort',
  'prepare_conflict_resolution',
  'restart_dev_server',
  'install_skills'
])

/** Runs one session tool; every call is timed and logged with its phases (LKM-200). */
export function runTreziTool(action: SessionTool, args: unknown, s: ToolScope): Promise<unknown> {
  const run = () => runTool(action, args, s)
  return timedToolCall(s.emitKey, String(action), () =>
    LIVE_EFFECT_TOOLS.has(action) ? treziLiveEffect(s.liveRoot, run) : run()
  )
}

async function runTool(action: SessionTool, args: unknown, s: ToolScope): Promise<unknown> {
  // The owner grants more names than run here (the calculators run in the provider).
  if (!SESSION_TOOLS.includes(action))
    return { error: `${String(action)} is not one of Trezi's session tools.` }
  const target = (args as { target?: unknown } | null)?.target
  const engine = (args as { engine?: unknown } | null)?.engine
  const browserTool =
    isPreviewObserver(action) || action === 'open_preview' || action === 'reload_preview'
  if (browserTool && target !== undefined && target !== 'user' && target !== 'agent')
    return { error: 'target must be "agent" or "user".' }
  if (browserTool && engine !== undefined && engine !== 'webkit' && engine !== 'chromium')
    return { error: 'engine must be "webkit" or "chromium".' }
  const browserEngine = engine === 'chromium' ? 'chromium' : 'webkit'
  if (
    target === 'user' &&
    (action === 'open_preview' ||
      action === 'reload_preview' ||
      action === 'preview_viewport' ||
      action === 'preview_speed')
  ) {
    if (s.background) return { error: 'Background agents cannot move the user preview.' }
    if (!(await revealGate()))
      return {
        error:
          'The user is interacting with the preview. Keep checking in the agent browser and reveal the result when the preview has been idle for 5 seconds.'
      }
  }
  // LKM-210: a landed revision the chat's agent looked at needs no automatic check.
  const saw = (revision: string | null | undefined) => {
    if (!s.background) noteServedRevision(s.emitKey, revision)
  }
  if (isPreviewObserver(action)) {
    if (target === 'user')
      return observeAgentPreview(action, args, s.liveRoot, (identity) =>
        saw(identity.servedRevision)
      )
    try {
      const browser = await agentBrowser(s.emitKey, s.liveRoot, browserEngine)
      if (!browser.url) {
        const server = previewServers.get(projectKey(s.liveRoot))
        if (!server)
          return {
            content: [
              { type: 'text', text: 'The project dev server is stopped. Call restart_dev_server.' }
            ],
            isError: true
          }
        const shown = getPreviewUrl()
        const route =
          shown && new URL(shown).origin === new URL(server.url).origin
            ? new URL(shown).pathname + new URL(shown).search + new URL(shown).hash
            : '/'
        await browser.open(route)
      }
      const identity = await browser.identity()
      let result: PreviewToolResult
      if (action === 'preview_location') {
        result = { content: [{ type: 'text' as const, text: `Agent browser: ${browser.url}` }] }
      } else if (action === 'preview_speed') {
        const speedArgs = (args ?? {}) as { speed?: unknown; step?: unknown }
        if (speedArgs.step !== undefined) {
          if (
            !Number.isInteger(speedArgs.step) ||
            (speedArgs.step as number) < 1 ||
            (speedArgs.step as number) > 600
          )
            return {
              content: [{ type: 'text', text: 'Step must be 1–600 frames.' }],
              isError: true
            }
          await browser.step(speedArgs.step as number)
        } else if (speedArgs.speed !== undefined) {
          const speed = parseSpeed(speedArgs.speed)
          if (speed === null)
            return {
              content: [{ type: 'text', text: 'Use speed 1, 0.5, 0.25, 0.1 or 0.' }],
              isError: true
            }
          await browser.setSpeed(speed)
        }
        result = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                speed: browser.speed,
                ...(speedArgs.step !== undefined ? { stepped: speedArgs.step } : {})
              })
            }
          ]
        }
      } else if (
        action === 'preview_screenshot' &&
        !(args as { selector?: unknown; x?: unknown })?.selector &&
        (args as { x?: unknown })?.x === undefined
      ) {
        const frame = await browser.capture((args as { full?: boolean })?.full === true)
        result = frame
          ? {
              content: [
                {
                  type: 'image' as const,
                  data: frame.jpeg.toString('base64'),
                  mimeType: 'image/jpeg'
                },
                {
                  type: 'text' as const,
                  text: `Screenshot: ${frame.width}×${frame.height} px JPEG.`
                }
              ]
            }
          : {
              content: [{ type: 'text' as const, text: 'Agent browser snapshot unavailable.' }],
              isError: true
            }
      } else {
        result = await runPreviewAgentTool(action, args, browser.host)
      }
      if (!result.isError) {
        saw(identity.servedRevision)
        result.content.push({ type: 'text', text: identityText(identity) })
      }
      return result
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Agent browser failed: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }
  if (action === 'project_ui_catalog' || action === 'compose_project_ui')
    return runProjectUiTool(s.root, s.emitKey, action, args as never, s.connectionId)
  if (action === 'chat_island')
    return s.background
      ? { error: 'Background edits cannot create chat islands.' }
      : runChatIslandTool(s.emitKey, s.root, args as never, s.connectionId)
  if (action === 'open_preview' || action === 'reload_preview') {
    if (target !== 'user') {
      try {
        const browser = await agentBrowser(s.emitKey, s.liveRoot, browserEngine)
        const path =
          action === 'open_preview'
            ? previewPath((args as { path?: unknown } | null)?.path)
            : browser.url
              ? new URL(browser.url).pathname +
                new URL(browser.url).search +
                new URL(browser.url).hash
              : '/'
        if (!path) return { error: 'Provide a project-root path starting with /.' }
        const opened = await browser.open(
          path,
          action === 'reload_preview'
            ? { reload: true, hard: (args as { hard?: unknown } | null)?.hard === true }
            : undefined
        )
        saw(opened.identity.servedRevision)
        return {
          requested: true,
          path,
          navigation: 'loaded',
          loaded: true,
          httpStatus: opened.status ?? null,
          finalUrl: opened.url,
          preview: opened.identity,
          message: 'The agent browser loaded this route. Call preview_screenshot to check it.'
        }
      } catch (error) {
        return {
          error: `Agent browser failed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
    const answer = (await (action === 'open_preview'
      ? openAgentPreview(s.liveRoot, s.emitKey, args as never, s.notify, s.background)
      : reloadAgentPreview(s.liveRoot, s.emitKey, args, s.notify, s.background))) as {
      loaded?: boolean
      httpStatus?: number | null
      preview?: { servedRevision?: string | null }
    } | null
    if (answer?.loaded && !(answer.httpStatus && answer.httpStatus >= 400))
      saw(answer.preview?.servedRevision)
    return answer
  }
  if (action === 'restart_dev_server')
    return restartAgentDevServer(s.liveRoot, s.emitKey, args, s.notify, s.background)
  if (action === 'open_code')
    return s.background
      ? { error: 'Background edits cannot navigate the user editor.' }
      : openAgentCode(s.root, s.liveRoot, s.emitKey, args as never, s.notify)
  if (action === 'install_skills') return installSkills(args, s)
  if (action === 'ask_user') return askUser(args, s)
  if (action === 'chat_ui') return chatUiTool(args, s)
  if (s.background)
    return {
      ok: false,
      guidance: 'This background edit lands automatically. Do not change the parent chat workspace.'
    }
  // LKM-196: one consistent status, never "parked" with no batch behind it.
  if (action === 'workspace_state' || action === 'prepare_conflict_resolution')
    await reconcilePark(s.emitKey, 'agent-tool')
  // LKM-200: the turn's timing, so the agent answers "how long did this take" from facts.
  if (action === 'workspace_state')
    return {
      ...(await agentWorkspaceEvidence(s.emitKey, s.liveRoot)),
      timing: turnTimings.report(s.emitKey),
      // LKM-205: the user's rulers, guides and grids, read-only.
      previewOverlay: agentPreviewOverlay(s.liveRoot)
    }
  if (action === 'land_now') {
    const message = (args as { message?: unknown } | null)?.message
    return landNow(
      s.emitKey,
      typeof message === 'string' && message.trim()
        ? message.slice(0, 2000)
        : 'Land current chat changes'
    )
  }
  if (
    [
      'git_sync_base',
      'git_merge_continue',
      'git_merge_abort',
      'pr_status',
      'publish_update',
      'publish_merge'
    ].includes(action)
  ) {
    const startedAt = Date.now()
    if (action === 'publish_update' || action === 'publish_merge') {
      const landed = (await landNow(s.emitKey, 'Land changes before publishing')) as {
        outcome?: string
        error?: string
      }
      if (landed.error || (landed.outcome !== 'merged' && landed.outcome !== 'unchanged'))
        return {
          error:
            landed.error ?? 'Changes did not land; resolve the parked files before publishing.',
          landing: landed
        }
    }
    return agentGitTool(s.emitKey, s.root, s.liveRoot, action, args, startedAt)
  }
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
