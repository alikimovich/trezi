import type { ControlPanelManifest } from '../shared/api'
import type { IslandBlock } from '../shared/chat-islands'
import { validateManifest } from './control-manifest'
import { validateShadowBlock } from './shadow-controls'

const id = /^[a-z0-9][a-z0-9-]{0,40}$/
export function islandDefinition(raw: unknown): {
  manifest: ControlPanelManifest
  blocks: IslandBlock[]
} {
  if (!raw || typeof raw !== 'object' || JSON.stringify(raw).length > 35000)
    throw new Error('Invalid island definition.')
  const input = raw as { manifest?: any; blocks?: unknown }
  const manifest = validateManifest({
    ...input.manifest,
    id: 'island',
    createdAt: new Date().toISOString()
  })
  if ('error' in manifest) throw new Error(manifest.error)
  if (
    manifest.file
      .split('/')
      .some((p) => p === '.trezi' || p === '.praxis' || p === '.dsgn' || p === '.git')
  )
    throw new Error('Cannot bind application metadata.')
  if (manifest.params.some((p) => p.apply.strategy !== 'literal'))
    throw new Error('Chat islands require selection-independent literal bindings.')
  if (!Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 12)
    throw new Error('Provide 1–12 blocks.')
  const seen = new Set<string>()
  const blocks = input.blocks.map((block: any): IslandBlock => {
    if (!block || typeof block.id !== 'string' || !id.test(block.id) || seen.has(block.id))
      throw new Error('Invalid or duplicate block id.')
    seen.add(block.id)
    if (typeof block.title !== 'string' || !block.title.trim() || block.title.length > 80)
      throw new Error('Invalid block title.')
    if (
      !['group', 'point', 'shadow'].includes(block.kind) ||
      !Array.isArray(block.params) ||
      !block.params.length ||
      block.params.length > 12 ||
      new Set(block.params).size !== block.params.length
    )
      throw new Error('Invalid block.')
    const fields = block.params.map((key: unknown) => manifest.params.find((p) => p.id === key))
    if (fields.some((p: unknown) => !p)) throw new Error('Unknown binding.')
    if (
      block.kind === 'point' &&
      (fields.length !== 2 ||
        fields.some(
          (p: any) =>
            p.kind !== 'number' || p.min === undefined || p.max === undefined || p.min >= p.max
        ))
    )
      throw new Error('Point requires two bounded numeric bindings.')
    if (block.kind === 'shadow') validateShadowBlock(fields, block.output)
    else if (block.output !== undefined) throw new Error('Only shadows have an output mode.')
    return {
      ...(block.kind === 'shadow' ? { output: block.output } : {}),
      id: block.id,
      title: block.title,
      kind: block.kind,
      params: [...block.params]
    }
  })
  for (const block of blocks.filter((b) => b.kind === 'shadow')) {
    if (
      blocks.some((other) => other !== block && other.params.some((p) => block.params.includes(p)))
    )
      throw new Error('Shadow bindings cannot be shared with another block.')
  }
  return { manifest, blocks }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const label = (item: any, at: number, kind: string) =>
  `${kind}[${at}]${typeof item?.id === 'string' ? ` (${item.id})` : ''}`
/**
 * Every problem `islandDefinition` refuses, not only the first (LKM-201): the manifest's
 * own fields, each param and each block, so the agent fixes the definition in one go
 * before it edits any source. Empty when the definition is valid.
 */
export function islandProblems(raw: unknown): string[] {
  let first: string
  try {
    islandDefinition(raw)
    return []
  } catch (error) {
    first = message(error)
  }
  const input = (raw && typeof raw === 'object' ? raw : {}) as { manifest?: any; blocks?: unknown }
  const m = input.manifest && typeof input.manifest === 'object' ? input.manifest : {}
  const params: unknown[] = Array.isArray(m.params) ? m.params : []
  const blocks: unknown[] = Array.isArray(input.blocks) ? input.blocks : []
  const problems: string[] = []
  const probe = {
    id: 'p',
    label: 'P',
    kind: 'number',
    apply: { strategy: 'literal', anchor: 'p = ' }
  }
  const own = validateManifest({ ...m, id: 'island', createdAt: 'now', params: [probe] })
  if ('error' in own) problems.push(`manifest: ${own.error}`)
  else if (
    String(m.file)
      .split('/')
      .some((p) => p === '.trezi' || p === '.praxis' || p === '.dsgn' || p === '.git')
  )
    problems.push('manifest: Cannot bind application metadata.')
  if (!params.length || params.length > 12) problems.push('manifest: params must have 1-12 entries')
  const ids = new Set<string>()
  const invalid = new Set<unknown>()
  const valid: unknown[] = []
  params.forEach((param: any, at) => {
    const alone = validateManifest({
      id: 'island',
      file: 'island.js',
      component: 'Island',
      title: 'Island',
      createdAt: 'now',
      params: [param]
    })
    const why =
      'error' in alone
        ? alone.error
        : alone.params[0].apply.strategy !== 'literal'
          ? 'Chat islands require selection-independent literal bindings.'
          : ids.has(alone.params[0].id)
            ? 'duplicate param id'
            : ''
    if (why) {
      problems.push(`${label(param, at, 'params')}: ${why}`)
      if (!ids.has(param?.id)) invalid.add(param?.id)
    } else valid.push(param)
    if (typeof param?.id === 'string') ids.add(param.id)
  })
  if (!blocks.length || blocks.length > 12) problems.push('blocks: Provide 1–12 blocks.')
  const blockIds = new Set<string>()
  // Blocks are checked against the valid params (a probe stands in when none is); one
  // naming an invalid param is reported with that param, not twice.
  const known = valid.length ? valid : [{ ...probe, id: 'trezi-probe' }]
  blocks.forEach((block: any, at) => {
    if (Array.isArray(block?.params) && block.params.some((id: unknown) => invalid.has(id))) return
    try {
      if (typeof block?.id === 'string' && blockIds.has(block.id))
        throw new Error('Invalid or duplicate block id.')
      if (typeof block?.id === 'string') blockIds.add(block.id)
      islandDefinition({
        manifest: { file: 'island.js', component: 'Island', title: 'Island', params: known },
        blocks: [block]
      })
    } catch (error) {
      problems.push(`${label(block, at, 'blocks')}: ${message(error)}`)
    }
  })
  return problems.length ? problems : [first]
}
