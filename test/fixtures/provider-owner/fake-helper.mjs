// A provider helper hosting a scripted fake provider (no SDK, no network), run by the
// Swift ProviderOwner fixture exactly as a real helper would be: the real helper host
// (`src/main/backends/helper-host.ts`) over stdin/stdout. Each user turn is a command:
//   say <text>            delta + done
//   tool <name> <json>    call a Trezi tool through the owner; reports the result
//                         (an image block as its media type and SHA-256) + done
//   ask <Tool> <detail>   a permission request; reports the answer + done
//   question              an agent question; reports the answers + done
//   edit <path>           an Edit tool note (record filesTouched) + done
//   resume <id>           reports a resumable thread id + done
//   whoami                reports model, mode and the resumed thread + done
//   error <message>       error + done
//   auth <text>           the CLI's own synthetic reply <text>, classified like the Claude
//                         adapter does: a sign-in failure is an `auth` error + done,
//                         anything else is said + done
//   images                reports each pasted image's type and SHA-256 + done
//   env                   reports environment names and open descriptors + done
//   login                 probes the stand-in Claude CLIs like the Claude adapter: an
//                         `auth` error when none is logged in, else "logged in <source>"
//   hang                  never finishes and emits nothing (Stop or the first-event deadline decides)
//   crash                 exits mid-turn
//   forge <json>          writes a raw frame to stdout, bypassing the host
//   flood <bytes>         writes one line of that many bytes
// FAKE_PROVIDER_STALL=1 never becomes ready; FAKE_PROVIDER_FAIL=1 fails to start;
// FAKE_PROVIDER_WEDGE=1 makes interrupt never answer; FAKE_PROVIDER_IGNORE_EOF=1 keeps
// running after its stdin closes (a helper the journal sweep must stop).
// The same fake is also hosted as `claude` (for the Claude-only subscription token); its
// "Check provider login" is the real Claude check, run against stand-in CLIs named by the
// arguments --claude-bundled=<path> and --claude-installed=<path:path>, and a stand-in
// `security` named by --claude-security=<path> (else the first on PATH, then the real one).
import { createHash } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { checkClaudeLogin, isAuthFailure, resolveClaudeCli } from '../../../src/main/backends/claude-login.ts'
import { runProviderHelper } from '../../../src/main/backends/helper-host.ts'
import { createRecordCapture } from '../../../src/main/backends/record.ts'

const sha = (base64) => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')

const fake = {
  id: 'fake',
  startSession: async (root, options, _getWindow, ctx) => {
    if (process.env.FAKE_PROVIDER_FAIL === '1') throw new Error('fake provider could not sign in')
    if (process.env.FAKE_PROVIDER_STALL === '1') await new Promise(() => {})
    const cap = createRecordCapture(root, 'fake')
    const pending = new Map()
    const pendingQuestions = new Map()
    let model = options.model ?? null
    let mode = options.permissionMode ?? 'default'
    let disposed = false
    let counter = 0
    const emit = (event) => { if (!disposed) ctx.onEvent({ ...event, projectKey: ctx.emitKey, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) }) }
    const say = (text) => { cap.appendAssistant(text); emit({ type: 'delta', text }) }
    const done = () => { cap.finalize(); emit({ type: 'done' }) }
    emit({ type: 'commands', commands: [{ name: 'fake', description: 'A fake command' }] })
    emit({ type: 'model', model: 'claude-opus-5-5' })
    const run = async (text, images) => {
      const [command, ...rest] = text.split(' ')
      const arg = rest.join(' ')
      switch (command) {
        case 'say': say(arg); return done()
        case 'tool': {
          const [name, ...json] = rest
          try {
            const result = await ctx.tools.invoke(name, json.length ? JSON.parse(json.join(' ')) : {})
            const image = result?.content?.find((block) => block.type === 'image')
            say(image ? `image ${image.mimeType} ${sha(image.data)}` : `result ${JSON.stringify(result)}`)
          } catch (error) {
            say(`tool-error ${error.message}`)
          }
          return done()
        }
        case 'ask': {
          const [tool, ...detail] = rest
          const id = `perm-${++counter}`
          pending.set(id, { toolName: tool, settle: (behavior) => { pending.delete(id); say(`permission ${behavior}`); done() } })
          emit({ type: 'permission-request', request: { id, toolName: tool, title: `Allow ${tool}?`, ...(detail.length ? { detail: detail.join(' ') } : {}), sessionKey: ctx.emitKey } })
          return
        }
        case 'question': {
          const id = `q-${++counter}`
          const questions = [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }]
          pendingQuestions.set(id, { settle: (answers) => { pendingQuestions.delete(id); say(`answers ${JSON.stringify(answers)}`); done() } })
          emit({ type: 'question-request', request: { id, questions, sessionKey: ctx.emitKey } })
          return
        }
        case 'edit': cap.noteTool('Edit', { file_path: arg }); emit({ type: 'status', text: `Edit · ${arg}` }); return done()
        case 'resume': cap.setSdkSessionId(arg); return done()
        case 'whoami': say(`model=${model} mode=${mode} resumed=${ctx.resumeSessionId ?? 'none'}`); return done()
        case 'error': emit({ type: 'error', message: arg }); return done()
        case 'auth':
          if (!isAuthFailure({ message: { model: '<synthetic>', content: [{ type: 'text', text: arg }] } })) { say(arg); return done() }
          emit({ type: 'error', code: 'auth', message: arg }); return done()
        case 'login': {
          // What the Claude adapter does before its first query: probe the CLIs, then the
          // CLI's own "Not logged in" reply when none is signed in.
          const cli = await resolveClaudeCli(true, claudeCandidates())
          const used = cli.installed.find((c) => c.path === cli.executable)?.auth ?? cli.bundled.auth
          if (used.loggedIn !== true) { emit({ type: 'error', code: 'auth', message: 'Not logged in · Please run /login' }); return done() }
          say(`logged in ${cli.source}`); return done()
        }
        case 'images': say(`images ${JSON.stringify((images ?? []).map((image) => [image.mediaType, sha(image.data)]))}`); return done()
        case 'env': {
          const inodes = []
          for (let fd = 0; fd < 256; fd++) { try { const s = fstatSync(fd); inodes.push([s.dev, s.ino]) } catch {} }
          say(`env ${JSON.stringify({ names: Object.keys(process.env).sort(), inodes })}`)
          return done()
        }
        case 'hang': return
        case 'crash': return process.exit(7)
        case 'forge': process.stdout.write(`${arg}\n`); return
        case 'flood': process.stdout.write(`${'x'.repeat(Number(arg))}\n`); return
        default: say(`unknown ${command}`); return done()
      }
    }
    return {
      key: 'fake', root, options, record: cap.record, pending, pendingQuestions, emit, finalize: cap.finalize,
      send: (text, images) => { void run(text, images) },
      dispose: () => { disposed = true },
      shutdown: () => {},
      setModel: async (next) => { model = next },
      setPermissionMode: async (next) => { mode = next },
      interrupt: async () => {
        if (process.env.FAKE_PROVIDER_WEDGE === '1') return new Promise(() => {})
        for (const [id, p] of pending) { pending.delete(id); emit({ type: 'permission-resolved', id }); void p }
        done()
        return undefined
      }
    }
  }
}

// Arguments, not variables: a Claude helper gets only the allowlisted CLAUDE_* names (LKM-124).
function claudeCandidates() {
  const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''
  return {
    bundled: flag('claude-bundled') || null,
    installed: flag('claude-installed').split(':').filter(Boolean),
    ...(flag('claude-security') ? { security: flag('claude-security') } : {})
  }
}

const claude = {
  ...fake,
  id: 'claude',
  checkLogin: () => checkClaudeLogin(claudeCandidates())
}

if (process.env.FAKE_PROVIDER_IGNORE_EOF === '1') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
  runProviderHelper({ fake, claude }, { input: process.stdin, output: process.stdout, exit: () => {} })
} else {
  runProviderHelper({ fake, claude })
}
