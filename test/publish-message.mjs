/**
 * Pure Publish commit/PR message builder. The regression fixture mirrors PR #8:
 * legacy chat paste is excluded and only commits that changed the branch become
 * concise summary bullets.
 *
 * Run with: bun test/publish-message.mjs
 */
import assert from 'node:assert'
import {
  buildPublishMessage,
  changedScopes,
  publishCommitSummaries
} from '../src/shared/publish-message.ts'

const legacyLog = [
  'so I have apca-cli project. I want to embed it here in a terminal like window\x1fTrezi turn 1.\x1e',
  "that's cool, but I actually want it to be interactive here, and zoomable\x1fTrezi turn 2.\x1e",
  'cool. add a new article called figma console\x1fTrezi turn 3.\x1e',
  'pull latest from main (+15 more)\x1fChanges requested in Trezi:\n- /clear\n- do it for me\x1e'
].join('')

const summaries = publishCommitSummaries(legacyLog)
assert.deepEqual(summaries, [
  'Embed apca-cli here in a terminal like window',
  'Be interactive here, and zoomable',
  'Add a new article called figma console'
])
assert.ok(!summaries.some((s) => /clear|do it|pull latest/i.test(s)), 'chat noise excluded')

const files = [
  'package.json',
  'bun.lock',
  'public/images/figma.png',
  'src/components/media/TerminalWindow.tsx',
  'src/components/media/TerminalWindow.module.css',
  'src/content/projects/figma-console.mdx'
]
assert.deepEqual(changedScopes(files), [
  'UI components',
  'content',
  'styles',
  'media',
  'dependencies'
])

const message = buildPublishMessage(
  'trezi/main',
  summaries,
  ' src/components/media/TerminalWindow.tsx | 51 +++++\n 6 files changed',
  files
)
assert.equal(message.title, 'Update UI components, content, styles, and media')
assert.ok(message.body.startsWith('## Summary\n\n- Embed apca-cli'), message.body)
assert.ok(message.body.includes('## Change overview'), message.body)
assert.ok(message.body.includes('Files changed: 6'), message.body)
assert.ok(message.body.includes('<summary>Diffstat</summary>'), message.body)
assert.ok(!message.body.includes('Changes requested in Trezi:'), message.body)

const single = buildPublishMessage('trezi/x', ['Fix the navigation'], '', ['src/Nav.tsx'])
assert.equal(single.title, 'Fix the navigation')

const fallback = buildPublishMessage('trezi/x', [], '', ['README.md'])
assert.equal(fallback.title, 'Update documentation')
assert.ok(fallback.body.includes('Update 1 documentation file.'))

console.log('PUBLISH-MESSAGE OK — git-based title, structured body, legacy chat excluded')
