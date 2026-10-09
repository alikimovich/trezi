const text = (lines: string[]) => lines.join(' ').replace(/\s+/g, ' ').toLowerCase()

/** Keep title evidence in the top viewport; other semantics may span the tall panel.
 *  The panel has no local preview box (LKM-133): a standalone "Preview" label fails. */
export function missingShadowCaptureSemantics(top: string[], bottom: string[]) {
  // Per line: "Shadow" followed by "Light Source" must not read as the title.
  const topLines = top.map((line) => text([line]))
  const visibleText = text([...top, ...bottom])
  return [
    ...['shadow light', 'light source'].filter(
      (label) => !topLines.some((line) => line.includes(label))
    ),
    ...['distance', 'blur', 'layers', 'decay', 'rgba', 'box-shadow', 'undo'].filter(
      (label) => !visibleText.includes(label)
    ),
    ...([...top, ...bottom].some((line) => line.trim().toLowerCase() === 'preview')
      ? ['no preview box']
      : [])
  ]
}
