// LKM-282: project UI discovery (react-docgen, then Babel) must not read the project's
// browserslist config. The provider helper runs in the worktree, and Babel searches the
// cwd: a browserslist `extends` requires a package from the project, and a bad query
// threw on every file. Fixtures are harmless markers, never real configs.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverProjectUi } from '../src/main/project-ui-catalog.ts'

await mkdir('test/artifacts', { recursive: true })
const base = await mkdtemp(join(process.cwd(), 'test/artifacts/docgen-browserslist-'))
const cwd = process.cwd()

async function project(name, browserslist) {
  const root = join(base, name)
  await mkdir(join(root, 'components'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, browserslist }))
  await writeFile(
    join(root, 'components/Card.tsx'),
    `import React from 'react'
export function Card({ title }: { title: string }) {
  return <section>{title}</section>
}`
  )
  return root
}

try {
  const extending = await project('extends', ['extends browserslist-config-marker'])
  const shared = join(extending, 'node_modules/browserslist-config-marker')
  await mkdir(shared, { recursive: true })
  await writeFile(
    join(shared, 'package.json'),
    JSON.stringify({ name: 'browserslist-config-marker', version: '1.0.0', main: 'index.js' })
  )
  await writeFile(
    join(shared, 'index.js'),
    `require('node:fs').writeFileSync(require('node:path').join(__dirname, '../../MARKER'), 'ran')
module.exports = ['defaults']\n`
  )
  const invalid = await project('invalid', ['lkm282 is not a browser query'])

  for (const root of [extending, invalid]) {
    process.chdir(root)
    const catalog = await discoverProjectUi(root)
    process.chdir(cwd)
    assert.deepEqual(
      catalog.components.map((component) => component.name),
      ['Card'],
      `${root}: the component is discovered whatever the browserslist config says`
    )
  }
  assert.equal(existsSync(join(extending, 'MARKER')), false, 'no project package was required')
  console.log('DOCGEN-BROWSERSLIST OK')
} finally {
  process.chdir(cwd)
  await rm(base, { recursive: true, force: true })
}
