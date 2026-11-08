// LKM-583: the code editor's Save and Reload of one file must not leave the shown document
// on a baseline that differs from disk. Save captures its document and updates that object
// once the write lands; Reload replaces the document with a fresh read, and the source
// owner's reads run outside its serialized write lane. Drives the real
// NativeEditorController with a source owner whose write and read are released by hand
// (no sleeps, no desktop, no provider).
import assert from 'node:assert/strict'
import { NativeEditorController } from '../src/native/editor-controller.ts'

const gate = () => {
  let open
  const promise = new Promise((resolve) => {
    open = resolve
  })
  return { promise, open }
}
const hash = (text) => `h:${text}`
/** Lets every queued continuation run (no timers). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function fixture(initial = 'v1') {
  const disk = new Map([['a.ts', initial]])
  const calls = [],
    states = []
  const holds = { write: null, read: null }
  /** The next `channel` call waits; a held read has already taken its bytes (a pre-write read). */
  const hold = (channel) => {
    const entered = gate(),
      release = gate()
    holds[channel] = { entered, release }
    return { entered: entered.promise, release: () => release.open() }
  }
  const wait = async (channel) => {
    const held = holds[channel]
    holds[channel] = null
    if (held) {
      held.entered.open()
      await held.release.promise
    }
  }
  const controller = new NativeEditorController(
    async (channel, _root, source, baseline, content, base) => {
      calls.push([channel, source, baseline, content, base])
      const file = typeof source === 'string' ? source.replace(/:\d+(?::\d+)?$/, '') : source
      if (channel === 'source:tree') return [...disk.keys()]
      if (channel === 'source:drafts') return []
      if (channel === 'source:read') {
        const code = disk.get(file)
        await wait('read')
        return { file, code, hash: hash(code), line: 1 }
      }
      if (channel === 'source:write') {
        await wait('write')
        // The owner's hash check: a write against a base that is no longer on disk is refused.
        if (hash(disk.get(file)) !== base) return { ok: false, conflict: true }
        disk.set(file, content)
        return { ok: true, hash: hash(content) }
      }
      return undefined
    },
    (state) => states.push(structuredClone(state))
  )
  const root = '/fixture'
  const act = (action, extra = {}) => controller.action({ action, root, ...extra })
  const shown = () => controller.session(root).documents.get('a.ts')
  const type = (text) => act('edit', { source: 'a.ts', revision: states.at(-1).revision + 1, text })
  const drafts = () =>
    calls.filter(
      ([c, s]) => (c === 'source:save-draft' || c === 'source:clear-draft') && s === 'a.ts'
    )
  return { controller, disk, calls, states, hold, act, shown, type, drafts, root }
}

/** The shown document agrees with disk: its baseline is the disk text and its hash is disk's. */
function agrees(f, label) {
  const doc = f.shown()
  assert.equal(doc.baseline, f.disk.get('a.ts'), `${label}: baseline is the disk text`)
  assert.equal(doc.baseHash, hash(f.disk.get('a.ts')), `${label}: baseHash is the disk hash`)
  assert.equal(
    f.states.at(-1).document?.code,
    f.disk.get('a.ts'),
    `${label}: published view is disk`
  )
}

const results = []
async function check(name, body) {
  try {
    await body()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error.message])
  }
}

await check('Reload while Save is held before commit shows the saved file', async () => {
  const f = fixture()
  await f.controller.open(f.root, 'a.ts')
  await f.type('v2')
  const write = f.hold('write')
  const saving = f.act('save')
  await write.entered
  const reloading = f.act('reload')
  await settle()
  write.release()
  await Promise.all([saving, reloading])
  assert.equal(f.disk.get('a.ts'), 'v2', 'the save landed')
  agrees(f, 'after both')
  assert.equal(f.states.at(-1).text, 'v2', 'shows the saved text')
  assert.equal(f.states.at(-1).dirty, false)
  assert.equal(f.states.at(-1).busy, false)
  assert.equal(f.drafts().at(-1)?.[0], 'source:clear-draft', 'no draft is kept for a clean file')
})

await check('Typing after Reload during a held Save saves without a false conflict', async () => {
  const f = fixture()
  await f.controller.open(f.root, 'a.ts')
  await f.type('v2')
  const write = f.hold('write')
  const saving = f.act('save')
  await write.entered
  const reloading = f.act('reload')
  await settle()
  write.release()
  await Promise.all([saving, reloading])
  await f.type('v3')
  const last = f.drafts().at(-1)
  f.controller.persist(f.controller.session(f.root), 'a.ts', true)
  const persisted = f.drafts().at(-1)
  assert.equal(persisted[0], 'source:save-draft', `the draft is persisted (${last?.[0]})`)
  assert.equal(persisted[2], hash(f.disk.get('a.ts')), 'the persisted draft is based on disk')
  await f.act('save')
  assert.equal(f.states.at(-1).error, '', 'no conflict')
  assert.equal(f.disk.get('a.ts'), 'v3', 'the typed text was saved')
  agrees(f, 'after the second save')
})

await check('Save while a Reload read is held shows the saved file', async () => {
  const f = fixture()
  await f.controller.open(f.root, 'a.ts')
  await f.type('v2')
  const read = f.hold('read')
  const reloading = f.act('reload')
  await read.entered
  const saving = f.act('save')
  await settle()
  read.release()
  await Promise.all([saving, reloading])
  agrees(f, 'after both')
  assert.equal(f.states.at(-1).dirty, false)
})

// Controls: behaviour that must stay as it was.
await check('control: ordinary Reload discards the draft and shows disk', async () => {
  const f = fixture()
  await f.controller.open(f.root, 'a.ts')
  await f.type('draft')
  f.disk.set('a.ts', 'external')
  await f.act('reload')
  assert.equal(f.states.at(-1).text, 'external')
  assert.equal(f.states.at(-1).dirty, false)
  agrees(f, 'reloaded')
  assert.equal(f.drafts().at(-1)?.[0], 'source:clear-draft')
})

await check('control: typing during a held Save stays dirty against the saved text', async () => {
  const f = fixture()
  await f.controller.open(f.root, 'a.ts')
  await f.type('v2')
  const write = f.hold('write')
  const saving = f.act('save')
  await write.entered
  await f.type('v3')
  write.release()
  await saving
  assert.equal(f.disk.get('a.ts'), 'v2')
  assert.equal(f.states.at(-1).text, 'v3')
  assert.equal(f.states.at(-1).dirty, true)
  agrees(f, 'saved')
})

await check(
  'control: a second Save of the same file while one is held does not write',
  async () => {
    const f = fixture()
    await f.controller.open(f.root, 'a.ts')
    await f.type('v2')
    const write = f.hold('write')
    const saving = f.act('save')
    await write.entered
    await f.act('save')
    write.release()
    await saving
    assert.equal(f.calls.filter(([c]) => c === 'source:write').length, 1)
    assert.equal(f.disk.get('a.ts'), 'v2')
  }
)

await check('control: an external writer during a held Save is refused, draft kept', async () => {
  const f = fixture()
  await f.controller.open(f.root, 'a.ts')
  await f.type('v2')
  const write = f.hold('write')
  const saving = f.act('save')
  await write.entered
  f.disk.set('a.ts', 'external')
  write.release()
  await saving
  assert.equal(f.disk.get('a.ts'), 'external')
  assert.equal(f.states.at(-1).conflict, true)
  assert.equal(f.states.at(-1).text, 'v2')
})

for (const [status, name, message] of results)
  console.log(`${status} ${name}${message ? `\n     ${message}` : ''}`)
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`Editor Reload/Save ordering: ${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
