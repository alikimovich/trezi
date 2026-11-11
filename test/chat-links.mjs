// LKM-657: links clicked in chat go to the right native destination. A synthetic project
// with a report, before/after screenshots, a PDF and a folder reproduces the "Saved the
// report and before/after screenshots" answer: source (relative, absolute or file:) opens
// Trezi's editor at its lines, images/PDF open in Quick Look, folders reveal in Finder,
// and anything outside the project, missing, secret or unsupported says where it points
// with Reveal in Finder / Copy Path for the owner. Escapes and other schemes stay refused.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chatLinkRoute } from '../src/main/chat-links.ts'
import { cardAction } from '../src/native/chat-actions.ts'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { parseChatLink, parseCodeLink } from '../src/shared/code-link.ts'

// --- Parsing: once, with schemes, decoding and line ranges ---------------------------------
const parsed = {
  'https://example.com/a': { kind: 'web', url: 'https://example.com/a' },
  'mailto:a@b.c': { kind: 'web', url: 'mailto:a@b.c' },
  'src/App.tsx:12': { kind: 'project', file: 'src/App.tsx', lines: { startLine: 12, endLine: 12 } },
  'trezi-code:src/a.css#L3-L5': {
    kind: 'project',
    file: 'src/a.css',
    lines: { startLine: 3, endLine: 5 }
  },
  '/p/src/App.tsx#L2-L4': {
    kind: 'local',
    path: '/p/src/App.tsx',
    lines: { startLine: 2, endLine: 4 }
  },
  '/p/src/App.tsx:7': {
    kind: 'local',
    path: '/p/src/App.tsx',
    lines: { startLine: 7, endLine: 7 }
  },
  '  /p/My%20Report.md  ': { kind: 'local', path: '/p/My Report.md' },
  'trezi-code:/p/a.css%23L1-L2': {
    kind: 'local',
    path: '/p/a.css',
    lines: { startLine: 1, endLine: 2 }
  },
  'file:///p/shots/before%20one.png': { kind: 'local', path: '/p/shots/before one.png' },
  'file://localhost/p/a.css#L3': {
    kind: 'local',
    path: '/p/a.css',
    lines: { startLine: 3, endLine: 3 }
  },
  // The URL parser removes dot segments, encoded ones included.
  'file:///p/src/%2e%2e/%2E%2E/etc/hosts': { kind: 'local', path: '/etc/hosts' },
  '~/notes.md': { kind: 'local', path: '~/notes.md' }
}
for (const [href, link] of Object.entries(parsed)) assert.deepEqual(parseChatLink(href), link, href)
for (const href of [
  'file://evil.example/share/a.png',
  'file://192.168.1.2/a.pdf',
  '//server/share/a.png',
  '\\\\server\\share\\a.png',
  'trezi-code:%2F%2Fserver/share',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vscode://file/etc/hosts',
  'x-apple.systempreferences:com.apple',
  'ssh://host',
  'terminal://run',
  'C:\\secret.txt',
  'file:///p/a%00b',
  '/p/a\nb',
  '/p/a.css#L5-L3',
  '~root/x',
  'trezi-code:%E0%A4%A',
  '',
  42
]) {
  const link = parseChatLink(href)
  assert.equal(link.kind, 'refused', `refused: ${JSON.stringify(href)} → ${JSON.stringify(link)}`)
}
// The LKM-364 parser keeps refusing every absolute form (provider tools rely on it).
for (const href of ['/etc/hosts', 'file:///etc/hosts', '~/x', 'trezi-code:/etc/hosts#L1'])
  assert.ok('error' in parseCodeLink(href), href)

// --- A synthetic project with an agent's report and screenshots ----------------------------
const root = await mkdtemp(join(tmpdir(), 'trezi-chat-links-'))
const outside = await mkdtemp(join(tmpdir(), 'trezi-chat-links-outside-'))
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const snapshotFiles = async () => {
  const seen = {}
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) seen[path] = (await readFile(path)).toString('base64')
    }
  }
  await walk(root)
  await walk(outside)
  return seen
}
try {
  const { realpath } = await import('node:fs/promises')
  const base = await realpath(root)
  const real = (rel) => join(base, rel)
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'reports/shots'), { recursive: true })
  await writeFile(
    join(root, 'src/App.tsx'),
    'export const A = 1\nexport const B = 2\nexport const C = 3\n'
  )
  await writeFile(join(root, 'reports/report.md'), '# Report\n\nAll checks: synthetic.\n')
  await writeFile(
    join(root, 'reports/report.html'),
    '<script>document.title="ran"</script><h1>Report</h1>\n'
  )
  await writeFile(join(root, 'reports/shots/before.png'), PNG)
  await writeFile(join(root, 'reports/shots/after one.png'), PNG)
  await writeFile(join(root, 'reports/summary.pdf'), '%PDF-1.4\n%%EOF\n')
  await writeFile(join(root, 'reports/trace.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]))
  await writeFile(join(root, '.env.local'), 'TOKEN=synthetic\n')
  await writeFile(join(outside, 'Secret.tsx'), 'export const SECRET = 1\n')
  await writeFile(join(outside, 'photo.png'), PNG)
  await symlink(join(outside, 'photo.png'), join(root, 'reports/shots/linked.png'))
  await symlink(outside, join(root, 'reports/linked'))
  const before = await snapshotFiles()

  // Source: relative, absolute and file: forms of the same file reach the same lines.
  const code = {
    root,
    source: 'src/App.tsx:2',
    range: { startLine: 2, endLine: 3, code: 'export const B = 2\nexport const C = 3' }
  }
  for (const href of [
    'src/App.tsx#L2-L3',
    'trezi-code:src/App.tsx#L2-L3',
    `${real('src/App.tsx')}#L2-L3`,
    `${join(root, 'src/App.tsx')}:2-3`,
    `trezi-code:${real('src/App.tsx')}#L2-L3`,
    `${pathToFileURL(real('src/App.tsx')).href}#L2-L3`,
    `${real('reports')}/../src/App.tsx#L2-L3`
  ])
    assert.deepEqual(await chatLinkRoute(root, href), { type: 'code', ...code }, href)
  assert.deepEqual(await chatLinkRoute(root, real('reports/report.md')), {
    type: 'code',
    root,
    source: 'reports/report.md:1'
  })
  // A local HTML report is shown as source text in the editor, never run.
  assert.equal((await chatLinkRoute(root, real('reports/report.html'))).type, 'code')

  // Artifacts: images and PDF in Quick Look (canonical paths), folders in Finder.
  for (const [href, path] of [
    [real('reports/shots/before.png'), real('reports/shots/before.png')],
    [pathToFileURL(real('reports/shots/after one.png')).href, real('reports/shots/after one.png')],
    ['reports/shots/after%20one.png', real('reports/shots/after one.png')],
    [real('reports/summary.pdf'), real('reports/summary.pdf')]
  ])
    assert.deepEqual(await chatLinkRoute(root, href), { type: 'quick-look', path }, href)
  for (const href of [real('reports/shots'), `${real('reports')}/`, 'reports', root])
    assert.equal((await chatLinkRoute(root, href)).type, 'reveal', href)

  // Notices: say where the link points; Reveal only where Finder can show it locally.
  const notices = [
    [join(outside, 'Secret.tsx'), /outside this project/, true],
    [pathToFileURL(join(outside, 'photo.png')).href, /outside this project/, true],
    ['/etc/hosts', /outside this project.*\/etc\/hosts/, true],
    ['~/Library/Keychains', /outside this project/, true],
    ['/Volumes/Share/report.pdf', /outside this project/, false],
    ['/net/host/report.pdf', /outside this project/, false],
    [real('reports/missing.png'), /does not exist/, false],
    ['reports/missing.md#L1', /does not exist/, false],
    [real('.env.local'), /may hold credentials/, true],
    [real('reports/trace.zip'), /cannot be shown in Trezi’s editor/, true]
  ]
  for (const [href, detail, reveal] of notices) {
    const route = await chatLinkRoute(root, href)
    assert.equal(route.type, 'notice', `${href}: ${JSON.stringify(route)}`)
    assert.match(route.detail, detail, href)
    assert.equal(route.reveal, reveal, `${href} reveal`)
    assert.doesNotMatch(route.detail, /SECRET|synthetic/, 'no content is disclosed')
  }
  assert.equal((await chatLinkRoute(root, '~/x.png')).path, join(homedir(), 'x.png'))

  // Refused: escapes through symlinks or traversal, remote files and other schemes.
  for (const href of [
    real('reports/shots/linked.png'),
    real('reports/linked/Secret.tsx'),
    'reports/linked/photo.png',
    '../outside.png',
    'trezi-code:..%2Foutside.css%23L1',
    'reports%2F..%2F..%2Fx.png',
    'file://server/share/a.png',
    'javascript:alert(1)',
    'https://example.com/a.png'
  ]) {
    const route = await chatLinkRoute(root, href)
    assert.ok('error' in route, `refused ${href}: ${JSON.stringify(route)}`)
  }
  assert.match((await chatLinkRoute('', 'src/App.tsx')).error, /Open a project/)

  // --- The chat action and its card -------------------------------------------------------
  const effects = []
  const controller = {
    services: {
      invoke: async (channel) => assert.fail(`links invoke nothing: ${channel}`),
      effect: (effect) => effects.push(effect)
    }
  }
  const chats = new NativeChatController({
    invoke: async () => ({}),
    render() {},
    effect() {}
  })
  const chat = chats.get('chat-links')
  chat.root = root
  const click = (value) => cardAction(controller, chat, { action: 'code-link', id: 'm1', value })
  const card = () => snapshot(chat, []).cards.find((c) => c.id === 'link')
  const press = (action) =>
    cardAction(controller, chat, { action, id: 'link', value: '/etc/passwd' })

  await click(real('reports/shots/before.png'))
  await click(pathToFileURL(real('reports/summary.pdf')).href)
  await click(real('reports'))
  await click(`${real('src/App.tsx')}#L2-L3`)
  assert.deepEqual(effects, [
    { type: 'quick-look', path: real('reports/shots/before.png') },
    { type: 'quick-look', path: real('reports/summary.pdf') },
    { type: 'reveal', path: real('reports') },
    { type: 'code', ...code }
  ])
  assert.equal(chat.error, undefined)
  assert.equal(card(), undefined)

  // Outside the project: one card naming the destination, Reveal/Copy on the owner's click.
  effects.length = 0
  await click(join(outside, 'photo.png'))
  assert.deepEqual(effects, [], 'nothing opens by itself')
  const shown = card()
  assert.equal(shown.title, 'Link not opened')
  assert.deepEqual(
    shown.actions.map((a) => a.action),
    ['link-reveal', 'link-copy', 'link-dismiss']
  )
  assert.match(shown.fullDetail ?? shown.detail, /photo\.png/)
  assert.equal(
    snapshot(chat, []).cards.filter((c) => c.id === 'link' || c.id === 'error').length,
    1
  )
  // The card's value is ignored: the resolved path is what is revealed.
  await press('link-reveal')
  assert.deepEqual(effects, [{ type: 'reveal', path: join(outside, 'photo.png') }])
  assert.equal(card(), undefined)
  await click('/Volumes/Share/report.pdf')
  assert.deepEqual(
    card().actions.map((a) => a.action),
    ['link-copy', 'link-dismiss'],
    'no Reveal for a network location'
  )
  await press('link-reveal')
  assert.equal(effects.length, 1, 'Reveal is not offered, so a stray press does nothing')
  await click(real('reports/trace.zip'))
  await press('link-copy')
  assert.deepEqual(effects.at(-1), { type: 'copy-path', path: real('reports/trace.zip') })
  await click('/etc/hosts')
  await press('link-dismiss')
  assert.equal(card(), undefined)
  assert.equal(effects.length, 2)

  // A refused link: the existing one-line error, which a later notice replaces.
  await click(real('reports/linked/Secret.tsx'))
  assert.match(chat.error, /^Not opened in the editor: .*symbolic link/)
  await click('/etc/hosts')
  assert.equal(chat.error, undefined, 'one message at a time')
  assert.ok(card())
  await click('javascript:alert(1)')
  assert.equal(card(), undefined)
  assert.match(chat.error, /^Not opened in the editor: /)

  assert.deepEqual(await snapshotFiles(), before, 'links write no file')
  console.log(
    'CHAT-LINKS OK — source abs/rel/file: with lines, images/PDF Quick Look, folders reveal, outside/missing/secret/unsupported notice, escapes and schemes refused'
  )
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
