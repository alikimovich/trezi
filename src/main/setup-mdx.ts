export const MDX_HELPER = '.trezi/trezi-mdx.mjs'

// A remark plugin, before MDX compilation: retain authored positions instead of
// stamping the generated JSX's unrelated line numbers. String plugin paths work
// with @next/mdx's serializable Turbopack options as well as webpack.
export const MDX_HELPER_CONTENT = `import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export default function treziMdx() {
  return (tree, file) => {
    if (process.env.NODE_ENV !== 'development' || !file.path) return
    const rel = path.relative(root, file.path)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return
    function walk(node) {
      const pos = node.position?.start
      if (pos) {
        const stamp = rel + ':' + pos.line + ':' + (pos.column - 1)
        if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
          if (node.name && /^[a-z]/.test(node.name) && !node.attributes.some(a => ['data-trezi-source', 'data-praxis-source'].includes(a.name))) {
            node.attributes.push({ type: 'mdxJsxAttribute', name: 'data-trezi-source', value: stamp })
          }
        } else if (['heading', 'paragraph', 'blockquote', 'list', 'listItem', 'code', 'link', 'image', 'table', 'tableRow', 'tableCell'].includes(node.type)) {
          node.data ||= {}
          node.data.hProperties ||= {}
          if (!('data-trezi-source' in node.data.hProperties) && !('data-praxis-source' in node.data.hProperties)) {
            node.data.hProperties['data-trezi-source'] = stamp
          }
        }
      }
      for (const child of node.children || []) walk(child)
    }
    walk(tree)
  }
}
`
