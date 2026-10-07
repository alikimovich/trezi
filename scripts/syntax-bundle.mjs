import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

/**
 * The code editor's Shiki bundle (LKM-183): `src/main/syntax-shiki-bundle.ts` with Shiki,
 * the Oniguruma WASM and the editor's grammars built in, as ESM split into lazy chunks
 * (one per grammar), so the app never resolves Shiki from the checkout and a grammar is
 * read only with its first file. Writes `<outdir>/shiki.mjs` plus `<outdir>/chunks/`.
 * Used by `scripts/build-native.mjs` and `test/syntax-bundle.mjs`.
 */

/** What the CJS backend bundle needs to find it: `syntax/shiki.mjs` beside `index.cjs`. */
export const SYNTAX_BUNDLE_DEFINE = { TREZI_SYNTAX_BUNDLE: '__treziSyntaxBundle' }
export const SYNTAX_BUNDLE_BANNER =
  'var __treziSyntaxBundle = require("node:path").join(__dirname, "syntax/shiki.mjs");'

export async function buildSyntaxBundle(root, outdir) {
  rmSync(outdir, { recursive: true, force: true })
  const result = await build({
    entryPoints: { shiki: join(root, 'src/main/syntax-shiki-bundle.ts') },
    outdir,
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    platform: 'node',
    target: 'es2022',
    format: 'esm',
    minify: true,
    metafile: true,
    logLevel: 'warning'
  })
  const external = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((item) => item.external && !item.path.startsWith('node:'))
  if (external.length)
    throw new Error(`Shiki bundle imports packages at runtime: ${external.map((i) => i.path).join(', ')}`)
  return result.metafile
}
