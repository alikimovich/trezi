import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentHash, setSourceOwner } from '../src/main/source-owner.ts'
import { applyStylePair } from '../src/main/styles.ts'

const root = mkdtempSync(join(tmpdir(), 'trezi-style-pair-'))
const commits = []
setSourceOwner({
  async commit(base, edits, options) {
    assert.equal(base, root)
    assert.equal(edits.length, 1, 'one source transaction per pair')
    const [edit] = edits
    const before = readFileSync(edit.path, 'utf8')
    assert.equal(edit.expectedHash, contentHash(before))
    commits.push({ before, after: edit.content, options })
    writeFileSync(edit.path, edit.content)
    return { ok: true, files: [edit.path], hashes: [contentHash(edit.content)] }
  }
})
try {
  const source = join(root, 'Card.tsx')
  writeFileSync(
    source,
    'export const Card = () => <div style={{ paddingLeft: "var(--space-a)", paddingRight: "18px", paddingTop: "7px", marginLeft: "auto", marginRight: "-4px", color: "red" }} />\n'
  )
  const edit = {
    source: 'Card.tsx:1',
    classes: [],
    props: ['padding-left', 'padding-right'],
    value: '24px'
  }
  assert.equal((await applyStylePair(root, edit)).applied, true)
  assert.equal(commits.length, 1)
  assert.match(commits[0].after, /paddingLeft: "24px"/)
  assert.match(commits[0].after, /paddingRight: "24px"/)
  assert.match(commits[0].after, /paddingTop: "7px"/)
  assert.match(commits[0].after, /marginLeft: "auto"/)
  assert.match(commits[0].after, /marginRight: "-4px"/)
  assert.match(commits[0].after, /color: "red"/)
  assert.equal((await applyStylePair(root, { ...edit, value: '-2px' })).applied, false)
  assert.equal(commits.length, 1)
  writeFileSync(source, commits[0].before)
  assert.match(
    readFileSync(source, 'utf8'),
    /var\(--space-a\)/,
    'one undo restores both sides and the token'
  )
  const svelte = join(root, 'Card.svelte')
  writeFileSync(
    svelte,
    '<div style="padding-left: 3px; padding-right: 5px; margin-left: auto; margin-right: -4px"></div>\n'
  )
  assert.equal((await applyStylePair(root, { ...edit, source: 'Card.svelte:1' })).applied, true)
  assert.equal(commits.length, 2)
  assert.match(readFileSync(svelte, 'utf8'), /padding-left: 24px; padding-right: 24px/)
  assert.match(readFileSync(svelte, 'utf8'), /margin-left: auto; margin-right: -4px/)
} finally {
  setSourceOwner(null)
  rmSync(root, { recursive: true, force: true })
}
console.log('Spacing pair commits one source transaction and preserves other declarations')
