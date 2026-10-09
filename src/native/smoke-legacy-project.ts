import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourceStamp } from '../preview/source-stamp'

const STAMP = 'index.html:4:1'
const HELPER = '.praxis/praxis-source.cjs'

/**
 * The fixture as a project set up before the rename (LKM-132): a `.praxis/` helper and
 * an element carrying only a `data-praxis-source` stamp. The fixture is not a Git
 * repository, so it is never "clean" and the migration leaves it alone: the old names
 * must open, preview and edit as they are. `restore` puts the fixture back.
 */
export async function checkLegacyProject(
  fixture: string,
  invoke: (channel: string, ...args: unknown[]) => Promise<any>,
  page: (code: string) => Promise<any>,
  wait: (check: () => Promise<any> | any, label: string, timeout?: number) => Promise<any>
) {
  const index = join(fixture, 'index.html')
  const original = readFileSync(index, 'utf8')
  const stamped = original.replace(
    '</h1>\n<p>',
    `</h1>\n<p id="legacy-stamp" data-praxis-source="${STAMP}">Legacy stamped</p>\n<p>`
  )
  assert.notEqual(stamped, original, 'The fixture has the heading line the legacy element follows')
  mkdirSync(join(fixture, '.praxis'), { recursive: true })
  writeFileSync(
    join(fixture, HELPER),
    "module.exports = () => ({ name: 'praxis-source', attr: 'data-praxis-source' })\n"
  )
  writeFileSync(index, stamped)
  try {
    const plan = await invoke('project:legacy-names', fixture)
    assert.equal(plan.legacy, true, 'The owner recognises the earlier setup')
    assert.ok(
      plan.helpers.includes(HELPER),
      `The old helper is listed: ${JSON.stringify(plan.helpers)}`
    )
    assert.equal(plan.clean, false, 'A folder outside Git is never migrated without confirmation')
    await wait(
      () => page(`!!document.querySelector('#legacy-stamp')`),
      'legacy element previewed after managed reload'
    )
    const stamp = `(${sourceStamp.toString()})(document.querySelector('#legacy-stamp'))`
    assert.equal(await page(stamp), STAMP, 'The preview reads the old stamp')
    assert.equal(
      await page(`document.querySelector('#legacy-stamp').hasAttribute('data-trezi-source')`),
      false,
      'Nothing restamps the old element'
    )
    const edited = await invoke('text:apply', fixture, {
      source: STAMP,
      text: 'Edited legacy stamp'
    })
    assert.ok(edited.applied, `The old stamp resolves and edits: ${JSON.stringify(edited)}`)
    await wait(
      () => page(`document.querySelector('#legacy-stamp')?.textContent === 'Edited legacy stamp'`),
      'legacy edit reaches the preview'
    )
    assert.ok((await invoke('edit:undo', fixture)).ok)
    await wait(
      () => page(`document.querySelector('#legacy-stamp')?.textContent === 'Legacy stamped'`),
      'legacy edit undone in the preview'
    )
    assert.equal(
      readFileSync(join(fixture, HELPER), 'utf8').includes('praxis-source'),
      true,
      'The old helper is untouched'
    )
    console.log(
      'Native legacy project: .praxis/ helper and data-praxis-* stamp open, preview and edit'
    )
  } finally {
    writeFileSync(index, original)
    rmSync(join(fixture, '.praxis'), { recursive: true, force: true })
  }
  await wait(
    () =>
      page(`!document.querySelector('#legacy-stamp') && !!document.querySelector('#native-title')`),
    'fixture restored after the legacy project'
  )
}
