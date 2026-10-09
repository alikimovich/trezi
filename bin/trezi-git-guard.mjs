#!/usr/bin/env node
// Codex PreToolUse command hook. The mode is fixed when the chat opens; stdin is
// one tool call. A denial is returned before the shell command runs.
import { execFileSync } from 'node:child_process'
import { gitCommandRefusal } from './trezi-git-policy.mjs'
let input = ''
const access = process.argv[2] === 'full' ? 'full' : 'managed'
const liveRoot = process.argv[3]
const workRoot = process.argv[4]
for await (const chunk of process.stdin) input += chunk
try {
  const call = JSON.parse(input)
  const command = call?.tool_input?.command
  if (call?.tool_name === 'Bash' && typeof command === 'string') {
    let liveBranch = ''
    try { liveBranch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: liveRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
    const refusal = gitCommandRefusal(command, access, liveRoot, workRoot, liveBranch)
    if (refusal) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: refusal
        }
      }))
    }
  }
} catch {
  // Invalid hook input is a harness error. Do not print untrusted bytes.
  process.exitCode = 2
}
