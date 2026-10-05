import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { IslandRecord, IslandValue } from '../shared/chat-islands'
import { lexLiteral, locateAnchor, renderLiteral, resolveLiteralValue } from './control-manifest'
import { revertGroup } from './edit-history'
import { jsxAttributeLiterals, renderJsxAttribute } from './jsx-attribute-literals'
import { enqueueRepoWrite } from './repo-write-queue'
import { shadowOutput } from './shadow-controls'
import { proposeEdit } from './source-commit'
export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex')
export async function islandSource(root: string, record: IslandRecord) {
  const base = await realpath(root),
    file = await realpath(resolve(root, record.manifest.file))
  const rel = relative(base, file)
  if (
    !rel ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    rel.split('/').some((p) => ['.git', '.trezi', '.praxis', '.dsgn'].includes(p))
  )
    throw new Error('Source target escapes the project or uses metadata.')
  const code = await readFile(file, 'utf8')
  if (Buffer.byteLength(code) > 2_000_000) throw new Error('Source file is too large.')
  return { file, code, ...(await sourceValues(code, file, record)), revision: sourceHash(code) }
}
/** The island's bound values as `code` holds them. */
async function sourceValues(code: string, file: string, record: IslandRecord) {
  const attributes = await jsxAttributeLiterals(code, file)
  const values: Record<string, IslandValue> = {}
  for (const p of record.manifest.params) {
    const loc =
      p.apply.strategy === 'literal' ? locateAnchor(code, p.apply.anchor) : { error: 'missing' }
    const start = 'at' in loc ? loc.at + (code.slice(loc.at).match(/^\s*/)?.[0].length ?? 0) : -1
    const attribute = attributes.get(start)
    const value =
      attribute && ['text', 'color', 'select'].includes(p.kind)
        ? attribute.value
        : resolveLiteralValue(code, p)
    if (value === null)
      throw new Error(`Cannot resolve ${p.label}. Ask the agent to rebind this island.`)
    values[p.id] = value
  }
  for (const block of record.blocks.filter((b) => b.kind === 'shadow')) shadowOutput(block, values)
  return { values, attributes }
}
export type IslandWrite =
  | { conflict?: undefined; group: string; revision: string; values: Record<string, IslandValue> }
  | { conflict: true; revision: string; values: Record<string, IslandValue> }
/** Bindings whose source value differs from what the island last saw. */
export function changedBindings(
  record: IslandRecord,
  seen: Record<string, IslandValue>,
  values: Record<string, IslandValue>
) {
  return record.manifest.params
    .filter((p) => p.id in seen && seen[p.id] !== values[p.id])
    .map((p) => p.id)
}
/**
 * One file/gesture = one validated write and undo group. All participants share repo queue.
 * The check is per binding, not per file (LKM-133): edits elsewhere in the file are kept and
 * written over; only when one of the island's own literals no longer holds the value the island
 * last saw (`seen`) is nothing written, and the current values come back as a conflict. Reset
 * passes no `seen`. Returns undefined when the values are already in the source.
 */
export function writeIsland(
  root: string,
  record: IslandRecord,
  seen: Record<string, IslandValue> | undefined,
  values: Record<string, IslandValue>,
  guard: () => boolean,
  gestureGroup?: string
) {
  return enqueueRepoWrite(root, async (): Promise<IslandWrite | undefined> => {
    if (!guard()) throw new Error('This island changed or closed. Reload its controls.')
    const source = await islandSource(root, record)
    if (seen && changedBindings(record, seen, source.values).length)
      return { conflict: true, revision: source.revision, values: source.values }
    const changes: { start: number; end: number; text: string }[] = []
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      !Object.keys(values).length
    )
      throw new Error('No values to apply.')
    values = { ...values }
    const derived = new Set<string>()
    for (const block of record.blocks.filter((b) => b.kind === 'shadow')) {
      const output = block.params[7]
      derived.add(output)
      // Ignore client-supplied output (including Reset); always derive it.
      delete values[output]
      if (block.params.some((id) => id in values)) {
        shadowOutput(block, { ...source.values, ...values }) // Reject out-of-range/fractional counts first.
        for (const id of block.params.slice(0, 6)) {
          if (!(id in values)) continue
          const param = record.manifest.params.find((p) => p.id === id)!
          const literal = renderLiteral('number', values[id], param)
          if (typeof literal !== 'string') throw new Error(literal.error)
          values[id] = Number(literal)
        }
        values[output] = shadowOutput(block, { ...source.values, ...values })
      }
    }
    for (const [id, value] of Object.entries(values)) {
      const param = record.manifest.params.find((p) => p.id === id)
      if (!param || param.apply.strategy !== 'literal') throw new Error('Unknown binding.')
      const loc = locateAnchor(source.code, param.apply.anchor)
      if ('error' in loc) throw new Error('Binding no longer resolves.')
      const start = loc.at + (source.code.slice(loc.at).match(/^\s*/)?.[0].length ?? 0)
      const attribute = source.attributes.get(start)
      const lit = attribute
        ? { ...attribute, raw: source.code.slice(attribute.start, attribute.end) }
        : lexLiteral(source.code, loc.at, param.kind)
      if (!lit) throw new Error('Source literal no longer resolves.')
      const converted =
        param.kind === 'bezier' && typeof value === 'string'
          ? value.match(/-?\d*\.?\d+/g)?.map(Number)
          : value
      const text = derived.has(id)
        ? JSON.stringify(value)
        : renderLiteral(param.kind, converted, param, lit.raw.startsWith('[') ? 'array' : 'string')
      if (typeof text !== 'string') throw new Error(text.error)
      changes.push({
        start: lit.start,
        end: lit.end,
        text: attribute ? renderJsxAttribute(JSON.parse(text), lit.raw[0]) : text
      })
    }
    changes.sort((a, b) => b.start - a.start)
    for (let i = 1; i < changes.length; i++)
      if (changes[i].end > changes[i - 1].start)
        throw new Error('Overlapping bindings cannot be changed together.')
    let next = source.code
    for (const change of changes)
      next = next.slice(0, change.start) + change.text + next.slice(change.end)
    if (next === source.code) return undefined
    // Protect external edits observed during validation too.
    if (!guard() || (await readFile(source.file, 'utf8')) !== source.code)
      throw new Error('Source changed before the edit could be saved.')
    const group = gestureGroup ?? `island:${randomUUID()}`
    // A proposal bound to the text validated above; a gesture keeps coalescing into one Undo step.
    const written = await proposeEdit(
      root,
      source.file,
      source.code,
      next,
      group,
      group,
      !!gestureGroup
    )
    if (!written.applied)
      throw new Error(written.error ?? 'Source changed before the edit could be saved.')
    // What the island now sees: the source values with this write applied.
    return {
      group,
      revision: sourceHash(next),
      values: (await sourceValues(next, source.file, record)).values
    }
  })
}
export function undoIsland(root: string, group: string, guard: () => boolean) {
  return enqueueRepoWrite(root, async () => {
    if (!guard()) throw new Error('This island changed or closed.')
    const result = await revertGroup(root, group)
    if (!result.ok) throw new Error('Cannot undo: source or edit history changed.')
  })
}
