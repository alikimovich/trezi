// LKM-161: type-level test of the island override wire format (src/shared/preview-channels.ts).
// Never run; `bun run typecheck` and `typecheck:native` compile it, and each expected
// error below fails the build if its malformed message ever type-checks.
import type {
  IslandOverrideMessage,
  IslandOverrideRequest
} from '../../src/shared/preview-channels'

export const wellFormed: IslandOverrideMessage[] = [
  { op: 'apply', key: 'k', from: '0 1px 2px red', css: '0 2px 4px red' },
  { op: 'settle', key: 'k', css: '0 2px 4px red' },
  { op: 'clear', key: 'k' },
  { op: 'clearAll' }
]
export const request: IslandOverrideRequest = { id: 1, op: 'clear', key: 'k' }

// @ts-expect-error apply needs the value the elements show now
export const applyWithoutFrom: IslandOverrideMessage = {
  op: 'apply',
  key: 'k',
  css: '0 2px 4px red'
}
// @ts-expect-error settle compares against the written css
export const settleWithoutCss: IslandOverrideMessage = { op: 'settle', key: 'k' }
// @ts-expect-error clear names the override
export const clearWithoutKey: IslandOverrideMessage = { op: 'clear' }
// @ts-expect-error there is no such op
export const unknownOp: IslandOverrideMessage = { op: 'remove', key: 'k' }
// @ts-expect-error values are strings
export const numericCss: IslandOverrideMessage = { op: 'settle', key: 'k', css: 4 }
// @ts-expect-error the reply is matched by a numeric id
export const requestWithoutId: IslandOverrideRequest = { op: 'clearAll' }
