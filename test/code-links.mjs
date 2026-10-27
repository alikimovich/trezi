// LKM-364: clickable code candidates in chat. `open_code` candidates carry a
// `trezi-code:` link; a click in chat re-validates it with LKM-363's project-file check
// and opens only Trezi's editor at that range. Escapes, absolute paths and other
// schemes are refused with a message, and nothing is written.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeLinkTarget, openAgentCode } from '../src/main/code-tools.ts'
import { cardAction } from '../src/native/chat-actions.ts'
import { NativeEditorController } from '../src/native/editor-controller.ts'
import {
  codeLinkHref,
  codeLinkMarkdown,
  isWebLink,
  parseCodeLink
} from '../src/shared/code-link.ts'

// --- The link format ----------------------------------------------------------------------
assert.equal(codeLinkHref('src/a.css', 3, 5), 'trezi-code:src/a.css#L3-L5')
assert.equal(codeLinkHref('src/My Card.tsx', 6, 6), 'trezi-code:src/My%20Card.tsx#L6')
assert.equal(
  codeLinkMarkdown({ file: 'src/a.css', startLine: 3, endLine: 5 }),
  '[src/a.css:3-5](trezi-code:src/a.css#L3-L5)'
)
assert.equal(
  codeLinkMarkdown({ file: 'src/[id].tsx', startLine: 2, endLine: 2 }),
  '[src/\\[id\\].tsx:2](trezi-code:src/%5Bid%5D.tsx#L2)'
)
const parsed = {
  'trezi-code:src/a.css#L3-L5': { file: 'src/a.css', lines: { startLine: 3, endLine: 5 } },
  'trezi-code:src/My%20Card.tsx#L6': {
    file: 'src/My Card.tsx',
    lines: { startLine: 6, endLine: 6 }
  },
  'trezi-code:src/%5Bid%5D.tsx#L2': { file: 'src/[id].tsx', lines: { startLine: 2, endLine: 2 } },
  'src/App.tsx:12': { file: 'src/App.tsx', lines: { startLine: 12, endLine: 12 } },
  'src/App.tsx:12-18': { file: 'src/App.tsx', lines: { startLine: 12, endLine: 18 } },
  'src/App.tsx:12:4': { file: 'src/App.tsx', lines: { startLine: 12, endLine: 12 } },
  './src/App.tsx#L12-L18': { file: 'src/App.tsx', lines: { startLine: 12, endLine: 18 } },
  'App.tsx:12': { file: 'App.tsx', lines: { startLine: 12, endLine: 12 } },
  'src/App.tsx': { file: 'src/App.tsx' }
}
for (const [href, target] of Object.entries(parsed))
  assert.deepEqual(parseCodeLink(href), target, href)
for (const href of [
  'https://example.com/a.css',
  'mailto:a@b.c',
  'file:///etc/hosts',
  'vscode://file/etc/hosts',
  'x-apple.systempreferences:com.apple',
  '/etc/hosts',
  'trezi-code:/etc/hosts#L1',
  '~/secret.txt',
  'C:\\secret.txt',
  'trezi-code:src/a.css#L5-L3',
  'trezi-code:src/a.css#L0',
  'trezi-code:%E0%A4%A',
  'trezi-code:a%00b',
  '',
  'x'.repeat(2001),
  42
])
  assert.ok('error' in parseCodeLink(href), `refused: ${String(href).slice(0, 40)}`)
assert.ok(isWebLink('HTTPS://x.y') && isWebLink('mailto:a@b.c') && !isWebLink('trezi-code:a'))

// --- A project with escapes ---------------------------------------------------------------
const root = await mkdtemp(join(tmpdir(), 'trezi-code-links-'))
const outside = await mkdtemp(join(tmpdir(), 'trezi-code-links-outside-'))
const CSS = '.card {\n  display: grid;\n}\n.other { color: red }\n'
const snapshot = async () => {
  const seen = {}
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) seen[path] = await readFile(path, 'utf8')
    }
  }
  await walk(root)
  await walk(outside)
  return seen
}
try {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/Card.module.css'), CSS)
  await writeFile(
    join(root, 'src/Card.tsx'),
    "import styles from './Card.module.css'\n\nexport const Card = () => (\n  <section className={styles.card} style={{ padding: 8 }}>x</section>\n)\n"
  )
  await writeFile(join(root, 'src/bin.dat'), 'a\0b\n')
  await writeFile(join(outside, 'Secret.tsx'), 'export const SECRET = 1\n')
  await symlink(join(outside, 'Secret.tsx'), join(root, 'src/Escape.tsx'))
  await symlink(outside, join(root, 'src/linked'))
  const before = await snapshot()

  // open_code candidates carry links back to their exact ranges.
  const result = await openAgentCode(
    root,
    root,
    'chat-1',
    { source: 'src/Card.tsx:4', target: 'styles', classes: ['card'] },
    () => {}
  )
  assert.equal(result.requested, false, JSON.stringify(result))
  assert.match(result.message, /`link`/)
  assert.ok(result.candidates.length > 1)
  for (const c of result.candidates) {
    const href = /^\[[^\]]+\]\((trezi-code:[^)]+)\)$/.exec(c.link)?.[1]
    assert.deepEqual(parseCodeLink(href), {
      file: c.file,
      lines: { startLine: c.startLine, endLine: c.endLine }
    })
    const target = await codeLinkTarget(root, href)
    assert.equal(target.source, `${c.file}:${c.startLine}`)
    assert.equal(target.range.startLine, c.startLine)
    assert.equal(target.range.endLine, c.endLine)
  }

  // A click resolves to the exact range and its code.
  assert.deepEqual(await codeLinkTarget(root, 'trezi-code:src/Card.module.css#L1-L3'), {
    root,
    source: 'src/Card.module.css:1',
    range: { startLine: 1, endLine: 3, code: '.card {\n  display: grid;\n}' }
  })
  assert.deepEqual(await codeLinkTarget(root, 'src/Card.module.css'), {
    root,
    source: 'src/Card.module.css:1'
  })
  // A range past the end is clamped to the file, not refused (the agent's file may have shrunk).
  assert.deepEqual((await codeLinkTarget(root, 'src/Card.module.css:4-99')).range, {
    startLine: 4,
    endLine: 4,
    code: '.other { color: red }'
  })
  // Crafted links: traversal, symlink escapes, absolute and other schemes, missing, binary.
  for (const href of [
    'trezi-code:../outside.css#L1',
    'trezi-code:src/../../outside.css#L1',
    'trezi-code:src/Escape.tsx#L1',
    'trezi-code:src/linked/Secret.tsx#L1',
    `trezi-code:${join(outside, 'Secret.tsx')}#L1`,
    `file://${join(outside, 'Secret.tsx')}`,
    'https://example.com/src/Card.tsx',
    'trezi-code:src/missing.tsx#L1',
    'trezi-code:src#L1',
    'trezi-code:src/bin.dat#L1'
  ]) {
    const refused = await codeLinkTarget(root, href)
    assert.ok('error' in refused, `refused ${href}: ${JSON.stringify(refused)}`)
    assert.doesNotMatch(refused.error, /SECRET/)
  }
  assert.match((await codeLinkTarget('', 'src/Card.tsx:1')).error, /Open a project/)

  // --- The chat action: an editor effect on success, a visible message otherwise -------------
  const effects = []
  const controller = {
    services: {
      invoke: async (channel) => assert.fail(`code links invoke nothing: ${channel}`),
      effect: (effect) => effects.push(effect)
    }
  }
  const chat = { root, chat: 'chat-1', error: undefined }
  const click = (value) => cardAction(controller, chat, { action: 'code-link', id: 'm1', value })
  await click('trezi-code:src/Card.module.css#L1-L3')
  assert.deepEqual(effects, [
    {
      type: 'code',
      root,
      source: 'src/Card.module.css:1',
      range: { startLine: 1, endLine: 3, code: '.card {\n  display: grid;\n}' }
    }
  ])
  assert.equal(chat.error, undefined)
  for (const value of [
    'trezi-code:../outside.css#L1',
    'trezi-code:src/Escape.tsx#L1',
    'file:///etc/hosts'
  ]) {
    await click(value)
    assert.equal(effects.length, 1, `${value} opened nothing`)
    assert.match(chat.error, /^Not opened in the editor: /)
    chat.error = undefined
  }
  // Another project's chat resolves inside its own root only.
  const other = { root: outside, chat: 'chat-2', error: undefined }
  await cardAction(controller, other, {
    action: 'code-link',
    id: 'm2',
    value: 'src/Card.module.css:1'
  })
  assert.equal(effects.length, 1)
  assert.match(other.error, /Not opened in the editor/)

  // --- The effect opens the editor through LKM-363's path; a dirty draft is kept ------------
  const calls = []
  const states = []
  const editor = new NativeEditorController(
    async (channel, _root, source) => {
      calls.push(channel)
      if (channel === 'source:tree') return ['src/Card.module.css']
      if (channel === 'source:read') {
        const file = source.replace(/:\d+(?::\d+)?$/, '')
        return file === 'src/Card.module.css' ? { file, code: CSS, line: 1 } : null
      }
    },
    (state) => states.push(structuredClone(state))
  )
  const draft = `/* draft */\n${CSS}`
  await editor.open(root, 'src/Card.module.css:1')
  await editor.action({
    action: 'edit',
    root,
    source: 'src/Card.module.css',
    revision: 3,
    text: draft
  })
  const { source, range } = effects[0]
  await editor.open(root, source, undefined, false, range)
  assert.equal(states.at(-1).text, draft, 'the draft is kept')
  assert.equal(states.at(-1).dirty, true)
  assert.deepEqual(states.at(-1).range, { startLine: 2, endLine: 4 }, 'found in the draft')
  const reads = ['source:tree', 'source:read', 'source:drafts', 'source:save-draft']
  assert.deepEqual(
    calls.filter((c) => !reads.includes(c)),
    [],
    'opening a link only reads'
  )
  assert.deepEqual(await snapshot(), before, 'links write no file')
  console.log(
    'CODE-LINKS OK — candidate links, exact range, escapes refused, chat effect, draft kept, read-only'
  )
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
