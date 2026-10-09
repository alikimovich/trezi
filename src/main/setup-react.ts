export const REACT_HELPER_CONTENT = `// Added by Trezi (.trezi/). Stamps data-trezi-source="path:line:col" on JSX elements
// so Trezi can map a clicked element to its source. Wire into the React Babel
// plugins for DEVELOPMENT ONLY; it also self-disables in production builds.
module.exports = function treziSource({ types: t }) {
  if (process.env.NODE_ENV === 'production') return { name: 'trezi-source', visitor: {} }
  const path = require('path')
  return {
    name: 'trezi-source',
    visitor: {
      JSXOpeningElement(p, state) {
        // Normalize a copied spread once so forwarded legacy instance locations
        // can override this element's generated canonical default. Copying first
        // preserves evaluation order and avoids reading source getters twice.
        for (const attribute of p.node.attributes) {
          if (attribute.type !== 'JSXSpreadAttribute') continue
          const argument = attribute.argument
          if (argument.type === 'CallExpression' && argument.callee.type === 'ArrowFunctionExpression' &&
              argument.callee.body.directives?.some(d => d.value.value === 'trezi-source-props')) continue
          const props = t.identifier('props')
          const get = key => t.memberExpression(props, t.stringLiteral(key), true)
          const canonical = () => get('data-trezi-component-source')
          const legacy = () => get('data-praxis-component-source')
          const body = t.blockStatement([
            t.ifStatement(t.logicalExpression('&&',
              t.binaryExpression('==', canonical(), t.nullLiteral()),
              t.binaryExpression('!=', legacy(), t.nullLiteral())),
              t.expressionStatement(t.assignmentExpression('=', canonical(), legacy()))),
            t.returnStatement(props)
          ], [t.directive(t.directiveLiteral('trezi-source-props'))])
          attribute.argument = t.callExpression(t.arrowFunctionExpression([props], body), [
            t.objectExpression([t.spreadElement(argument)])
          ])
        }
        const loc = p.node.loc
        if (!loc) return
        if (p.node.attributes.some((a) => a.name && ['data-trezi-source', 'data-praxis-source'].includes(a.name.name))) return
        const root = state.file.opts.root || process.cwd()
        const file = path.relative(root, state.file.opts.filename || '')
        const where = file + ':' + loc.start.line + ':' + loc.start.column
        // Host stamp: APPEND so the innermost host's own location wins (a forwarded
        // {...props} value is overwritten by this).
        p.node.attributes.push(t.jsxAttribute(t.jsxIdentifier('data-trezi-source'), t.stringLiteral(where)))
        // v8 F3a — component-instance stamp: on COMPONENT tags (Capitalized or a
        // member like Foo.Bar), UNSHIFT (insert first) so a child's {...props}
        // spread overwrites it with the OUTER authored instance — the instance call
        // site wins over the host, letting the inspector edit per-instance props.
        const name = p.node.name
        // A component tag is any non-host (React's own test: host iff /^[a-z]/) — a
        // member like Foo.Bar, or a non-lowercase identifier. Skip Fragment (it
        // rejects unknown props) to avoid a dev-console warning.
        const isHost = name && name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name)
        const isFragment =
          name &&
          ((name.type === 'JSXIdentifier' && name.name === 'Fragment') ||
            (name.type === 'JSXMemberExpression' &&
              name.property &&
              name.property.name === 'Fragment'))
        const isComponent =
          !isHost &&
          !isFragment &&
          name &&
          (name.type === 'JSXMemberExpression' || name.type === 'JSXIdentifier')
        if (isComponent && !p.node.attributes.some(a => ['data-trezi-component-source', 'data-praxis-component-source'].includes(a.name?.name))) {
          p.node.attributes.unshift(
            t.jsxAttribute(t.jsxIdentifier('data-trezi-component-source'), t.stringLiteral(where))
          )
        }
      }
    }
  }
}
`
