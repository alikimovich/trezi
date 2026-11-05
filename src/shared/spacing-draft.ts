/**
 * The spacing a Selection-mode handle may drag (LKM-541). A released handle sends one
 * `{ prop, value }` draft; the Styles inspector stages it like a typed field value, so
 * Apply, Undo and Revert stay the LKM-539 draft contract. Values are whole CSS pixels.
 */
export const SPACING_DRAFT_PROPS = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'row-gap',
  'column-gap'
] as const
export type SpacingDraftProp = (typeof SPACING_DRAFT_PROPS)[number]
export interface SpacingDraft {
  prop: SpacingDraftProp
  /** Whole, non-negative pixels as a decimal string ("24"). */
  value: string
}

/** The page is semi-trusted: only an allowlisted prop with a bounded pixel count passes. */
export function parseSpacingDraft(input: unknown): SpacingDraft | null {
  if (!input || typeof input !== 'object') return null
  const { prop, value } = input as Record<string, unknown>
  if (typeof prop !== 'string' || !(SPACING_DRAFT_PROPS as readonly string[]).includes(prop))
    return null
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value) || Number(value) > 2000) return null
  return { prop: prop as SpacingDraftProp, value: String(Number(value)) }
}
