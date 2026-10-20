import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCAL-WEBKIT-4: the managed agent-browser launcher and every local module it, the
 * Codex/Claude guard and the policy import, copied into the app before it is signed
 * (`Contents/Resources/browser/bin`, the same layout as the checkout's `bin`). The bundled
 * backend and provider helper resolve this copy first, so a built or moved app needs
 * no checkout for browser setup or the launcher route.
 */
export const MANAGED_BROWSER_FILES = [
  ['managed/agent-browser', 0o755],
  ['trezi-browser-tools.mjs', 0o644],
  ['trezi-browser-guard.mjs', 0o755],
  ['trezi-browser-policy.mjs', 0o644]
]

/** Relative imports of a packaged module; each must be packaged too. */
export function localImports(source) {
  return [...source.matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)].map((match) => match[1])
}

export function packageManagedBrowser(root, resources) {
  const target = join(resources, 'browser/bin')
  rmSync(join(resources, 'browser'), { recursive: true, force: true })
  mkdirSync(join(target, 'managed'), { recursive: true })
  const names = new Set(MANAGED_BROWSER_FILES.map(([name]) => name))
  for (const [name, mode] of MANAGED_BROWSER_FILES) {
    const from = join(root, 'bin', name)
    for (const spec of localImports(readFileSync(from, 'utf8'))) {
      const imported = join(name, '..', spec)
      if (!names.has(imported)) throw new Error(`${name} imports ${spec}, which is not packaged`)
    }
    copyFileSync(from, join(target, name))
    chmodSync(join(target, name), mode)
  }
  return target
}
