/**
 * Read-only code navigation for a selected preview object (LKM-363): maps the
 * element's source stamp (`path:line[:col]`) to the element's own range and to the
 * sources of its styles, each with its provenance. It reuses the inspector's
 * mappings (the JSX locator behind `source:read`, parse5 locations as in
 * `html-source.ts`, the class-rule matching of `style-class-rule.ts`, Cmd+click
 * component resolution) and never writes. Paths are realpath-checked against the
 * project, so `..` and symlinks cannot leave it.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type BabelNode, collectNodes, findElementAtLine, resolveComponentByImports } from './props'

export type CodeSourceKind =
  | 'element'
  | 'stamp-line'
  | 'inline-style'
  | 'class-attribute'
  | 'css-rule'
  | 'component'

export interface CodeSourceCandidate {
  kind: CodeSourceKind
  file: string
  startLine: number
  endLine: number
  /** Where the mapping came from, in words the agent can show the user. */
  provenance: string
}

export interface CodeSources {
  file: string
  element?: string
  candidates: CodeSourceCandidate[]
  /** The runtime result is not fully known from source (spread props, computed classes, stale stamp). */
  ambiguous: boolean
  notes: string[]
}

const MAX_BYTES = 2 * 1024 * 1024
const MAX_CSS_FILES = 300
const MAX_CANDIDATES = 24
const SOURCE_RE = /^([\w./@-]+):(\d+)(?::(\d+))?$/
const CLASS_RE = /^[A-Za-z_-][\w-]*$/
const SKIPPED = new Set(['node_modules', '.git', '.trezi', 'dist', 'build', 'out'])
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lineAt = (text: string, offset: number) => {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** A project-relative text file, resolved through symlinks; null outside the project. */
export async function projectFile(
  root: string,
  file: string
): Promise<{ path: string; file: string } | null> {
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\0')) return null
  try {
    const base = await realpath(root)
    const path = await realpath(resolve(base, file))
    const rel = relative(base, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return { path, file: rel.split(sep).join('/') }
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > MAX_BYTES) return null
    const text = await readFile(path, 'utf8')
    return text.includes('\0') ? null : text.replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** Rules whose selector names `.name` (comments blanked so lines keep their numbers). */
export function cssRuleRanges(
  css: string,
  name: string,
  offset = 0,
  whole = css
): { startLine: number; endLine: number; selector: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const token = new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`)
  const found: { startLine: number; endLine: number; selector: string }[] = []
  for (const match of text.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const selector = match[1].trim()
    if (!selector || selector.startsWith('@') || !token.test(selector)) continue
    const start = offset + match.index + (match[1].length - match[1].trimStart().length)
    found.push({
      startLine: lineAt(whole, start),
      endLine: lineAt(whole, offset + match.index + match[0].length - 1),
      selector: selector.replace(/\s+/g, ' ').slice(0, 120)
    })
  }
  return found
}

async function cssFiles(base: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (folder: string) => {
    if (files.length >= MAX_CSS_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    // Symlinked entries are neither files nor directories here, so none is followed.
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) await visit(join(folder, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.css') && files.length < MAX_CSS_FILES)
        files.push(join(folder, entry.name))
    }
  }
  await visit(base)
  return files
}

/** Vite's CSS-module runtime name `_local_hash_line` maps back to `local` in a `.module.css`. */
function runtimeNames(classes: unknown): { name: string; module: boolean }[] {
  if (!Array.isArray(classes)) return []
  return classes.slice(0, 40).flatMap((value) => {
    if (typeof value !== 'string' || !CLASS_RE.test(value)) return []
    const vite = /^_([A-Za-z_][\w-]*)_[a-zA-Z0-9]{5,}_\d+$/.exec(value)
    return [vite ? { name: vite[1], module: true } : { name: value, module: false }]
  })
}

type Found = {
  element?: string
  candidates: CodeSourceCandidate[]
  ambiguous: boolean
  /** No element starts on the stamp line; `element` is only the enclosing one. */
  drifted?: boolean
  notes: string[]
  /** Class names to look up in global CSS, and module names per `.module.css` file. */
  globals: Set<string>
  modules: Map<string, Set<string>>
  /** `<style>` blocks of the stamped file itself (HTML): [offset, text]. */
  blocks: [number, string][]
}

const range = (node: BabelNode) => ({
  startLine: node.loc?.start.line ?? 1,
  endLine: node.loc?.end.line ?? node.loc?.start.line ?? 1
})

function literalClasses(node: BabelNode | null | undefined, into: Set<string>): boolean {
  if (!node) return true
  if (node.type === 'StringLiteral') {
    for (const name of String((node as { value?: string }).value ?? '').split(/\s+/))
      if (CLASS_RE.test(name)) into.add(name)
    return true
  }
  if (node.type === 'JSXExpressionContainer')
    return literalClasses(node.expression as BabelNode, into)
  if (node.type === 'TemplateLiteral') {
    for (const quasi of (node.quasis as BabelNode[] | undefined) ?? [])
      literalClasses(
        { type: 'StringLiteral', value: (quasi.value as { cooked?: string })?.cooked } as never,
        into
      )
    return !((node.expressions as unknown[] | undefined) ?? []).length
  }
  return false
}

/** `import styles from './Card.module.css'` → local name → repo-relative module file. */
function cssModuleImports(ast: BabelNode, file: string): Map<string, string> {
  const imports: BabelNode[] = []
  collectNodes(ast, 'ImportDeclaration', imports)
  const found = new Map<string, string>()
  for (const imp of imports) {
    const spec = (imp.source as { value?: string } | undefined)?.value
    if (typeof spec !== 'string' || !spec.startsWith('.') || !/\.module\.css$/.test(spec)) continue
    for (const s of (imp.specifiers as BabelNode[] | undefined) ?? []) {
      const local = (s.local as { name?: string } | undefined)?.name
      if (local && s.type !== 'ImportSpecifier')
        found.set(local, join(dirname(file), spec).split(sep).join('/'))
    }
  }
  return found
}

async function jsxSources(code: string, file: string, line: number, column?: number) {
  const found: Found = {
    candidates: [],
    ambiguous: false,
    notes: [],
    globals: new Set(),
    modules: new Map(),
    blocks: []
  }
  const hit = await findElementAtLine(code, line, column).catch(() => null)
  if (!hit) return found
  found.element = hit.name
  if (hit.opening.loc?.start.line !== line) {
    found.drifted = found.ambiguous = true
    found.notes.push(
      `No element starts at line ${line}; <${hit.name}> only encloses it, so the file may have changed since the preview stamped it.`
    )
  }
  const elements: BabelNode[] = []
  collectNodes(hit.ast, 'JSXElement', elements)
  const whole = elements.find(
    (e) => (e.openingElement as BabelNode | undefined)?.start === hit.opening.start
  )
  found.candidates.push({
    kind: 'element',
    file,
    ...range(whole ?? hit.opening),
    provenance: `<${hit.name}> element at the preview's source stamp ${file}:${line}`
  })
  const attributes = (hit.opening.attributes as BabelNode[] | undefined) ?? []
  if (attributes.some((a) => a.type === 'JSXSpreadAttribute')) {
    found.ambiguous = true
    found.notes.push('A {...spread} on the element can add className or style at runtime.')
  }
  const attribute = (name: string) =>
    attributes.find(
      (a) => a.type === 'JSXAttribute' && (a.name as { name?: string } | undefined)?.name === name
    )
  const style = attribute('style')
  if (style)
    found.candidates.push({
      kind: 'inline-style',
      file,
      ...range(style),
      provenance: `inline style attribute on <${hit.name}>`
    })
  const className = attribute('className') ?? attribute('class')
  if (className) {
    const value = className.value as BabelNode | null
    const literal = literalClasses(value, found.globals)
    const modules = cssModuleImports(hit.ast, file)
    const members: BabelNode[] = []
    collectNodes(value, 'MemberExpression', members)
    for (const member of members) {
      const object = (member.object as { name?: string } | undefined)?.name
      const property = member.property as { type: string; name?: string; value?: string }
      const name = member.computed ? property.value : property.name
      const module = object ? modules.get(object) : undefined
      if (module && typeof name === 'string' && CLASS_RE.test(name)) {
        if (!found.modules.has(module)) found.modules.set(module, new Set())
        found.modules.get(module)!.add(name)
      }
    }
    const expression = value?.type === 'JSXExpressionContainer' ? value.expression : undefined
    if (!literal && !(expression?.type === 'MemberExpression' && found.modules.size)) {
      found.ambiguous = true
      found.notes.push('className is computed at runtime; only its literal parts are mapped.')
    }
    found.candidates.push({
      kind: 'class-attribute',
      file,
      ...range(className),
      provenance: `className on <${hit.name}>`
    })
  }
  if (/^[A-Z]/.test(hit.name))
    found.notes.push(`<${hit.name}> is a component: its own styles live where it is defined.`)
  return found
}

type P5Loc = {
  startLine: number
  endLine: number
  startCol: number
  startOffset: number
  endOffset: number
}
type P5Node = {
  tagName?: string
  attrs?: { name: string; value: string }[]
  childNodes?: P5Node[]
  content?: P5Node
  value?: string
  sourceCodeLocation?: {
    startTag?: P5Loc
    endTag?: P5Loc
    startLine: number
    endLine: number
    attrs?: Record<string, P5Loc>
  } | null
}

async function htmlSources(code: string, file: string, line: number, column?: number) {
  const found: Found = {
    candidates: [],
    ambiguous: false,
    notes: [],
    globals: new Set(),
    modules: new Map(),
    blocks: []
  }
  let doc: P5Node
  try {
    const { parse } = await import('parse5')
    doc = parse(code, { sourceCodeLocationInfo: true }) as unknown as P5Node
  } catch {
    return found
  }
  const all: P5Node[] = []
  const walk = (node: P5Node) => {
    for (const child of [...(node.childNodes ?? []), ...(node.content ? [node.content] : [])]) {
      if (child.tagName) all.push(child)
      walk(child)
    }
  }
  walk(doc)
  for (const el of all)
    if (el.tagName === 'style' && el.sourceCodeLocation?.startTag && el.sourceCodeLocation.endTag)
      found.blocks.push([
        el.sourceCodeLocation.startTag.endOffset,
        code.slice(
          el.sourceCodeLocation.startTag.endOffset,
          el.sourceCodeLocation.endTag.startOffset
        )
      ])
  const onLine = all.filter((el) => el.sourceCodeLocation?.startTag?.startLine === line)
  const el =
    onLine.find((e) => e.sourceCodeLocation?.startTag?.startCol === column) ??
    (column == null ? onLine[0] : undefined)
  const loc = el?.sourceCodeLocation
  if (!el || !loc) return found
  found.element = el.tagName
  found.candidates.push({
    kind: 'element',
    file,
    startLine: loc.startLine,
    endLine: loc.endTag?.endLine ?? loc.endLine,
    provenance: `<${el.tagName}> element at the preview's source stamp ${file}:${line}`
  })
  const attr = (name: string) => el.attrs?.find((a) => a.name === name)
  if (attr('style') && loc.attrs?.style)
    found.candidates.push({
      kind: 'inline-style',
      file,
      startLine: loc.attrs.style.startLine,
      endLine: loc.attrs.style.endLine,
      provenance: `inline style attribute on <${el.tagName}>`
    })
  const classes = attr('class')
  if (classes && loc.attrs?.class) {
    for (const name of classes.value.split(/\s+/)) if (CLASS_RE.test(name)) found.globals.add(name)
    found.candidates.push({
      kind: 'class-attribute',
      file,
      startLine: loc.attrs.class.startLine,
      endLine: loc.attrs.class.endLine,
      provenance: `class attribute on <${el.tagName}>`
    })
  }
  return found
}

/**
 * The selected object's element range (`target: 'element'`) or its style sources
 * (`'styles'`) with provenance. `classes` are the runtime classes the preview reported,
 * used only to find rules; they never name a location by themselves.
 */
export async function resolveCodeSources(
  root: string,
  source: unknown,
  target: 'element' | 'styles',
  classes?: unknown
): Promise<CodeSources | { error: string }> {
  const match = typeof source === 'string' ? SOURCE_RE.exec(source) : null
  if (!match) return { error: 'Provide the selected element’s source as path:line[:column].' }
  const located = await projectFile(root, match[1])
  if (!located) return { error: 'The source must be a file inside the project.' }
  const code = await readText(located.path)
  if (code === null) return { error: 'Could not read that project file as text.' }
  const line = Number(match[2]),
    column = match[3] == null ? undefined : Number(match[3])
  const extension = extname(located.file).toLowerCase()
  const found = /^\.(jsx?|tsx?|mjs|cjs)$/.test(extension)
    ? await jsxSources(code, located.file, line, column)
    : /^\.html?$/.test(extension)
      ? await htmlSources(code, located.file, line, column)
      : null
  const notes = found?.notes ?? []
  let candidates = found?.candidates ?? []
  const stale = !found?.element
  const ambiguous = stale || !!found?.ambiguous
  const stampLine: CodeSourceCandidate = {
    kind: 'stamp-line',
    file: located.file,
    startLine: line,
    endLine: line,
    provenance: `the preview's source stamp line ${located.file}:${line}`
  }
  if (stale) {
    // The stamp line is all that is known: the file changed, or the type has no element map.
    notes.push(
      found
        ? 'No element starts at this stamp now; the file may have changed since the preview stamped it.'
        : `Element ranges are not mapped for ${extension || 'this file type'}; only the stamp line is known.`
    )
    candidates = [stampLine]
  }
  const drifted = !stale && !!found?.drifted
  if (target === 'element')
    return {
      file: located.file,
      element: found?.element,
      candidates: [
        ...(drifted ? [stampLine] : []),
        ...candidates.filter((c) => c.kind === 'element' || c.kind === 'stamp-line')
      ],
      // Spread props or computed classes change the styles, never where the element is.
      ambiguous: stale || drifted,
      notes: stale ? notes.slice(-1) : drifted ? notes.slice(0, 1) : []
    }

  const styles: CodeSourceCandidate[] = candidates.filter((c) => c.kind === 'inline-style')
  const classAttribute = candidates.find((c) => c.kind === 'class-attribute')
  const globals = new Set(found?.globals ?? [])
  const modules = new Map(found?.modules ?? [])
  const runtimeModules = new Set<string>()
  for (const { name, module } of runtimeNames(classes)) {
    if (module) runtimeModules.add(name)
    else globals.add(name)
  }
  const base = await realpath(root)
  // One rule can match several of the classes (`.a, .b:hover {}`): it is one candidate.
  const addRule = (
    file: string,
    rule: { startLine: number; endLine: number },
    provenance: string
  ) =>
    styles.some(
      (c) => c.file === file && c.startLine === rule.startLine && c.kind === 'css-rule'
    ) ||
    styles.push({
      kind: 'css-rule',
      file,
      startLine: rule.startLine,
      endLine: rule.endLine,
      provenance
    })
  const rules = (text: string, file: string, names: Iterable<string>, kind: string) => {
    for (const name of names)
      for (const rule of cssRuleRanges(text, name))
        addRule(file, rule, `${kind} rule \`${rule.selector}\` in ${file} (matches class .${name})`)
  }
  for (const [offset, block] of found?.blocks ?? [])
    for (const name of globals)
      for (const rule of cssRuleRanges(block, name, offset, code))
        addRule(
          located.file,
          rule,
          `<style> rule \`${rule.selector}\` in ${located.file} (matches class .${name})`
        )
  for (const [module, names] of modules) {
    const file = await projectFile(base, module)
    const text = file && (await readText(file.path))
    if (file && text) rules(text, file.file, names, 'CSS module')
    else notes.push(`The CSS module ${module} could not be read.`)
  }
  if (globals.size || runtimeModules.size)
    for (const path of await cssFiles(base)) {
      if (styles.length >= MAX_CANDIDATES) break
      const file = relative(base, path).split(sep).join('/')
      if (modules.has(file)) continue
      const isModule = file.endsWith('.module.css')
      const names = isModule ? runtimeModules : globals
      if (!names.size) continue
      const text = await readText(path)
      if (text) rules(text, file, names, isModule ? 'CSS module' : 'Global CSS')
    }
  const mapped = styles.some((c) => c.kind === 'css-rule')
  // Utility or external classes: the class list itself is where they are set.
  if (classAttribute && !mapped)
    styles.push({
      ...classAttribute,
      provenance: `${classAttribute.provenance}: no project CSS rule matches these classes (utility or external classes are set here)`
    })
  if (found?.element && /^[A-Z]/.test(found.element) && extension !== '.html') {
    const defined = resolveComponentByImports(base, located.file, found.element)
    const file = defined ? await projectFile(base, defined) : null
    const text = file ? await readText(file.path) : null
    if (file && text) {
      const at = new RegExp(
        `(?:function\\s+${found.element}\\b|(?:const|let|var|class)\\s+${found.element}\\b)`
      ).exec(text)
      const startLine = at ? lineAt(text, at.index) : 1
      styles.push({
        kind: 'component',
        file: file.file,
        startLine,
        endLine: startLine,
        provenance: `shared component <${found.element}> defined in ${file.file}; styles set there apply to every use`
      })
    }
  }
  if (!styles.length) notes.push('No style source is mapped for this element.')
  return {
    file: located.file,
    element: found?.element,
    candidates: styles.slice(0, MAX_CANDIDATES),
    ambiguous: ambiguous || styles.length > MAX_CANDIDATES,
    notes
  }
}
