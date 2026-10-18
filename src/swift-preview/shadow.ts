import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Trezi-owned shadow of a project (LKM-275). `xcodebuild` and SwiftPM write state of
 * their own next to what they read (`project.xcworkspace/xcshareddata/swiftpm`,
 * `<package>/.swiftpm`, `Package.resolved`), even with the scratch and derived data
 * paths elsewhere. Removing it afterwards is still a write to the user's repository,
 * so no such tool runs there: it runs in a shadow under Trezi's derived data, where
 * the project's folders are symlinks, the `.xcodeproj` and `.xcworkspace` bundles are
 * copies, and every Swift package folder is a real folder holding symlinks to its
 * entries plus copies of `Package.swift` and `Package.resolved`. A tool can create
 * files only inside those copies and folders. The tool's output names shadow paths;
 * `map` turns them back into the project's.
 *
 * The shadow keeps the layout of the real paths below their common ancestor, so
 * relative references (`../Shared` packages, `group:` workspace entries) resolve.
 * Entries outside it do not exist in the shadow.
 */
export interface ShadowSpec {
  /** The project folder: mirrored with symlinks. */
  root: string
  /** Bundles or files copied: `.xcodeproj`, `.xcworkspace`. */
  copies?: string[]
  /** Swift package folders; the local packages their manifests reference come along. */
  packages?: string[]
}

type Kind = 'path' | 'tree' | 'package' | 'copy'
interface Node {
  kind: Kind
  children: Map<string, Node>
}

/** Never mirrored: tool state and history. */
const SKIP = new Set(['.git', '.build', '.swiftpm'])
/** A package's files its tools may write: copied instead of linked. */
const OWN = new Set(['Package.swift', 'Package.resolved'])
const BUNDLES =
  /\.(xcodeproj|xcworkspace|xcassets|xcframework|framework|app|bundle|playground|lproj)$/
const MAX_SCAN = 4_000

/** Absolute folders of the local packages a manifest references (`.package(path: …)`). */
function localDependencies(dir: string): string[] {
  let text: string
  try {
    text = readFileSync(join(dir, 'Package.swift'), 'utf8')
  } catch {
    return []
  }
  return [...text.matchAll(/\.package\s*\([^)]*?\bpath:\s*"([^"]+)"/g)].map((m) =>
    resolve(dir, m[1])
  )
}

/** The packages and, transitively, the local packages they reference. */
export function withLocalDependencies(dirs: string[]): string[] {
  const found = new Set<string>()
  const queue = dirs.map((d) => resolve(d))
  while (queue.length && found.size < 64) {
    const dir = queue.shift() as string
    if (found.has(dir)) continue
    found.add(dir)
    for (const dep of localDependencies(dir))
      if (existsSync(join(dep, 'Package.swift'))) queue.push(dep)
  }
  return [...found]
}

/** Every folder with a `Package.swift` in the project (bounded; no hidden or generated folders). */
export function findPackageDirs(root: string): string[] {
  const found: string[] = []
  let visited = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || visited++ > MAX_SCAN) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    if (names.includes('Package.swift')) found.push(dir)
    for (const name of names.sort()) {
      if (
        name.startsWith('.') ||
        BUNDLES.test(name) ||
        ['node_modules', 'Pods', 'Carthage', 'DerivedData', 'build'].includes(name)
      )
        continue
      const path = join(dir, name)
      try {
        if (statSync(path).isDirectory()) walk(path, depth + 1)
      } catch {}
    }
  }
  walk(resolve(root), 0)
  return found
}

/** The package folders a tool run must not reach: the project's, and those it references. */
export function packageDirs(
  root: string,
  refs: { kind: string; path?: string }[] = [],
  scanned: string[] = findPackageDirs(root)
): string[] {
  const referenced = refs
    .filter((r) => r.kind === 'local' && r.path)
    .map((r) => (isAbsolute(r.path as string) ? (r.path as string) : join(root, r.path as string)))
    .filter((dir) => existsSync(join(dir, 'Package.swift')))
  return [...new Set([...scanned, ...referenced.map((d) => resolve(d))])]
}

/** What an xcodebuild run on a project or workspace needs in its shadow. */
export function xcodeSpec(
  root: string,
  container: { kind: string; path: string; projects?: string[] },
  packages: string[]
): ShadowSpec {
  const projects = container.kind === 'workspace' ? (container.projects ?? []) : []
  return { root, copies: [container.path, ...projects].map((p) => join(root, p)), packages }
}

function commonDir(paths: string[]): string {
  const split = paths.map((p) => resolve(p).split(sep).filter(Boolean))
  const first = split[0] ?? []
  let length = first.length
  for (const parts of split) {
    let i = 0
    while (i < length && i < parts.length && parts[i] === first[i]) i++
    length = i
  }
  return sep + first.slice(0, length).join(sep)
}

export class Shadow {
  /** The shadow of `spec.root`: where a tool runs. */
  readonly root: string
  private readonly ancestor: string
  private readonly tree: Node = { kind: 'path', children: new Map() }

  constructor(
    /** Trezi's folder holding the whole shadow; created fresh and removed by `remove`. */
    readonly dir: string,
    spec: ShadowSpec
  ) {
    const root = resolve(spec.root)
    const packages = withLocalDependencies(spec.packages ?? [])
    const copies = (spec.copies ?? []).map((c) => resolve(c))
    // Above the root and every package: they keep their own folder names (SwiftPM derives
    // a local package's identity from its folder name).
    this.ancestor = commonDir([root, ...packages, ...copies].map((p) => dirname(p)))
    this.root = this.of(root)
    this.mark(root, 'tree')
    for (const dir of packages) this.mark(dir, 'package')
    for (const copy of copies) this.mark(copy, 'copy')
  }

  /** The shadow path of a real one. */
  of(real: string): string {
    return join(this.dir, relative(this.ancestor, resolve(real)))
  }

  private mark(path: string, kind: Kind) {
    let node = this.tree
    for (const name of relative(this.ancestor, path).split(sep).filter(Boolean)) {
      if (!node.children.has(name)) node.children.set(name, { kind: 'path', children: new Map() })
      node = node.children.get(name) as Node
    }
    if (kind === 'package' || node.kind === 'path' || kind === 'copy') node.kind = kind
  }

  create() {
    rmSync(this.dir, { recursive: true, force: true })
    this.populate(this.tree, this.ancestor, this.dir, ['tree', 'package'].includes(this.tree.kind))
  }

  private populate(node: Node, real: string, shadow: string, full: boolean) {
    mkdirSync(shadow, { recursive: true })
    if (full)
      for (const entry of readdirSync(real)) {
        if (node.children.has(entry) || SKIP.has(entry)) continue
        const from = join(real, entry)
        if (node.kind === 'package' && OWN.has(entry)) cpSync(from, join(shadow, entry))
        else symlinkSync(from, join(shadow, entry))
      }
    for (const [name, child] of node.children) {
      const from = join(real, name)
      if (!existsSync(from)) continue
      if (child.kind === 'copy') cpSync(from, join(shadow, name), { recursive: true })
      else
        this.populate(
          child,
          from,
          join(shadow, name),
          full || ['tree', 'package'].includes(child.kind)
        )
    }
  }

  /** Text from a tool run with the shadow's paths replaced by the real ones. */
  map(text: string): string {
    if (!text) return text
    const names = new Set([this.dir])
    try {
      names.add(realpathSync(this.dir))
    } catch {}
    const real = this.ancestor === sep ? '' : this.ancestor
    // The longer first: `/private/var/…` contains `/var/…`.
    return [...names]
      .sort((a, b) => b.length - a.length)
      .reduce((out, name) => out.split(name).join(real), text)
  }

  remove() {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

let counter = 0

/** Drops shadows a crashed run left behind (Trezi's own folder, never the project). */
function sweep(base: string) {
  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return
  }
  for (const name of names)
    try {
      if (Date.now() - statSync(join(base, name)).mtimeMs > 6 * 3_600_000)
        rmSync(join(base, name), { recursive: true, force: true })
    } catch {}
}

/** A shadow in `<cacheDir>/shadow/`, removed when `run` ends, however it ends. */
export async function withShadow<T>(
  cacheDir: string,
  spec: ShadowSpec,
  run: (shadow: Shadow) => Promise<T>
): Promise<T> {
  const base = join(cacheDir, 'shadow')
  sweep(base)
  const shadow = new Shadow(
    join(base, `${process.pid}-${Date.now().toString(36)}-${counter++}`),
    spec
  )
  try {
    shadow.create()
    return await run(shadow)
  } finally {
    shadow.remove()
  }
}

interface ToolResult {
  code: number | null
  stdout: string
  stderr: string
  error: string
}

/**
 * Runs a tool in a shadow (`run` gets the shadow of `spec.root` as its working folder)
 * and returns its result with shadow paths mapped back. When the shadow cannot be made
 * the tool does not run, and the error says so: the project is never the fallback.
 */
export async function runInShadow(
  cacheDir: string,
  spec: ShadowSpec,
  run: (cwd: string, shadow: Shadow) => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await withShadow(cacheDir, spec, async (shadow) => {
      const result = await run(shadow.root, shadow)
      return {
        ...result,
        stdout: shadow.map(result.stdout),
        stderr: shadow.map(result.stderr),
        error: shadow.map(result.error)
      }
    })
  } catch (error) {
    return {
      code: null,
      stdout: '',
      stderr: '',
      error: `Trezi could not prepare its shadow copy of the project (the project itself is never used to run build tools): ${(error as Error).message}`
    }
  }
}
