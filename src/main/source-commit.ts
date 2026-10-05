import type { PropEditResult } from '../shared/api'
import { contentHash, sourceOwner } from './source-owner'

export const STALE_PROPOSAL =
  'The file changed since it was read, so nothing was written. Try the edit again.'

/**
 * Commit ONE parser proposal: `before` is the exact text the parser read and computed
 * `after` from. This is the only place a source-edit engine's result becomes a file
 * write (v8 F3b Undo included). The source owner commits the proposal only if the
 * file still holds `before` (hash-bound: an external edit, a cancelled or an
 * out-of-order parse is refused with nothing written). A no-op (after === before)
 * reports success without writing.
 *
 * `key` coalesces rapid edits of one target (retyping a prop) into one Undo step;
 * `group` batches the distinct-key edits of one gesture into one atomic Undo;
 * `gesture` keeps coalescing for as long as the gesture lasts (an island drag).
 */
export async function proposeEdit(
  root: string,
  file: string,
  before: string,
  after: string,
  key: string,
  group?: string,
  gesture = false
): Promise<PropEditResult> {
  if (after === before) return { applied: true }
  try {
    const result = await sourceOwner().commit(
      root,
      [{ path: file, expectedHash: contentHash(before), content: after }],
      { key, group, gesture }
    )
    return result.ok ? { applied: true } : { applied: false, error: STALE_PROPOSAL }
  } catch (error) {
    return {
      applied: false,
      error: error instanceof Error ? error.message : 'Could not write the source file.'
    }
  }
}
