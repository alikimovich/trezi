/**
 * Resolve a clicked Svelte element to the component *instance* that rendered it —
 * the Svelte counterpart of v8 F3a (which the React stamp solves with
 * `data-trezi-component-source`). A Svelte component renders no wrapper DOM node,
 * so a click inside `EmptyState.svelte`'s markup resolves to the **definition**,
 * not the `<EmptyState …/>` call site the user authored. Editing the definition
 * changes the prop's *default* (option D), which is rarely what's wanted.
 *
 * We can't carry a usage-site stamp through Svelte's compiled output, so we
 * disambiguate by **content**: the clicked host element renders a prop value, so
 * match that rendered text against each usage's literal string props. Only a
 * UNIQUE exact match resolves — 0 or >1 candidates return null so the caller
 * keeps the safe option-D default rather than editing the wrong instance.
 *
 * Pure (no fs / no svelte compiler) so it's bun-unit-testable; the caller in
 * props-svelte.ts does the parsing and feeds the usages in.
 */

/** A `<Component …/>` usage's literal string-valued props, plus its source. */
export interface SvelteUsage {
  /** "relpath:line:col" of the component-usage node (the edit target). */
  source: string
  /** Literal string values set on the usage, e.g. `description="Nothing yet"`. */
  literals: string[]
}

/** Collapse surrounding/inner whitespace so DOM text and source literals compare. */
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ')

export function pickInstance(usages: SvelteUsage[], clickedText: string | null): string | null {
  const target = norm(clickedText ?? '')
  if (!target) return null
  const hits = usages.filter((u) => u.literals.some((v) => norm(v) === target))
  return hits.length === 1 ? hits[0].source : null
}
