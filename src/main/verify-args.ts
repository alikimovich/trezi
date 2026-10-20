import { previewPath } from '../shared/preview-navigation'
import { type InteractArgs, parseInteraction } from './agent-interact'
import { AGENT_VIEWPORT_DEFAULT, parseAgentViewport } from './agent-viewport'
import { type BrowserCheck, parseChecks } from './browser-checks'
import type { VerifyEngine } from './verification-receipts'

/**
 * LOCAL-WEBKIT-2: what `preview_verify` accepts. Setup `steps` are `preview_interact`
 * actions; `checks` are the declarative assertions of `./browser-checks`; `viewport`
 * is the agent page's (WebKit) or the run's (Chromium) size and color scheme. Pure, so
 * every limit and every engine refusal is unit-tested.
 */

export const VERIFY_LIMITS = { steps: 10 } as const
/** Steps the managed Chromium route performs with trusted CDP input. */
const CHROMIUM_STEPS = new Set(['click', 'type', 'press', 'hover', 'select', 'wait'])

export interface VerifyArgs {
  engine: VerifyEngine
  /** A route on the session's dev server; unset keeps the agent page's route. */
  path?: string
  reload: boolean
  steps: InteractArgs[]
  checks: BrowserCheck[]
  /** Raw `preview_viewport` fields, applied before the run. */
  viewport?: Record<string, unknown>
  screenshot: boolean
}

export type VerifyRequest = VerifyArgs | { list: true } | { error: string }

export function parseVerify(raw: unknown): VerifyRequest {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (a.target !== undefined && a.target !== 'agent')
    return {
      error:
        "preview_verify runs only in this session's agent browser (or managed Chromium); it never checks or moves the user's preview."
    }
  if (a.list === true) return { list: true }
  if (a.engine !== undefined && a.engine !== 'webkit' && a.engine !== 'chromium')
    return { error: 'engine must be "webkit" or "chromium".' }
  const engine: VerifyEngine = a.engine === 'chromium' ? 'chromium' : 'webkit'
  const args: VerifyArgs = {
    engine,
    reload: a.reload === true,
    steps: [],
    checks: [],
    screenshot: a.screenshot !== false
  }
  for (const key of ['reload', 'screenshot'] as const)
    if (a[key] !== undefined && typeof a[key] !== 'boolean')
      return { error: `${key} must be true or false.` }
  if (a.path !== undefined) {
    const path = previewPath(a.path)
    if (!path || path.length > 2000) return { error: 'path must be a route such as "/settings".' }
    args.path = path
  }
  if (a.viewport !== undefined) {
    if (!a.viewport || typeof a.viewport !== 'object' || Array.isArray(a.viewport))
      return { error: 'viewport takes the preview_viewport fields: preset, width, height, theme.' }
    const viewport = parseAgentViewport(a.viewport, AGENT_VIEWPORT_DEFAULT)
    if ('error' in viewport) return { error: `viewport: ${viewport.error}` }
    args.viewport = a.viewport as Record<string, unknown>
  }
  if (a.steps !== undefined) {
    if (!Array.isArray(a.steps) || a.steps.length > VERIFY_LIMITS.steps)
      return {
        error: `steps must be a list of at most ${VERIFY_LIMITS.steps} preview_interact actions.`
      }
    for (const [i, item] of a.steps.entries()) {
      const step = parseStep(item, engine)
      if ('error' in step) return { error: `steps[${i}]: ${step.error}` }
      args.steps.push(step)
    }
  }
  const checks = parseChecks(a.checks, engine)
  if ('error' in checks) return checks
  args.checks = checks.checks
  return args
}

function parseStep(item: unknown, engine: VerifyEngine): InteractArgs | { error: string } {
  const step = parseInteraction({ ...(item as object), screenshot: false })
  if ('error' in step) return step
  if (step.action === 'refs') return { error: 'refs is not a setup step; call preview_interact.' }
  if (engine === 'webkit') return step
  if (!CHROMIUM_STEPS.has(step.action))
    return { error: `${step.action} is not available as a managed Chromium step.` }
  if (step.ref || step.source || step.x !== undefined || step.index)
    return {
      error:
        'managed Chromium steps take a CSS selector (refs, source stamps, points and index are WebKit-only).'
    }
  if (step.force) return { error: 'force is a WebKit-only step option.' }
  if (['click', 'type', 'hover', 'select'].includes(step.action) && !step.selector?.trim())
    return { error: `${step.action} needs a selector with engine "chromium".` }
  return step
}
