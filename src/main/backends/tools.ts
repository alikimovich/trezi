import type { NativeView } from '../../native/platform'

/**
 * Send an IPC message to the main renderer, guarding a destroyed webContents.
 *
 * Backend event streams fire from async SDK callbacks that keep running after
 * the renderer process is killed (OS display sleep / GPU loss): the window
 * outlives its `webContents`, so a bare `getWindow()?.webContents.send(...)`
 * throws an uncaught "Object has been destroyed" — the crash dialog seen on
 * wake. `isDestroyed()` makes a late emit a safe no-op.
 */
export function sendToRenderer(
  getWindow: () => NativeView | null,
  channel: string,
  payload: unknown
): void {
  const wc = getWindow()?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

/**
 * Tool-name policy + status helpers shared by the model-provider backends
 * (`claude.ts`, `codex.ts`, …) and by the generic permission machinery in
 * `agent.ts`. Lives in its own module so providers and `agent.ts` can both import
 * it without an import cycle.
 *
 * The tool NAMES here are Claude-Agent-SDK-flavored (Read/Edit/Bash/…). Other
 * providers reuse `describeTool`/`touchesSidecar` for their own equivalents where
 * the names line up; where they differ, a provider maps its names before calling.
 */

// Read-only tools are auto-approved even in "Ask" mode — they can't mutate the
// repo, and prompting for every file read would make the agent unusable.
export const AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
// Tools that 'acceptEdits' auto-approves (mirrors the SDK's edit semantics).
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// The legacy sidecar names stay protected: old repos still carry them.
const SIDECAR_RE = /(^|[\s/\\"'])\.(trezi|praxis|dsgn)([/\\]|$)/

/** Does this tool target the .trezi/ sidecar (edit-tool path or a Bash command)? */
export function touchesSidecar(toolName: string, input: unknown): boolean {
  const i = input as Record<string, unknown>
  if (EDIT_TOOLS.has(toolName)) {
    const path = i?.file_path ?? i?.path
    if (typeof path === 'string' && SIDECAR_RE.test(path)) return true
  }
  if (toolName === 'Bash' && typeof i?.command === 'string' && SIDECAR_RE.test(i.command)) {
    return true
  }
  return false
}

/** The single most relevant input field for a tool, trimmed to one short line. */
export function toolDetail(_name: string, input: unknown): string | undefined {
  const i = input as Record<string, unknown>
  const raw = i?.file_path ?? i?.path ?? i?.pattern ?? i?.command
  if (raw == null) return undefined
  const s = String(raw).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, 160) : undefined
}

export function describeTool(name: string, input: unknown): string {
  // The question itself is shown as a card; its status never names the raw tool (LKM-193).
  if (name === 'AskUserQuestion') return 'Asking you a question'
  const detail = toolDetail(name, input)
  return detail ? `${name} · ${detail}` : name
}
