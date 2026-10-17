import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeStructure } from '../shared/api'

export type { NativeStructure }

/**
 * The native project roots in a folder (LKM-273): `.xcworkspace` and `.xcodeproj`
 * bundles and `Package.swift` manifests, as project-relative paths sorted in UTF-16
 * order. Part of project detection, so `src/service/RuntimeDetect.swift`
 * (`nativeStructure`) mirrors it exactly; `test/runtime-owner.mjs` checks the parity.
 * Pure: directory listings and lstat only, symlinks are never followed.
 */

/** Levels below the root that are searched: `ios/App.xcworkspace`, `Packages/Kit/Package.swift`. */
export const NATIVE_SCAN_DEPTH = 2
/** Folders never searched: dependencies and build output. Hidden folders are skipped too. */
const SKIPPED = new Set(['node_modules', 'Pods', 'Carthage', 'DerivedData', 'build'])
/** Bundles that are directories but never hold a project of their own. */
const BUNDLES = ['.xcassets', '.app', '.framework', '.xcframework', '.bundle', '.playground']

export function discoverNative(root: string): NativeStructure | null {
  const found: NativeStructure = { workspaces: [], projects: [], packages: [] }
  const visit = (dir: string, prefix: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const path = join(dir, name)
      const relative = prefix ? `${prefix}/${name}` : name
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (stat.isFile() && name === 'Package.swift') found.packages.push(relative)
      if (!stat.isDirectory()) continue
      if (name.endsWith('.xcworkspace')) found.workspaces.push(relative)
      else if (name.endsWith('.xcodeproj')) found.projects.push(relative)
      else if (
        depth < NATIVE_SCAN_DEPTH &&
        !SKIPPED.has(name) &&
        !BUNDLES.some((suffix) => name.endsWith(suffix))
      )
        visit(path, relative, depth + 1)
    }
  }
  visit(root, '', 0)
  if (!found.workspaces.length && !found.projects.length && !found.packages.length) return null
  found.workspaces.sort()
  found.projects.sort()
  found.packages.sort()
  return found
}
