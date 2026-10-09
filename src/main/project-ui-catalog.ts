import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'
import { discoverSvelteComponent } from './project-ui-svelte'

export interface UiComponent {
  name: string
  framework?: 'react' | 'svelte'
  file: string
  exported: string
  description: string
  props: Record<string, z.ZodType>
  children: boolean
  childrenRequired: boolean
}
export interface ProjectUiCatalog {
  components: UiComponent[]
  styles: string[]
  warnings: string[]
}
const ignored = new Set([
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  'test',
  'tests',
  '__tests__',
  'public'
])
const identifier = /^[A-Z][A-Za-z0-9_]*$/

/** Bounded static discovery: never import or execute project code or follow symlinks. */
export async function discoverProjectUi(root: string): Promise<ProjectUiCatalog> {
  const result: ProjectUiCatalog = { components: [], styles: [], warnings: [] }
  const { parse, builtinResolvers, builtinImporters } = await import('react-docgen')
  let visited = 0
  let sources = 0
  let truncated = false
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 7) {
      truncated = true
      return
    }
    const entries = await readdir(join(root, dir), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 3000 || sources >= 150 || result.components.length >= 40) {
        truncated = true
        return
      }
      if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink()) continue
      const file = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(file, depth + 1)
        continue
      }
      if (!entry.isFile() || (await lstat(join(root, file))).size > 150_000) continue
      if (/\.(css|scss)$/.test(file) && result.styles.length < 12) {
        const css = await readFile(join(root, file), 'utf8')
        const tokens = [...css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)]
          .slice(0, 35)
          .map((m) => `${m[1]}: ${m[2].trim()}`)
        result.styles.push(`${file}${tokens.length ? `\n${tokens.join('\n')}` : ''}`)
      }
      if (!/\.(tsx|jsx|svelte)$/.test(file) || /\.(test|spec|stories)\./.test(file)) continue
      sources++
      const code = await readFile(join(root, file), 'utf8')
      if (file.endsWith('.svelte')) {
        if (!identifier.test(entry.name.slice(0, -7))) {
          result.warnings.push(
            `${file}: only capitalized reusable Svelte components are cataloged (routes are not components).`
          )
          continue
        }
        try {
          const component = await discoverSvelteComponent(file, code)
          while (
            ['Text', 'React', 'GeneratedComposition'].includes(component.name) ||
            result.components.some((c) => c.name === component.name)
          )
            component.name += '_'
          result.components.push(component)
        } catch (error) {
          result.warnings.push(
            `${file}: unsupported Svelte component; ${error instanceof Error ? error.message : String(error)}`
          )
        }
        continue
      }
      const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const exports = new Map<string, string>()
      for (const node of ast.statements) {
        if (
          ts.isExportDeclaration(node) &&
          !node.moduleSpecifier &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause)
        ) {
          for (const e of node.exportClause.elements)
            if (!e.isTypeOnly) exports.set(e.propertyName?.text ?? e.name.text, e.name.text)
        }
        if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression))
          exports.set(node.expression.text, 'default')
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
        if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
        const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
          exports.set(
            node.name?.text ?? 'DefaultComponent',
            isDefault ? 'default' : (node.name?.text ?? '')
          )
        }
        if (ts.isVariableStatement(node))
          for (const d of node.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) exports.set(d.name.text, d.name.text)
          }
      }
      let docs: ReturnType<typeof parse>
      try {
        docs = parse(code, {
          filename: file,
          resolver: new builtinResolvers.FindExportedDefinitionsResolver({ limit: 0 }),
          importer: builtinImporters.ignoreImporter,
          babelOptions: { babelrc: false, configFile: false }
        })
      } catch {
        continue
      }
      for (const doc of docs) {
        if (result.components.length >= 40) {
          truncated = true
          break
        }
        const localName = doc.displayName ?? (exports.size === 1 ? [...exports.keys()][0] : '')
        const exported = exports.get(localName)
        if (
          !exported ||
          !identifier.test(localName) ||
          (exported !== 'default' && !identifier.test(exported))
        )
          continue
        let name = localName
        while (
          ['Text', 'React', 'GeneratedComposition'].includes(name) ||
          result.components.some((c) => c.name === name)
        )
          name += '_'
        const props: Record<string, z.ZodType> = {}
        let children = false
        let childrenRequired = false
        let unsupported = false
        for (const [key, prop] of Object.entries(doc.props ?? {})) {
          if (key === 'children') {
            const childType = prop.tsType ?? prop.flowType ?? prop.type
            if (childType?.name === 'signature' || childType?.name === 'func') {
              if (prop.required) unsupported = true
            } else {
              children = true
              childrenRequired = !!prop.required && !prop.defaultValue
            }
            continue
          }
          if (
            !/^[a-zA-Z][\w-]*$/.test(key) ||
            key === 'ref' ||
            key === 'key' ||
            /^on[A-Z]/.test(key) ||
            key === 'dangerouslySetInnerHTML'
          ) {
            if (prop.required) unsupported = true
            continue
          }
          const type = (prop.tsType ?? prop.flowType ?? prop.type) as
            | { name?: string; value?: unknown; elements?: unknown }
            | undefined
          let field: z.ZodType | undefined
          if (type?.name === 'string') field = z.string().max(4000)
          if (type?.name === 'number') field = z.number().finite()
          if (type?.name === 'boolean') field = z.boolean()
          const values =
            type?.name === 'enum' ? type.value : type?.name === 'union' ? type.elements : undefined
          if (Array.isArray(values) && values.length > 0) {
            const literals: Array<string | number | boolean> = []
            for (const v of values) {
              const raw = (v as { value?: unknown }).value
              if (typeof raw !== 'string') break
              try {
                const value =
                  raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : JSON.parse(raw)
                if (['string', 'number', 'boolean'].includes(typeof value)) literals.push(value)
              } catch {
                /* Nonliteral unions need an adapter. */
              }
            }
            if (literals.length === values.length)
              field = z.literal(
                literals as [string | number | boolean, ...(string | number | boolean)[]]
              )
          }
          if (!field) {
            if (prop.required && !prop.defaultValue) unsupported = true
            continue
          }
          props[key] = prop.required && !prop.defaultValue ? field : field.optional()
        }
        if (unsupported) {
          result.warnings.push(`${file}: ${localName} needs a nonliteral prop adapter; skipped.`)
          continue
        }
        result.components.push({
          name,
          framework: 'react',
          file,
          exported,
          description: doc.description?.slice(0, 500) || `${localName} from ${file}`,
          props,
          childrenRequired,
          children
        })
      }
    }
  }
  await walk('', 0)
  if (truncated) result.warnings.push('Discovery limit reached; this is a partial catalog.')
  if (!result.components.length)
    result.warnings.push(
      'No supported React or Svelte components found. Use ordinary source editing for this project.'
    )
  return result
}
