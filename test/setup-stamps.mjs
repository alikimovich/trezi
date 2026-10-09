import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SVELTE_HELPER_CONTENT } from '../src/main/setup.ts'
import { MDX_HELPER_CONTENT } from '../src/main/setup-mdx.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-stamps-')))
const previous = process.env.NODE_ENV
try {
  process.env.NODE_ENV = 'development'
  mkdirSync(join(root, '.trezi'))
  symlinkSync(
    new URL('../node_modules', import.meta.url).pathname,
    join(root, 'node_modules'),
    'dir'
  )
  writeFileSync(join(root, '.trezi/svelte.mjs'), SVELTE_HELPER_CONTENT)
  writeFileSync(join(root, '.trezi/mdx.mjs'), MDX_HELPER_CONTENT)
  const svelte = (await import(pathToFileURL(join(root, '.trezi/svelte.mjs')).href)).default()
  const mdx = (await import(pathToFileURL(join(root, '.trezi/mdx.mjs')).href)).default()
  for (const name of ['data-praxis-source', 'data-trezi-source']) {
    for (const tag of ['h1', 'Card']) {
      const content = `<${tag} ${name}="src/Original.svelte:42:0" />`
      const run = (code) =>
        svelte.markup({ content: code, filename: join(root, 'Generated.svelte') }).code
      assert.equal(run(content), content)
      assert.equal(run(run(content)), content)
    }
    const element = {
      type: 'mdxJsxFlowElement',
      name: 'h1',
      attributes: [{ type: 'mdxJsxAttribute', name, value: 'original.mdx:42:0' }],
      position: { start: { line: 1, column: 1 } }
    }
    const paragraph = {
      type: 'paragraph',
      data: { hProperties: { [name]: 'original.mdx:42:0' } },
      position: { start: { line: 2, column: 1 } }
    }
    const tree = { type: 'root', children: [element, paragraph] }
    const before = JSON.stringify(tree)
    mdx(tree, { path: join(root, 'Generated.mdx') })
    mdx(tree, { path: join(root, 'Generated.mdx') })
    assert.equal(JSON.stringify(tree), before)
  }
  assert.match(
    svelte.markup({ content: '<h1>Hello</h1>', filename: join(root, 'Fresh.svelte') }).code,
    /data-trezi-source=/
  )
  const fresh = { type: 'paragraph', position: { start: { line: 3, column: 1 } } }
  mdx(fresh, { path: join(root, 'Fresh.mdx') })
  assert.equal(fresh.data.hProperties['data-trezi-source'], 'Fresh.mdx:3:0')
  console.log(
    'SETUP-STAMPS OK: legacy/current mappings preserved across repeated Svelte and MDX instrumentation'
  )
} finally {
  if (previous === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previous
  rmSync(root, { recursive: true, force: true })
}
