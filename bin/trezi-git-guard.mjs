#!/usr/bin/env node
// Codex PreToolUse command hook. The mode is fixed when the chat opens; stdin is
// one tool call. A denial is returned before the shell command runs.
let input = ''
const access = process.argv[2] === 'full' ? 'full' : 'managed'
const liveRoot = process.argv[3]
for await (const chunk of process.stdin) input += chunk
try {
  const call = JSON.parse(input)
  const command = call?.tool_input?.command
  if (call?.tool_name === 'Bash' && typeof command === 'string') {
    const match = command.match(/(?:^|[;&|\n(]\s*|\s)(?:\S*\/)?git\s+(?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*(add|am|apply|bisect|branch|checkout|cherry-pick|clean|commit|fetch|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|update-ref|worktree)\b/i)
    if (match) {
      const verb = match[1].toLowerCase()
      const liveTarget = liveRoot && command.includes(liveRoot) && /(?:^|\s)(?:\S*\/)?git\s+-C\s+/.test(command)
      if (access === 'full' && verb !== 'push' && !liveTarget) process.exit(0)
      const tool = verb === 'push' ? 'publish_update' : verb === 'commit' ? 'git_merge_continue' : ['merge', 'fetch', 'pull'].includes(verb) ? 'git_sync_base' : 'Trezi Git tools'
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: access === 'full'
            ? `Git changes to the live checkout and raw pushes are refused. Use ${tool} from the chat worktree.`
            : `Agent Git access is Managed. Raw git ${verb} is refused; use ${tool}.`
        }
      }))
    }
  }
} catch {
  // Invalid hook input is a harness error. Do not print untrusted bytes.
  process.exitCode = 2
}
