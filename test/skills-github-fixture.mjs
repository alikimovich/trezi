import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { fixtureArchive } from '../src/native/skills-github-fixture.ts'

// The native fixture must keep long playbook paths intact in its USTAR archive.
// A truncated name made the service reject Impeccable as missing a static playbook.
const commit = '5af4319c4e7a7ee3e5e2b9fe899bcfb21c6190cb'
const root = `impeccable-${commit}`
const path = 'plugin/skills/impeccable/reference/adapt.native.md'
const archive = gunzipSync(
  fixtureArchive({
    repository: 'pbakaus/impeccable',
    refs: { [commit]: commit },
    commit,
    files: { [path]: '# Native adaptation\n' }
  })
)
const field = (block, start, length) =>
  block
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/, '')
const names = []
for (let offset = 0; offset < archive.length; ) {
  const block = archive.subarray(offset, offset + 512)
  if (block.every((byte) => byte === 0)) break
  const name = field(block, 0, 100)
  const prefix = field(block, 345, 155)
  names.push(prefix ? `${prefix}/${name}` : name)
  const size = Number.parseInt(field(block, 124, 12).trim(), 8) || 0
  offset += 512 + Math.ceil(size / 512) * 512
}
assert.ok(`${root}/${path}`.length > 100, 'The path exercises the USTAR prefix')
assert.ok(names.includes(`${root}/${path}`), 'The complete playbook path survives the archive')
