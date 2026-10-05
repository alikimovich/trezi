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
