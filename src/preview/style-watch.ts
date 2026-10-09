/**
 * LKM-216: tells main when the page's stylesheets change in place: Vite rewrites a
 * `<style data-vite-dev-id>` or swaps a `<link>`, Next and webpack do the same. That is
 * the "HMR applied the CSS" signal the editor's freshness check waits for before it
 * re-reads computed styles or reloads a stylesheet itself. Debounced; main ignores it
 * unless a source change is outstanding, so CSS-in-JS churn costs one message per burst.
 */
const DEBOUNCE_MS = 80

const isStyleNode = (node: Node | null): boolean =>
  !!node &&
  (node.nodeName === 'STYLE' ||
    (node.nodeName === 'LINK' &&
      /\bstylesheet\b/i.test((node as Element).getAttribute('rel') ?? '')))

/** Whether a mutation touched a stylesheet: added/removed, its text or its href. */
export function touchesStyles(record: MutationRecord): boolean {
  if (record.type === 'attributes') return isStyleNode(record.target)
  if (record.type === 'characterData') return isStyleNode(record.target.parentNode)
  if (isStyleNode(record.target)) return true
  for (const node of [...record.addedNodes, ...record.removedNodes])
    if (isStyleNode(node)) return true
  return false
}

export function watchStyles(notify: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const observer = new MutationObserver((records) => {
    // The parser inserting the document's own `<link>`s is a load, not a CSS update.
    if (timer || document.readyState === 'loading' || !records.some(touchesStyles)) return
    timer = setTimeout(() => {
      timer = null
      notify()
    }, DEBOUNCE_MS)
  })
  // The document itself: a document-start script may run before `<html>` exists.
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'media', 'disabled']
  })
  return () => {
    observer.disconnect()
    if (timer) clearTimeout(timer)
  }
}
