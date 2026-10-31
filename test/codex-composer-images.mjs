// LKM-390: a composer image reaches Codex as real image input. The route is the real one
// from the composer: the chat controller, `planAttachments`, `agent:send`, the real Codex
// adapter and the real SDK, whose `--image` arguments a stand-in `codex` CLI reads and
// hashes. No model request, network or real credential, and the fixture user's CODEX_HOME.
// - delivery: first turn, later turns of a thread, a saved thread, a seeded thread that
//   replaces a lost one, and turns queued in the composer or in the adapter;
// - a retry (network, rejected model) sends the image again; Stop, a failed turn, a CLI that
//   dies and a shutdown keep their behaviour and leave no temp file;
// - a temp copy that cannot be written is said, in the chat and to the model;
// - temp copies left by a killed helper are swept;
// - the same route through the real helper entry under the Swift ProviderOwner fixture,
//   the path a seat chat takes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileProviderFixture, startProviderFixture } from './helpers/provider-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-codex-images-')))
const HOME = join(scratch, 'codex-home')
const WT = join(scratch, 'wt')
const TMP = join(scratch, 'tmp')
const SAVED = join(scratch, 'attachments')
for (const dir of [HOME, WT, TMP, SAVED]) mkdirSync(dir)
const LOG = join(scratch, 'exec.log')
const SCRIPT = join(scratch, 'script.json')
const CLI = join(scratch, 'codex')
const IMPL = join(scratch, 'codex-impl.mjs')
/** How the next runs of the stand-in end, in order; a run past the list answers. */
const script = (...modes) => writeFileSync(SCRIPT, JSON.stringify(modes))
const ROUTING = 'workspace routing discovery failed: error sending request'
const REJECTED =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-fixture-a\' model is not supported when using Codex with a ChatGPT account."}}'

// The shell answers the adapter's probes; only `exec` starts Bun (see test/codex-model.mjs).
writeFileSync(
  CLI,
  `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.0.0-test'; exit 0 ;;
  debug) echo '{"models":[{"slug":"gpt-fixture-a","display_name":"a","visibility":"list","priority":1},{"slug":"gpt-fixture-b","display_name":"b","visibility":"list","priority":2}]}'; exit 0 ;;
esac
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(IMPL)} "$@"
`
)
writeFileSync(
  IMPL,
  `import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
if (args[0] !== 'exec') process.exit(2)
const prompt = readFileSync(0, 'utf8')
let modes = []
try { modes = JSON.parse(readFileSync(${JSON.stringify(SCRIPT)}, 'utf8')) } catch {}
const mode = modes.shift() ?? 'ok'
writeFileSync(${JSON.stringify(SCRIPT)}, JSON.stringify(modes))
const paths = args.flatMap((arg, i) => (arg === '--image' ? [args[i + 1]] : []))
const images = paths.map((path) => ({
  path,
  sha: existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null,
  mode: existsSync(path) ? statSync(path).mode & 0o777 : null
}))
const resumed = args.indexOf('resume')
const resume = resumed < 0 ? null : args[resumed + 1]
const at = args.indexOf('--model')
const model = at < 0 ? null : args[at + 1]
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ mode, resume, model, prompt, images }) + '\\n')
if (mode === 'no-rollout') {
  process.stderr.write('Error: no rollout found for thread id ' + resume + '\\n')
  process.exit(1)
}
if (mode === 'crash') {
  process.stderr.write('Reading prompt from stdin...\\nfixture crash\\n')
  process.exit(3)
}
out({ type: 'thread.started', thread_id: mode === 'other-thread' ? 'thread-other' : (resume ?? 'thread-' + process.pid) })
out({ type: 'turn.started' })
if (mode === 'hang') setInterval(() => {}, 1000)
else if (mode === 'turn-failed') {
  out({ type: 'turn.failed', error: { message: 'fixture failure' } })
  process.exit(1)
} else if (mode === 'network') {
  out({ type: 'turn.failed', error: { message: ${JSON.stringify(ROUTING)} } })
  process.exit(1)
} else if (mode === 'rejected') {
  out({ type: 'error', message: ${JSON.stringify(REJECTED)} })
  process.exit(1)
} else {
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 400))
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Seen.' } })
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })
}
`
)
chmodSync(CLI, 0o755)

process.env.TREZI_CODEX_BIN = CLI
process.env.CODEX_HOME = HOME
process.env.TMPDIR = TMP
process.env.TREZI_CODEX_STREAM_GRACE_MS = '300'

const { codexProvider } = await import('../src/main/backends/codex.ts')
const { RESUME_NOTE } = await import('../src/main/backends/claude-resume.ts')
const { helperProvider } = await import('../src/main/backends/helper-session.ts')
const { setProviderOwner } = await import('../src/main/provider-owner.ts')
const { setProviderProbe } = await import('../src/main/self-heal/network.ts')
const { RECOVERED_STATUS } = await import('../src/main/self-heal/status.ts')
const { shutdownTreziAgentTools } = await import('../src/main/trezi-agent-tools.ts')
const { NativeChatController } = await import('../src/native/chat-controller.ts')

setProviderProbe(async () => true)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, label, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await sleep(10)
  }
}
const runs = () =>
  (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const hash = (data) => createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex')
const leftovers = () => readdirSync(TMP)
const noTempFiles = (label) =>
  until(() => leftovers().length === 0, `${label}: no temp file stays`, 5000)

/** Valid base64 of a fixture's own bytes. The stand-in hashes them; it does not decode them. */
const picture = (name, type = 'image/png') => ({
  name,
  path: '',
  type,
  data: Buffer.from(`pixels of ${name}`.padEnd(30, '.')).toString('base64')
})
const RED = picture('red.png')
const BLUE = picture('blue.jpg', 'image/jpeg')
const GREEN = picture('green.webp', 'image/webp')

const sessions = []
let chats = 0

/** A chat as the app wires it: the composer's actions, `agent:send`, this provider's session. */
async function composerChat(provider, ctx = {}) {
  const key = `images-${++chats}`
  const events = []
  let controller
  const session = await provider.startSession(
    WT,
    { provider: 'codex', permissionMode: 'auto' },
    () => null,
    {
      emitKey: key,
      liveRoot: WT,
      onEvent: (event) => {
        events.push(event)
        controller?.event(event)
      },
      ...ctx
    }
  )
  sessions.push(session)
  let saved = 0
  controller = new NativeChatController({
    invoke: async (channel, ...args) => {
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: WT,
              chats: [
                {
                  sessionKey: key,
                  record: { transcript: [], title: 'Images' },
                  isRunning: false,
                  options: { provider: 'codex', permissionMode: 'auto' }
                }
              ]
            }
          ]
        }
      if (channel === 'providers:choices') return []
      if (channel === 'attachments:save') {
        const path = join(SAVED, `${key}-${++saved}-${args[1]}`)
        writeFileSync(path, Buffer.from(args[0].data, 'base64'))
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
      root: WT,
      selection: null,
      turn: {},
      setup: { needed: false, dismissed: false, status: null },
      tokens: { needed: false, dismissed: false },
      notes: [],
      spawns: []
    }
  })
  let revision = 0
  /** One composer submission: its files, its text, the Send button. */
  const submit = async (text, files = []) => {
    if (files.length) await controller.composer({ chat: key, action: 'files', files })
    await controller.composer({
      chat: key,
      action: 'input',
      text,
      caret: text.length,
      revision: ++revision
    })
    await controller.composer({ chat: key, action: 'send' })
  }
  const of = (type) => events.filter((event) => event.type === type)
  const turn = async (text, files = []) => {
    const ran = runs().length
    const done = of('done').length
    await submit(text, files)
    await until(() => of('done').length > done, `the turn "${text}" ended`)
    await until(() => !controller.get(key).isRunning, `the chat is idle after "${text}"`)
    await sleep(60) // a second `done` would land here
    assert.equal(of('done').length, done + 1, `"${text}" ended exactly once`)
    return runs().slice(ran)
  }
  return { session, controller, key, events, of, submit, turn }
}

let fixture
try {
  // --- first turn, and the later turns of the thread ------------------------------------
  const chat = await composerChat(codexProvider)
  const [first, ...noMore] = await chat.turn('What does this show?', [RED])
  assert.deepEqual(noMore, [])
  assert.equal(first.images.length, 1, 'the composer image reached the CLI as --image')
  assert.equal(first.images[0].sha, hash(RED.data), 'its bytes are the composer image')
  assert.equal(first.images[0].mode, 0o600, 'readable by this user only')
  assert.match(first.images[0].path, /\.png$/)
  assert.equal(dirname(dirname(first.images[0].path)), TMP)
  assert.ok(first.resume === null, 'a new thread')
  assert.match(first.prompt, /\[Attached images — the image\(s\) in this message are on disk at\]/)
  assert.match(first.prompt, /What does this show\?$/)
  assert.ok(first.prompt.includes('---'), "the first turn carries Trezi's rules")
  assert.ok(!first.prompt.includes(RED.data), 'the image is not pasted into the prompt')
  await noTempFiles('first turn')

  const [second] = await chat.turn('And these?', [BLUE, GREEN])
  assert.ok(second.resume, 'a later turn continues the thread')
  assert.deepEqual(
    second.images.map((image) => image.sha),
    [hash(BLUE.data), hash(GREEN.data)],
    'several images keep their order'
  )
  assert.match(second.images[0].path, /\.jpg$/)
  assert.match(second.images[1].path, /\.webp$/)
  await noTempFiles('a later turn')

  const [plain] = await chat.turn('No picture this time')
  assert.deepEqual(plain.images, [], 'a turn without images passes none')
  assert.equal(plain.prompt, 'No picture this time')

  // --- a saved thread ---------------------------------------------------------------------
  const saved = await composerChat(codexProvider, {
    resumeSessionId: 'saved-thread',
    resumeSummary: 'The chat so far: a footer.'
  })
  const [resumed] = await saved.turn('Compare with this', [RED])
  assert.equal(resumed.resume, 'saved-thread')
  assert.equal(resumed.images[0]?.sha, hash(RED.data), 'a resumed thread gets the image')
  await noTempFiles('resumed thread')

  // A saved thread the CLI cannot find: the seeded thread takes the same turn and image.
  for (const failure of ['no-rollout', 'other-thread']) {
    const lost = await composerChat(codexProvider, {
      resumeSessionId: `lost-${failure}`,
      resumeSummary: 'The chat so far: a footer.'
    })
    script(failure)
    const [gone, seeded, ...none] = await lost.turn('Compare with this', [BLUE])
    assert.deepEqual(none, [])
    assert.equal(gone.resume, `lost-${failure}`)
    assert.equal(gone.images[0]?.sha, hash(BLUE.data))
    assert.equal(seeded.resume, null, `${failure}: a new thread replaces it`)
    assert.equal(seeded.images[0]?.sha, hash(BLUE.data), `${failure}: the image goes along`)
    assert.ok(seeded.prompt.includes('The chat so far: a footer.'), 'with the summary')
    assert.ok(seeded.prompt.includes('[Attached images'), 'and the attachment header')
    assert.ok(seeded.prompt.endsWith('Compare with this'))
    assert.ok(lost.of('status').some((event) => event.text === RESUME_NOTE))
    assert.deepEqual(lost.of('error'), [])
    await noTempFiles(failure)
  }

  // --- queued turns -----------------------------------------------------------------------
  // Queued in the composer while a turn runs: sent once it ends, with its own image.
  const queuedChat = await composerChat(codexProvider)
  script('slow')
  const before = runs().length
  await queuedChat.submit('First in line', [RED])
  await until(() => runs().length > before, 'the first turn started')
  await queuedChat.submit('Waiting in line', [BLUE])
  assert.equal(queuedChat.controller.get(queuedChat.key).queue.length, 1, 'the second one queued')
  await until(() => queuedChat.of('done').length === 2, 'both turns ended')
  const [ahead, behind] = runs().slice(before)
  assert.equal(ahead.images[0]?.sha, hash(RED.data))
  assert.equal(behind.images[0]?.sha, hash(BLUE.data), 'the queued turn sends its own image')
  assert.equal(behind.images.length, 1)
  assert.ok(behind.prompt.endsWith('Waiting in line'))
  await noTempFiles('composer queue')

  // Handed to the adapter back to back: its chain runs them in order.
  const chained = await composerChat(codexProvider)
  const start = runs().length
  chained.session.send('one', [{ mediaType: RED.type, data: RED.data }])
  chained.session.send('two', [{ mediaType: BLUE.type, data: BLUE.data }])
  chained.session.send('three')
  await until(() => chained.of('done').length === 3, 'the chained turns ended')
  assert.deepEqual(
    runs()
      .slice(start)
      .map((run) => run.images.map((image) => image.sha)),
    [[hash(RED.data)], [hash(BLUE.data)], []],
    'each chained turn has its own images'
  )
  await noTempFiles('adapter chain')

  // --- Stop ------------------------------------------------------------------------------
  const stopped = await composerChat(codexProvider)
  script('hang')
  const beforeStop = runs().length
  await stopped.submit('Take your time', [RED])
  await until(() => runs().length > beforeStop, 'the hung turn started')
  assert.equal(runs().at(-1).images[0]?.sha, hash(RED.data))
  assert.equal(leftovers().length, 1, 'the copy exists during the turn')
  await stopped.session.interrupt()
  await until(() => stopped.of('done').length === 1, 'Stop ended the turn')
  assert.deepEqual(stopped.of('error'), [], 'Stop is not an error')
  await noTempFiles('Stop')
  await until(() => !stopped.controller.get(stopped.key).isRunning, 'the chat is idle')
  const [afterStop] = await stopped.turn('Go on', [BLUE])
  assert.equal(afterStop.images[0]?.sha, hash(BLUE.data), 'the session takes the next image')

  // --- errors ----------------------------------------------------------------------------
  const failing = await composerChat(codexProvider)
  script('turn-failed')
  await failing.turn('Fail this', [RED])
  assert.match(failing.of('error').at(-1).message, /fixture failure/)
  await noTempFiles('turn.failed')
  script('crash')
  await failing.turn('Die on this', [RED])
  assert.match(failing.of('error').at(-1).message, /fixture crash/)
  assert.equal(failing.of('error').length, 2)
  await noTempFiles('a CLI that dies')
  const [survived] = await failing.turn('Still there?', [BLUE])
  assert.equal(survived.images[0]?.sha, hash(BLUE.data), 'an error costs no later turn')

  // A failure the adapter retries: every run gets the image, the temp copy outlives them.
  const retried = await composerChat(codexProvider)
  script('network')
  const [cut, reran] = await retried.turn('Over a bad network', [RED])
  assert.equal(cut.images[0]?.sha, hash(RED.data))
  assert.equal(reran.images[0]?.sha, hash(RED.data), 'the retry sends the image again')
  assert.ok(retried.of('status').some((event) => event.text === RECOVERED_STATUS))
  await noTempFiles('network retry')

  const fellBack = await composerChat(codexProvider)
  script('rejected')
  const [refused, onFallback] = await fellBack.turn('On a model this login lacks', [BLUE])
  assert.equal(refused.images[0]?.sha, hash(BLUE.data))
  assert.equal(onFallback.images[0]?.sha, hash(BLUE.data), 'the fallback model gets the image')
  assert.equal(onFallback.model, 'gpt-fixture-b')
  await noTempFiles('model fallback')

  // Session teardown mid-turn.
  const closing = await composerChat(codexProvider)
  script('hang')
  const beforeClose = runs().length
  await closing.submit('Closing soon', [RED])
  await until(() => runs().length > beforeClose, 'the turn started')
  closing.session.shutdown()
  await noTempFiles('shutdown')

  // --- a copy that cannot be written ------------------------------------------------------
  const unwritable = await composerChat(codexProvider)
  const blocked = join(scratch, 'not-a-directory')
  writeFileSync(blocked, '')
  process.env.TMPDIR = blocked
  const [without] = await unwritable.turn('Can you see it?', [RED])
  process.env.TMPDIR = TMP
  assert.deepEqual(without.images, [])
  assert.match(without.prompt, /\[Not attached: 1 image\(s\) could not be prepared for Codex/)
  assert.ok(
    unwritable.of('status').some((event) => /could not be prepared/.test(event.text)),
    'the chat says so'
  )

  // --- copies a killed helper left behind ---------------------------------------------------
  const stale = join(TMP, 'trezi-codex-images-stale')
  const recent = join(TMP, 'trezi-codex-images-recent')
  mkdirSync(stale)
  mkdirSync(recent)
  writeFileSync(join(stale, 'image-1.png'), 'old')
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  utimesSync(stale, twoDaysAgo, twoDaysAgo)
  const swept = await composerChat(codexProvider)
  await swept.turn('Sweep first', [RED])
  assert.deepEqual(leftovers(), ['trezi-codex-images-recent'], 'only the stale copy goes')
  rmSync(recent, { recursive: true })

  // --- the path a seat chat takes: the helper under the real Swift owner ---------------------
  mkdirSync(join(scratch, 'profile'))
  fixture = await startProviderFixture(compileProviderFixture(), join(scratch, 'profile'), {
    PROVIDER_HELPER_ARGS: `${join(root, 'test/fixtures/codex-helper.mjs')}\u001f${CLI}`,
    PROVIDER_HELPER_PROVIDERS: 'codex'
  })
  setProviderOwner(fixture.owner())
  const helper = await composerChat(helperProvider('codex'))
  const [viaHelper] = await helper.turn('Through the helper', [RED, BLUE])
  assert.deepEqual(
    viaHelper.images.map((image) => image.sha),
    [hash(RED.data), hash(BLUE.data)],
    'the images cross the owner and reach the CLI'
  )
  await noTempFiles('helper turn')
  const [helperNext] = await helper.turn('And on the same thread', [GREEN])
  assert.ok(helperNext.resume, 'the helper continues the thread')
  assert.equal(helperNext.images[0]?.sha, hash(GREEN.data))
  await noTempFiles('helper resume')
  script('hang')
  const beforeHelperStop = runs().length
  await helper.submit('Stop in the helper', [RED])
  await until(() => runs().length > beforeHelperStop, 'the helper turn started')
  await helper.session.interrupt()
  await noTempFiles('helper Stop')

  assert.ok(statSync(WT).isDirectory())
  console.log(
    'CODEX-COMPOSER-IMAGES OK — first, later, resumed, seeded and queued turns, Stop, errors, retries, cleanup, in-process and in the helper'
  )
} finally {
  for (const session of sessions) session.shutdown()
  await fixture?.stop()
  setProviderOwner(null)
  setProviderProbe(null)
  await shutdownTreziAgentTools()
  rmSync(scratch, { recursive: true, force: true })
}
