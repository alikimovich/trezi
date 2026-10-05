import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { AUTO_ALLOW_TOOLS, EDIT_TOOLS } from './backends/tools'

/**
 * The provider owner's policy (S10), pure. The Swift service mirrors it exactly in
 * `src/service/ProviderPolicy.swift`; `test/provider-owner.mjs` pins the owner's answers
 * to the ones this module gave through the in-process twin LKM-111 removed. Adapters
 * without a grant (inside a helper) and the tool limits still call it directly.
 *
 * A provider session's capabilities are decided by the owner from facts it was told
 * when the session opened (provider, background or not, its root) — never from what
 * the adapter or helper asks for later. The adapter cannot widen its own grant.
 */

/** Cancellation: how long Stop waits for a provider's graceful answer before killing it. */
export const INTERRUPT_GRACE_MS = 3_000

/** Bounds on what a provider session may hand the owner (and a helper may send). */
export const LIMITS = {
  /** One helper frame (a line on its stdout). Holds a screenshot or pasted images. */
  helperLine: 24 * 1024 * 1024,
  /** A user turn's text, in UTF-16 units. */
  sendText: 2 * 1024 * 1024,
  /** Images on one turn, and each image's base64 length (about 10 MiB decoded). */
  images: 16,
  imageBase64: 14 * 1024 * 1024,
  /** All images on one turn together (Bun's pipe to the service carries at most 32 MiB a line). */
  imagesTotal: 20 * 1024 * 1024,
  /** A permission request's path or command, in UTF-16 units; a longer one is denied unchecked. */
  permissionTarget: 4 * 1024 * 1024,
  /** A Trezi tool call's JSON arguments, in bytes. */
  toolArgs: 256 * 1024,
  /** Text fields of relayed events (a delta, a status line, an error). */
  eventText: 1024 * 1024,
  /** Tool calls and approvals a helper may have open at once. */
  pendingTools: 8,
  pendingApprovals: 32
} as const

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** Trezi's own agent tools, bare names (Claude sees them as `mcp__trezi__<name>`). */
export const TREZI_TOOLS = [
  'project_ui_catalog',
  'compose_project_ui',
  'preview_location',
  'preview_screenshot',
  'preview_inspect',
  'preview_evaluate',
  'preview_console',
  'preview_viewport',
  'open_preview',
  'open_code',
  'chat_island',
  'spring_to_css',
  'check_contrast',
  'fluid_clamp',
  'color_scale',
  'layered_shadow',
  'line_height',
  'list_recommended_skills',
  'install_skills',
  'workspace_state',
  'prepare_conflict_resolution'
] as const

/** Tools a background (comment) session is not granted, and what it is told instead. */
export const FOREGROUND_ONLY: Readonly<Record<string, string>> = {
  open_code: 'Background edits cannot navigate the user editor.',
  chat_island: 'Background edits cannot create chat islands.',
  preview_viewport: 'Background edits cannot resize the user preview.'
}

/** Trezi tools that never prompt (side-effect-free or validated by their own service). */
const AUTO_TREZI = new Set<string>(
  TREZI_TOOLS.filter(
    (t) => t !== 'install_skills' && t !== 'workspace_state' && t !== 'prepare_conflict_resolution'
  )
)
const AUTO_ALLOW = AUTO_ALLOW_TOOLS
const EDIT = EDIT_TOOLS
const SIDECAR = /(^|[\s/\\"'])\.(trezi|praxis|dsgn)([/\\]|$)/
const MCP_PREFIX = 'mcp__trezi__'

export const MESSAGES = {
  inactive: 'Session no longer active.',
  sidecar: 'The .trezi/ sidecar is managed by trezi, not the agent.',
  profile: "Trezi's own data is managed by Trezi, not the agent.",
  closed: 'This provider session is no longer active.',
  ungranted: (tool: string) => `The ${tool} tool is not granted to this session.`,
  tooLarge: 'The tool arguments are too large.',
  targetTooLarge: 'The request is too large for Trezi to check.'
}

export function grantedTools(background: boolean): string[] {
  return TREZI_TOOLS.filter((tool) => !(background && tool in FOREGROUND_ONLY))
}

export interface PolicyScope {
  /** The session is open and not stopped (the adapter's own abort state is separate). */
  live: boolean
  background: boolean
  root: string
  liveRoot: string
  /** Trezi's profile (userData): chat worktrees live under it; nothing else there is the agent's. */
  profile: string
}

export type PermissionVerdict =
  | { decision: 'allow' }
  | { decision: 'ask' }
  | { decision: 'question' }
  | { decision: 'deny'; message: string }

/**
 * The file path or command a permission request is about: an edit tool's path, a
 * Bash command. A helper that only knows the request's display detail passes that.
 */
export function permissionTarget(tool: string, input: unknown): string | undefined {
  const i = input as Record<string, unknown> | null | undefined
  if (EDIT.has(tool)) {
    const path = i?.file_path ?? i?.path
    return typeof path === 'string' ? path : undefined
  }
  if (tool === 'Bash' && typeof i?.command === 'string') return i.command
  return undefined
}

const within = (path: string, dir: string): boolean => {
  const d = normalize(dir).replace(/[/\\]+$/, '')
  return path === d || path.startsWith(d + sep)
}

/** An edit whose (lexical) target is in Trezi's profile but outside this session's roots. */
function touchesProfile(tool: string, target: string | undefined, scope: PolicyScope): boolean {
  if (!EDIT.has(tool) || !target || !scope.profile) return false
  const absolute = normalize(isAbsolute(target) ? target : resolve(scope.root, target))
  return (
    within(absolute, scope.profile) &&
    !within(absolute, scope.root) &&
    !within(absolute, scope.liveRoot)
  )
}

/**
 * What a provider's permission hook (Claude's `canUseTool`, a helper's request) is
 * answered. Order matters and matches the pre-S10 adapter exactly: questions, Trezi
 * tools, the sidecar, Trezi's own data, read-only tools, then a closed session, else ask.
 */
export function decidePermission(
  tool: string,
  target: string | undefined,
  scope: PolicyScope
): PermissionVerdict {
  if (tool === 'AskUserQuestion')
    return scope.live ? { decision: 'question' } : { decision: 'deny', message: MESSAGES.inactive }
  if (tool.startsWith(MCP_PREFIX)) {
    const name = tool.slice(MCP_PREFIX.length)
    if (AUTO_TREZI.has(name)) {
      return scope.background && name in FOREGROUND_ONLY
        ? { decision: 'deny', message: FOREGROUND_ONLY[name] }
        : { decision: 'allow' }
    }
  }
  if (target !== undefined && (EDIT.has(tool) || tool === 'Bash') && SIDECAR.test(target))
    return { decision: 'deny', message: MESSAGES.sidecar }
  if (touchesProfile(tool, target, scope)) return { decision: 'deny', message: MESSAGES.profile }
  if (AUTO_ALLOW.has(tool)) return { decision: 'allow' }
  if (!scope.live) return { decision: 'deny', message: MESSAGES.inactive }
  return { decision: 'ask' }
}

export type ToolRefusal = { code: 'unauthorized' | 'invalidRequest'; message: string }

/** Whether a session may run one of Trezi's tools with arguments of `bytes` bytes. */
export function authorizeTool(
  tool: string,
  bytes: number,
  scope: Pick<PolicyScope, 'live' | 'background'>
): ToolRefusal | null {
  if (!scope.live) return { code: 'unauthorized', message: MESSAGES.closed }
  if (!(TREZI_TOOLS as readonly string[]).includes(tool))
    return { code: 'unauthorized', message: MESSAGES.ungranted(tool) }
  if (scope.background && tool in FOREGROUND_ONLY)
    return { code: 'unauthorized', message: FOREGROUND_ONLY[tool] }
  if (bytes > LIMITS.toolArgs) return { code: 'invalidRequest', message: MESSAGES.tooLarge }
  return null
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** A turn's images: at most `images` of them, each valid, `imagesTotal` together. */
export function validImages(images: readonly { mediaType?: unknown; data?: unknown }[]): boolean {
  let total = 0
  for (const image of images) {
    if (!validImage(image.mediaType, image.data)) return false
    total += (image.data as string).length
  }
  return images.length <= LIMITS.images && total <= LIMITS.imagesTotal
}

/** A pasted/dropped image or a tool's image block: an allowed type, well-formed, bounded. */
export function validImage(mediaType: unknown, data: unknown): boolean {
  return (
    typeof mediaType === 'string' &&
    (IMAGE_TYPES as readonly string[]).includes(mediaType) &&
    typeof data === 'string' &&
    data.length > 0 &&
    data.length <= LIMITS.imageBase64 &&
    data.length % 4 === 0 &&
    BASE64.test(data)
  )
}

/** A provider id: a label for in-process adapters; for helpers, one the service was built with. */
export const validProviderID = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id)

/** A session, chat or approval id the owner stores and names files after. */
export const validSessionID = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
