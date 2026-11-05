import ts from 'typescript'
import { lexLiteral, locateAnchor } from '../main/control-manifest'
import type { ControlParam } from '../shared/api'

/** A deliberately small single-writer subset. Every reference to the created
 * element must be a known top-level write or its final append. This rejects
 * aliases, callbacks and later style mutations we cannot attribute to the literal. */
export function linkedOpacityStamp(code: string, file: string, param: ControlParam): string | null {
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
  const created = new Set(targets.map(({ decl }) => (decl.name as ts.Identifier).text))
  // Do not claim a single writer in a file that can obtain the element by a
  // selector, pass it through another API, or hide an assignment in a callback.
  if (allAssignments.length !== assignments.length) return null
  const supportedFile = statements.every((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.every((decl) => {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) return false
        const value = decl.initializer
        return (
          created.has(decl.name.text) ||
          ts.isNumericLiteral(value) ||
          ts.isStringLiteral(value) ||
          (ts.isArrayLiteralExpression(value) &&
            value.elements.every(
              (item) =>
                ts.isNumericLiteral(item) ||
                (ts.isPrefixUnaryExpression(item) && ts.isNumericLiteral(item.operand))
            )) ||
          (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand))
        )
      })
    }
    if (!ts.isExpressionStatement(statement)) return false
    const expression = statement.expression
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return [...created].some(
        (name) =>
          (chain(expression.left, [name, 'id']) && ts.isStringLiteral(expression.right)) ||
          chain(expression.left, [name, 'textContent']) ||
          chain(expression.left, [name, 'style', 'boxShadow']) ||
          (chain(expression.left, [name, 'style', 'cssText']) &&
            ts.isStringLiteral(expression.right) &&
            !/opacity/i.test(expression.right.text)) ||
          chain(expression.left, [name, 'style', 'opacity'])
      )
    }
    if (!ts.isCallExpression(expression)) return false
    return [...created].some(
      (name) =>
        (chain(expression.expression, [name, 'setAttribute']) &&
          expression.arguments.length === 2 &&
          ts.isStringLiteral(expression.arguments[0]) &&
          expression.arguments[0].text === 'data-trezi-source' &&
          ts.isStringLiteral(expression.arguments[1])) ||
        ((chain(expression.expression, ['document', 'body', 'append']) ||
          chain(expression.expression, ['document', 'body', 'appendChild'])) &&
          expression.arguments.length === 1 &&
          ts.isIdentifier(expression.arguments[0]) &&
          expression.arguments[0].text === name)
    )
  })
  if (!supportedFile) return null
  const linked = targets.filter(({ decl }) => {
    const variable = (decl.name as ts.Identifier).text
    const ids = allAssignments.filter((entry) => chain(entry.left, [variable, 'id']))
    const opacities = allAssignments.filter((entry) =>
      chain(entry.left, [variable, 'style', 'opacity'])
    )
    const direct =
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
    if (!direct) return false
    const creation = source.getLineAndCharacterOfPosition(decl.parent.parent.getStart(source))
    const stamp = `${file}:${creation.line + 1}:${creation.character + 1}`
    let appendCount = 0
    let stampCount = 0
    let safe = true
    const inspect = (node: ts.Node) => {
      if (!safe) return
      if (ts.isIdentifier(node) && node.text === variable && node !== decl.name) {
        let cursor: ts.Node = node
        while (cursor.parent && !ts.isSourceFile(cursor.parent)) cursor = cursor.parent
        if (!ts.isExpressionStatement(cursor)) {
          safe = false
          return
        }
        const expression = cursor.expression
        if (
          ts.isBinaryExpression(expression) &&
          expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const left = expression.left
          const safeProperty =
            expression === ids[0] ||
            expression === opacities[0] ||
            chain(left, [variable, 'textContent']) ||
            chain(left, [variable, 'style', 'boxShadow']) ||
            (chain(left, [variable, 'style', 'cssText']) &&
              ts.isStringLiteral(expression.right) &&
              !/opacity/i.test(expression.right.text))
          if (!safeProperty) safe = false
        } else if (ts.isCallExpression(expression)) {
          if (
            chain(expression.expression, [variable, 'setAttribute']) &&
            expression.arguments.length === 2 &&
            ts.isStringLiteral(expression.arguments[0]) &&
            expression.arguments[0].text === 'data-trezi-source' &&
            ts.isStringLiteral(expression.arguments[1]) &&
            expression.arguments[1].text === stamp
          )
            stampCount++
          else if (
            (chain(expression.expression, ['document', 'body', 'append']) ||
              chain(expression.expression, ['document', 'body', 'appendChild'])) &&
            expression.arguments.length === 1 &&
            expression.arguments[0] === node
          )
            appendCount++
          else safe = false
        } else safe = false
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
    return safe && appendCount === 1 && stampCount === 1
  })
  if (linked.length !== 1) return null
  const position = source.getLineAndCharacterOfPosition(
    linked[0].decl.parent.parent.getStart(source)
  )
  return `${position.line + 1}:${position.character + 1}`
}
