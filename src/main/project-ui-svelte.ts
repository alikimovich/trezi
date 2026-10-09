import { basename } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'
import type { UiComponent } from './project-ui-catalog'

// Deliberately stricter than the best-effort prop editor: a composition must know
// every input contract. Never execute project code or load project preprocessors.
function literal(node: ts.Expression): string | number | boolean | undefined {
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text)
}
function schema(type?: ts.TypeNode, init?: ts.Expression): z.ZodType | undefined {
  if (!type && init) {
    const value = literal(init)
    if (typeof value === 'string') return z.string().max(4000)
    if (typeof value === 'number') return z.number().finite()
    if (typeof value === 'boolean') return z.boolean()
  }
  if (type?.kind === ts.SyntaxKind.StringKeyword) return z.string().max(4000)
  if (type?.kind === ts.SyntaxKind.NumberKeyword) return z.number().finite()
  if (type?.kind === ts.SyntaxKind.BooleanKeyword) return z.boolean()
  if (type && (ts.isUnionTypeNode(type) || ts.isLiteralTypeNode(type))) {
    const types = ts.isUnionTypeNode(type) ? type.types : [type]
    const values = types.map((t) => (ts.isLiteralTypeNode(t) ? literal(t.literal) : undefined))
    if (values.every((v) => v !== undefined))
      return z.literal(values as [string | number | boolean, ...(string | number | boolean)[]])
  }
}
export async function discoverSvelteComponent(file: string, code: string): Promise<UiComponent> {
  const { parse, compile } = await import('svelte/compiler')
  // Compilation checks snippet/slot/rune semantics as well as parseability.
  compile(code, { filename: file, generate: 'server' })
  const ast = parse(code, { modern: true })
  const content = ast.instance?.content as
    | (import('estree').Program & { start: number; end: number })
    | undefined
  const script = content ? code.slice(content.start, content.end) : ''
  const source = ts.createSourceFile(
    `${file}.ts`,
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const fail = (reason: string): never => {
    throw new Error(reason)
  }
  const props: Record<string, z.ZodType> = {}
  let children = false,
    childrenRequired = false,
    runes = false
  const snippetNames = new Set<string>()
  for (const stmt of source.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === 'svelte'
    ) {
      const bindings = stmt.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements)
          if ((item.propertyName?.text ?? item.name.text) === 'Snippet')
            snippetNames.add(item.name.text)
    }
  }
  const add = (name: string, type?: ts.TypeNode, init?: ts.Expression, optional = false) => {
    if (!/^[A-Za-z][\w]*$/.test(name) || name === 'constructor' || name === 'prototype')
      fail(`Unsupported prop name ${name}`)
    if (
      name === 'children' &&
      runes &&
      type &&
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      snippetNames.has(type.typeName.text) &&
      (!type.typeArguments?.length ||
        (type.typeArguments.length === 1 &&
          ts.isTupleTypeNode(type.typeArguments[0]) &&
          !type.typeArguments[0].elements.length))
    ) {
      if (init) fail('children snippet defaults need an adapter')
      children = true
      childrenRequired = !optional
      return
    }
    const field = schema(type, init)
    if (!field) return fail(`Prop ${name} needs a nonliteral or unresolved type adapter`)
    props[name] = init || optional ? field.optional() : field
  }
  let propsCalls = 0
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === '$props'
    )
      propsCalls++
    if (ts.isIdentifier(node) && ['$$props', '$$restProps', '$$slots'].includes(node.text))
      fail('Dynamic props/slots need an adapter')
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const stmt of source.statements) {
    if (ts.isExportDeclaration(stmt)) fail('Re-exported props need an adapter')
    if (!ts.isVariableStatement(stmt)) continue
    const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    for (const d of stmt.declarationList.declarations) {
      if (exported) {
        if (!(stmt.declarationList.flags & ts.NodeFlags.Let) || !ts.isIdentifier(d.name))
          fail('Only export let props are supported')
        add((d.name as ts.Identifier).text, d.type, d.initializer)
      }
      if (
        !d.initializer ||
        !ts.isCallExpression(d.initializer) ||
        d.initializer.expression.getText(source) !== '$props'
      )
        continue
      runes = true
      if (propsCalls !== 1 || !ts.isObjectBindingPattern(d.name))
        fail('Use a single destructured $props() declaration')
      let type = d.type
      if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
        const name = type.typeName.text
        const declaration = source.statements.find(
          (s) =>
            (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name.text === name
        )
        if (
          declaration &&
          ts.isInterfaceDeclaration(declaration) &&
          !declaration.heritageClauses &&
          !declaration.typeParameters
        )
          type = ts.factory.createTypeLiteralNode(declaration.members)
        else if (
          declaration &&
          ts.isTypeAliasDeclaration(declaration) &&
          !declaration.typeParameters
        )
          type = declaration.type
      }
      if (type && !ts.isTypeLiteralNode(type))
        fail('Props type must be a local literal interface/type')
      const members = new Map<string, ts.PropertySignature>()
      if (type && ts.isTypeLiteralNode(type))
        for (const member of type.members) {
          if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name))
            fail('Props index signatures/methods need an adapter')
          members.set((member.name as ts.Identifier).text, member as ts.PropertySignature)
        }
      for (const item of (d.name as ts.ObjectBindingPattern).elements) {
        if (
          item.dotDotDotToken ||
          !ts.isIdentifier(item.name) ||
          (item.propertyName && !ts.isIdentifier(item.propertyName))
        )
          fail('Rest or nested props need an adapter')
        const name = (item.propertyName ?? item.name).getText(source)
        const member = members.get(name)
        if (type && !member) fail(`Missing type for prop ${name}`)
        add(name, member?.type, item.initializer, !!member?.questionToken)
        members.delete(name)
      }
      if (members.size) fail('All declared Props members must be destructured')
    }
  }
  if (propsCalls && !runes) fail('Use destructured $props()')
  // Inspect parsed markup, not strings/comments, to recognize default composition.
  type MarkupNode = {
    type?: string
    name?: string
    attributes?: unknown[]
    expression?: MarkupNode
    callee?: MarkupNode
    arguments?: unknown[]
  }
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    const node = value as MarkupNode
    if (
      node.type === 'Identifier' &&
      ['$$props', '$$restProps', '$$slots'].includes(node.name ?? '')
    )
      fail('Dynamic props/slots need an adapter')
    if (node.type === 'SlotElement') {
      if (node.attributes?.length) fail('Named slots or slot props need an adapter')
      children = true
    }
    if (node.type === 'RenderTag') {
      const call =
        node.expression?.type === 'ChainExpression' ? node.expression.expression : node.expression
      if (
        call?.type !== 'CallExpression' ||
        call.callee?.name !== 'children' ||
        call.arguments?.length ||
        !children
      )
        fail('Only a zero-argument children snippet is supported')
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(walk)
      else if (child && typeof child === 'object') walk(child)
    }
  }
  walk(ast.fragment)
  return {
    name: basename(file, '.svelte'),
    file,
    exported: 'default',
    framework: 'svelte',
    description: `Svelte component from ${file}`,
    props,
    children,
    childrenRequired
  }
}
