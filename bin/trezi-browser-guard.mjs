#!/usr/bin/env node
// Codex PreToolUse command hook (LKM-269). argv[2] is the verified absolute path of
// Trezi's managed agent-browser wrapper, or empty when this install has none; stdin is
// one tool call. A denial is returned before the shell command runs.
import { browserCommandRefusal } from './trezi-browser-policy.mjs'
let input = ''
const wrapper = process.argv[2] || undefined
for await (const chunk of process.stdin) input += chunk
try {
  const call = JSON.parse(input)
  const command = call?.tool_input?.command
  if (call?.tool_name === 'Bash' && typeof command === 'string') {
    const refusal = browserCommandRefusal(command, wrapper, call?.cwd)
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
