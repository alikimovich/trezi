import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

/**
 * `trezi-previews.json`: what the Swift preview host compiles (LKM-271). `sources` are
 * the component files, `previews` the files declaring `TreziPreviews.all`, both paths
 * (files or folders) relative to the project root; `exclude` skips paths such as the
 * app's `@main` entry. `libraries` are separately built modules the sources import
 * (a Swift package's library target, such as Scraib's ScraibKit): each is compiled first
 * into its own module and dylib, then found with -I/-L/-l. Pure helpers: no process, no clock.
 */
export interface PreviewManifest {
  name: string
  sources: string[]
  previews: string[]
  exclude: string[]
  libraries: PreviewLibrary[]
}

export interface PreviewLibrary {
  /** The module name `import` uses. */
  name: string
  sources: string[]
}

export interface Diagnostic {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'note'
  message: string
}

/** Folders never compiled into the host: build output, packages and hidden folders. */
const SKIPPED_DIRS = new Set(['.build', 'DerivedData', 'node_modules', 'Pods', 'Carthage', 'build'])

function paths(value: unknown, field: string, required: boolean): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim()))
    throw new Error(`trezi-previews.json: "${field}" must be a list of paths.`)
  if (required && value.length === 0)
    throw new Error(`trezi-previews.json: "${field}" needs at least one path.`)
  return value.map((entry: string) => {
    const path = normalize(entry.trim()).replace(/[/\\]+$/, '')
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
      throw new Error(`trezi-previews.json: "${entry}" is outside the project.`)
    return path === '' ? '.' : path
  })
}

function libraries(value: unknown): PreviewLibrary[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('trezi-previews.json: "libraries" must be a list.')
  const names = new Set<string>()
  return value.map((entry: unknown) => {
    const fields = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name))
      throw new Error('trezi-previews.json: each library needs a unique module "name".')
    names.add(name)
    return { name, sources: paths(fields.sources, `libraries.${name}.sources`, true) }
  })
}

export function parseManifest(text: string): PreviewManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('trezi-previews.json is not valid JSON.')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('trezi-previews.json must contain an object.')
  const fields = raw as Record<string, unknown>
  return {
    name: typeof fields.name === 'string' ? fields.name : '',
    sources: paths(fields.sources, 'sources', true),
    previews: paths(fields.previews, 'previews', true),
    exclude: paths(fields.exclude, 'exclude', false),
    libraries: libraries(fields.libraries)
  }
}

/**
 * Every `.swift` file under the manifest's paths, sorted and de-duplicated. Symlinks
 * are not followed, so nothing outside the project is compiled.
 */
export function collectSources(
  root: string,
  manifest: PreviewManifest,
  from: string[] = [...manifest.sources, ...manifest.previews]
): string[] {
  const excluded = new Set(manifest.exclude.map((path) => join(root, path)))
  const found = new Set<string>()
  const visit = (path: string, depth: number) => {
    if (excluded.has(path) || depth > 24) return
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(path)
    } catch {
      return
    }
    if (stat.isFile() && path.endsWith('.swift')) found.add(path)
    if (!stat.isDirectory()) return
    for (const name of readdirSync(path).sort()) {
      if (name.startsWith('.') || SKIPPED_DIRS.has(name) || name.endsWith('.xcodeproj')) continue
      visit(join(path, name), depth + 1)
    }
  }
  for (const path of from) visit(join(root, path), 0)
  return [...found].sort()
}

const DIAGNOSTIC = /^(.+?):(\d+):(\d+): (error|warning|note): (.*)$/

/** swiftc's `file:line:col: severity: message` lines, paths relative to the project. */
export function parseDiagnostics(output: string, root: string): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC.exec(line.trimEnd())
    if (!match) continue
    const path = relative(root, match[1])
    found.push({
      file:
        path.startsWith('..') || isAbsolute(path) ? match[1].split('/').pop() || match[1] : path,
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as Diagnostic['severity'],
      message: match[5]
    })
  }
  return found
}

/** The `xcrun` arguments compiling a library module to `dir`/lib<name>.dylib and <name>.swiftmodule. */
export function libraryCompileArgs(options: {
  name: string
  sources: string[]
  moduleCache: string
  dir: string
}): string[] {
  return [
    '--sdk',
    'macosx',
    'swiftc',
    '-parse-as-library',
    '-Onone',
    '-emit-module',
    '-emit-library',
    '-module-name',
    options.name,
    '-module-cache-path',
    options.moduleCache,
    '-emit-module-path',
    join(options.dir, `${options.name}.swiftmodule`),
    '-o',
    join(options.dir, `lib${options.name}.dylib`),
    ...options.sources
  ]
}

/** The `xcrun` arguments compiling the host runtime with the project's files. */
export function hostCompileArgs(options: {
  host: string
  sources: string[]
  moduleCache: string
  output: string
  /** Built library modules: the directory holding <name>.swiftmodule and lib<name>.dylib. */
  libraries?: { name: string; dir: string }[]
}): string[] {
  const linked = (options.libraries ?? []).flatMap(({ name, dir }) => [
    '-I',
    dir,
    '-L',
    dir,
    `-l${name}`,
    '-Xlinker',
    '-rpath',
    '-Xlinker',
    dir
  ])
  return [
    '--sdk',
    'macosx',
    'swiftc',
    '-parse-as-library',
    '-Onone',
    '-module-name',
    'TreziPreviewHost',
    '-module-cache-path',
    options.moduleCache,
    ...linked,
    '-o',
    options.output,
    options.host,
    ...options.sources
  ]
}
