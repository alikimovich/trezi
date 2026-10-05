import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ViteSetupInfo } from '../shared/api'

/**
 * React on Vite (LKM-153). `react({ babel: { plugins } })` stopped being a stamping
 * path: Vite 8 transforms JSX with Oxc, `@vitejs/plugin-react` 6 dropped its Babel
 * option, and `@vitejs/plugin-react-swc` never had one. So every Vite version gets
 * the same small `enforce: 'pre'` plugin. It runs the unchanged `trezi-source.cjs`
 * visitor through `@babel/core` (parse and print only, no presets) before Vite's own
 * JSX transform, so Vite 7 and 8 produce the stamps Next and Babel projects do.
 */
export const VITE_HELPER = '.trezi/trezi-vite.mjs'

export const VITE_HELPER_CONTENT = `// Added by Trezi (.trezi/). A dev-only Vite plugin that stamps
// data-trezi-source="path:line:col" on JSX elements so Trezi can map a clicked
// element to its source. It runs the trezi-source.cjs Babel visitor (parse and
// print only) before Vite's own JSX transform (esbuild in Vite 7, Oxc in Vite 8).
// Add trezi() FIRST in the plugins array, for the dev server only. It is
// \`apply: 'serve'\`, so builds never run it. Needs @babel/core in devDependencies.
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const JSX = /\\.[jt]sx$/

export default function trezi() {
  let babel = null, stamp = null, root = null, logger = console
  const warned = new Set()
  const warn = (message) => {
    if (warned.has(message)) return
    warned.add(message)
    logger.warn('[trezi-source] ' + message)
  }
  return {
    name: 'trezi-source',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      logger = config.logger ?? console
      if (process.env.NODE_ENV === 'production') return
      // Vite keeps import.meta.url of a config import; the project root is a fallback.
      let here = dirname(fileURLToPath(import.meta.url))
      if (!existsSync(join(here, 'trezi-source.cjs'))) here = join(config.root, '.trezi')
      const helper = join(here, 'trezi-source.cjs')
      if (!existsSync(helper)) return warn('.trezi/trezi-source.cjs is missing, so elements are not mapped to source. Run Connect to Trezi again.')
      root = realpathSync(dirname(here))
      const require = createRequire(join(root, 'package.json'))
      try { babel = require('@babel/core') } catch (error) {
        return warn(error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes("'@babel/core'")
          ? '@babel/core is not installed, so elements are not mapped to source. Add it to devDependencies.'
          : '@babel/core could not be loaded, so elements are not mapped to source: ' + (error && error.message ? error.message.split('\\n')[0] : error))
      }
      stamp = require(helper)
    },
    transform(code, id) {
      if (!babel || !stamp || id.startsWith('\\0')) return null
      let file = id.split('?')[0]
      if (!JSX.test(file) || file.includes('/node_modules/') || !code.includes('<')) return null
      // The root is a real path, so a symlinked id (preserveSymlinks, /tmp) must be one too.
      try { file = realpathSync(file) } catch {}
      try {
        const result = babel.transformSync(code, {
          filename: file, root, cwd: root, configFile: false, babelrc: false, sourceMaps: true,
          parserOpts: { plugins: file.endsWith('.tsx') ? ['jsx', 'typescript'] : ['jsx'] },
          plugins: [stamp]
        })
        return result ? { code: result.code, map: result.map } : null
      } catch (error) {
        warn('could not map ' + relative(root, file) + ': ' + (error && error.message ? error.message.split('\\n')[0] : error))
        return null
      }
    }
  }
}
`

/**
 * The installed version, read from the nearest `node_modules` up the tree (hoisted in a
 * workspace). Folders, not the resolver: exports may hide package.json, and Bun's
 * resolver would try to auto-install a package that is missing.
 */
async function installedVersion(root: string, name: string): Promise<string | undefined> {
  for (let folder = root; ; folder = dirname(folder)) {
    try {
      const version = JSON.parse(
        await readFile(join(folder, 'node_modules', name, 'package.json'), 'utf8')
      ).version
      if (typeof version === 'string') return version
    } catch {
      /* Not installed here. */
    }
    if (dirname(folder) === folder) return undefined
  }
}

const majorOf = (version?: string): number | undefined => {
  const match = /(\d+)/.exec(version?.replace(/^[^\d]*/, '') ?? '')
  return match ? Number(match[1]) : undefined
}

/** Vite and its React plugin, or `undefined` when the project is not built by Vite. */
export async function detectVite(root: string): Promise<ViteSetupInfo | undefined> {
  type Deps = Record<string, string> | undefined
  let pkg: { dependencies?: Deps; devDependencies?: Deps; peerDependencies?: Deps }
  try {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const declared = (name: string): string | undefined =>
    pkg.devDependencies?.[name] ?? pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name]
  const declaredVersion = declared('vite')
  const reactPlugin = [
    '@vitejs/plugin-react',
    '@vitejs/plugin-react-swc',
    '@vitejs/plugin-react-oxc'
  ].find(declared)
  if (!declaredVersion && !reactPlugin) return undefined
  const version = await installedVersion(root, 'vite')
  const info: ViteSetupInfo = {
    version,
    declaredVersion,
    major: majorOf(version ?? declaredVersion)
  }
  if (reactPlugin) {
    info.reactPlugin = reactPlugin
    info.reactPluginVersion = (await installedVersion(root, reactPlugin)) ?? declared(reactPlugin)
  }
  return info
}
