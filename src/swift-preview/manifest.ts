import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

/**
 * `trezi-previews.json`: what the Swift preview host compiles (LKM-271). `sources` are
 * the component files, `previews` the files declaring `TreziPreviews.all`, both paths
 * (files or folders) relative to the project root; `exclude` skips paths such as the
 * app's `@main` entry. Pure helpers: no process, no clock.
 */
export interface PreviewManifest {
  name: string
  sources: string[]
  previews: string[]
  exclude: string[]
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
    exclude: paths(fields.exclude, 'exclude', false)
  }
}

/**
 * Every `.swift` file under the manifest's paths, sorted and de-duplicated. Symlinks
 * are not followed, so nothing outside the project is compiled.
 */
export function collectSources(root: string, manifest: PreviewManifest): string[] {
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
  for (const path of [...manifest.sources, ...manifest.previews]) visit(join(root, path), 0)
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

/** The `xcrun` arguments compiling the host runtime with the project's files. */
export function hostCompileArgs(options: {
  host: string
  sources: string[]
  moduleCache: string
  output: string
}): string[] {
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
    '-o',
    options.output,
    options.host,
    ...options.sources
  ]
}
