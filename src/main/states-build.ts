import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { nextShim, SERVER_ONLY } from './states-shims'

/** The isolated runtime each state frame boots: mounts the component from the bundle. */
const FRAME = join(__dirname, '../..', 'src/preview/states-frame.ts')
/** The host caps a preview message at 16 MB; leave room for the states and the CSS. */
const MAX_BUNDLE = 12 * 1024 * 1024
const MAX_INLINE_ASSET = 2 * 1024 * 1024

export type Framework = 'next' | 'vite' | 'react'

/** Whether `name` sits in a node_modules folder `dir` resolves from. */
function installed(dir: string, name: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules', name, 'package.json'))) return true
    if (dirname(at) === at) return false
  }
}

export interface StatesPackage {
  /** The directory of the package.json that owns the component (a monorepo app, or the root). */
  dir: string
  framework: Framework
  /** next.config wires SVGR, so an `.svg` import is a component. */
  svgComponents: boolean
}

export interface StatesBuildInput {
  root: string
  source: string
  exportName: string
  provider?: { source: string; exportName: string } | null
}

export type StatesBuild =
  | { ok: true; code: string; css: string; inputs: string[]; notes: string[]; framework: Framework }
  | { ok: false; reason: string; inputs: string[] }

type BunLog = { level: string; message: string; position?: { file?: string; line?: number } | null }
type BunPluginBuilder = {
  onResolve(
    options: { filter: RegExp; namespace?: string },
    handle: (args: { path: string; importer: string }) => unknown
  ): void
  onLoad(
    options: { filter: RegExp; namespace?: string },
    handle: (args: { path: string }) => unknown
  ): void
}
type BunBuild = (options: Record<string, unknown>) => Promise<{
  success: boolean
  logs: BunLog[]
  outputs: { kind: string; path: string; text(): Promise<string> }[]
  metafile?: { inputs: Record<string, unknown> }
}>
type BunGlobal = {
  build: BunBuild
  resolveSync(specifier: string, from: string): string
  Transpiler: new (options: { loader: string }) => { scan(code: string): { exports: string[] } }
}
const bun = () => (globalThis as unknown as { Bun?: BunGlobal }).Bun

/** The package that owns `file`: the nearest package.json at or below the project root. */
export function statesPackage(root: string, file: string): StatesPackage {
  let dir = dirname(resolve(root, file))
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        const framework: Framework = deps.next ? 'next' : deps.vite ? 'vite' : 'react'
        const config = ['next.config.js', 'next.config.mjs', 'next.config.ts']
          .map((name) => join(dir, name))
          .find(existsSync)
        return {
          dir,
          framework,
          svgComponents: !!config && readFileSync(config, 'utf8').includes('@svgr/webpack')
        }
      } catch {}
    }
    if (relative(root, dir) === '' || relative(root, dir).startsWith('..')) break
    dir = dirname(dir)
  }
  return { dir: root, framework: 'react', svgComponents: false }
}

/** Public build-time variables only: what the framework would inline into browser code anyway. */
function publicEnv(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['.env', '.env.development', '.env.local', '.env.development.local']) {
    let text = ''
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const match = /^\s*(?:export\s+)?((?:NEXT_PUBLIC_|VITE_)[A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return out
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp'
}

function imageSize(bytes: Buffer, ext: string): { width?: number; height?: number } {
  if (ext === '.png' && bytes.length > 24)
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (ext === '.gif' && bytes.length > 10)
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (ext === '.svg') {
    const text = bytes.toString('utf8', 0, 2000)
    const width = Number(/\swidth=["'](\d+(?:\.\d+)?)/.exec(text)?.[1])
    const height = Number(/\sheight=["'](\d+(?:\.\d+)?)/.exec(text)?.[1])
    if (width && height) return { width, height }
  }
  return {}
}

/** An imported asset as the framework would hand it to the component: Next's static image
 * object, Vite's URL string, a raw string or an SVG component. */
function assetModule(
  file: string,
  query: string,
  pkg: StatesPackage,
  react: string,
  notes: Set<string>
) {
  const bytes = readFileSync(file)
  const ext = extname(file).toLowerCase()
  if (query === 'raw') return `export default ${JSON.stringify(bytes.toString('utf8'))}`
  const url =
    bytes.length <= MAX_INLINE_ASSET
      ? `data:${MIME[ext] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`
      : `/${relative(pkg.dir, file).split('\\').join('/')}`
  if (bytes.length > MAX_INLINE_ASSET)
    notes.add(`${relative(pkg.dir, file)} is large, so the states load it from the dev server.`)
  if (query === 'url' || query === 'inline') return `export default ${JSON.stringify(url)}`
  const svgComponent =
    ext === '.svg' && (query === 'react' || query === 'component' || pkg.svgComponents)
  if (svgComponent)
    return `import * as React from ${JSON.stringify(react)}
const src = ${JSON.stringify(url)}
export const ReactComponent = (props) => React.createElement('img', { src, alt: '', ...props })
export default ReactComponent`
  if (pkg.framework === 'next')
    return `export default ${JSON.stringify({ src: url, ...imageSize(bytes, ext), blurDataURL: url })}`
  return `export default ${JSON.stringify(url)}`
}

/** Aliases a vite.config declares with `path.resolve(__dirname, './src')` or `new URL('./src', import.meta.url)`. */
function viteAliases(dir: string): [string, string][] {
  const config = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']
    .map((name) => join(dir, name))
    .find(existsSync)
  if (!config) return []
  const text = readFileSync(config, 'utf8')
  const out: [string, string][] = []
  const pattern =
    /['"]?([@~#$][\w/-]*|[A-Za-z][\w-]*)['"]?\s*:\s*(?:path\.)?(?:resolve|join|fileURLToPath)\(\s*(?:__dirname\s*,\s*|new URL\(\s*)?['"](\.{0,2}\/?[^'"]*)['"]/g
  for (const match of text.matchAll(pattern)) out.push([match[1], resolve(dir, match[2])])
  return out
}

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']
const isProject = (path: string) => !path.split(/[\\/]/).includes('node_modules')
const SCRIPT = /\.[cm]?[jt]sx?$/
const loaderOf = (path: string) =>
  /\.tsx$/.test(path) ? 'tsx' : /\.[cm]?ts$/.test(path) ? 'ts' : /\.jsx$/.test(path) ? 'jsx' : 'jsx'
const SERVER_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use server['"]/

/** Project-relative, also when the bundler reports the real path of a symlinked root. */
function rel(root: string, file: string | undefined): string {
  if (!file) return ''
  if (!isAbsolute(file)) return file
  let real = root
  try {
    real = realpathSync(root)
  } catch {}
  const path = [relative(root, file), relative(real, file)].find((item) => !item.startsWith('..'))
  return path ?? file
}

/** One actionable sentence for a failed build: what is missing and what to do about it. */
function failure(root: string, pkg: StatesPackage, logs: BunLog[]): string {
  const error = logs.find((log) => log.level === 'error') ?? logs[0]
  if (!error) return 'Trezi could not build this component.'
  const where = error.position?.file
    ? ` (${rel(root, error.position.file)}${error.position.line ? `:${error.position.line}` : ''})`
    : ''
  const missing = /Could not resolve:? "([^"]+)"/.exec(error.message)?.[1]
  if (missing && !missing.startsWith('.') && !missing.startsWith('/'))
    return `"${missing}" is not installed${where}. Install the project's dependencies in ${rel(root, pkg.dir) || 'the project'} (for example \`bun install\`), then show states again.`
  if (missing) return `The import "${missing}" points to a file that does not exist${where}.`
  return `Trezi could not build this component${where}: ${error.message.split('\n')[0].slice(0, 240)}`
}

/** Build the component (and its provider) into one browser bundle with the project's own React,
 * styles and modules. Nothing is written to the project: the output stays in memory. */
export async function buildStates(input: StatesBuildInput): Promise<StatesBuild> {
  const Bun = bun()
  if (!Bun) return { ok: false, reason: 'Show states needs Trezi’s Bun runtime.', inputs: [] }
  const { root } = input
  const component = resolve(root, input.source)
  const pkg = statesPackage(root, input.source)
  const require = createRequire(join(pkg.dir, 'package.json'))
  const resolveFrom = (spec: string) => {
    try {
      return require.resolve(spec)
    } catch {
      return null
    }
  }
  // On disk first: without any node_modules, Bun's resolver would install a missing package from
  // the registry, and Show states never installs anything.
  const react = installed(pkg.dir, 'react') ? resolveFrom('react') : null
  const reactDom = installed(pkg.dir, 'react-dom')
    ? (resolveFrom('react-dom/client') ?? resolveFrom('react-dom'))
    : null
  if (!react || !reactDom)
    return {
      ok: false,
      reason: `React is not installed in ${rel(root, pkg.dir) || 'this project'}. Install the project's dependencies, then show states again.`,
      inputs: []
    }
  if (!existsSync(FRAME))
    return { ok: false, reason: 'Trezi’s states runtime is missing from this build.', inputs: [] }
  const provider = input.provider ? resolve(root, input.provider.source) : null
  const notes = new Set<string>()
  const shims = new Map<string, string>()
  const server: { spec: string; importer: string }[] = []
  const aliases = viteAliases(pkg.dir)
  const env = publicEnv(pkg.dir)
  const entry = [
    // First: the frame runtime guards the document before any project module evaluates.
    `import { mount } from ${JSON.stringify(FRAME)}`,
    `import * as React from ${JSON.stringify(react)}`,
    `import * as ReactDOM from ${JSON.stringify(reactDom)}`,
    `import * as Component from ${JSON.stringify(component)}`,
    provider ? `import * as Provider from ${JSON.stringify(provider)}` : 'const Provider = null',
    `mount({ React, ReactDOM, module: Component, exportName: ${JSON.stringify(input.exportName)}, provider: Provider, providerExport: ${JSON.stringify(input.provider?.exportName ?? null)} })`
  ].join('\n')
  const run = (cssModules: boolean) =>
    Bun.build({
      entrypoints: ['trezi-states-entry'],
      target: 'browser',
      format: 'esm',
      throw: false,
      metafile: true,
      jsx: { runtime: 'automatic', development: true },
      define: {
        'process.env.NODE_ENV': '"development"',
        ...Object.fromEntries(
          Object.entries(env).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])
        ),
        'import.meta.env': JSON.stringify({
          MODE: 'development',
          DEV: true,
          PROD: false,
          SSR: false,
          BASE_URL: '/',
          ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('VITE_')))
        })
      },
      plugins: [
        {
          name: 'trezi-states',
          setup(build: BunPluginBuilder) {
            build.onResolve({ filter: /^trezi-states-entry$/ }, () => ({
              path: 'entry',
              namespace: 'trezi'
            }))
            build.onLoad({ filter: /.*/, namespace: 'trezi' }, () => ({
              contents: entry,
              loader: 'js'
            }))
            // One React: every copy a package or shim asks for is the project's own.
            build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
              const path = resolveFrom(args.path)
              return path ? { path } : undefined
            })
            // A package's own Node fallback is stubbed quietly; the project importing one is not.
            build.onResolve({ filter: SERVER_ONLY }, (args) => {
              if (isProject(args.importer))
                server.push({ spec: args.path, importer: args.importer })
              return { path: args.path, namespace: 'trezi-server' }
            })
            build.onLoad({ filter: /.*/, namespace: 'trezi-server' }, () => ({
              contents: 'export default {}',
              loader: 'js'
            }))
            build.onResolve({ filter: /^(next(\/.*)?|client-only)$/ }, (args) => {
              let importer = ''
              try {
                importer = readFileSync(args.importer, 'utf8')
              } catch {}
              const shim = nextShim(args.path, react, importer)
              if (shim === null) return undefined
              // A font shim exports what its importer names, so each importer gets its own.
              const key = `${args.path}#${shims.size}`
              shims.set(key, shim)
              return { path: key, namespace: 'trezi-shim' }
            })
            build.onLoad({ filter: /.*/, namespace: 'trezi-shim' }, (args) => ({
              contents: shims.get(args.path) ?? 'export {}',
              loader: 'js'
            }))
            // Global stylesheets are already on the page the frames copy; only modules are scoped.
            build.onResolve({ filter: /\.(css|scss|sass|less|styl)(\?.*)?$/ }, (args) => {
              const module = /\.module\.\w+$/.test(args.path)
              if (module && cssModules && args.path.endsWith('.css') && isProject(args.importer))
                return undefined
              if (module)
                notes.add(
                  `${args.path} class names are kept as written; its rules are not compiled.`
                )
              return { path: args.path, namespace: module ? 'trezi-classes' : 'trezi-empty' }
            })
            build.onLoad({ filter: /.*/, namespace: 'trezi-empty' }, () => ({
              contents: '',
              loader: 'js'
            }))
            build.onLoad({ filter: /.*/, namespace: 'trezi-classes' }, () => ({
              contents:
                'export default new Proxy({}, { get: (_, key) => typeof key === "string" ? key : undefined })',
              loader: 'js'
            }))
            build.onResolve({ filter: /\?(react|url|raw|inline|component)$/ }, (args) => {
              const [spec, query] = args.path.split('?')
              let path: string | null = null
              try {
                path = Bun.resolveSync(spec, dirname(args.importer))
              } catch {}
              return path ? { path: `${path}?${query}`, namespace: 'trezi-asset' } : undefined
            })
            build.onLoad({ filter: /.*/, namespace: 'trezi-asset' }, (args) => {
              const at = args.path.lastIndexOf('?')
              return {
                contents: assetModule(
                  args.path.slice(0, at),
                  args.path.slice(at + 1),
                  pkg,
                  react,
                  notes
                ),
                loader: 'js'
              }
            })
            build.onLoad({ filter: /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/ }, (args) => ({
              contents: assetModule(args.path, '', pkg, react, notes),
              loader: 'js'
            }))
            // Aliases a tsconfig does not declare: vite.config ones, then `@/` as `src/`.
            build.onResolve({ filter: /^[@~#$]/ }, (args) => {
              if (!isProject(args.importer)) return undefined
              try {
                return { path: Bun.resolveSync(args.path, dirname(args.importer)) }
              } catch {}
              const candidates = aliases
                .filter(([key]) => args.path === key || args.path.startsWith(`${key}/`))
                .map(([key, target]) => join(target, args.path.slice(key.length)))
              if (args.path.startsWith('@/'))
                candidates.push(join(pkg.dir, 'src', args.path.slice(2)))
              for (const candidate of candidates)
                for (const path of [
                  candidate,
                  ...EXTENSIONS.map((ext) => candidate + ext),
                  ...EXTENSIONS.map((ext) => join(candidate, `index${ext}`))
                ])
                  if (extname(path) && existsSync(path)) return { path }
              return undefined
            })
            // A `'use server'` module is a set of server actions: the client gets callable stubs.
            build.onLoad({ filter: SCRIPT }, (args) => {
              if (!isProject(args.path)) return undefined
              const code = readFileSync(args.path, 'utf8')
              if (!SERVER_DIRECTIVE.test(code)) return undefined
              const exports = new Bun.Transpiler({ loader: loaderOf(args.path) }).scan(code).exports
              notes.add(`Server actions from ${rel(root, args.path)} do nothing in states.`)
              return {
                contents: exports
                  .map((name) =>
                    name === 'default'
                      ? 'export default async function action() {}'
                      : `export async function ${name}() {}`
                  )
                  .join('\n'),
                loader: 'js'
              }
            })
          }
        }
      ]
    })
  let result = await run(true)
  // A CSS module the bundler cannot compile (Tailwind `@apply`, Sass syntax) keeps its class
  // names instead of failing the whole render.
  if (!result.success && result.logs.some((log) => /\.css$/.test(log.position?.file ?? ''))) {
    notes.clear()
    result = await run(false)
  }
  const inputs = Object.keys(result.metafile?.inputs ?? {})
    .filter((path) => !/^[\w-]+:/.test(path))
    .map((path) => resolve(path))
    .filter((path) => isProject(path) && rel(root, path) !== path && path !== FRAME)
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  const watched = [...new Set([...inputs, component, ...(provider ? [provider] : [])].map(real))]
  if (server.length) {
    const first = server[0]
    const from = rel(root, first.importer)
    return {
      ok: false,
      inputs: watched,
      reason: `${from || input.source} imports "${first.spec}", which runs only on the server, so its component cannot render in the browser. Select a client component that receives this data as props, or keep the server work in the page and pass the result down.`
    }
  }
  if (!result.success)
    return { ok: false, reason: failure(root, pkg, result.logs), inputs: watched }
  const code = (await result.outputs.find((output) => output.kind === 'entry-point')?.text()) ?? ''
  const css = (
    await Promise.all(
      result.outputs.filter((output) => output.path.endsWith('.css')).map((output) => output.text())
    )
  ).join('\n')
  if (code.length + css.length > MAX_BUNDLE)
    return {
      ok: false,
      inputs: watched,
      reason: `This component's bundle is ${Math.round((code.length + css.length) / 1048576)} MB, too large to preview. Select a smaller component.`
    }
  return { ok: true, code, css, inputs: watched, notes: [...notes], framework: pkg.framework }
}
