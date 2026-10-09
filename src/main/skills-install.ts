/**
 * The contract of a curated skill-pack install (`npx skills add …`). The service's
 * workflow owner runs it (service/WorkflowTools.swift, journaled); the agent tool
 * reaches it through `workflowOwner().installSkills`. The pure catalog and argv builder
 * live in skill-packs.ts, and only packs in that allowlist are installed.
 *
 * Scope → target dir:
 *   project → <liveRoot>/.claude/skills   (NO -g)
 *   user    → ~/.claude/skills            (-g via buildInstallArgs)
 *
 * liveRoot is the LIVE checkout, not a per-chat worktree — the caller threads it from
 * SpawnContext.liveRoot. An install never throws for a normal failure (unknown pack,
 * non-zero exit, timeout, spawn error): it resolves to `ok: false`.
 */

export interface InstallInput {
  packId: string
  scope: 'project' | 'user'
  liveRoot: string
}

export interface InstallResult {
  ok: boolean
  packId: string
  scope: 'project' | 'user'
  /** Where skills land for this scope. */
  targetDir: string
  /** Skill folder names found in targetDir afterward (best-effort). */
  installed: string[]
  message: string
  stderr?: string
}
