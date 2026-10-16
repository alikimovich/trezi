import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStates, statesPackage } from '../src/main/states-build.ts'
import { conventionalProvider, locateComponent } from '../src/main/states-locate.ts'
import { proposeStates } from '../src/main/states-propose.ts'
import { writeStatesFixtures } from '../src/native/smoke-states-projects.ts'

// LKM-263: discovery from props and source, and the in-memory build of a Next.js and a Vite
// component with the project's own React. Nothing is written into the project.
const root = mkdtempSync(join(tmpdir(), 'trezi-states-build-'))
const fixtures = writeStatesFixtures(root, join(process.cwd(), 'node_modules'))
const inventory = () =>
  readdirSync(root, { recursive: true })
    .map(String)
    .filter((path) => !path.split('/').includes('node_modules'))
    .sort()
const files = inventory()

const card = locateComponent(root, fixtures.stamps.card)
assert.ok(!('error' in card), JSON.stringify(card))
assert.equal(card.component, 'ProjectCard')
assert.equal(card.exportName, 'default')
assert.equal(card.source, 'states-fixtures/next-app/app/components/ProjectCard.tsx')
assert.equal(card.directive, 'client')
assert.equal(card.schema.project.fields.status.kind, 'enum')
assert.equal(card.callProps.project.name, 'Atlas', 'literal call-site props seed the states')
const cardStates = proposeStates(card, null).states
assert.deepEqual(
  cardStates.map((state) => state.label),
  [
    'Default',
    'Loading',
    'Error',
    'Disabled',
    'Status: paused',
    'Status: archived',
    'No tags',
    'Long text'
  ]
)
assert.equal(cardStates.find((state) => state.id === 'loading').props.loading, true)
assert.equal(cardStates.find((state) => state.id === 'no-tags').props.project.tags.length, 0)
const live = proposeStates(card, {
  project: { name: 'Live', status: 'paused', tags: [] },
  loading: false
})
assert.equal(live.states[0].label, 'As on the page')
assert.equal(live.states[0].origin, 'page')
assert.deepEqual(statesPackage(root, card.source).framework, 'next')
assert.deepEqual(conventionalProvider(root, 'states-fixtures/next-app'), {
  source: 'states-fixtures/next-app/app/providers.tsx',
  exportName: 'Providers'
})

const badge = locateComponent(root, fixtures.stamps.badge)
assert.equal(badge.component, 'StatusBadge')
assert.equal(statesPackage(root, badge.source).framework, 'vite')
const badgeProposal = proposeStates(badge, null)
assert.deepEqual(
  badgeProposal.states.map((state) => state.id),
  ['default', 'status-offline', 'status-degraded', 'compact', 'long-text']
)
assert.deepEqual(
  badgeProposal.missing.map((item) => item.id),
  ['interactive'],
  'useState is not claimed as discoverable'
)

const recent = locateComponent(root, fixtures.stamps.async)
assert.match(
  recent.server,
  /RecentProjects is an async Server Component .* Select a client component inside it/
)
assert.match(
  locateComponent(root, { source: null, componentSource: null }).error,
  /no source stamp/
)

// Next.js: next/image, next/link, next/navigation, next/font, `@/` paths, a CSS module, a PNG and
// the app's providers, bundled with the project's React.
const next = await buildStates({
  root,
  source: card.source,
  exportName: 'default',
  provider: conventionalProvider(root, 'states-fixtures/next-app')
})
assert.ok(next.ok, next.reason)
assert.equal(next.framework, 'next')
assert.match(next.css, /background: ?rgb\(250, 240, 255\)|background: ?#faf0ff/)
assert.match(next.code, /data:image\/png;base64,/)
assert.doesNotMatch(next.code, /from ["']next\//, 'next/* is shimmed, never imported')
for (const input of ['ProjectCard.tsx', 'providers.tsx', 'format.ts', 'ProjectCard.module.css'])
  assert.ok(
    next.inputs.some((path) => path.endsWith(input)),
    `${input} is watched`
  )
assert.ok(
  next.inputs.every((path) => !path.includes('node_modules')),
  'packages are not watched'
)

// A second build in the same process reads the edited source, never a cached copy.
const format = next.inputs.find((path) => path.endsWith('format.ts'))
const formatSource = readFileSync(format, 'utf8')
writeFileSync(format, "export function formatDate(_iso: string): string {\n  return 'edited'\n}\n")
const edited = await buildStates({
  root,
  source: card.source,
  exportName: 'default',
  provider: conventionalProvider(root, 'states-fixtures/next-app')
})
writeFileSync(format, formatSource)
assert.ok(edited.ok, edited.reason)
assert.match(edited.code, /"edited"/, 'the rebuild sees the edit')

// Vite: the vite.config alias and a CSS module.
const vite = await buildStates({ root, source: badge.source, exportName: 'StatusBadge' })
assert.ok(vite.ok, vite.reason)
assert.equal(vite.framework, 'vite')
assert.match(vite.css, /rgb\(240, 246, 255\)|#f0f6ff/)
assert.ok(vite.inputs.some((path) => path.endsWith('tone.ts')))

// Server-only imports name the file and say what to do.
const server = await buildStates({
  root,
  source: 'states-fixtures/next-app/app/components/ServerStats.tsx',
  exportName: 'ServerStats'
})
assert.equal(server.ok, false)
assert.match(
  server.reason,
  /^states-fixtures\/next-app\/app\/components\/ServerStats\.tsx imports "server-only", which runs only on the server/
)
assert.match(server.reason, /Select a client component that receives this data as props/)

// A project without React installed asks for its dependencies.
mkdirSync(join(root, 'bare/src'), { recursive: true })
writeFileSync(join(root, 'bare/package.json'), '{"name":"bare","dependencies":{"react":"19.0.0"}}')
writeFileSync(join(root, 'bare/src/A.tsx'), 'export function A() { return <p>a</p> }\n')
const bare = await buildStates({ root, source: 'bare/src/A.tsx', exportName: 'A' })
assert.equal(bare.ok, false)
assert.match(bare.reason, /React is not installed in bare\. Install the project's dependencies/)
rmSync(join(root, 'bare'), { recursive: true })

assert.deepEqual(inventory(), files, 'building states writes nothing into the project')
rmSync(root, { recursive: true, force: true })
console.log('states-build: OK')
