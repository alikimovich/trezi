import { resolve } from 'node:path'

/** Shared Claude/Codex command policy. Hooks run before any permission bypass. */
export function gitCommandRefusal(command, access, liveRoot = '', workRoot = '', liveBranch = '') {
  const pattern = /(?:^|[;&|\n(]\s*|\s)(?:\S*\/)?git\s+((?:(?:-C|--git-dir|--work-tree)\s+\S+\s+)*)(add|am|apply|bisect|branch|checkout|cherry-pick|clean|commit|fetch|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|update-ref|worktree)\b([^;&|\n]*)/gi
  for (const match of command.matchAll(pattern)) {
  const verb = match[2].toLowerCase()
  const args = match[3].trim()
  const branchMutation = /(?:^|\s)(?:-d|-D|-f|-m|-M|-c|-C|--delete|--force|--move|--copy|--set-upstream-to)(?:\s|$)/.test(args)
  const readOnly =
    (verb === 'branch' && !branchMutation && (!args || /^(?:--show-current|--list|-l|-a|-r|--all|--remotes)(?:\s|$)/.test(args))) ||
    (verb === 'stash' && /^(?:list|show)(?:\s|$)/.test(args)) ||
    (verb === 'tag' && !/(?:^|\s)(?:-d|-f|--delete|--force)(?:\s|$)/.test(args) && (!args || /^(?:-l|--list)(?:\s|$)/.test(args))) ||
    (verb === 'worktree' && /^list(?:\s|$)/.test(args))
  if (readOnly) continue
  const tool = verb === 'push' ? 'publish_update' : verb === 'commit' ? 'git_merge_continue' : ['merge', 'fetch', 'pull'].includes(verb) ? 'git_sync_base' : 'Trezi Git tools'
  if (access === 'managed') return `Agent Git access is Managed. Raw git ${verb} is refused; use ${tool} in this chat worktree.`
  const directory = match[1].match(/-C\s+(['"]?)(\S+?)\1(?:\s|$)/)?.[2]
  const targetsLive = liveRoot && (
    match[1].includes(liveRoot) ||
    (directory && workRoot && resolve(workRoot, directory) === resolve(liveRoot)) ||
    command.includes(`cd ${liveRoot} &&`) || command.includes(`cd '${liveRoot}' &&`) ||
    command.includes(`cd "${liveRoot}" &&`) ||
    command.includes(`cd ${liveRoot};`) || command.includes(`cd '${liveRoot}';`)
  )
  const targetsLiveRef = liveBranch && (
    (verb === 'update-ref' && args.includes(`refs/heads/${liveBranch}`)) ||
    (verb === 'branch' && branchMutation && args.split(/\s+/).includes(liveBranch)) ||
    ((verb === 'checkout' || verb === 'switch') && /(?:^|\s)(?:-B|-C)(?:\s|$)/.test(args) && args.split(/\s+/).includes(liveBranch))
  )
  if (verb === 'push' || targetsLive || targetsLiveRef)
    return `Agent Git access is Full, but raw pushes and changes to the live branch are refused. Use ${tool} from the chat worktree.`
  }
  return null
}
