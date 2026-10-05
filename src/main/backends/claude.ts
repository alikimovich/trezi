import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { chatIslandDescription, chatIslandShape } from '../../../bin/chat-island-schema.mjs'
import {
  previewToolText as PREVIEW_TOOL_TEXT,
  previewToolShapes as previewShapes
} from '../../../bin/preview-tool-schema.mjs'
import type { NativeView } from '../../native/platform'
import type {
  AgentEvent,
  AgentOptions,
  ImageAttachment,
  PermissionRequest,
  QuestionAnswers,
  QuestionRequest,
  QuestionSpec,
  SessionTranscriptEntry,
  SlashCommandItem
} from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import { checkContrast, suggestAccessible } from '../apca'
import { discoverPortableSkills } from '../bundled-skills'
import { fluidClamp, fluidScale } from '../fluid'
import { liveCheckoutEdit } from '../live-write-guard'
import { recordClaudeModels } from '../model-catalog'
import { oklchScale } from '../oklch'
import type { PreviewObserver } from '../preview-observation-tools'
import { providerOwner } from '../provider-owner'
import {
  decidePermission,
  INTERRUPT_GRACE_MS,
  type PermissionVerdict,
  permissionTarget
} from '../provider-policy'
import { treziRules } from '../rules'
import { runTreziTool, sessionTool } from '../session-tools'
import { elevationScale, layeredShadow } from '../shadows'
import { SKILL_PACKS } from '../skill-packs'
import { discoverProjectSkills, mergeSlashCommands } from '../skills'
import {
  analyze,
  fromBounceDuration,
  fromRatioFreq,
  PRESETS,
  type SpringConfig,
  springToCss,
  toCssVars,
  toKeyframes,
  toTransition
} from '../spring'
import { letterSpacing, lineHeight } from '../type-metrics'
import { claudeIsolationOptions } from './claude-isolation'
import {
  checkClaudeLogin,
  claudeCliChoice,
  forgetClaudeCli,
  isAuthFailure,
  isLoginCommand,
  LOGIN_COMMAND_MESSAGE,
  resolveClaudeCli
} from './claude-login'
import { interruptWithEscalation } from './interrupt'
import { parseProjectMemoryEvaluation, projectMemoryEvaluationPrompt } from './memory'
import { createRecordCapture } from './record'
import { withSkillReferences } from './skill-menu'
import { streamedChars, streamUsage } from './stream-usage'
import { sanitizeTitle, transcriptDigest } from './title'
import { describeTool, sendToRenderer, toolDetail } from './tools'
import type {
  ModelProvider,
  PendingPrompt,
  PendingQuestion,
  ProviderSession,
  SpawnContext
} from './types'

// The bundled Trezi agent plugin (skills teaching the preview workflow). Lives
// at the repo root; resolved relative to the compiled main (out/main →
// ../../agent-plugin), the same walk as index.ts's appIcon. Only wired in when
// present so a stripped build degrades gracefully instead of erroring.
const PLUGIN_PATH = join(__dirname, '../../agent-plugin')

// The two in-process `trezi` MCP tools, fully-qualified (mcp__<server>__<tool>).
// Read-only observers of the user's preview — auto-allowed so they never prompt.
const PREVIEW_TOOL_NAMES = new Set([
  'mcp__trezi__preview_location',
  'mcp__trezi__preview_screenshot',
  // LKM-138: isolated-world inspection; evaluate is read-only and bounded, and a
  // viewport change is temporary and restores itself.
  'mcp__trezi__preview_inspect',
  'mcp__trezi__preview_evaluate',
  'mcp__trezi__preview_console',
  'mcp__trezi__preview_viewport'
])
// Validated in-process tools are auto-allowed by both allowedTools and
// canUseTool. Chat islands persist through the island service; main remains
// the sole writer of app state under `.trezi/`.
const TREZI_TOOL_NAMES = new Set([
  ...PREVIEW_TOOL_NAMES,
  'mcp__trezi__chat_island',
  'mcp__trezi__open_code',
  'mcp__trezi__open_preview',
  'mcp__trezi__project_ui_catalog',
  'mcp__trezi__compose_project_ui',
  // Pure, deterministic spring→CSS calculator. No state, no side effects, so
  // it's auto-allowed like the observers — it never touches disk or the repo.
  'mcp__trezi__spring_to_css',
  // APCA accessible-contrast checker + color suggester. Also pure (reads no repo
  // state, writes nothing) — auto-allowed for the same reason.
  'mcp__trezi__check_contrast',
  // Design-system calculators (fluid clamp() sizing, OKLCH color ramps, layered
  // shadows, size-aware line-height). All pure math — no state, no disk — so
  // auto-allowed like the rest.
  'mcp__trezi__fluid_clamp',
  'mcp__trezi__color_scale',
  'mcp__trezi__layered_shadow',
  'mcp__trezi__line_height',
  // Lists the curated skill-pack catalog — pure/read-only (no install, no
  // network), so auto-allowed. Its sibling `install_skills` is deliberately NOT
  // here: it writes files + hits the network, so it must surface a permission card.
  'mcp__trezi__list_recommended_skills'
])

// `spring_to_css` input — three interchangeable ways to describe the spring
// (physical, ζ/frequency, or Framer-style bounce/duration) plus a preset shortcut
// and output-shape knobs. Pure calculation: the SDK turns this zod shape into
// JSON Schema so the model sees every field without prompt bloat.
const springToCssShape = {
  stiffness: z
    .number()
    .positive()
    .optional()
    .describe('Physical spring: spring constant k (>0). Pair with damping.'),
  damping: z
    .number()
    .min(0)
    .optional()
    .describe('Physical spring: damping coefficient c (>=0). Pair with stiffness.'),
  mass: z
    .number()
    .positive()
    .optional()
    .describe('Mass m (>0). Default 1. Applies to all input modes.'),
  dampingRatio: z
    .number()
    .positive()
    .optional()
    .describe('ζ: <1 bounces, 1 critical, >1 overdamped. Pair with frequencyHz.'),
  frequencyHz: z
    .number()
    .positive()
    .optional()
    .describe('Natural frequency in Hz. Pair with dampingRatio.'),
  bounce: z
    .number()
    .optional()
    .describe('Framer-style bounciness (~0–1; higher = bouncier). Pair with durationMs.'),
  durationMs: z
    .number()
    .positive()
    .optional()
    .describe('Framer-style target settle duration (ms). Pair with bounce.'),
  preset: z
    .string()
    .optional()
    .describe(`Named preset instead of raw params. One of: ${Object.keys(PRESETS).join(', ')}.`),
  property: z.string().optional().describe("CSS property the motion drives. Default 'transform'."),
  format: z
    .enum(['transition', 'linear', 'css-vars', 'keyframes', 'json'])
    .optional()
    .describe("Output shape. Default 'transition' (property + duration + linear())."),
  simplify: z
    .number()
    .optional()
    .describe(
      'RDP tolerance (e.g. 0.001) to trim control points on long curves. Omit for full resolution.'
    )
}

/** Resolve the spring config from whichever of the three input modes was given. */
function resolveSpringConfig(a: {
  stiffness?: number
  damping?: number
  mass?: number
  dampingRatio?: number
  frequencyHz?: number
  bounce?: number
  durationMs?: number
  preset?: string
}): SpringConfig | { error: string } {
  const mass = a.mass ?? 1
  if (a.preset !== undefined) {
    const cfg = PRESETS[a.preset]
    if (!cfg)
      return {
        error: `unknown preset "${a.preset}". Choose one of: ${Object.keys(PRESETS).join(', ')}.`
      }
    return cfg
  }
  if (a.stiffness !== undefined || a.damping !== undefined) {
    if (a.stiffness === undefined || a.damping === undefined) {
      return { error: 'stiffness and damping must be given together.' }
    }
    return { stiffness: a.stiffness, damping: a.damping, mass }
  }
  if (a.dampingRatio !== undefined || a.frequencyHz !== undefined) {
    if (a.dampingRatio === undefined || a.frequencyHz === undefined) {
      return { error: 'dampingRatio and frequencyHz must be given together.' }
    }
    return fromRatioFreq(a.dampingRatio, a.frequencyHz, mass)
  }
  if (a.bounce !== undefined || a.durationMs !== undefined) {
    if (a.bounce === undefined || a.durationMs === undefined) {
      return { error: 'bounce and durationMs must be given together.' }
    }
    return fromBounceDuration(a.bounce, a.durationMs, mass)
  }
  return {
    error:
      'no spring given. Provide one of: stiffness+damping, dampingRatio+frequencyHz, bounce+durationMs, or preset.'
  }
}

// `check_contrast` input — a color pair plus text context, and how to suggest an
// accessible alternative when it fails. Pure calculation over the APCA reference
// tables (apca.ts); the SDK turns this zod shape into JSON Schema for the model.
const checkContrastShape = {
  foreground: z.string().describe('Text/foreground color: hex, rgb(), hsl(), or CSS color name.'),
  background: z.string().describe('Background color (same formats).'),
  fontSizePx: z.number().positive().optional().describe('Text size in px. Default 16.'),
  fontWeight: z
    .number()
    .optional()
    .describe('Font weight 100–900 (snapped to nearest 100). Default 400.'),
  wcag2: z
    .boolean()
    .optional()
    .describe('Also report the legacy WCAG 2 ratio (AA/AAA). Default false.'),
  suggest: z
    .enum(['auto', 'foreground', 'background', 'none'])
    .optional()
    .describe(
      "When/what to suggest an accessible alternative for, preserving hue: 'auto' (default) suggests a " +
        "new foreground only if the pair fails; 'foreground'/'background' force a suggestion for that color; " +
        "'none' skips it."
    )
}

// `fluid_clamp` input — a single fluid value (minPx+maxPx) or a whole modular
// scale. Viewport/root knobs are shared. Pure Utopia math (fluid.ts).
const fluidClampShape = {
  minPx: z
    .number()
    .positive()
    .optional()
    .describe('Size in px at the min viewport (single-value mode). Pair with maxPx.'),
  maxPx: z
    .number()
    .positive()
    .optional()
    .describe('Size in px at the max viewport (single-value mode). Pair with minPx.'),
  scale: z
    .object({
      baseMinPx: z.number().positive().describe('Base step size (px) at the min viewport.'),
      baseMaxPx: z.number().positive().describe('Base step size (px) at the max viewport.'),
      ratioMin: z
        .number()
        .positive()
        .optional()
        .describe('Modular ratio at the min viewport (default 1.2 — tighter on mobile).'),
      ratioMax: z
        .number()
        .positive()
        .optional()
        .describe('Modular ratio at the max viewport (default 1.25).'),
      stepsUp: z.number().int().optional().describe('Steps above base (default 5).'),
      stepsDown: z.number().int().optional().describe('Steps below base (default 2).')
    })
    .optional()
    .describe('Generate a whole fluid type/space scale instead of a single value.'),
  minViewportPx: z
    .number()
    .positive()
    .optional()
    .describe('Viewport where the min size applies (default 320).'),
  maxViewportPx: z
    .number()
    .positive()
    .optional()
    .describe('Viewport where the max size applies (default 1280).'),
  rootPx: z
    .number()
    .positive()
    .optional()
    .describe('Root font size for rem conversion (default 16).'),
  format: z
    .enum(['value', 'css-vars'])
    .optional()
    .describe(
      "Output shape. 'value' (default) = raw clamp() strings; 'css-vars' = a --step-* custom-property block."
    )
}

// `color_scale` input — an OKLCH perceptual tonal ramp from a seed color (oklch.ts).
const colorScaleShape = {
  seed: z.string().describe('Seed color (hex) to build the ramp around.'),
  steps: z
    .number()
    .int()
    .optional()
    .describe('Number of steps (default 12; step 1 = lightest, N = darkest).'),
  hueShift: z.number().optional().describe('Degrees to rotate the hue from the seed (default 0).'),
  lightnessRange: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('[darkestL, lightestL] in OKLCH lightness 0..1 (default [0.18, 0.98]).'),
  format: z
    .enum(['hex-list', 'css-vars', 'tailwind'])
    .optional()
    .describe("Output shape (default 'hex-list')."),
  name: z
    .string()
    .optional()
    .describe("Token name prefix for css-vars/tailwind output (default 'color').")
}

// `layered_shadow` input — one elevation shadow or a whole elevation scale (shadows.ts).
const layeredShadowShape = {
  elevation: z
    .number()
    .optional()
    .describe('Logical lift (0 = flush, larger = more raised, ~0..24). Single-shadow mode.'),
  scale: z
    .boolean()
    .optional()
    .describe('Generate a whole elevation scale instead of a single shadow.'),
  levels: z
    .number()
    .int()
    .optional()
    .describe('Number of elevation tokens when scale=true (default 5).'),
  layers: z.number().int().optional().describe('Stacked box-shadow layers per shadow (default 5).'),
  lightAngleDeg: z
    .number()
    .optional()
    .describe('Direction light comes from (default 180 = top → shadow cast downward).'),
  colorRgb: z
    .tuple([z.number(), z.number(), z.number()])
    .optional()
    .describe('Shadow color as RGB 0-255 (default [0,0,0]).'),
  baseAlpha: z
    .number()
    .positive()
    .optional()
    .describe('Opacity of the closest (tightest) layer (default 0.12).'),
  format: z
    .enum(['value', 'css-vars'])
    .optional()
    .describe("Output shape. 'value' (default) or a --shadow-* custom-property block.")
}

// `line_height` input — a font size plus optional measure/role and output knobs.
// Pure type-metrics math (type-metrics.ts): size-aware, WCAG-floored leading and
// (optional) Material-3 tracking. The SDK turns this zod shape into JSON Schema.
const lineHeightShape = {
  fontSizePx: z.number().positive().describe('Font size in px to compute leading for.'),
  measureCh: z
    .number()
    .positive()
    .optional()
    .describe(
      'Line length in characters (measure). Longer lines get a touch more leading (~66ch ideal).'
    ),
  role: z
    .enum(['auto', 'body', 'heading', 'display'])
    .optional()
    .describe(
      "Type role (default 'auto' = inferred from size). Sets the WCAG floor: 'body' is floored at 1.5; 'heading'/'display' may sit tighter."
    ),
  includeTracking: z
    .boolean()
    .optional()
    .describe('Also return a recommended letter-spacing (tracking) for this size.'),
  format: z
    .enum(['value', 'css'])
    .optional()
    .describe(
      "Output shape. 'value' (default) = the unitless line-height number; 'css' = a `line-height: <n>;` declaration (plus `letter-spacing` when includeTracking)."
    )
}

/** Panel id assigned by main: component slug + a short hash of file+component,
 *  matching validateManifest's `^[a-z0-9][a-z0-9-]{0,40}$` by construction. */
// The Agent SDK is ESM-only; this CJS main bundle must reach it via a dynamic
// import() (preserved by Rollup for external deps) rather than a static require.
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<SdkModule> | null = null
const loadSdk = (): Promise<SdkModule> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

/** A push-driven async queue of user messages for the SDK's streaming input. */
class InputStream implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = []
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(text: string, images?: ImageAttachment[]): void {
    // Plain string when there are no images; otherwise a content-block array so the
    // Claude Agent SDK sees the text + each pasted/dropped image as a vision block.
    const content =
      images && images.length
        ? [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map((im) => ({
              type: 'image',
              source: { type: 'base64', media_type: im.mediaType, data: im.data }
            }))
          ]
        : text
    const msg = {
      type: 'user',
      message: { role: 'user', content }
    } as unknown as SDKUserMessage
    const next = this.waiting.shift()
    if (next) next({ value: msg, done: false })
    else this.buffer.push(msg)
  }

  close(): void {
    this.closed = true
    for (let r = this.waiting.shift(); r; r = this.waiting.shift())
      r({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const buffered = this.buffer.shift()
        if (buffered) return Promise.resolve({ value: buffered, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}

/** Pull a text delta out of a streaming partial-message event, shape-tolerant. */
function textDelta(msg: unknown): string | null {
  const event = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } })
    .event
  if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return event.delta.text ?? null
  }
  return null
}

/**
 * Coerce the AskUserQuestion tool input into our `QuestionSpec[]`, tolerating the
 * SDK's loosely-typed payload. Returns [] when nothing usable is present (the
 * caller then lets the tool fall through rather than showing an empty card).
 */
function parseQuestions(input: unknown): QuestionSpec[] {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return []
  const out: QuestionSpec[] = []
  for (const q of raw) {
    const question =
      typeof (q as { question?: unknown })?.question === 'string'
        ? (q as { question: string }).question
        : ''
    const options = Array.isArray((q as { options?: unknown })?.options)
      ? (q as { options: unknown[] }).options
          .map((o) => ({
            label:
              typeof (o as { label?: unknown })?.label === 'string'
                ? (o as { label: string }).label
                : '',
            ...(typeof (o as { description?: unknown })?.description === 'string'
              ? { description: (o as { description: string }).description }
              : {})
          }))
          .filter((o) => o.label)
      : []
    if (!question || options.length === 0) continue
    out.push({
      question,
      header:
        typeof (q as { header?: unknown })?.header === 'string' && (q as { header: string }).header
          ? (q as { header: string }).header
          : 'Question',
      options,
      multiSelect: (q as { multiSelect?: unknown })?.multiSelect === true
    })
  }
  return out
}

/**
 * Feed the user's picks back to the model as the AskUserQuestion tool result. We
 * DENY the tool with the answer as its message: in headless SDK mode there is no
 * built-in interactive prompt to run, so intercepting `canUseTool` and returning
 * the answer here keeps the whole exchange under trezi's control. The message is
 * phrased as an answer so the model continues with the user's choice in hand.
 */
function formatAnswers(questions: QuestionSpec[], answers: QuestionAnswers): string {
  const lines = questions.map((q) => {
    const a = (answers[q.question] ?? '').trim()
    return `- ${q.question}\n  → ${a || '(no answer)'}`
  })
  return `The user answered your question(s):\n${lines.join('\n')}`
}

/**
 * The incumbent backend: a persistent multi-turn Claude Agent SDK `query()` with
 * `cwd` = the opened repo, so the repo's CLAUDE.md + .claude/skills are discovered
 * (`settingSources`). Auth = the user's Claude subscription (`claude login` /
 * `setup-token`). This is the verbatim pre-v7 `startSession`, now behind the
 * `ModelProvider` seam.
 */
async function startSession(
  root: string,
  options: AgentOptions,
  getWindow: () => NativeView | null,
  ctx?: SpawnContext
): Promise<ProviderSession> {
  const key = projectKey(root)
  // A detached comment spawn (v8 F1) files its events + history under the PARENT
  // project's key (so the rail/history surface it), and stamps `sessionId` so the
  // renderer keeps it out of the main chat stream.
  const emitKey = ctx?.emitKey ?? key
  // The persisted record's `projectKey` must stay the canonical project key (not
  // `emitKey`) — `sessions-store.ts#list` and `agent:sessions-list` always query by
  // the plain `projectKey(root)`, so an additional/resumed chat (whose `emitKey` is
  // `${key}#…`) would otherwise get a history record no rail lookup can ever find.
  const cap = createRecordCapture(root, key)
  const { query, createSdkMcpServer, tool } = await loadSdk()
  const input = new InputStream()
  const abort = new AbortController()
  const pending = new Map<string, PendingPrompt>()
  const pendingQuestions = new Map<string, PendingQuestion>()
  // Per-session: disposed when replaced/closed; namespaces fallback permission ids.
  let disposed = false
  // Set when `interrupt` had to force-stop a wedged query. The abort makes the
  // reader loop throw rather than reach a `result`, but a graceful interrupt that
  // lands just AFTER the grace window could still deliver one — and the seam
  // promises exactly one `done` per turn, which the escalation has already sent.
  let hardStopped = false
  let permCounter = 0

  const emit = (event: AgentEvent): void => {
    if (disposed) return
    const tagged = {
      ...event,
      projectKey: emitKey,
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {})
    }
    // agent.ts watches this in-process hook for a spawn's terminal done/error, and
    // (v9) an interactive session's for workspace-snapshot isRunning tracking.
    ctx?.onEvent?.(tagged)
    sendToRenderer(getWindow, 'agent:event', tagged)
  }

  // In-process SDK MCP server bundling Trezi's own agent tools: read-only views
  // of the user's live preview (the native NativeView that index.ts owns,
  // reached via the preview-state registry) which OBSERVE what the user sees
  // (agent-browser is the agent's own headless copy for interaction),
  // chat_island, a family of pure design-system
  // calculators — spring_to_css, check_contrast, fluid_clamp, color_scale,
  // layered_shadow, line_height — and the skill-pack tools (list_recommended_skills
  // pure; install_skills side-effecting). The observers, calculators and
  // list_recommended_skills are auto-allowed (see allowedTools + canUseTool) so they
  // never prompt — all are side-effect-free, and chat_island persists only
  // through the validated chat-island service. install_skills is NOT auto-allowed:
  // it writes files + hits the network, so it surfaces a normal permission card.
  // Every Trezi tool call is authorized by the provider owner against this session's
  // grant before it runs (S10): a background edit is not granted the editor or islands,
  // a closed session nothing, and oversized arguments are refused.
  const guarded = <T extends { name: string; handler: (...a: any[]) => Promise<any> }>(
    defs: T[]
  ): T[] =>
    defs.map((def) => ({
      ...def,
      handler: async (args: unknown, extra: unknown) => {
        if (ctx?.grant) {
          try {
            await providerOwner().authorize(ctx.grant, def.name, args)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
              isError: true
            }
          }
        }
        return def.handler(args, extra)
      }
    }))
  // The tools that need main's state (the preview, islands, the editor, Gen UI, skill
  // installs) run in Bun: from a provider helper they go there through the owner, which
  // checks the helper's grant (`sessionTool`, LKM-131); in Bun they run here.
  const scope = {
    root,
    liveRoot: ctx?.liveRoot ?? root,
    emitKey,
    background: !!ctx?.sessionId,
    connectionId: options.connectionId,
    notify: (channel: string, payload: unknown): void => sendToRenderer(getWindow, channel, payload)
  }
  const treziTool = sessionTool(ctx?.tools, (action, args) => runTreziTool(action, args, scope))
  const failed = (result: unknown): boolean => !!(result as { error?: unknown } | null)?.error
  const asText = async (pending: Promise<unknown>) => {
    const result = await pending
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(failed(result) ? { isError: true } : {})
    }
  }
  // The preview observers already answer as MCP content (text or a JPEG); a failure is text.
  const observed = async (action: PreviewObserver, args: unknown = {}) => {
    const result = (await treziTool(action, args)) as { content?: unknown } | null
    return Array.isArray(result?.content)
      ? (result as { content: never[] })
      : asText(Promise.resolve(result))
  }
  const previewServer = createSdkMcpServer({
    name: 'trezi',
    version: '1.0.0',
    tools: guarded([
      tool(
        'project_ui_catalog',
        'Discover supported React and Svelte components, literal props and styles for UI composition. Requires Experimental Gen UI enabled.',
        {},
        async () => asText(treziTool('project_ui_catalog', {}))
      ),
      tool(
        'compose_project_ui',
        'Return project-component source: .tsx for React or .svelte for Svelte. Do not mix frameworks. For the current chat model provide file and spec. With Jev selected provide file, prompt and atomic candidates; Jev chooses the composition. Apply returned source with ordinary edit tools. Never silently fall back if Jev fails.',
        {
          file: z.string(),
          prompt: z.string().optional(),
          candidates: z
            .array(
              z.object({
                id: z.string(),
                description: z.string(),
                element: z.object({ type: z.string(), props: z.record(z.string(), z.unknown()) }),
                root: z.boolean().optional(),
                resource: z.string().optional()
              })
            )
            .optional(),
          spec: z
            .object({
              root: z.string(),
              elements: z.record(
                z.string(),
                z
                  .object({
                    type: z.string(),
                    props: z.record(z.string(), z.unknown()),
                    children: z.array(z.string())
                  })
                  .strict()
              )
            })
            .strict()
            .optional()
        },
        async (args) => asText(treziTool('compose_project_ui', args))
      ),
      tool(
        'preview_location',
        "The page/route currently shown in the user's live preview pane.",
        {},
        async () => observed('preview_location')
      ),
      tool(
        'preview_screenshot',
        PREVIEW_TOOL_TEXT.preview_screenshot,
        previewShapes.preview_screenshot,
        async (args) => observed('preview_screenshot', args)
      ),
      tool(
        'preview_inspect',
        PREVIEW_TOOL_TEXT.preview_inspect,
        previewShapes.preview_inspect,
        async (args) => observed('preview_inspect', args)
      ),
      tool(
        'preview_evaluate',
        PREVIEW_TOOL_TEXT.preview_evaluate,
        previewShapes.preview_evaluate,
        async (args) => observed('preview_evaluate', args)
      ),
      tool(
        'preview_console',
        PREVIEW_TOOL_TEXT.preview_console,
        previewShapes.preview_console,
        async (args) => observed('preview_console', args)
      ),
      tool(
        'preview_viewport',
        PREVIEW_TOOL_TEXT.preview_viewport,
        previewShapes.preview_viewport,
        async (args) => observed('preview_viewport', args)
      ),
      tool(
        'open_preview',
        'Open a project page in the user preview. Pass a root-relative path with optional query/hash. Navigation waits for this turn to land.',
        { path: z.string() },
        async (args) => asText(treziTool('open_preview', args))
      ),
      tool(
        'open_code',
        'Open the mini code editor at an exact project file and highlight inclusive source lines. Read the file first; use when asked to show the exact code or implementation.',
        {
          file: z.string(),
          startLine: z.number().int().min(1),
          endLine: z.number().int().min(1).optional()
        },
        async (args) => asText(treziTool('open_code', args))
      ),
      tool('chat_island', chatIslandDescription, chatIslandShape, async (args) =>
        asText(treziTool('chat_island', args))
      ),
      // Pure spring→CSS calculator. LLMs can't reliably integrate a spring in
      // their head, so this computes the EXACT `linear()` easing + duration the
      // agent should paste into the target repo's CSS. No state, no disk, no
      // side effects — deterministic function, auto-allowed like the observers.
      tool(
        'spring_to_css',
        'Compute a CSS `linear()` easing + duration from a physical spring, so a bouncy/springy ' +
          'motion runs on the compositor as a normal `transition`/`@keyframes` instead of a JS loop. ' +
          'Use this ANY time the user asks for a spring, bouncy, springy, or physics-based animation, ' +
          'or gives spring params (stiffness/damping/mass, ζ+frequency, or bounce+duration) — do NOT ' +
          'hand-write spring `linear()` values or guess a cubic-bezier. Returns exact values to paste ' +
          'into source. Note: only `transform` and `opacity` are compositor-cheap.',
        springToCssShape,
        async (args) => {
          const cfg = resolveSpringConfig(args)
          if ('error' in cfg) {
            return {
              content: [{ type: 'text' as const, text: `spring_to_css failed: ${cfg.error}` }],
              isError: true
            }
          }

          const opts = { simplify: args.simplify ?? 0, property: args.property }
          const m = analyze(cfg, opts)
          const p2 = (n: number): number => Number(n.toFixed(2))

          let out: string
          switch (args.format ?? 'transition') {
            case 'linear':
              out = springToCss(cfg, opts).easing
              break
            case 'css-vars':
              out = toCssVars(cfg, opts)
              break
            case 'keyframes':
              out = toKeyframes(cfg, {
                ...opts,
                prop: args.property ? `--${args.property}` : undefined
              })
              break
            case 'json':
              out = JSON.stringify(springToCss(cfg, opts), null, 2)
              break
            default:
              out = toTransition(cfg, opts)
          }

          const property = args.property ?? 'transform'
          const compositorSafe = property === 'transform' || property === 'opacity'
          const notes = [
            `ζ=${p2(m.dampingRatio)} (${m.regime}), ${p2(m.frequencyHz)}Hz, overshoot ${p2(m.overshoot * 100)}%`,
            `settle ${m.settleDuration}ms · visual ~${m.visualDuration}ms · ${m.pointCount} points`,
            compositorSafe
              ? `'${property}' is compositor-friendly.`
              : `Warning: '${property}' is NOT compositor-cheap (only transform/opacity are) — this runs on the main thread and can jank.`,
            'Wrap in @media (prefers-reduced-motion: reduce) to disable. Needs Chrome/Edge 113+, Firefox 112+, Safari 17.2+ (falls back to ease).'
          ]

          return {
            content: [{ type: 'text' as const, text: `${out}\n\n/* ${notes.join('\n   ')} */` }]
          }
        }
      ),
      // APCA (Lc) accessible-contrast checker + color suggester. APCA is the
      // perceptual model WCAG 3 is built around — don't eyeball readability or
      // use the old 4.5:1 ratio. When a pair fails, it hands back the nearest
      // accessible color (hue preserved) so the palette still matches. Pure
      // calc over the reference tables — no state, no disk, auto-allowed.
      tool(
        'check_contrast',
        'Check whether a foreground/background color pair is readable using APCA (Lc) — the perceptual ' +
          'contrast model WCAG 3 is built around, more accurate than WCAG 2. Use it whenever you pick, ' +
          'change, or review text/UI colors, or the user asks if a color pair is accessible/readable/legible. ' +
          'When the pair fails it also SUGGESTS the nearest accessible color (adjusting lightness, keeping ' +
          'hue) so the palette still matches — use that hex instead of guessing. Pass fontSizePx/fontWeight ' +
          'for accurate thresholds (APCA readability depends on text size + weight).',
        checkContrastShape,
        async (args) => {
          try {
            const res = await checkContrast({
              foreground: args.foreground,
              background: args.background,
              fontSizePx: args.fontSizePx,
              fontWeight: args.fontWeight,
              wcag2: args.wcag2
            })

            const badge =
              res.verdict === 'pass'
                ? '✓ PASS'
                : res.verdict === 'fail'
                  ? '✗ FAIL'
                  : `⚠ ${res.verdict.toUpperCase()}`
            const lines = [
              `${badge} — APCA Lc ${res.lc.toFixed(1)} for ${res.foreground} on ${res.background} at ${res.fontSizePx}px/${res.fontWeight}`,
              res.message
            ]
            if (res.wcag2) {
              lines.push(
                `WCAG 2: ${res.wcag2.ratioRounded}:1 — AA ${res.wcag2.AA}, AAA ${res.wcag2.AAA}, UI 3:1 ${res.wcag2.uiComponents}.`
              )
            }

            // Decide whether to suggest an accessible alternative.
            const mode = args.suggest ?? 'auto'
            const role: 'foreground' | 'background' | null =
              mode === 'foreground' || mode === 'background'
                ? mode
                : mode === 'auto' && res.verdict !== 'pass'
                  ? 'foreground'
                  : null
            if (role) {
              const adjust = role === 'foreground' ? args.foreground : args.background
              const fixed = role === 'foreground' ? args.background : args.foreground
              const s = await suggestAccessible(adjust, fixed, role, res.fontSizePx, res.fontWeight)
              lines.push(
                s.bestEffort
                  ? `Suggested ${role}: ${s.hex} (Lc ${s.lc.toFixed(1)}, ${s.verdict}) — closest to ${adjust} preserving hue, but no hue-preserving lightness fully passes at this size; increase font size/weight or shift the other color too.`
                  : `Suggested accessible ${role}: ${s.hex} (Lc ${s.lc.toFixed(1)}, passes) — nearest to ${adjust} preserving hue.`
              )
            }

            return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `check_contrast failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // Fluid clamp() sizing. The middle `calc()` term of a fluid clamp() is a
      // two-point solve in mixed rem/vw units that LLMs get subtly wrong (the
      // size ends up off at real viewports). This computes it exactly and is
      // verified to hit both endpoints. Pure math — no state, auto-allowed.
      tool(
        'fluid_clamp',
        'Compute a CSS `clamp()` for fluid (responsive) type or spacing that scales smoothly between a ' +
          'min size at a small viewport and a max size at a large one. Use whenever you set a responsive ' +
          'font-size or spacing that should grow with the screen — do NOT hand-write the clamp() calc() ' +
          'term, it is easy to get wrong. Give minPx+maxPx for one value, or `scale` for a whole modular ' +
          'type/space scale. Output is rem-based so it respects user zoom.',
        fluidClampShape,
        async (args) => {
          try {
            const vp = {
              minViewportPx: args.minViewportPx,
              maxViewportPx: args.maxViewportPx,
              rootPx: args.rootPx
            }
            if (args.scale) {
              const steps = fluidScale({ ...args.scale, ...vp })
              const body =
                args.format === 'css-vars'
                  ? steps.map((s) => `  --step-${s.step}: ${s.css};`).join('\n')
                  : steps.map((s) => `step ${s.step}: ${s.css}`).join('\n')
              const out = args.format === 'css-vars' ? `:root {\n${body}\n}` : body
              return { content: [{ type: 'text' as const, text: out }] }
            }
            if (args.minPx === undefined || args.maxPx === undefined) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'fluid_clamp failed: provide minPx and maxPx (single value), or a `scale` object.'
                  }
                ],
                isError: true
              }
            }
            const r = fluidClamp({ minPx: args.minPx, maxPx: args.maxPx, ...vp })
            const css = args.format === 'css-vars' ? `--fluid: ${r.css};` : r.css
            const note = r.isStatic
              ? 'min and max are equal — emitted a static rem value.'
              : `verified: ${r.checkAtMinPx}px at ${args.minViewportPx ?? 320}px viewport, ${r.checkAtMaxPx}px at ${args.maxViewportPx ?? 1280}px.${r.warning ? ` Note: ${r.warning}` : ''}`
            return { content: [{ type: 'text' as const, text: `${css}\n\n/* ${note} */` }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `fluid_clamp failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // OKLCH perceptual tonal ramp. Hand-picked hex ramps drift in hue and have
      // uneven perceptual lightness steps; OKLCH↔sRGB is a nonlinear transform
      // with an iterative gamut-map an LLM can't do in its head. Pure, auto-allowed.
      tool(
        'color_scale',
        'Generate a perceptually-even OKLCH tonal color ramp (Radix/Material-style 1..N scale) from a ' +
          'single seed color, each step gamut-mapped to valid sRGB. Use when building a color system, ' +
          'shades/tints of a brand color, or a token palette — do NOT hand-pick hex shades (they drift ' +
          'in hue and step unevenly). Pair the resulting steps with check_contrast to pick accessible ' +
          'text/background pairs.',
        colorScaleShape,
        async (args) => {
          try {
            const steps = oklchScale({
              seed: args.seed,
              steps: args.steps,
              hueShift: args.hueShift,
              lightnessRange: args.lightnessRange
            })
            const name = args.name ?? 'color'
            let out: string
            switch (args.format) {
              case 'css-vars':
                out = `:root {\n${steps.map((s) => `  --${name}-${s.index}: ${s.hex};`).join('\n')}\n}`
                break
              case 'tailwind':
                out = `${name}: {\n${steps.map((s) => `  ${s.index * 50}: '${s.hex}',`).join('\n')}\n}`
                break
              default:
                out = steps
                  .map(
                    (s) =>
                      `${s.index}: ${s.hex}  (oklch ${s.oklch.l.toFixed(3)} ${s.oklch.c.toFixed(3)} ${s.oklch.h.toFixed(1)})`
                  )
                  .join('\n')
            }
            return { content: [{ type: 'text' as const, text: out }] }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `color_scale failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // Layered box-shadow. A realistic cast shadow is 5-6 correlated layers with
      // a shared light angle; LLMs emit one flat `0 4px 6px rgba(...)`. This
      // derives the whole stack from one elevation number. Pure, auto-allowed.
      tool(
        'layered_shadow',
        'Generate a realistic multi-layer CSS `box-shadow` (or a whole elevation scale) from one elevation ' +
          'value — several stacked layers with a shared light angle, the way real depth looks. Use whenever ' +
          'you add a shadow/elevation to a card, popover, button, etc. — do NOT hand-write a single flat ' +
          'box-shadow; it looks cheap. Set `scale: true` for a coherent sm..2xl token set.',
        layeredShadowShape,
        async (args) => {
          try {
            const common = {
              layers: args.layers,
              lightAngleDeg: args.lightAngleDeg,
              colorRgb: args.colorRgb,
              baseAlpha: args.baseAlpha
            }
            if (args.scale) {
              const set = elevationScale({ levels: args.levels, ...common })
              const out =
                args.format === 'css-vars'
                  ? `:root {\n${set.map((e) => `  --shadow-${e.label}: ${e.css};`).join('\n')}\n}`
                  : set.map((e) => `${e.label} (level ${e.level}): ${e.css}`).join('\n\n')
              return { content: [{ type: 'text' as const, text: out }] }
            }
            if (args.elevation === undefined) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'layered_shadow failed: provide `elevation`, or set `scale: true`.'
                  }
                ],
                isError: true
              }
            }
            const r = layeredShadow({ elevation: args.elevation, ...common })
            const out = args.format === 'css-vars' ? `--shadow: ${r.css};` : r.css
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${out}\n\n/* ${r.layers.length} layers, shared light angle */`
                }
              ]
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return {
              content: [{ type: 'text' as const, text: `layered_shadow failed: ${msg}` }],
              isError: true
            }
          }
        }
      ),
      // Size-aware, WCAG-floored line-height (and optional letter-spacing). LLMs
      // default to a hardcoded 1.5 everywhere; real leading is inverse to size and
      // measure-aware, with body text floored at 1.5. Pure math (type-metrics.ts) —
      // no state, no disk, auto-allowed like the other calculators.
      tool(
        'line_height',
        'Compute an accessible, size-appropriate CSS line-height (and optional letter-spacing) for a ' +
          'font size. Call this WHENEVER you set a font-size or line-height instead of defaulting to 1.5 ' +
          'everywhere — leading should tighten as type grows, stay measure-aware, and body text is floored ' +
          'at 1.5 per WCAG 2.1 SC 1.4.12. Pass includeTracking for a matching letter-spacing.',
        lineHeightShape,
        async (args) => {
          const lh = lineHeight({
            fontSizePx: args.fontSizePx,
            measureCh: args.measureCh,
            role: args.role
          })
          const ls = args.includeTracking ? letterSpacing(args.fontSizePx) : null
          const lines: string[] = []
          if ((args.format ?? 'value') === 'css') {
            lines.push(`line-height: ${lh.lineHeight};`)
            if (ls) lines.push(`letter-spacing: ${ls.css};`)
          } else {
            lines.push(
              `line-height: ${lh.lineHeight} (${lh.lineHeightPx}px at ${args.fontSizePx}px)`
            )
            if (ls) lines.push(`letter-spacing: ${ls.css}`)
          }
          const notes = [lh.rationale]
          if (ls) notes.push(ls.rationale)
          if (lh.floored) {
            notes.push('WCAG 2.1 SC 1.4.12: body text must stay usable at line-height ≥ 1.5.')
          }
          return {
            content: [
              { type: 'text' as const, text: `${lines.join('\n')}\n\n/* ${notes.join('\n   ')} */` }
            ]
          }
        }
      ),
      // Curated catalog of external "taste" skill packs Trezi can OFFER to install.
      // Pure/read-only — just formats SKILL_PACKS for the model; no network, no disk,
      // so it's auto-allowed. Its sibling install_skills is NOT (it writes + fetches).
      tool(
        'list_recommended_skills',
        'List the curated catalog of external design/craft skill packs Trezi can offer to install into ' +
          "the user's project or user scope. Call this when a design task would benefit from established " +
          'craft you lack (animation/interaction taste, color systems, frontend polish), then OFFER the ' +
          'user a relevant pack — never install silently. Use the returned id with install_skills.',
        {},
        async () => {
          const text = SKILL_PACKS.map(
            (p) =>
              `• ${p.id} — ${p.title}\n  ${p.description}\n  ${p.url} (recommended scope: ${p.recommendedScope})`
          ).join('\n\n')
          return {
            content: [
              {
                type: 'text' as const,
                text: `Curated skill packs (install with install_skills using the id):\n\n${text}`
              }
            ]
          }
        }
      ),
      // Install a curated skill pack (`npx skills add … --copy`) into the project or
      // user scope. SIDE-EFFECTING: writes files + hits the network, so it is NOT in
      // TREZI_TOOL_NAMES — it surfaces a normal permission card. packId is validated
      // against the curated allowlist (skill-packs.ts) BEFORE anything spawns, so an
      // arbitrary repo string can never reach `npx skills add`. Persists to the LIVE
      // root (ctx.liveRoot), not the per-chat worktree, so installs aren't stranded.
      tool(
        'install_skills',
        "Install a curated skill pack into the user's project (<repo>/.claude/skills/) or user scope " +
          '(~/.claude/skills/), after the user agrees. Only packs from list_recommended_skills are allowed. ' +
          'OFFER first and let the user pick the scope — never install silently. Newly installed skills are ' +
          'discovered on the next message/session, so they take effect then.',
        {
          packId: z
            .string()
            .describe('Pack id from list_recommended_skills (curated allowlist only).'),
          scope: z
            .enum(['project', 'user'])
            .optional()
            .describe(
              "Install target: 'project' = <repo>/.claude/skills, 'user' = ~/.claude/skills. Defaults to the pack's recommendedScope."
            )
        },
        async (args) => {
          // Main checks the allowlist, then the workflow owner installs (`session-tools.ts`).
          const result = (await treziTool('install_skills', args)) as {
            ok?: boolean
            message?: string
            error?: string
          }
          const message = result.message ?? `install_skills failed: ${result.error ?? 'no result'}`
          const restart =
            'Newly installed skills are discovered when the agent starts its next turn — they take ' +
            'effect on your next message (or a fresh session), not mid-turn.'
          return {
            content: [
              { type: 'text' as const, text: result.ok ? `${message}\n\n${restart}` : message }
            ],
            ...(result.ok ? {} : { isError: true })
          }
        }
      )
    ])
  })

  // In a provider helper: an installed `claude` that is logged in when the bundled
  // one is not (LKM-119, `claude-login.ts`). The owner passes the choice an earlier
  // helper made this app session, so the probes run once (LKM-135).
  const phase = ctx?.onPhase ?? (() => {})
  let executable: string | undefined
  if (process.env.TREZI_PROVIDER_HELPER === '1') {
    if (ctx?.claudeCli) {
      executable = ctx.claudeCli.executable
      phase('auth', { ms: 0, cached: true })
    } else {
      const probing = Date.now()
      const cli = await resolveClaudeCli()
      executable = cli.executable
      phase('auth', { ms: Date.now() - probing, cached: false, ...claudeCliChoice(cli) })
    }
  }
  const spawned = Date.now()
  const q: Query = query({
    prompt: input,
    options: {
      cwd: root,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      settingSources: ['user', 'project', 'local'],
      // The repo's CLAUDE.md + skills load via settingSources; Trezi's own
      // operating rules (v8 R) are appended to the Claude Code preset, with the
      // preview-tools section (Claude alone can call the in-process trezi tools).
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: treziRules({ previewTools: true, projectMemory: ctx?.projectMemory })
      },
      // The trezi MCP server (preview_location / preview_screenshot / chat_island /
      // spring_to_css / check_contrast / fluid_clamp / color_scale / layered_shadow /
      // line_height / list_recommended_skills / install_skills). All but install_skills
      // are auto-allowed here so they never surface a permission card (canUseTool also
      // short-circuits them, belt-and-suspenders) — main validates everything
      // chat_island persists, and install_skills prompts (writes files + network).
      mcpServers: { trezi: previewServer },
      // LKM-138: none of the user's own plugins or MCP servers unless Settings allows them.
      ...claudeIsolationOptions(root, options.claudeUserPlugins === true),
      allowedTools: [...TREZI_TOOL_NAMES],
      // The bundled Trezi skill plugin (only when present in this build).
      ...(existsSync(PLUGIN_PATH)
        ? { plugins: [{ type: 'local' as const, path: PLUGIN_PATH }] }
        : {}),
      includePartialMessages: true,
      permissionMode: options.permissionMode ?? 'default',
      allowDangerouslySkipPermissions: true,
      abortController: abort,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort as 'low' | 'medium' | 'high' } : {}),
      // v9 resume: reload a past conversation's context (the record's captured
      // sdkSessionId) instead of starting fresh. Absent for the default open/new-chat path.
      ...(ctx?.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      // LKM-151: a worktree chat never edits the live checkout by absolute path, in any
      // permission mode (hooks run before bypass/auto approvals; canUseTool does not).
      // LKM-156: nor names it in a Bash command.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const pre = input as { tool_name?: string; tool_input?: unknown }
                const denied = liveCheckoutEdit(
                  pre.tool_name ?? '',
                  pre.tool_input,
                  root,
                  ctx?.liveRoot ?? root
                )
                return denied
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: denied.reason
                      }
                    }
                  : { continue: true }
              }
            ]
          }
        ]
      },
      canUseTool: async (toolName, toolInput, opts) => {
        // The provider owner decides (S10); the adapter only settles the SDK callback.
        // An owner that cannot answer fails closed.
        const verdict: PermissionVerdict = ctx?.grant
          ? await providerOwner()
              .permission(ctx.grant, toolName, toolInput)
              .catch(() => ({
                decision: 'deny' as const,
                message: 'Trezi could not check this permission.'
              }))
          : decidePermission(toolName, permissionTarget(toolName, toolInput), {
              live: true,
              background: !!ctx?.sessionId,
              root,
              liveRoot: ctx?.liveRoot ?? root,
              profile: ''
            })
        // The agent asking the user a question isn't a permission decision — surface
        // it as an interactive multiple-choice card and feed the answer back as the
        // tool result (it never shows an approve/deny card).
        if (verdict.decision === 'question') {
          const questions = parseQuestions(toolInput)
          if (questions.length === 0) {
            return { behavior: 'deny', message: 'The question had no answerable options.' }
          }
          if (disposed || abort.signal.aborted || opts.signal.aborted) {
            return { behavior: 'deny', message: 'Session no longer active.' }
          }
          const id = opts.toolUseID || `${key}:q${++permCounter}`
          const request: QuestionRequest = { id, questions, sessionKey: emitKey }
          return await new Promise((resolve) => {
            const cleanup = (): void => {
              pendingQuestions.delete(id)
              opts.signal.removeEventListener('abort', onAbort)
            }
            const onAbort = (): void => {
              cleanup()
              emit({ type: 'question-resolved', id })
              resolve({ behavior: 'deny', message: 'Interrupted.' })
            }
            pendingQuestions.set(id, {
              settle: (answers) => {
                cleanup()
                resolve({
                  behavior: 'deny',
                  message: answers
                    ? formatAnswers(questions, answers)
                    : 'The user dismissed the question without answering.'
                })
              }
            })
            opts.signal.addEventListener('abort', onAbort, { once: true })
            emit({ type: 'question-request', request })
          })
        }
        // Trezi's own tools (also in allowedTools) and read-only tools are allowed
        // without a prompt; the .trezi/ sidecar and Trezi's own data are denied.
        if (verdict.decision === 'allow') {
          emit({ type: 'status', text: describeTool(toolName, toolInput) })
          return { behavior: 'allow', updatedInput: toolInput }
        }
        if (verdict.decision === 'deny') return { behavior: 'deny', message: verdict.message }
        if (disposed || abort.signal.aborted || opts.signal.aborted) {
          return { behavior: 'deny', message: 'Session no longer active.' }
        }
        // In `auto` mode the SDK's classifier auto-approves routine tools without
        // calling this hook; a call reaching here is one the classifier flagged as
        // risky (the 'ask' path). Surface an approve/deny card so the user decides —
        // this is the only prompt in auto mode, for genuinely dangerous ops.
        emit({ type: 'status', text: describeTool(toolName, toolInput) })
        const id = opts.toolUseID || `${key}:perm${++permCounter}`
        const request: PermissionRequest = {
          id,
          toolName,
          title: opts.title || `Allow ${toolName}?`,
          ...(opts.displayName ? { displayName: opts.displayName } : {}),
          ...(toolDetail(toolName, toolInput) ? { detail: toolDetail(toolName, toolInput)! } : {}),
          sessionKey: emitKey
        }
        return await new Promise((resolve) => {
          const cleanup = (): void => {
            pending.delete(id)
            opts.signal.removeEventListener('abort', onAbort)
          }
          const onAbort = (): void => {
            cleanup()
            emit({ type: 'permission-resolved', id })
            resolve({ behavior: 'deny', message: 'Interrupted.' })
          }
          pending.set(id, {
            toolName,
            settle: (behavior) => {
              cleanup()
              resolve(
                behavior === 'allow'
                  ? { behavior: 'allow', updatedInput: toolInput }
                  : { behavior: 'deny', message: 'Denied by the user in Trezi.' }
              )
            }
          })
          opts.signal.addEventListener('abort', onAbort, { once: true })
          emit({ type: 'permission-request', request })
        })
      }
    }
  })

  // The "/" menu (LKM-54): project skills — the opened repo's
  // `.claude/skills/**/SKILL.md`, discovered + described here in main so the
  // renderer never touches the filesystem — rank ahead of the SDK's advertised
  // commands, shadowing same-named ones. Either side may resolve first, so both
  // land in this closure and re-emit the merged list.
  const portableSkills = await discoverPortableSkills()
  let projectSkills: SlashCommandItem[] = []
  let sdkCommandNames: string[] = []
  const availablePortableSkills = () =>
    portableSkills.filter((skill) => !projectSkills.some((project) => project.name === skill.name))
  const emitCommands = (): void => {
    const merged = mergeSlashCommands(
      [...projectSkills, ...availablePortableSkills()],
      sdkCommandNames.filter(
        (name) => !portableSkills.some((skill) => name === `trezi:${skill.name}`)
      )
    )
    if (merged.length) emit({ type: 'commands', commands: merged })
  }
  emitCommands()
  void discoverProjectSkills(root).then((skills) => {
    if (disposed || !skills.length) return
    projectSkills = skills
    emitCommands()
  })

  // Populate the "/" menu immediately: with a streaming input, the SDK's `init`
  // system message (which carries slash_commands) only arrives after the FIRST
  // user message — so a freshly-opened project's "/" menu would be empty until you
  // chat once. supportedCommands() (captured at initialize) fetches them eagerly.
  // Its answer also means the CLI is up (LKM-135): the session starts with the chat,
  // so a cold CLI warms while the user types and the owner's short deadline ends there.
  let started = false
  const cliStarted = (): void => {
    if (started) return
    started = true
    phase('cli', { ms: Date.now() - spawned })
  }
  let progressAt = 0
  const progress = (): void => {
    if (Date.now() - progressAt < 1000) return
    progressAt = Date.now()
    phase('progress')
  }
  void q
    .supportedCommands()
    .then((cmds) => {
      cliStarted()
      if (disposed || !cmds.length) return
      sdkCommandNames = cmds.map((c) => c.name)
      emitCommands()
    })
    .catch(() => {
      /* older SDK / not ready — the init message will still populate on first turn */
    })

  // Feed the model picker (see main/model-catalog.ts). A LIVE query is the only
  // thing that can say which models this account actually has — `choices()` runs
  // on a picker render with no session to ask — so every session opportunistically
  // hands its answer to the catalog, which persists it for the next launch. Purely
  // fire-and-forget: never awaited, never emitted, never able to fail a turn. The
  // try/catch is for an SDK old enough to lack the method outright, which would
  // throw SYNCHRONOUSLY here and take session startup with it.
  try {
    void q
      .supportedModels()
      .then((models) => recordClaudeModels(models))
      .catch(() => {
        /* not ready / no auth — the picker keeps its cached or last-resort list */
      })
  } catch {
    /* no supportedModels() on this SDK — same outcome, one turn earlier */
  }

  // The kill switch Stop escalates to: abort the query the SDK was built with (the
  // same switch shutdown() uses), end the turn exactly once, and let agent.ts rebuild
  // the now-dead session (`hardStopped`).
  const forceStop = (): void => {
    if (hardStopped) return
    hardStopped = true // stop the reader loop double-emitting on a late result
    abort.abort()
    input.close()
    emit({
      type: 'error',
      message:
        'That turn stopped responding, so Trezi force-stopped it. The chat has been ' +
        'restarted — earlier messages are still shown, but the assistant no longer has ' +
        'them in context.'
    })
    cap.finalize()
    emit({ type: 'done' })
  }

  // Drive the output stream for the life of the session.
  void (async () => {
    let streamedText = false
    // The turn's login card is out; if the CLI then exits, the turn only needs its `done`.
    let authFailed = false
    // Token accounting for the API request in flight (`stream-usage.ts`): the
    // SDK's cumulative reports, sent once each, plus a live output estimate from
    // the streamed text, thinking and tool input in between (LKM-147).
    const usage = streamUsage((delta) => emit({ type: 'usage', ...delta }))
    const reportUsage = (raw: unknown): void => usage.report(raw)
    try {
      for await (const msg of q) {
        cliStarted()
        switch (msg.type) {
          case 'system': {
            const sys = msg as { subtype?: string; slash_commands?: string[]; session_id?: string }
            // The turn's session began, or the CLI reports work (a request, a retry,
            // thinking) before any output: the owner keeps waiting (LKM-135).
            if (sys.subtype === 'init') phase('init')
            else progress()
            if (sys.subtype === 'init') {
              // v9 resume: capture the SDK's own resumable session id off the init
              // message — this is what a later `agent:resume-session` forwards back
              // as `options.resume`. Distinct from `ctx.sessionId` (v8 F1 spawn bookkeeping).
              if (typeof sys.session_id === 'string' && sys.session_id) {
                cap.setSdkSessionId(sys.session_id)
              }
              if (Array.isArray(sys.slash_commands)) {
                sdkCommandNames = sys.slash_commands
                emitCommands()
              }
            }
            break
          }
          case 'stream_event': {
            const ev = (
              msg as {
                event?: {
                  type?: string
                  message?: unknown
                  usage?: unknown
                  delta?: Record<string, unknown>
                }
              }
            ).event
            if (ev?.type === 'message_start') {
              // A new request — its counters start from zero again.
              usage.start()
              reportUsage((ev.message as { usage?: unknown } | undefined)?.usage)
            } else if (ev?.type === 'message_delta') {
              reportUsage(ev.usage)
            } else {
              usage.streamed(streamedChars(ev))
            }
            const text = textDelta(msg)
            if (text) {
              streamedText = true
              cap.appendAssistant(text)
              emit({ type: 'delta', text })
            }
            break
          }
          case 'assistant': {
            // The final, authoritative usage for this request — a no-op delta
            // when the stream events above already reported all of it.
            reportUsage((msg.message as { usage?: unknown }).usage)
            // "Not logged in · Please run /login" is the CLI's, not the model's: a login
            // card, never assistant text (LKM-119).
            if (isAuthFailure(msg as never)) {
              const said = msg.message.content
                .map((block) => (block.type === 'text' ? block.text : ''))
                .join(' ')
                .trim()
              emit({ type: 'error', code: 'auth', message: said || 'Claude is not logged in.' })
              authFailed = true
              forgetClaudeCli()
              break
            }
            for (const block of msg.message.content) {
              if (block.type === 'text' && !streamedText) {
                cap.appendAssistant(block.text)
                emit({ type: 'delta', text: block.text })
              } else if (block.type === 'tool_use') {
                // Capture in the assistant stream (not canUseTool) so tools are
                // recorded even under bypassPermissions, where canUseTool is skipped.
                cap.noteTool(block.name, block.input)
                emit({ type: 'status', text: describeTool(block.name, block.input) })
              }
            }
            break
          }
          case 'result': {
            if (hardStopped) break // the force-stop already finalized and sent `done`
            cap.finalize()
            emit({ type: 'done' })
            streamedText = false
            authFailed = false
            break
          }
        }
      }
    } catch (err) {
      if (authFailed) emit({ type: 'done' })
      else if (!abort.signal.aborted) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
  })()

  return {
    key,
    root,
    options,
    send: (text, images) => {
      // Claude's /login needs its terminal UI: the chat shows the login card instead.
      if (isLoginCommand(text)) {
        emit({ type: 'error', code: 'auth', message: LOGIN_COMMAND_MESSAGE })
        emit({ type: 'done' })
        return
      }
      input.push(withSkillReferences(text, availablePortableSkills()), images)
    },
    pending,
    pendingQuestions,
    emit,
    record: cap.record,
    finalize: cap.finalize,
    dispose: () => {
      disposed = true
    },
    shutdown: () => {
      abort.abort()
      input.close()
    },
    setModel: async (model) => {
      await q.setModel?.(model)
    },
    setPermissionMode: async (mode) => {
      await q.setPermissionMode?.(mode)
    },
    // `q.interrupt()` is a CONTROL REQUEST to the CLI subprocess, and the SDK's
    // control-request promise settles only when a matching `control_response` comes
    // back — there is no timeout in the SDK. So when that subprocess is wedged (the
    // request went out and nothing ever came back: 0 tokens in, 0 out, the turn
    // running for minutes) the graceful path never returns — precisely the state Stop
    // exists to escape. The provider owner holds the deadline and tells
    // provider-sessions.ts when to reach for `forceStop` (S10); started outside that
    // wiring, the adapter bounds it itself.
    interrupt: async () => {
      if (ctx?.grant) {
        await q.interrupt?.()
        return undefined
      }
      return await interruptWithEscalation({
        graceful: () => q.interrupt?.(),
        graceMs: INTERRUPT_GRACE_MS,
        escalate: forceStop
      })
    },
    forceStop
  }
}

/**
 * One-shot, tool-less completion that names a chat by its subject (see the
 * `ModelProvider.generateTitle` contract). Runs a fresh headless `query()` with
 * no setting sources (skip the repo's CLAUDE.md/skills — a title needs none) and
 * every tool denied, so it can't touch the repo or drift into work. Aborts after
 * a short deadline; any failure resolves to null (the rail keeps its heuristic
 * name). Reuses the session's model so it honours the user's provider auth.
 */
async function generateTitle(
  transcript: SessionTranscriptEntry[],
  options: AgentOptions
): Promise<string | null> {
  const convo = transcriptDigest(transcript)
  if (!convo) return null

  const { query } = await loadSdk()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 20_000)
  try {
    const prompt =
      'Below is the start of a conversation between a user and a coding assistant working on a UI/design project.\n\n' +
      `${convo}\n\n` +
      'Write a short, specific title (3–6 words, Title Case, no quotes, no trailing punctuation) naming what this ' +
      'conversation is actually about — the task or subject, not a greeting and not the literal opening words. ' +
      'Reply with ONLY the title.'
    let out = ''
    const q = query({
      prompt,
      options: {
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: [],
        includePartialMessages: false,
        permissionMode: 'default',
        abortController: abort,
        // A title needs no tools; deny everything so it can never edit the repo.
        canUseTool: async () => ({ behavior: 'deny', message: 'Titling uses no tools.' }),
        ...(options.model ? { model: options.model } : {})
      }
    })
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') out += block.text
        }
      } else if (msg.type === 'result') {
        break
      }
    }
    return sanitizeTitle(out)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Tool-free post-turn distillation into the one shared project memory. */
async function updateProjectMemory(
  currentMemory: string,
  transcript: SessionTranscriptEntry[],
  options: AgentOptions
): Promise<string | null> {
  const prompt = projectMemoryEvaluationPrompt(currentMemory, transcript)
  if (!prompt) return null

  const { query } = await loadSdk()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 25_000)
  try {
    let out = ''
    const q = query({
      prompt,
      options: {
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: [],
        includePartialMessages: false,
        permissionMode: 'default',
        abortController: abort,
        maxTurns: 1,
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'Project-memory evaluation uses no tools.'
        }),
        ...(options.model ? { model: options.model } : {})
      }
    })
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') out += block.text
        }
      } else if (msg.type === 'result') {
        break
      }
    }
    return parseProjectMemoryEvaluation(out, currentMemory)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const claudeProvider: ModelProvider = {
  id: 'claude',
  supportsSpawn: true,
  startSession,
  generateTitle,
  updateProjectMemory,
  checkLogin: checkClaudeLogin
}
