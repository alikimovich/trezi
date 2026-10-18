import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

/**
 * The sidecar writer (LKM-276): the only code that writes generated preview
 * declarations, configuration and choices, and only into Trezi's own folder for the
 * project (`<userData>/swift-previews/<hash>`, else its derived data), never into the
 * repo. It refuses a folder inside the project, a path that leaves the folder, and a
 * symlink anywhere on the way; it writes a file only when its content changed (so
 * module cache keys stay put), atomically through a temporary file, and removes files
 * of a generated set that are no longer generated.
 */
function real(path: string): string {
  let current = normalize(path)
  const rest: string[] = []
  while (!existsSync(current) && dirname(current) !== current) {
    rest.unshift(current.slice(dirname(current).length + 1))
    current = dirname(current)
  }
  return join(realpathSync(current), ...rest)
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export class SidecarWriter {
  readonly dir: string

  constructor(
    dir: string,
    private readonly projectRoot: string
  ) {
    if (!isAbsolute(dir))
      throw new Error(`Trezi's folder for generated previews must be absolute: ${dir}`)
    const resolved = real(dir)
    const root = real(projectRoot)
    if (inside(resolved, root) || inside(root, resolved))
      throw new Error(`Generated previews are never written inside the project (${dir}).`)
    this.dir = resolved
  }

  /** The absolute path of `rel`, after checking it stays in the folder through no symlink. */
  path(rel: string): string {
    const clean = normalize(rel)
    if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`))
      throw new Error(`A generated file must stay in Trezi's folder: ${rel}`)
    const target = join(this.dir, clean)
    let current = this.dir
    for (const part of clean.split(sep)) {
      current = join(current, part)
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error(`Refusing to write through the symlink ${current}.`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        break
      }
    }
    if (inside(target, real(this.projectRoot)))
      throw new Error(`Refusing to write into the project: ${target}`)
    return target
  }

  /** Writes `content` unless the file already holds it; true when it changed. */
  write(rel: string, content: string): boolean {
    const target = this.path(rel)
    try {
      if (readFileSync(target, 'utf8') === content) return false
    } catch {}
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, content)
    renameSync(temporary, target)
    return true
  }

  read(rel: string): string | null {
    try {
      return readFileSync(this.path(rel), 'utf8')
    } catch {
      return null
    }
  }

  /**
   * Writes a whole generated set under `prefix` and removes what it no longer holds.
   * Returns the paths whose content changed.
   */
  writeSet(prefix: string, files: Record<string, string>): string[] {
    const changed = Object.entries(files)
      .filter(([rel, content]) => this.write(join(prefix, rel), content))
      .map(([rel]) => rel)
    const keep = new Set(Object.keys(files).map((rel) => this.path(join(prefix, rel))))
    const visit = (dir: string) => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const path = join(dir, name)
        const stat = lstatSync(path)
        if (stat.isDirectory()) {
          visit(path)
          if (!readdirSync(path).length) rmSync(path, { recursive: true, force: true })
        } else if (!keep.has(path)) rmSync(path, { force: true })
      }
    }
    visit(this.path(prefix))
    return changed
  }
}
