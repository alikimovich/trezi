/** JSX quoted attributes use HTML entities, not JavaScript backslash escapes. */
export interface JsxAttributeLiteral {
  start: number
  end: number
  value: string
}

export function renderJsxAttribute(value: string, quote = '"'): string {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll(quote, quote === '"' ? '&quot;' : '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')
  return quote + escaped + quote
}

/** Index only direct attributes; strings inside JSX expressions remain JS literals.
 * Parse rather than infer context from the anchor (which may also occur in JS). */
export async function jsxAttributeLiterals(
  code: string,
  file: string
): Promise<Map<number, JsxAttributeLiteral>> {
  const result = new Map<number, JsxAttributeLiteral>()
  // .ts/.mts/.cts permit angle-bracket assertions and cannot contain JSX.
  if (/\.[cm]?ts$/.test(file) || !/\.[cm]?[jt]sx?$/.test(file) || !code.includes('<')) return result
  const { parse } = await import('@babel/parser')
  const ast = parse(code, {
    sourceType: 'unambiguous',
    plugins: file.endsWith('.tsx') ? ['jsx', 'typescript'] : ['jsx']
  })
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'JSXAttribute' && node.value?.type === 'StringLiteral') {
      const { start, end, value } = node.value
      result.set(start, { start, end, value })
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'extra', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(ast)
  return result
}
