import { join } from 'node:path'
import ts from 'typescript'
import type { PropField } from '../shared/api'

/** Resolve the instantiated JSX signature, including imported/inherited/generic
 * props. No source changes are required. Fresh programs avoid stale schemas after
 * HMR edits (including changes to imported aliases). Used only after docgen fails. */
export function typescriptProps(
  root: string,
  file: string,
  line: number,
  column: number
): PropField[] {
  try {
    const configPath = ts.findConfigFile(root, ts.sys.fileExists)
    const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : {}
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root)
    const program = ts.createProgram([file], {
      ...parsed.options,
      noEmit: true,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      // Resolve React's JSX namespace in JS fixtures too.
      types: parsed.options.types ?? ['react'],
      typeRoots: parsed.options.typeRoots ?? [join(root, 'node_modules/@types')]
    })
    const source = program.getSourceFile(file)
    if (!source) return []
    const offset = source.getPositionOfLineAndCharacter(line - 1, column)
    let opening: ts.JsxOpeningLikeElement | undefined
    const walk = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.getStart(source) === offset
      ) {
        opening = node
      }
      if (!opening) ts.forEachChild(node, walk)
    }
    walk(source)
    if (!opening) return []
    const checker = program.getTypeChecker()
    const signature = checker.getResolvedSignature(opening)
    const props = signature?.parameters[0]
    if (!props) return []
    const type = checker.getTypeOfSymbolAtLocation(props, opening)
    return checker
      .getPropertiesOfType(type)
      .filter((symbol) => /^[A-Za-z_$][\w$-]*$/.test(symbol.name))
      .map((symbol): PropField => {
        const base = {
          name: symbol.name,
          fromSchema: true,
          required: !(symbol.flags & ts.SymbolFlags.Optional)
        }
        const value = checker.getTypeOfSymbolAtLocation(symbol, opening!)
        const parts = (value.isUnion() ? value.types : [value]).filter(
          (part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))
        )
        if (parts.length && parts.every((part) => part.isStringLiteral())) {
          return {
            ...base,
            kind: 'enum',
            options: parts.map((part) => (part as ts.StringLiteralType).value)
          }
        }
        const all = (flags: ts.TypeFlags) =>
          parts.length > 0 && parts.every((part) => Boolean(part.flags & flags))
        return {
          ...base,
          kind: all(ts.TypeFlags.StringLike)
            ? 'string'
            : all(ts.TypeFlags.NumberLike)
              ? 'number'
              : all(ts.TypeFlags.BooleanLike)
                ? 'boolean'
                : 'other'
        }
      })
  } catch {
    return []
  }
}
