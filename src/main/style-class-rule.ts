import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { StyleEditResult } from '../shared/api'
import { commitEdit } from './props'
import { isSafeStyleValue, STYLE_PROPS } from './styles'

export interface ClassRule {
  file: string
  className: string
}

const skipped = new Set(['node_modules', '.git', '.trezi', 'dist', 'build', 'out'])
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Vite's default CSS-module name is _localName_hash_line. A plain class may
// also come from project CSS. Never guess from an arbitrary hashed-looking name.
function localNames(classes: string[]): string[] {
  return classes.flatMap((name) => {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) return []
    const vite = /^_([A-Za-z_][\w-]*)_[a-zA-Z0-9]{5,}_\d+$/.exec(name)
    return vite ? [vite[1]] : [name]
  })
}

async function cssFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory() && !skipped.has(entry.name)) await visit(join(folder, entry.name))
      else if (entry.isFile() && /\.css$/.test(entry.name)) files.push(join(folder, entry.name))
    }
  }
  await visit(root)
  return files
}

function ruleSpans(css: string, name: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  const selector = new RegExp(`(?:^|})\\s*\\.${escapeRegExp(name)}\\s*\\{`, 'g')
  for (const match of css.matchAll(selector)) {
    const start = match.index + match[0].length
    const end = css.indexOf('}', start)
    if (end >= 0 && !css.slice(start, end).includes('{')) spans.push({ start, end })
  }
  return spans
}

export async function resolveClassRule(root: string, classes: string[]): Promise<ClassRule | null> {
  if (!Array.isArray(classes) || classes.length > 40) return null
  const names = new Set(localNames(classes))
  if (!names.size) return null
  const matches: ClassRule[] = []
  for (const file of await cssFiles(root)) {
    const css = await readFile(file, 'utf8')
    for (const name of names) {
      for (const _ of ruleSpans(css, name))
        matches.push({ file: relative(root, file), className: name })
    }
    if (matches.length > 1) return null
  }
  return matches.length === 1 ? matches[0] : null
}

export async function applyClassRule(
  root: string,
  classes: string[],
  prop: string,
  value: string,
  group?: string
): Promise<StyleEditResult> {
  if (!STYLE_PROPS.has(prop) || !isSafeStyleValue(value, prop === 'box-shadow' ? 1024 : 200))
    return { applied: false, error: 'Invalid style edit.' }
  // Resolve again at commit time: a newly added rule must make the edit read-only.
  const rule = await resolveClassRule(root, classes)
  if (!rule)
    return { applied: false, error: 'The CSS rule is missing or ambiguous. Refresh the island.' }
  const file = join(root, rule.file)
  const before = await readFile(file, 'utf8')
  const after = rewriteClassRule(before, rule.className, prop, value)
  if (!after)
    return { applied: false, error: 'The CSS rule changed or is ambiguous. Refresh the island.' }
  const result = await commitEdit(
    root,
    file,
    before,
    after,
    `${rule.file}:${rule.className}:${prop}`,
    group
  )
  return result.applied
    ? { applied: true, strategy: 'class-rule' }
    : { applied: false, error: result.error }
}

export function rewriteClassRule(
  before: string,
  className: string,
  prop: string,
  value: string
): string | null {
  if (!STYLE_PROPS.has(prop) || !isSafeStyleValue(value, prop === 'box-shadow' ? 1024 : 200))
    return null
  const [span] = ruleSpans(before, className)
  if (!span || ruleSpans(before, className).length !== 1) return null
  const body = before.slice(span.start, span.end)
  const declaration = new RegExp(`(^|;)\\s*${escapeRegExp(prop)}\\s*:\\s*([^;}]*)`, 'g')
  const found = [...body.matchAll(declaration)]
  if (found.length > 1) return null
  const nextBody = found.length
    ? body.slice(0, found[0].index + found[0][0].length - found[0][2].length) +
      value +
      body.slice(found[0].index + found[0][0].length)
    : `${body.replace(/\s*$/, '')}\n  ${prop}: ${value};\n`
  return before.slice(0, span.start) + nextBody + before.slice(span.end)
}
