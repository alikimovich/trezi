import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NativeView } from '../../native/platform'
import type { AgentEvent, AgentOptions, ProviderLoginReport } from '../../shared/api'
import { projectKey } from '../../shared/projectKey'
import { treziRules } from '../rules'
import { compatibilityCatalog } from '../session-skills'
import { createRecordCapture } from './record'
import { describeTool, sendToRenderer } from './tools'
import type { ModelProvider, PendingPrompt, ProviderSession, SpawnContext } from './types'

/**
 * OPTIONAL (LKM-315) — Google Gemini backend via the **Gemini CLI** (`gemini`).
 * Unlike the Claude and Codex backends, this provider has NO SDK dependency in
 * package.json — it shells out to an external `gemini` binary that most installs
 * won't have. So `pickProvider` (see ./index.ts) routes to it only while the user
 * turned Gemini on in Settings → AI Providers (`../gemini-setting.ts`); off, its
 * models are not listed and no Gemini helper starts.
 *
 * Auth is the user's **Google account** ("Login with Google": run `gemini` once and
 * sign in), or a Gemini API key saved in Settings: the service keeps it encrypted
 * with the Keychain helper and puts it only into a Gemini helper's environment as
 * `GEMINI_API_KEY` (`ProviderLaunch.swift`). Gemini edits the repo with its own
 * tools; we just map its headless JSONL event stream to trezi's `AgentEvent` stream.
 *
 * Each turn spawns `gemini -p <prompt> --output-format stream-json [-m <model>]` in
 * the repo and streams its JSONL events (`init`/`message`/`tool_use`/`tool_result`/
 * `error`/`result`). Reachable only when `AgentOptions.provider === 'gemini'`. If the
 * CLI isn't installed or the user isn't signed in, the turn fails soft (error + done).
 *
 * KNOWN LIMITATION: headless `-p` runs one turn per process, so conversation
 * context does not carry across turns yet (a follow-up can use the CLI's session/
 * checkpoint mode or ACP for a persistent thread).
 */

/**
 * The `gemini` to run: `TREZI_GEMINI_BIN` (tests force the CLI-absent path with it,
 * even on machines where a real `gemini` is installed), else the first executable on
 * PATH or in the usual install folders (an app opened from the Finder has a short
 * PATH), else the bare name, which fails soft at spawn.
 */
export function geminiBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TREZI_GEMINI_BIN) return env.TREZI_GEMINI_BIN
  const home = env.HOME || homedir()
  const candidates = [
    ...(env.PATH ?? '')
      .split(':')
      .filter(Boolean)
      .map((dir) => join(dir, 'gemini')),
    '/opt/homebrew/bin/gemini',
    '/usr/local/bin/gemini',
    join(home, '.local/bin/gemini'),
    join(home, '.npm-global/bin/gemini'),
    join(home, '.bun/bin/gemini')
  ]
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return 'gemini'
}

/** Ways the Gemini CLI can be signed in, as the helper sees them (names, never values). */
function geminiAuth(env: NodeJS.ProcessEnv): string | null {
  if (env.GEMINI_API_KEY) return 'Gemini API key'
  if (env.GOOGLE_API_KEY) return 'Google API key'
  if (env.GOOGLE_GENAI_USE_VERTEXAI === 'true') return 'Vertex AI'
  if (existsSync(join(env.HOME || homedir(), '.gemini/oauth_creds.json')))
    return 'Login with Google'
  return null
}

/** "Check provider login" for Gemini (LKM-315): the CLI is there and some sign-in is set up. */
async function checkGeminiLogin(): Promise<Omit<ProviderLoginReport, 'provider'>> {
  const executable = geminiBin()
  const version = await new Promise<string | null>((resolve) => {
    execFile(executable, ['--version'], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? null : String(stdout).trim().split('\n')[0].slice(0, 80))
    )
  })
  const token = !!process.env.GEMINI_API_KEY
  if (version === null)
    return {
      loggedIn: false,
      token,
      detail:
        'The Gemini CLI was not found. Install it (npm install -g @google/gemini-cli), then run gemini and choose Login with Google.'
    }
  const method = geminiAuth(process.env)
  return {
    loggedIn: !!method,
    executable,
    token,
    ...(method ? { authMethod: method } : {}),
    detail: `Gemini CLI ${version}: ${method ? `signed in with ${method}` : 'not signed in. Run gemini and choose Login with Google, or save a Gemini API key in Settings.'}`
  }
}

/** Map one parsed Gemini JSONL event to a trezi AgentEvent (or null to ignore). */
function mapEvent(ev: unknown): AgentEvent | null {
  const e = ev as Record<string, unknown>
  const type = e?.type as string | undefined
  switch (type) {
    case 'message': {
      // Assistant text chunk. Shape-tolerant: text may be nested.
      const text =
        (e?.text as string | undefined) ??
        (e?.content as string | undefined) ??
        ((e?.message as Record<string, unknown> | undefined)?.text as string | undefined)
      const role = (e?.role as string | undefined) ?? 'assistant'
      if (role === 'assistant' && typeof text === 'string' && text) return { type: 'delta', text }
      return null
    }
    case 'tool_use': {
      const name = (e?.name ?? e?.tool ?? 'tool') as string
      return { type: 'status', text: describeTool(String(name), e) }
    }
    case 'error': {
      const msg = (e?.message ?? e?.error ?? 'Gemini error') as string
      return { type: 'error', message: String(msg) }
    }
    // 'init' / 'tool_result' / 'result' carry no chat text we surface; 'result'
    // ends the turn (handled on process close).
    default:
      return null
  }
}

async function startSession(
  root: string,
  options: AgentOptions,
  getWindow: () => NativeView | null,
  // v9 resume/multi-chat: Gemini has no resume primitive here (headless `-p` runs
  // don't carry a session id at all yet) — accept the context and no-op the resume;
  // `emitKey` is still honored so an additional live chat routes to its own slice.
  ctx?: SpawnContext
): Promise<ProviderSession> {
  const key = projectKey(root)
  // `emitKey` tags live events (so an additional/resumed chat's `${key}#…` sessionKey
  // routes into its own renderer chat slice) — but the PERSISTED record must keep the
  // canonical `key`, since `sessions-store.ts#list`/`agent:sessions-list` always query
  // by the plain projectKey(root); tagging the record with `emitKey` would orphan an
  // additional/resumed chat's history entry (no lookup could ever find it again).
  const emitKey = ctx?.emitKey ?? key
  const cap = createRecordCapture(root, key)
  const pending = new Map<string, PendingPrompt>()
  let disposed = false
  let aborted = false
  let child: ChildProcessWithoutNullStreams | null = null
  // Each turn is its own process, so a model switch applies from the next one.
  let model = options.model && options.model !== 'default' ? options.model : undefined
  // trezi rules (v8 R): no system-prompt arg here, so prepend them to the first turn.
  let firstTurn = true
  // LKM-287: experimental — the pinned library skills as a compatibility catalog. Gemini
  // CLI may limit its file tools to the workspace, so a body can be out of its reach.
  const skillsCatalog = compatibilityCatalog(ctx?.skills, 'gemini')

  const emit = (event: AgentEvent): void => {
    if (disposed) return
    const tagged = { ...event, projectKey: emitKey }
    // agent.ts's in-process hook — v9 workspace-snapshot isRunning tracking
    // (set for every interactive session: default, new-chat, resumed).
    ctx?.onEvent?.(tagged)
    sendToRenderer(getWindow, 'agent:event', tagged)
  }

  // Serialize turns: each send() runs one `gemini -p` process to completion.
  let chain: Promise<void> = Promise.resolve()
  // Set by `interrupt` for the CURRENT turn only (unlike session-level `aborted`),
  // so the kill it performs isn't reported to the user as a crash.
  let turnInterrupted = false
  const runTurn = (text: string): Promise<void> =>
    new Promise<void>((resolve) => {
      if (aborted || disposed) return resolve()
      turnInterrupted = false
      let proc: ChildProcessWithoutNullStreams
      try {
        // No model: the CLI's own default. Otherwise a picker alias (`pro`, `flash`, …).
        const args = ['-p', text, '--output-format', 'stream-json', ...(model ? ['-m', model] : [])]
        proc = spawn(geminiBin(), args, { cwd: root, env: process.env })
      } catch (err) {
        emit({
          type: 'error',
          message: `Gemini backend unavailable: ${err instanceof Error ? err.message : String(err)}. Install the Gemini CLI and run \`gemini\` to sign in with Google.`
        })
        emit({ type: 'done' })
        return resolve()
      }
      child = proc
      let buf = ''
      const onLine = (line: string): void => {
        const s = line.trim()
        if (!s) return
        let ev: unknown
        try {
          ev = JSON.parse(s)
        } catch {
          return // non-JSON noise
        }
        const mapped = mapEvent(ev)
        if (!mapped || disposed || aborted) return
        if (mapped.type === 'delta') cap.appendAssistant(mapped.text)
        else if (mapped.type === 'status') cap.noteTool('gemini', ev)
        emit(mapped)
      }
      proc.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          onLine(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
        }
      })
      // Surface a spawn failure (e.g. CLI not installed) as an auth-shaped error.
      proc.on('error', (err) => {
        emit({
          type: 'error',
          message: `Gemini CLI not found: ${err.message}. Install it and run \`gemini\` to sign in with Google.`
        })
      })
      proc.on('close', (codeNum) => {
        if (buf.trim()) onLine(buf)
        // A non-zero exit with no streamed text usually means not-signed-in / bad input.
        // A turn the USER stopped exits non-zero by definition — reporting that as
        // "Gemini exited with code null" would turn pressing Stop into an error.
        // With no sign-in set up it is an `auth` error, so the chat shows the same
        // sign-in card as for Claude and Codex (LKM-315).
        if (codeNum !== 0 && !aborted && !turnInterrupted) {
          emit(
            geminiAuth(process.env)
              ? {
                  type: 'error',
                  message: `Gemini exited with code ${codeNum}. If you haven't signed in, run \`gemini\` and Login with Google.`
                }
              : {
                  type: 'error',
                  code: 'auth',
                  message:
                    'Gemini is not signed in. Run gemini and choose Login with Google, or save a Gemini API key in Settings → AI Providers → Gemini….'
                }
          )
        }
        cap.finalize()
        emit({ type: 'done' })
        child = null
        resolve()
      })
    })

  return {
    key,
    root,
    options,
    // Gemini CLI is text-only here; images (paste/drop) are ignored for now.
    send: (text, _images) => {
      const prompt = firstTurn
        ? `${treziRules({ projectMemory: ctx?.projectMemory })}${skillsCatalog ? `\n\n${skillsCatalog}` : ''}\n\n---\n\n${text}`
        : text
      firstTurn = false
      chain = chain.then(() => runTurn(prompt))
    },
    setModel: async (next) => {
      model = next && next !== 'default' ? next : undefined
    },
    pending,
    emit,
    record: cap.record,
    finalize: cap.finalize,
    dispose: () => {
      disposed = true
    },
    shutdown: () => {
      aborted = true
      child?.kill()
    },
    // Gemini had NO interrupt at all, so Stop was a silent no-op here: the button
    // did nothing and the turn ran to completion. A turn IS one `gemini -p` child,
    // so killing it ends the turn (its `close` handler emits the `done`) while
    // leaving the session able to take the next one. Local and synchronous, so it
    // can't wedge the way a control-request round trip can — no `hardStopped`.
    interrupt: async () => {
      if (!child) return undefined
      turnInterrupted = true
      child.kill()
      return undefined
    }
  }
}

export const geminiProvider: ModelProvider = {
  id: 'gemini',
  startSession,
  checkLogin: checkGeminiLogin
}
