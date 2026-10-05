/**
 * Serve-time source stamping + text splicing for vanilla HTML projects (Tier 2
 * of the vanilla-JS editing work — see docs/PROGRESS.md).
 *
 * Framework projects get `data-trezi-source="path:line:col"` injected by a
 * build-time plugin so the preview can map a clicked element back to source. A
 * static site has no build step — but the static server serves the on-disk file
 * verbatim, so the DOM→source map is nearly free: parse the HTML with location
 * info and insert the stamp into each element's start tag, pointing at that
 * element's own line/col in the file. `spliceHtmlText` is the inverse — given a
 * stamp, rewrite that element's plain-text content back into the file.
 *
 * parse5 is ESM-only; main is CJS, so it's loaded via dynamic import() (like
 * @babel/parser in props.ts). Everything here is pure string-in/string-out so it
 * unit-tests without a filesystem, and stamping degrades to the original HTML on
 * any parse failure rather than breaking the preview.
 */
type Parse5 = typeof import('parse5')
let parse5Promise: Promise<Parse5> | null = null
const loadParse5 = (): Promise<Parse5> => (parse5Promise ??= import('parse5'))

// parse5 location shape (subset we use). 1-based line/col, 0-based offsets.
interface Loc {
  startOffset: number
  endOffset: number
  startLine: number
  startCol: number
}
interface ElementLoc {
  startOffset: number
  endOffset: number
  startTag?: Loc
  endTag?: Loc
}
interface P5Node {
  nodeName: string
  tagName?: string
  attrs?: { name: string; value: string }[]
  childNodes?: P5Node[]
  value?: string
  sourceCodeLocation?: ElementLoc | null
}

// Elements not worth stamping: structural/head content the user never clicks to
// edit, and where an injected attribute could confuse the browser.
const SKIP_TAGS = new Set([
  'html',
  'head',
  'body',
  'meta',
  'title',
  'link',
  'base',
  'script',
  'style',
  'noscript'
])

/** Walk every element node (depth-first) that carries a real source location. */
function walkElements(node: P5Node, visit: (el: P5Node) => void): void {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) visit(child)
    walkElements(child, visit)
  }
}

/** Escape a value for an HTML double-quoted attribute. */
const attrEscape = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/** Escape text for HTML text-node content (can't break out of the element). */
const textEscape = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Insert `data-trezi-source="relpath:line:col"` into every stampable element's
 * start tag. The stamp's line:col is the element's own position in `html`, so
 * `spliceHtmlText` (and the code drawer) can find it again. Returns the original
 * HTML unchanged if it can't be parsed.
 */
export async function stampHtml(html: string, relpath: string): Promise<string> {
  let doc: P5Node
  try {
    const { parse } = await loadParse5()
    doc = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node
  } catch {
    return html
  }

  // Collect insertions first, then apply them back-to-front so earlier offsets
  // stay valid as we splice.
  const inserts: { at: number; text: string }[] = []
  walkElements(doc, (el) => {
    const tag = el.tagName ?? ''
    if (SKIP_TAGS.has(tag)) return
    const st = el.sourceCodeLocation?.startTag
    if (!st) return // auto-inserted / unlocatable element
    if (el.attrs?.some((a) => a.name === 'data-trezi-source' || a.name === 'data-praxis-source'))
      return // already stamped

    // Land the attribute right after the tag name: `<tag| ...>`. Scan the raw
    // source for the name rather than trusting tagName's case/length.
    const afterLt = st.startOffset + 1
    const name = /^[^\s/>]+/.exec(html.slice(afterLt, st.endOffset))?.[0] ?? ''
    const at = afterLt + name.length
    const value = `${relpath}:${st.startLine}:${st.startCol}`
    inserts.push({ at, text: ` data-trezi-source="${attrEscape(value)}"` })
  })

  inserts.sort((a, b) => b.at - a.at)
  let out = html
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at)
  return out
}

/**
 * Rewrite the plain-text content of the element stamped `line:col` in `html`.
 * Returns the new HTML, or null when the edit isn't a safe direct splice (no
 * such element, element/comment children, or no proper close tag) — the caller
 * then falls back to the agent, mirroring the JSX/Svelte text-edit paths.
 */
export async function spliceHtmlText(
  html: string,
  line: number,
  col: number,
  newText: string
): Promise<string | null> {
  let doc: P5Node
  try {
    const { parse } = await loadParse5()
    doc = parse(html, { sourceCodeLocationInfo: true }) as unknown as P5Node
  } catch {
    return null
  }

  let target: P5Node | null = null
  walkElements(doc, (el) => {
    const st = el.sourceCodeLocation?.startTag
    if (st && st.startLine === line && st.startCol === col) target = el
  })
  if (!target) return null
  const el: P5Node = target
  const loc = el.sourceCodeLocation
  // Need a real start+end tag (a void or unclosed element has no text content).
  if (!loc?.startTag || !loc.endTag) return null
  // Only plain-text (or empty) content is a safe splice; any element/comment
  // child hands off to the agent.
  if (!(el.childNodes ?? []).every((c) => c.nodeName === '#text')) return null

  const innerStart = loc.startTag.endOffset
  const innerEnd = loc.endTag.startOffset
  const raw = html.slice(innerStart, innerEnd)
  // Preserve the existing leading/trailing whitespace (indentation), like the
  // JSX path — unless the content is all whitespace, where lead/trail overlap.
  const allWs = /^\s*$/.test(raw)
  const lead = allWs ? '' : (raw.match(/^\s*/)?.[0] ?? '')
  const trail = allWs ? '' : (raw.match(/\s*$/)?.[0] ?? '')
  const clean = newText.replace(/\s+/g, ' ').trim()
  return html.slice(0, innerStart) + lead + textEscape(clean) + trail + html.slice(innerEnd)
}
