// LKM-390 live proof: a real Codex and Claude turn through the native composer route must
// see a generated image. NativeChatController plans the attachments, `helperProvider` runs
// the real adapter in a helper the real Swift ProviderOwner supervises, on the user's own
// subscription. Each picture is chosen at random when the test runs and has a neutral file
// name, and the on-disk copy the prompt lists is a blank decoy: only a picture really in
// the model's input can give the right answer. Four turns: a first image, a second one on
// the resumed thread, a text turn about the first after its temp copy is gone, and a Mark up
// composite whose marked shape the model must name (LKM-391).
//
// Writes receipt.json and the PNGs to TREZI_LIVE_ARTIFACTS (default test/artifacts/
// provider-image-live); no prompt beyond the fixed ones below, no account data. Codex
// reports no model, so pin it with TREZI_LIVE_CODEX_MODEL for the receipt to name it.
// Real provider calls: runs only with TREZI_LIVE_PROVIDERS=1 (otherwise SKIP, which is not
// PASS). Run with: TREZI_LIVE_PROVIDERS=1 TREZI_LIVE_ARTIFACTS=<dir> bun run test:provider-image-live
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomInt } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

if (process.env.TREZI_LIVE_PROVIDERS !== '1') {
  console.log(
    'PROVIDER-IMAGE-LIVE SKIP: set TREZI_LIVE_PROVIDERS=1 to make real Claude and Codex calls on your subscriptions'
  )
  process.exit(0)
}

const { helperProvider } = await import('../src/main/backends/helper-session.ts')
const { setProviderOwner } = await import('../src/main/provider-owner.ts')
const { NativeChatController } = await import('../src/native/chat-controller.ts')
const { markupNote } = await import('../src/native/markup-context.ts')
const { compileProviderFixture, startProviderFixture } = await import(
  './helpers/provider-fixture.mjs'
)

const root = fileURLToPath(new URL('..', import.meta.url))
const artifacts = resolve(
  process.env.TREZI_LIVE_ARTIFACTS ?? join(root, 'test/artifacts/provider-image-live')
)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-provider-image-live-')))
const MATRIX = [
  {
    provider: 'codex',
    ...(process.env.TREZI_LIVE_CODEX_MODEL ? { model: process.env.TREZI_LIVE_CODEX_MODEL } : {}),
    effort: 'low',
    permissionMode: 'default'
  },
  { provider: 'claude', model: 'haiku', effort: 'low', permissionMode: 'default' }
]
const TURN_MS = 180_000
const COLOURS = { red: [220, 30, 30], green: [20, 160, 60], blue: [30, 60, 220] }
const SHAPES = {
  circle: (x, y) => (x - 128) ** 2 + (y - 128) ** 2 < 90 ** 2,
  square: (x, y) => Math.abs(x - 128) < 80 && Math.abs(y - 128) < 80,
  triangle: (x, y) => y > 48 && y < 208 && Math.abs(x - 128) < (y - 48) * 0.55
}
const ASK =
  'Reply with exactly two lowercase words, the colour then the shape in the attached image: one of red, green, blue, then one of circle, square, triangle. Do not use any tools and do not open any file.'
const RECALL =
  'Which colour was the shape in the first image of this chat? Reply with exactly one lowercase word. Do not use any tools and do not open any file.'
const MARKED =
  'Which shape did I mark? Reply with exactly one lowercase word: circle, square or triangle. Do not use any tools and do not open any file.'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pick = (list) => list[randomInt(list.length)]

function crc(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc(body), body.length + 4)
  return out
}
/** A 256 px RGB PNG. */
function png(pixel) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(256, 0)
  header.writeUInt32BE(256, 4)
  header[8] = 8
  header[9] = 2
  const stride = 256 * 3 + 1
  const rows = Buffer.alloc(stride * 256)
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) rows.set(pixel(x, y), y * stride + 1 + x * 3)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const WHITE = [255, 255, 255]
const BLANK = png(() => [128, 128, 128])

/** A new picture, never the same as `not`. */
function picture(not) {
  for (;;) {
    const colour = pick(Object.keys(COLOURS))
    const shape = pick(Object.keys(SHAPES))
    if (`${colour} ${shape}` === not?.expected) continue
    const bytes = png((x, y) => (SHAPES[shape](x, y) ? COLOURS[colour] : WHITE))
    return { expected: `${colour} ${shape}`, colour, bytes }
  }
}

/** Three grey shapes in a random order with a red box drawn around one, as a pen would. */
function markedUp() {
  const names = Object.keys(SHAPES)
  const shift = randomInt(names.length)
  const order = names.map((_, index) => names[(index + shift) % names.length])
  const marked = randomInt(order.length)
  const centre = (index) => 43 + 85 * index
  const bytes = png((x, y) => {
    const edge = Math.max(Math.abs(x - centre(marked)), Math.abs(y - 128))
    if (edge >= 36 && edge <= 41) return [220, 30, 30]
    const index = Math.floor(x / 85.34)
    const inside = SHAPES[order[index]]((x - centre(index)) * 3 + 128, (y - 128) * 3 + 128)
    return inside ? [120, 120, 120] : WHITE
  })
  return { expected: order[marked], bytes }
}

/** One chat: a real helper session behind the real composer, turn by turn. */
async function openChat(options, project) {
  const key = `image-live-${options.provider}`
  const events = []
  let controller
  const session = await helperProvider(options.provider).startSession(
    project,
    options,
    () => null,
    {
      emitKey: key,
      liveRoot: project,
      onEvent: (event) => {
        events.push(event)
        controller?.event(event)
      }
    }
  )
  controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: project,
              chats: [
                {
                  sessionKey: key,
                  record: { transcript: [], title: 'Image' },
                  isRunning: false,
                  options
                }
              ]
            }
          ]
        }
      if (channel === 'providers:choices') return []
      if (channel === 'attachments:save') {
        const path = join(scratch, `${randomInt(1e9)}.png`)
        writeFileSync(path, BLANK)
        return path
      }
      if (channel === 'agent:send') session.send(args[0], args[1])
      return { ok: true }
    },
    render() {},
    effect() {}
  })
  await controller.command({
    type: 'context',
    context: {
      chat: key,
      root: project,
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  let revision = 0
  const turn = async (text, files = []) => {
    const start = events.length
    if (files.length) await controller.composer({ chat: key, action: 'files', files })
    await controller.composer({
      chat: key,
      action: 'input',
      text,
      caret: text.length,
      revision: ++revision
    })
    await controller.composer({ chat: key, action: 'send' })
    const deadline = Date.now() + TURN_MS
    while (!events.slice(start).some((e) => e.type === 'done')) {
      // The picture must come from the input: any tool card is refused and fails the turn.
      for (const [id, prompt] of session.pending) {
        session.pending.delete(id)
        prompt.settle('deny')
      }
      assert.ok(Date.now() < deadline, `${options.provider}: no done within ${TURN_MS} ms`)
      await sleep(50)
    }
    const seen = events.slice(start)
    const of = (type) => seen.filter((e) => e.type === type)
    return {
      answer: of('delta')
        .map((e) => e.text)
        .join('')
        .trim()
        .toLowerCase(),
      model: events.findLast((e) => e.type === 'model')?.model ?? options.model ?? 'CLI default',
      errors: of('error').map((e) => e.message),
      statuses: of('status').map((e) => e.text),
      permissionRequests: of('permission-request').length,
      tempCopiesLeft: readdirSync(tmpdir()).filter((n) => n.startsWith('trezi-codex-images-'))
        .length
    }
  }
  return {
    turn,
    markUp: (file, note) => controller.addMarkup({ chat: key, project }, file, note),
    close: () => session.shutdown()
  }
}

const receipt = {
  command: 'TREZI_LIVE_PROVIDERS=1 bun run test:provider-image-live',
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) !== '',
  at: new Date().toISOString(),
  runs: []
}
let fixture
try {
  mkdirSync(artifacts, { recursive: true })
  const binary = compileProviderFixture()
  const profile = join(scratch, 'profile')
  mkdirSync(profile)
  // The helper's TMPDIR: its temp copies are this run's, so none left over can be counted.
  process.env.TMPDIR = mkdtempSync(join(scratch, 'tmp-'))
  fixture = await startProviderFixture(binary, profile, {
    PROVIDER_HELPER_EXEC: process.execPath,
    PROVIDER_HELPER_ARGS: join(root, 'src/main/backends/provider-helper-entry.ts'),
    PROVIDER_HELPER_PROVIDERS: 'claude,codex'
  })
  setProviderOwner(fixture.owner())
  for (const options of MATRIX) {
    const project = join(scratch, options.provider)
    mkdirSync(project)
    execFileSync('git', ['init', '-q'], { cwd: project })
    const chat = await openChat(options, project)
    const first = picture()
    const second = picture(first)
    const run = { provider: options.provider, turns: [] }
    receipt.runs.push(run)
    const asked = async (image, index) => {
      const name = `fixture-${index}.png`
      const file = join(artifacts, `${options.provider}-${name}`)
      writeFileSync(file, image.bytes)
      const result = await chat.turn(ASK, [
        { name, path: '', type: 'image/png', data: image.bytes.toString('base64') }
      ])
      const sha256 = createHash('sha256').update(image.bytes).digest('hex')
      run.turns.push({ ...result, file, sha256, expected: image.expected })
      writeFileSync(join(artifacts, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
      return result
    }
    try {
      for (const [index, image] of [first, second].entries()) {
        const result = await asked(image, index + 1)
        console.log(`PROVIDER-IMAGE-LIVE ${options.provider}/${result.model}: ${result.answer}`)
        assert.deepEqual(result.errors, [], `${options.provider}: the turn failed`)
        assert.equal(result.answer, image.expected, `${options.provider}: wrong picture`)
        assert.equal(result.permissionRequests, 0, `${options.provider}: it reached for a tool`)
        assert.equal(result.tempCopiesLeft, 0, `${options.provider}: a temp copy was left`)
      }
      const recall = await chat.turn(RECALL)
      run.turns.push({ ...recall, expected: first.colour })
      assert.deepEqual(recall.errors, [])
      assert.ok(
        recall.answer.includes(first.colour),
        `${options.provider}: the resumed thread lost the first image: ${recall.answer}`
      )
      // LKM-391: a composite added the way Mark up adds it, with its statement.
      const composite = markedUp()
      const file = join(artifacts, `${options.provider}-mark-up.png`)
      writeFileSync(file, composite.bytes)
      const added = chat.markUp(
        { name: 'Mark up.png', type: 'image/png', data: composite.bytes.toString('base64') },
        (name) =>
          markupNote(name, {
            url: 'http://localhost:5173/pricing?token=not-sent',
            viewportWidth: 256,
            viewportHeight: 256,
            zoom: 1,
            scrollX: 0,
            scrollY: 0,
            imageWidth: 256,
            imageHeight: 256
          })
      )
      assert.deepEqual(added, { ok: true }, `${options.provider}: Mark up was not added`)
      const marked = await chat.turn(MARKED)
      run.turns.push({ ...marked, file, expected: composite.expected })
      console.log(`PROVIDER-IMAGE-LIVE ${options.provider} mark up: ${marked.answer}`)
      assert.deepEqual(marked.errors, [], `${options.provider}: the Mark up turn failed`)
      assert.equal(marked.answer, composite.expected, `${options.provider}: wrong mark`)
      assert.equal(marked.permissionRequests, 0, `${options.provider}: it reached for a tool`)
    } finally {
      chat.close()
    }
  }
  writeFileSync(join(artifacts, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`PROVIDER-IMAGE-LIVE PASS: ${artifacts}/receipt.json`)
} finally {
  writeFileSync(join(artifacts, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  await fixture?.kill().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
