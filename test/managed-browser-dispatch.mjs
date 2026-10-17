// Actual installed provider CLIs, deterministic loopback model APIs, fake credentials.
// No provider subscription or browser is used. Run serially; no desktop/Swift fixtures.
import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Codex } from '@openai/codex-sdk'
import { gitAccessHook } from '../src/main/backends/codex-mcp.ts'
import {
  managedBrowserCodexConfig,
  managedBrowserEnv,
  managedBrowserRefusal,
  trustedCodexHookOverrides
} from '../src/main/backends/managed-browser-path.ts'

const repo = join(import.meta.dir, '..')
const scratch = mkdtempSync(join(tmpdir(), 'trezi-browser-dispatch-'))
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const fixtures = []
for (const shape of ['src/main/backends', 'out/native']) {
  const root = join(scratch, shape.startsWith('src') ? 'source with spaces' : 'bundle')
  const base = join(root, shape)
  mkdirSync(base, { recursive: true })
  mkdirSync(join(root, 'bin/managed'), { recursive: true })
  mkdirSync(join(root, 'global'), { recursive: true })
  const marker = join(root, 'managed.marker'),
    globalMarker = join(root, 'global.marker')
  for (const [path, output] of [
    [join(root, 'bin/managed/agent-browser'), marker],
    [join(root, 'global/agent-browser'), globalMarker]
  ]) {
    writeFileSync(
      path,
      `#!/bin/sh\nprintf 'executed\\n' >> ${shellQuote(output)}\nprintf 'managed-fixture-ok\\n'\n`
    )
    chmodSync(path, 0o755)
  }
  for (const file of ['trezi-browser-guard.mjs', 'trezi-browser-policy.mjs'])
    copyFileSync(join(repo, 'bin', file), join(root, 'bin', file))
  fixtures.push({ root, base, marker, globalMarker, global: join(root, 'global/agent-browser') })
}
const cleanEnv = (home) => ({
  PATH: `${join(home, 'global')}:/usr/bin:/bin:/usr/sbin:/sbin:${join(process.execPath, '..')}`,
  HOME: home,
  TMPDIR: scratch,
  CODEX_HOME: home,
  CLAUDE_CONFIG_DIR: home,
  OPENAI_API_KEY: 'fixture-only',
  ANTHROPIC_API_KEY: 'fixture-only',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  SHELL: '/bin/zsh'
})
let pending,
  result,
  requests = 0
const sse = (events) =>
  new Response(events.map((x) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' }
  })
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const body = await req.json().catch(() => ({}))
    if (!path.endsWith('/responses') && !path.endsWith('/messages')) return Response.json({})
    requests++
    const command = pending
    pending = undefined
    if (path.endsWith('/responses')) {
      const outputs = body.input?.filter((x) => x.type === 'function_call_output')
      if (!command) result = outputs?.at(-1)?.output
      const item = command
        ? {
            id: `fc_${requests}`,
            type: 'function_call',
            call_id: `call_${requests}`,
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: command,
              yield_time_ms: 1000,
              max_output_tokens: 1000
            }),
            status: 'completed'
          }
        : {
            id: `msg_${requests}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done.', annotations: [] }]
          }
      const response = {
        id: `resp_${requests}`,
        object: 'response',
        created_at: 1,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
      return sse([
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response }
      ])
    }
    const outputs = body.messages
      ?.flatMap((x) => (Array.isArray(x.content) ? x.content : []))
      .filter((x) => x.type === 'tool_result')
    if (!command) result = JSON.stringify(outputs?.at(-1)?.content)
    const content = command
      ? {
          type: 'tool_use',
          id: `tool_${requests}`,
          name: 'Bash',
          input: { command, description: 'Hermetic managed browser routing fixture' }
        }
      : { type: 'text', text: 'Done.' }
    const message = {
      id: `msg_${requests}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-fixture',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }
    return sse([
      { type: 'message_start', message },
      {
        type: 'content_block_start',
        index: 0,
        content_block: command ? { ...content, input: {} } : content
      },
      ...(command
        ? [
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
            }
          ]
        : []),
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 }
      },
      { type: 'message_stop' }
    ])
  }
})
const endpoint = `http://127.0.0.1:${server.port}`
function check(f, denied, before) {
  assert.equal(pending, undefined, 'the actual CLI requested the fixture tool call')
  assert.equal(existsSync(f.globalMarker), false, 'the unapproved global browser never executed')
  assert.equal(
    existsSync(f.marker) ? readFileSync(f.marker, 'utf8').split('\n').filter(Boolean).length : 0,
    before + (denied ? 0 : 1),
    'only the approved managed route executes'
  )
  assert.match(
    String(result),
    denied ? /managed|global|blocked|refus/i : /managed-fixture-ok/,
    'the CLI returned the real hook/shell outcome to its loopback API'
  )
}
try {
  // Default SDK binary follows the lockfile; optional installed override exercises a
  // second operator CLI without relying on it for normal unit-tier coverage.
  const binaries = [
    undefined,
    ...(process.env.TREZI_DISPATCH_CODEX_BIN ? [process.env.TREZI_DISPATCH_CODEX_BIN] : [])
  ]
  for (const binary of binaries)
    for (const f of fixtures) {
      rmSync(f.marker, { force: true })
      const home = mkdtempSync(join(scratch, 'codex-'))
      const env = cleanEnv(home)
      const browser = managedBrowserCodexConfig(f.base, env.PATH, process.execPath)
      const git = gitAccessHook(repo, 'managed', home, home)
      const groups = [...git.hooks.PreToolUse, ...browser.hooks.PreToolUse]
      const unrelatedMarker = join(home, 'unrelated-hook.marker')
      writeFileSync(
        join(home, 'hooks.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: '^Bash$',
                hooks: [{ type: 'command', command: `touch ${shellQuote(unrelatedMarker)}` }]
              }
            ]
          }
        })
      )
      const codex = new Codex({
        ...(binary ? { codexPathOverride: binary } : {}),
        env,
        configOverrides: trustedCodexHookOverrides(groups),
        config: {
          ...browser,
          hooks: { PreToolUse: groups },
          model_provider: 'fixture',
          model_providers: {
            fixture: {
              name: 'fixture',
              base_url: `${endpoint}/v1`,
              wire_api: 'responses',
              env_key: 'OPENAI_API_KEY'
            }
          },
          features: { hooks: true, shell_snapshot: false },
          analytics: { enabled: false }
        }
      })
      const options = {
        workingDirectory: home,
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        model: 'fixture-model'
      }
      let thread = codex.startThread(options)
      for (const [index, command] of [
        '"$TREZI_AGENT_BROWSER" snapshot --session trezi-fixture',
        `command -p -- ${shellQuote(f.global)} snapshot --session trezi-fixture`,
        'git push origin main',
        `${shellQuote(join(f.root, 'bin/managed/agent-browser'))} snapshot --session trezi-fixture`
      ].entries()) {
        pending = command
        result = undefined
        const turn = await thread.run('Execute the fixture action.', {
          signal: AbortSignal.timeout(20000)
        })
        assert.ok(
          !turn.items.some(
            (item) =>
              item.type === 'error' &&
              /unrecognized configuration|ignored.*hooks/.test(item.message)
          ),
          'actual CLI accepts exact hook trust configuration'
        )
        check(f, index === 1 || index === 2, index === 0 ? 0 : 1)
        assert.equal(
          existsSync(unrelatedMarker),
          false,
          'an unrelated untrusted user hook remains untrusted'
        )
        assert.ok(thread.id, 'actual CLI supplied a resumable session')
        thread = codex.resumeThread(thread.id, options)
      }
      console.log(
        `PASS actual Codex ${binary ? 'installed' : 'bundled'} ${f.base.endsWith('out/native') ? 'bundle' : 'source'} first/resumed dispatch`
      )
    }
  for (const f of fixtures) {
    rmSync(f.marker, { force: true })
    const home = mkdtempSync(join(scratch, 'claude-'))
    const env = {
      ...cleanEnv(home),
      ...managedBrowserEnv(f.base, cleanEnv(home).PATH, process.execPath),
      ANTHROPIC_BASE_URL: endpoint
    }
    let session
    for (const [index, command] of [
      '"$TREZI_AGENT_BROWSER" snapshot --session trezi-fixture',
      `command -p -- ${shellQuote(f.global)} snapshot --session trezi-fixture`,
      `${shellQuote(join(f.root, 'bin/managed/agent-browser'))} snapshot --session trezi-fixture`
    ].entries()) {
      pending = command
      result = undefined
      const q = query({
        prompt: 'Execute the fixture action.',
        options: {
          cwd: home,
          ...(process.env.TREZI_DISPATCH_CLAUDE_BIN
            ? { pathToClaudeCodeExecutable: process.env.TREZI_DISPATCH_CLAUDE_BIN }
            : {}),
          env,
          settingSources: [],
          model: 'claude-fixture',
          permissionMode: 'acceptEdits',
          allowedTools: ['Bash'],
          maxTurns: 3,
          ...(session ? { resume: session } : {}),
          hooks: {
            PreToolUse: [
              {
                matcher: '^Bash$',
                hooks: [
                  async (input) => {
                    const refusal = managedBrowserRefusal(
                      f.base,
                      input.tool_name,
                      input.tool_input,
                      home
                    )
                    return refusal
                      ? {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: refusal
                          }
                        }
                      : {}
                  }
                ]
              }
            ]
          }
        }
      })
      const timer = setTimeout(() => q.close(), 20000)
      try {
        for await (const event of q) {
          if (event.session_id) session = event.session_id
        }
      } finally {
        clearTimeout(timer)
        q.close()
      }
      check(f, index === 1, index === 0 ? 0 : 1)
      assert.ok(session, 'actual Claude session is resumable')
    }
    console.log(
      `PASS actual Claude ${f.base.endsWith('out/native') ? 'bundle' : 'source'} first/resumed dispatch`
    )
  }
} finally {
  server.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}
