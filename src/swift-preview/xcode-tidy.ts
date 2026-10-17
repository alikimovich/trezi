import { existsSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/**
 * Keeps xcodebuild from leaving anything in the user's project (LKM-275). Both
 * `xcodebuild -list` and `-showBuildSettings` may create empty
 * `xcshareddata/swiftpm/configuration` folders (inside `project.xcworkspace` for a
 * project), and for each local package the project references the folders
 * `tidySwiftPM` covers. Those it created are removed again, innermost first; anything
 * else new is returned as a leftover (project-relative) to report, never deleted.
 */
export async function tidyXcode<T>(
  root: string,
  container: { kind: string; path: string; packages?: { kind: string; path?: string }[] },
  run: () => Promise<T>
): Promise<{ value: T; leftovers: string[] }> {
  const parts = [
    ...(container.kind === 'workspace' ? [] : ['project.xcworkspace']),
    'xcshareddata',
    'swiftpm',
    'configuration'
  ]
  const locals = (container.packages ?? [])
    .filter((p) => p.kind === 'local' && p.path && !p.path.startsWith('..'))
    .map((p) => join(root, p.path as string))
  return tidy(root, [chain(join(root, container.path), parts), ...swiftpmChains(locals)], run)
}

/**
 * The same for SwiftPM run on (or depending on) packages in the user's project:
 * `swift package` and `swift build` (and xcodebuild, for a referenced package) create
 * the package's `.swiftpm/configuration` and `.swiftpm/xcode` folders even with the
 * scratch path elsewhere.
 */
export function tidySwiftPM<T>(
  root: string,
  packages: string[],
  run: () => Promise<T>
): Promise<{ value: T; leftovers: string[] }> {
  return tidy(root, swiftpmChains(packages), run)
}

function swiftpmChains(packages: string[]): string[][] {
  return packages.flatMap((dir) => [
    chain(dir, ['.swiftpm', 'configuration']),
    chain(dir, ['.swiftpm', 'xcode'])
  ])
}

/** Each folder from `base/parts[0]` down to `base/parts…`. */
function chain(base: string, parts: string[]): string[] {
  return parts.map((_, i) => join(base, ...parts.slice(0, i + 1)))
}

async function tidy<T>(
  root: string,
  chains: string[][],
  run: () => Promise<T>
): Promise<{ value: T; leftovers: string[] }> {
  const existed = new Set(chains.flat().filter((path) => existsSync(path)))
  const tops = [...new Set(chains.map((c) => c[0]))]
  const before = new Set(tops.flatMap((top) => listing(top)))
  let value: T
  try {
    value = await run()
  } finally {
    for (const folders of chains)
      for (let i = folders.length - 1; i >= 0; i--) {
        if (existed.has(folders[i]) || !existsSync(folders[i])) continue
        try {
          if (readdirSync(folders[i]).length === 0) rmdirSync(folders[i])
        } catch {}
      }
  }
  const leftovers = tops
    .flatMap((top) => listing(top))
    .filter((path) => !before.has(path))
    .map((path) => posix.relative(root, path))
  return { value, leftovers }
}

/** Files and empty folders under `dir`: a folder holding a leftover is not one itself. */
function listing(dir: string, depth = 0): string[] {
  if (depth > 6) return []
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const path = join(dir, name)
    let directory = false
    try {
      directory = statSync(path).isDirectory()
    } catch {}
    const inside = directory ? listing(path, depth + 1) : []
    return inside.length ? inside : [path]
  })
}
