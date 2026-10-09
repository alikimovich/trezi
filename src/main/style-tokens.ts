import type { StyleEdit, TokenSet, TokenSource } from '../shared/api'
import { PROP_TOKEN_RULES, tokenReference, tokenValueKind } from '../shared/token-match'
import { detectTokens } from './tokens'
import { rewriteClassList, rewriteClassListToken } from './tw-styles'

/**
 * The design-token half of the Styles commit engine, in its own module so both
 * `styles.ts` (React/JSX) and `styles-svelte.ts` can use it without importing
 * each other.
 *
 * The contract: the island sends only a token NAME + GROUP. Main re-detects the
 * project's tokens and re-resolves the pick here, so nothing the island claims
 * is ever written verbatim — same discipline as the control-panel manifests.
 */

/**
 * Very-short-lived memo of `detectTokens`. A single gesture can fan out into
 * four commits (the linked padding/margin row writes all four longhands), and
 * detection walks up to 120 stylesheets — re-scanning per longhand would make
 * one click four filesystem sweeps. Short enough that editing a theme file and
 * immediately picking a token still sees the change.
 */
const DETECT_TTL_MS = 1500
let detectMemo: { root: string; at: number; set: Promise<TokenSet> } | null = null

/** LKM-216: a change in the live tree drops the memo at once, not only on the TTL. */
export function invalidateTokenMemo(root?: string) {
  if (!root || detectMemo?.root === root) detectMemo = null
}

function detectTokensCached(root: string, now: number): Promise<TokenSet> {
  if (detectMemo && detectMemo.root === root && now - detectMemo.at < DETECT_TTL_MS) {
    return detectMemo.set
  }
  const set = detectTokens(root)
  detectMemo = { root, at: now, set }
  return set
}

/** A token pick, re-resolved and re-validated against the project's own tokens. */
export interface ResolvedTokenRef {
  /** The text to write into source: `var(--color-text)`, or the token's value. */
  ref: string
  /** The token's own name — also the Tailwind class suffix, where one exists. */
  name: string
  /** Which detection source it came from (decides whether a class form exists). */
  source: TokenSource
  /** The token's recorded value, for the agent prompt. */
  value: string
}

/**
 * Look up `edit.token` in the project's tokens and decide what to write for it.
 *
 * Null means "no usable token" — the caller then applies the edit as a plain
 * value edit, which is still correct: only the *reference* is unavailable.
 * Never an error. A token that vanished between the pick and the commit (the
 * user edited their theme file mid-gesture) is a race, not a failure.
 */
export async function resolveTokenRef(
  root: string,
  edit: StyleEdit
): Promise<ResolvedTokenRef | null> {
  const picked = edit.token
  if (!picked || typeof picked.name !== 'string' || typeof picked.group !== 'string') return null
  const rule = PROP_TOKEN_RULES[edit.prop]
  if (!rule) return null
  const set = await detectTokensCached(root, Date.now())
  const token = set.groups
    .find((g) => g.name === picked.group)
    ?.tokens.find((t) => t.name === picked.name)
  if (!token) return null
  // Re-run the same value-shape gate the picker used. This is what stops a
  // compromised island landing a color token in `padding-top`.
  if (!rule.kinds.includes(tokenValueKind(token.value))) return null
  if (rule.inRange && !rule.inRange(token.value)) return null
  return {
    ref: tokenReference(set.source, token),
    name: token.name,
    source: set.source,
    value: token.value
  }
}

/**
 * The S1 class rewrite for an edit, token-aware.
 *
 * With a token from the project's own `tailwind.config.*`, the token NAME is
 * the scale key, so a class form is real: `text-brand-500`. A token from CSS
 * custom properties or a manifest has NO class form — returning null there
 * drops the edit to S2, which splices the `var(--color-text)` reference.
 * Rewriting a class anyway would produce `text-[#6c6c6c]`, hard-coding the very
 * value the user asked to stop hard-coding.
 */
export function tokenClassRewrite(
  classList: string,
  edit: StyleEdit,
  token: ResolvedTokenRef | null
): string | null {
  if (!token) return rewriteClassList(classList, edit.prop, edit.value)
  return token.source === 'tailwind'
    ? rewriteClassListToken(classList, edit.prop, token.name)
    : null
}
