import { lstat } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { z } from 'zod'
import { cancelControlComposition } from './controls-jev'
import { discoverProjectUi, type ProjectUiCatalog } from './project-ui-catalog'

export type ProjectUiEngine = 'agent' | 'jev'
const enabledSessions = new Map<string, ProjectUiEngine>()
const turns = new Map<string, object>()
const composing = new Map<string, AbortController>()
export function cancelProjectUi(key: string): void {
  cancelControlComposition(key)
  enabledSessions.delete(key)
  turns.delete(key)
  composing.get(key)?.abort()
  composing.delete(key)
}
export function setProjectUiEnabled(
  key: string,
  enabled: boolean,
  engine: ProjectUiEngine = 'agent'
): void {
  cancelProjectUi(key)
  if (enabled) {
    enabledSessions.set(key, engine)
    turns.set(key, {})
  } else enabledSessions.delete(key)
}
export const projectUiEnabled = (key: string): boolean => enabledSessions.has(key)

export function projectUiInstructions(enabled: boolean, engine: ProjectUiEngine = 'agent'): string {
  if (enabled && engine === 'jev')
    return `[Trezi UI composition: Jev for this turn]\nFor UI generation, call project_ui_catalog. Read project components and usage, then prepare concrete atomic candidates (id, description, element: {type, props}, optional root:false and resource for mutually exclusive alternatives). Supply actual copy and literal prop values. Call compose_project_ui with file, prompt (the user's UI request), and candidates. Jev MUST choose membership, ordering and layout; do not submit a prebuilt spec or substitute your own layout. Write the returned framework-correct source using ordinary edit tools and integrate with the page, preserving project styles/providers. If Jev fails or is incomplete, report that and do not silently fall back to another engine. Never install json-render in the target. Non-UI requests work normally.\n\n`
  return enabled
    ? `[Trezi UI composition: ON for this turn]\nFor UI generation, call project_ui_catalog, then compose_project_ui with a static json-render spec using the discovered components. Read their source and existing usage to preserve theme, providers, layout and styling conventions. Write the returned framework-correct source in your worktree and integrate it with the requested page using ordinary edit tools. Do not install json-render in the target project. These tools return source, not saved files. Preserve normal application logic; explain unsupported components or frameworks instead of inventing catalog entries. For non-UI requests work normally.\n\n`
    : '[Trezi UI composition: OFF for this turn. Do not use project_ui_catalog or compose_project_ui; use ordinary source editing.]\n\n'
}

const elementSchema = z
  .object({
    type: z.string(),
    props: z.record(z.string(), z.unknown()),
    children: z.array(z.string()).max(100)
  })
  .strict()
const specSchema = z
  .object({ root: z.string(), elements: z.record(z.string(), elementSchema) })
  .strict()

export async function buildCatalog(project: ProjectUiCatalog) {
  const { defineCatalog, defineSchema } = await import('@json-render/core')
  const schema = defineSchema((s) => ({
    spec: s.object({
      root: s.string(),
      elements: s.record(
        s.object({
          type: s.ref('catalog.components'),
          props: s.propsOf('catalog.components'),
          children: s.array(s.string())
        })
      )
    }),
    catalog: s.object({
      components: s.map({ props: s.zod(), description: s.string(), slots: s.array(s.string()) })
    })
  }))
  const components: Record<string, { props: z.ZodType; description: string; slots: string[] }> = {
    Text: {
      props: z.object({ text: z.string().max(4000) }).strict(),
      description: 'Plain text node, no wrapper or children.',
      slots: []
    }
  }
  for (const component of project.components) {
    if (component.name === 'Text')
      throw new Error('Component name Text is reserved for literal text.')
    components[component.name] = {
      props: z.object(component.props).strict(),
      slots: component.children ? ['default'] : [],
      description: `${component.description}. Framework: ${component.framework ?? 'react'}; output ${component.framework === 'svelte' ? '.svelte' : '.tsx'}. ${component.childrenRequired ? 'Requires children.' : component.children ? 'Accepts children.' : 'No children.'}`
    }
  }
  return defineCatalog(schema, { components })
}

export function validateProjectUiFile(file: string): 'react' | 'svelte' {
  if (
    !/^[\w./-]+\.(tsx|svelte)$/.test(file) ||
    file.startsWith('/') ||
    file
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '..' ||
          p.startsWith('.') ||
          ['node_modules', 'dist', 'build', 'out'].includes(p)
      )
  )
    throw new Error(
      'Choose a repo-relative .tsx or .svelte output file outside hidden/dependency/build directories.'
    )
  return file.endsWith('.svelte') ? 'svelte' : 'react'
}

export async function exportProjectUi(
  project: ProjectUiCatalog,
  input: unknown
): Promise<{ file: string; code: string }> {
  const args = z
    .object({ file: z.string().max(250), spec: specSchema })
    .strict()
    .parse(input)
  const framework = validateProjectUiFile(args.file)
  const keys = Object.keys(args.spec.elements)
  if (keys.length > 100) throw new Error('Use at most 100 elements.')
  const catalog = await buildCatalog(project)
  const validation = catalog.validate(args.spec)
  if (!validation.success)
    throw new Error(`Invalid composition: ${JSON.stringify(validation.error)}`)
  const components = new Map(project.components.map((c) => [c.name, c]))
  const visited = new Set<string>()
  function validate(key: string, depth: number): void {
    if (depth > 25 || visited.has(key))
      throw new Error(
        'Composition must be a tree, without cycles or shared nodes, at most 25 levels deep.'
      )
    const node = args.spec.elements[key]
    if (!node) throw new Error(`Missing element: ${key}`)
    visited.add(key)
    if (node.type === 'Text') {
      z.object({ text: z.string().max(4000) })
        .strict()
        .parse(node.props)
      if (node.children.length) throw new Error('Text cannot contain children.')
    } else {
      const component = components.get(node.type)
      if (!component) throw new Error(`Unknown component: ${node.type}`)
      if ((component.framework ?? 'react') !== framework)
        throw new Error(
          `${node.type} is ${component.framework ?? 'react'}; cannot compose it into ${framework} source.`
        )
      z.object(component.props).strict().parse(node.props)
      if (component.childrenRequired && !node.children.length)
        throw new Error(`${node.type} requires children.`)
      if (!component.children && node.children.length)
        throw new Error(`${node.type} does not accept children.`)
    }
    for (const child of node.children) validate(child, depth + 1)
  }
  validate(args.spec.root, 0)
  if (visited.size !== keys.length) throw new Error('Remove elements unreachable from the root.')
  const { collectUsedComponents } = await import('@json-render/codegen')
  const used = collectUsedComponents(args.spec)
  const imports = [...used]
    .filter((name) => name !== 'Text')
    .map((name) => {
      const c = components.get(name)
      if (!c) throw new Error(`Unknown component: ${name}`)
      if (c.file === args.file)
        throw new Error('Output cannot replace a component used by this composition.')
      let path = posix.relative(dirname(args.file), c.file).replace(/\.[jt]sx?$/, '')
      if (!path.startsWith('.')) path = `./${path}`
      return `import ${c.exported === 'default' ? name : `{ ${c.exported}${c.exported !== name ? ` as ${name}` : ''} }`} from ${JSON.stringify(path).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}`
    })
  const serialize = (value: unknown) =>
    JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
  function render(key: string, depth: number): string {
    const node = args.spec.elements[key]
    const indent = '  '.repeat(depth)
    if (node.type === 'Text') return `${indent}{${serialize(node.props.text)}}`
    // Expression serialization preserves literal text in JSX and Svelte markup.
    const props = Object.entries(node.props)
      .map(([key, value]) => ` ${key}={${serialize(value)}}`)
      .join('')
    return node.children.length
      ? `${indent}<${node.type}${props}>\n${node.children.map((c) => render(c, depth + 1)).join('\n')}\n${indent}</${node.type}>`
      : `${indent}<${node.type}${props} />`
  }
  const jsx = render(args.spec.root, framework === 'svelte' ? 0 : 3)
  if (framework === 'svelte') {
    const code = `<script>\n${imports.join('\n')}\n</script>\n\n${jsx}\n`
    const { compile } = await import('svelte/compiler')
    compile(code, { filename: args.file, generate: 'server' })
    return { file: args.file, code }
  }
  return {
    file: args.file,
    code: `import * as React from 'react'\n${imports.join('\n')}\n\nexport default function GeneratedComposition() {\n  return (\n    <React.Fragment>\n${jsx}\n    </React.Fragment>\n  )\n}\n`
  }
}

/** Read-only tools scoped to the provider's current worktree and explicit turn setting. */
export async function runProjectUiTool(
  root: string,
  key: string,
  action: string,
  args?: unknown,
  connectionId?: string
): Promise<unknown> {
  if (!projectUiEnabled(key))
    return { error: 'Experimental Gen UI is off. Enable it in Settings and send a new message.' }
  try {
    const engine = enabledSessions.get(key)
    const turn = turns.get(key)
    const assertCurrent = () => {
      if (!turn || turns.get(key) !== turn)
        throw new Error('UI composition turn changed or was cancelled. Send a new message.')
    }
    const project = await discoverProjectUi(root)
    assertCurrent()
    if (!projectUiEnabled(key) || enabledSessions.get(key) !== engine)
      throw new Error('UI composition setting changed. Send a new message.')
    if (action === 'project_ui_catalog') {
      const catalog = await buildCatalog(project)
      assertCurrent()
      return {
        engine: enabledSessions.get(key),
        prompt: catalog.prompt({
          customRules: [
            'Static compositions only. No actions, state, expressions or dynamic props. Use Text for literal text. Follow each component children constraint. Match the output extension to component framework (.tsx for React, .svelte for Svelte); never mix frameworks.'
          ]
        }),
        components: project.components.map(({ props: _props, ...c }) => c),
        styles: project.styles,
        warnings: project.warnings,
        guidance:
          'Read component implementations and current page usage. Export with compose_project_ui, then write and integrate the returned source using normal edit tools. Keep existing theme providers and styles.'
      }
    }
    if (action !== 'compose_project_ui') throw new Error('Unknown UI composition action.')
    if (!project.components.length) throw new Error(project.warnings.join(' '))
    const file = z.object({ file: z.string().max(250) }).parse(args).file
    validateProjectUiFile(file)
    let destination = root
    for (const segment of file.split('/')) {
      destination = join(destination, segment)
      try {
        if ((await lstat(destination)).isSymbolicLink())
          throw new Error('Output path must not traverse symlinks.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    assertCurrent()
    if (enabledSessions.get(key) === 'jev') {
      if (composing.has(key)) return { error: 'Jev is already composing for this chat.' }
      const controller = new AbortController()
      composing.set(key, controller)
      try {
        const { composeProjectUiWithJev } = await import('./project-ui-jev')
        const result = await composeProjectUiWithJev(project, args, {
          signal: controller.signal,
          connectionId
        })
        assertCurrent()
        return { ...result, saved: false, warnings: project.warnings }
      } finally {
        if (composing.get(key) === controller) composing.delete(key)
      }
    }
    const output = await exportProjectUi(project, args)
    assertCurrent()
    return {
      ...output,
      engine: 'agent',
      saved: false,
      warnings: project.warnings
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
