import type { ControlParam } from '../shared/api'
import type { IslandBlock, IslandValue } from '../shared/chat-islands'
import { type ShadowLightInput, shadowLight } from './shadows'
import { rewriteClassList } from './tw-styles'

const bounds = [
  [-1, 1],
  [-1, 1],
  [0, 64],
  [0, 80],
  [1, 8],
  [0, 1]
]
const keys = ['x', 'y', 'distance', 'blur', 'layers', 'decay', 'color'] as const

/** A compound block keeps all inputs and its derived output together through Jev. */
export function validateShadowBlock(fields: ControlParam[], output: unknown) {
  if (fields.length !== 8 || !['css', 'tailwind'].includes(String(output)))
    throw new Error('Shadow requires seven inputs, one output, and css/tailwind output mode.')
  const anchors = fields.map((p) => (p.apply.strategy === 'literal' ? p.apply.anchor : ''))
  if (new Set(anchors).size !== fields.length)
    throw new Error('Shadow bindings must use distinct anchors.')
  for (let i = 0; i < 6; i++) {
    if (
      fields[i].kind !== 'number' ||
      fields[i].min !== bounds[i][0] ||
      fields[i].max !== bounds[i][1]
    )
      throw new Error('Shadow input bounds do not match the Shadow Light contract.')
  }
  if (fields[4].step !== 1 || fields[6].kind !== 'color' || fields[7].kind !== 'text')
    throw new Error('Shadow requires integer layer steps, rgba color and a text output binding.')
}

export function shadowBlockCss(block: IslandBlock, values: Record<string, IslandValue>): string {
  const input = Object.fromEntries(keys.map((key, i) => [key, values[block.params[i]]]))
  return shadowLight(input as unknown as ShadowLightInput).css
}

/** Generate output from the whole latest source snapshot, never a stale UI copy. */
export function shadowOutput(block: IslandBlock, values: Record<string, IslandValue>): string {
  const css = shadowBlockCss(block, values)
  const output = values[block.params[7]]
  if (typeof output !== 'string') throw new Error('Shadow output must be a string literal.')
  const next = block.output === 'tailwind' ? rewriteClassList(output, 'box-shadow', css) : css
  if (next == null) throw new Error('Shadow class list is ambiguous.')
  if (next.length > 8192 || /[<>]/.test(next)) throw new Error('Unsafe shadow output literal.')
  return next
}
