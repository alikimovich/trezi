import ts from 'typescript'
import { lexLiteral, locateAnchor } from '../main/control-manifest'
import type { ControlParam } from '../shared/api'

/** Conservative readback family: a top-level numeric const directly sets one
 * top-level created element's opacity, whose literal id is the declared selector.
 * Arbitrary expressions, aliases and JSX have no proven source-to-DOM link. */
export function linkedOpacityLine(code: string, file: string, param: ControlParam): number | null {
  if (
    !/\.[cm]?jsx?$/.test(file) ||
    param.apply.strategy !== 'literal' ||
    param.kind !== 'number' ||
    param.rendered?.property !== 'opacity' ||
    !/^#[A-Za-z][\w-]*$/.test(param.rendered.selector)
  )
    return null
  const anchor = locateAnchor(code, param.apply.anchor)
  if ('error' in anchor) return null
  const literal = lexLiteral(code, anchor.at, 'number')
  if (!literal || Number(literal.raw) < 0 || Number(literal.raw) > 1) return null
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const statements = source.statements
  const chain = (node: ts.Node, names: string[]): boolean => {
    let cursor = node
    for (let i = names.length - 1; i > 0; i--) {
      if (!ts.isPropertyAccessExpression(cursor) || cursor.name.text !== names[i]) return false
      cursor = cursor.expression
    }
    return ts.isIdentifier(cursor) && cursor.text === names[0]
  }
  const assignments = statements.flatMap((statement) =>
    ts.isExpressionStatement(statement) &&
    ts.isBinaryExpression(statement.expression) &&
    statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? [statement.expression]
      : []
  )
  const allAssignments: ts.BinaryExpression[] = []
  const allDeclarations: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      allAssignments.push(node)
    if (ts.isVariableDeclaration(node)) allDeclarations.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const declarations = statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations].map((decl) => ({
          decl,
          isConst: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
        }))
      : []
  )
  const bound = declarations.filter(
    ({ decl, isConst }) =>
      isConst &&
      ts.isIdentifier(decl.name) &&
      decl.initializer?.getStart(source) === literal.start &&
      decl.initializer.getEnd() === literal.end &&
      ts.isNumericLiteral(decl.initializer)
  )
  if (bound.length !== 1) return null
  const name = (bound[0].decl.name as ts.Identifier).text
  // A second declaration or assignment can shadow/change the constant.
  if (
    allDeclarations.filter((decl) => ts.isIdentifier(decl.name) && decl.name.text === name)
      .length !== 1 ||
    allAssignments.some((entry) => ts.isIdentifier(entry.left) && entry.left.text === name)
  )
    return null
  const selectorId = param.rendered.selector.slice(1)
  const targets = declarations.filter(
    ({ decl, isConst }) =>
      isConst &&
      ts.isIdentifier(decl.name) &&
      !!decl.initializer &&
      ts.isCallExpression(decl.initializer) &&
      chain(decl.initializer.expression, ['document', 'createElement']) &&
      decl.initializer.arguments.length === 1 &&
      ts.isStringLiteral(decl.initializer.arguments[0])
  )
  const linked = targets.filter(({ decl }) => {
    const variable = (decl.name as ts.Identifier).text
    const ids = allAssignments.filter((entry) => chain(entry.left, [variable, 'id']))
    const opacities = allAssignments.filter((entry) =>
      chain(entry.left, [variable, 'style', 'opacity'])
    )
    return (
      ids.length === 1 &&
      ts.isStringLiteral(ids[0].right) &&
      ids[0].right.text === selectorId &&
      assignments.includes(ids[0]) &&
      opacities.length === 1 &&
      assignments.includes(opacities[0]) &&
      ts.isIdentifier(opacities[0].right) &&
      opacities[0].right.text === name &&
      // No second declaration or direct reassignment may replace the target.
      allDeclarations.filter((other) => ts.isIdentifier(other.name) && other.name.text === variable)
        .length === 1 &&
      !allAssignments.some((entry) => ts.isIdentifier(entry.left) && entry.left.text === variable)
    )
  })
  if (linked.length !== 1) return null
  return source.getLineAndCharacterOfPosition(linked[0].decl.getStart(source)).line + 1
}
