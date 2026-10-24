/**
 * Drop the select-mode hover (LKM-328). The page drops it itself when a move lands on a
 * native shield, but WebKit can skip that move (macOS 27 did, over the islands), so the host
 * also says when the pointer enters an island (`mouseEntered` on its own tracking area) and
 * the page runs the same clear: a pending coalesced hover is cancelled with the box.
 */
export type HoverDropParts = {
  /** The coalesced hover; `clear` cancels a frame still waiting to paint. */
  hover: { clear: () => void }
  /** Forget the last hovered element so the next move over it paints again. */
  forget: () => void
  hideBox: () => void
  clearMeasure: () => void
  /** True while an inline edit or comment composer holds the highlight frozen. */
  frozen: () => boolean
}

export function createHoverDrop(parts: HoverDropParts): { drop: () => void; entered: () => void } {
  const drop = (): void => {
    parts.forget()
    parts.hover.clear()
    parts.hideBox()
    parts.clearMeasure()
  }
  return {
    drop,
    /** The host's word that the pointer is over a native island: a frozen highlight stays. */
    entered(): void {
      if (!parts.frozen()) drop()
    }
  }
}
