/**
 * chat-worktrees.ts through the Swift repository owner (test/repository-owner.mjs runs\n * it with the owner preloaded). Per-CHAT worktree isolation (v9):
 * every interactive chat runs in its own `trezi/chat-<id>` worktree, and after each
 * completed turn its work auto-merges onto the LIVE tree; on mid-turn drift the turn
 * PARKS on the branch instead of clobbering the user's edit.
 *
 * Asserts: fork includes the live WIP and lands on `trezi/chat-<id>` with its own cloned
 * node_modules and .env symlinked; a chat install/remove never touches the live
 * node_modules (LKM-146); turn-1 completeTurn merges onto the live tree and advances the base;
 * turn-2's diff is INCREMENTAL (only the new file, base advanced past turn-1); syncFromLive
 * mirrors a between-turn live edit and no-ops when identical; mid-turn drift on a touched
 * file PARKS and does NOT clobber the live file; a parked second turn re-squashes into ONE
 * cumulative commit; applyParked 3-way-applies onto a DIRTY live tree; discardParked resets
 * the worktree (keeping the branch); `clean -fd` spares the node_modules/.env symlinks.
 * Uses real temp git repos.
 *
 * Run with: bun test/repository-owner.mjs
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyParked,
  completeTurn,
  createChatWorktree,
  discardParked,
  stageResolve,
  syncFromLive
} from '../src/main/chat-worktrees.ts'
import { provisionDependencies } from '../src/main/worktree-dependencies.ts'

const base = mkdtempSync(join(tmpdir(), 'trezi-cwt-'))
const worktreesDir = join(base, 'worktrees')
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** Spin up a fresh temp git repo with node_modules/.env gitignored + committed files. */
function makeRepo(name, files) {
  const repo = join(base, name)
  mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-q', '-b', 'main')
  g(repo, 'config', 'user.name', 'Test')
  g(repo, 'config', 'user.email', 'test@local')
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
  // Real runtime deps the worktree symlinks in — present so the links resolve.
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', '.marker'), 'dep\n')
  writeFileSync(join(repo, '.env'), 'SECRET=1\n')
  for (const [f, content] of Object.entries(files)) writeFileSync(join(repo, f), content)
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', 'init')
  return repo
}

try {
  // ============================================================================
  // repo1 — fork includes WIP · turn-1 merge · turn-2 incremental · syncFromLive
  //         · clean -fd spares symlinks
  // ============================================================================
  const repo1 = makeRepo('repo1', { 'README.md': 'base\n' })
  // The interactive main agent has uncommitted WIP + an untracked file in the live tree.
  writeFileSync(join(repo1, 'README.md'), 'base\nWIP\n')
  writeFileSync(join(repo1, 'Untracked.tsx'), 'export const New = () => null\n')

  const wt = await createChatWorktree(repo1, 'chatone', worktreesDir)
  ok(wt.branch === 'trezi/chat-chatone', `fork lands on trezi/chat-<id>: ${wt.branch}`)
  ok(existsSync(wt.path), 'chat worktree checkout exists')
  ok(readFileSync(join(wt.path, 'README.md'), 'utf8').includes('WIP'), 'fork includes the live WIP')
  ok(existsSync(join(wt.path, 'Untracked.tsx')), 'fork includes the untracked live file')
  ok(existsSync(join(wt.path, 'node_modules', '.marker')), 'node_modules cloned into the fork')
  ok(
    lstatSync(join(wt.path, 'node_modules')).isDirectory(),
    'the fork owns its node_modules (a real folder, not a link to the live one)'
  )
  ok(existsSync(join(wt.path, '.env')), '.env symlinked into the fork')

  // --- turn 1: agent creates FileA in the worktree → completeTurn merges onto live ---
  writeFileSync(join(wt.path, 'FileA.tsx'), 'a\n')
  const t1 = await completeTurn(repo1, wt, 'turn 1')
  ok(t1.outcome === 'merged', `turn 1 merges: ${JSON.stringify(t1.outcome)}`)
  ok(!!t1.newBase, 'merged turn returns a newBase for the caller to advance')
  ok(t1.files.includes('FileA.tsx'), `turn-1 files: ${JSON.stringify(t1.files)}`)
  ok(
    existsSync(join(repo1, 'FileA.tsx')) &&
      readFileSync(join(repo1, 'FileA.tsx'), 'utf8') === 'a\n',
    'turn 1 landed FileA on the LIVE tree'
  )
  ok(
    readFileSync(join(repo1, 'README.md'), 'utf8').includes('WIP'),
    "the main agent's live WIP survived the merge"
  )
  ok(
    t1.edits.length === 1 && t1.edits[0].after === 'a\n',
    `merged turn returns before/after edits for undo: ${JSON.stringify(t1.edits)}`
  )
  wt.baseSha = t1.newBase // caller advances the base after a merge

  // --- turn 2: agent creates FileB → diff is INCREMENTAL (FileA already merged/based) ---
  const beforeTurn2Base = wt.baseSha
  writeFileSync(join(wt.path, 'FileB.tsx'), 'b\n')
  const t2 = await completeTurn(repo1, wt, 'turn 2')
  ok(t2.outcome === 'merged', `turn 2 merges: ${JSON.stringify(t2.outcome)}`)
  ok(
    t2.files.length === 1 && t2.files[0] === 'FileB.tsx',
    `turn-2 diff is incremental (only the new file, not FileA): ${JSON.stringify(t2.files)}`
  )
  const t2revs = g(repo1, 'rev-list', `${beforeTurn2Base}..${t2.newBase}`)
    .trim()
    .split('\n')
    .filter(Boolean)
  ok(t2revs.length === 1, `turn 2 is a single commit off the advanced base: ${t2revs.length}`)
  ok(existsSync(join(repo1, 'FileB.tsx')), 'turn 2 landed FileB on the live tree')
  wt.baseSha = t2.newBase

  // --- syncFromLive mirrors a between-turn live edit; no-ops when identical ---
  writeFileSync(join(repo1, 'LiveEdit.tsx'), 'live\n') // user (or another chat's merge) edits the live tree
  const s1 = await syncFromLive(repo1, wt)
  ok(s1.synced === true, 'syncFromLive syncs a between-turn live edit')
  ok(
    existsSync(join(wt.path, 'LiveEdit.tsx')) &&
      readFileSync(join(wt.path, 'LiveEdit.tsx'), 'utf8') === 'live\n',
    'syncFromLive mirrored the live edit into the worktree'
  )
  const s2 = await syncFromLive(repo1, wt)
  ok(s2.synced === false, 'syncFromLive is a no-op when the worktree already matches live')
  // clean -fd (run by syncFromLive) must NOT remove the gitignored runtime-dep symlinks.
  ok(
    existsSync(join(wt.path, 'node_modules', '.marker')),
    'clean -fd spared the worktree node_modules'
  )
  ok(existsSync(join(wt.path, '.env')), 'clean -fd spared the .env symlink')

  // LKM-146: an install/remove in the chat never touches the live node_modules before landing.
  const liveDeps = () => readdirSync(join(repo1, 'node_modules')).sort().join(',')
  const liveBefore = liveDeps()
  mkdirSync(join(wt.path, 'node_modules', 'added-dep'))
  writeFileSync(join(wt.path, 'node_modules', 'added-dep', 'index.js'), 'export default 1\n')
  rmSync(join(wt.path, 'node_modules', '.marker'))
  writeFileSync(join(wt.path, 'package.json'), '{"dependencies":{"added-dep":"1.0.0"}}\n')
  ok(liveDeps() === liveBefore, `a chat install leaves the live node_modules alone: ${liveDeps()}`)
  ok(
    readFileSync(join(repo1, 'node_modules', '.marker'), 'utf8') === 'dep\n',
    'a chat remove leaves the live dependency in place'
  )
  const t3 = await completeTurn(repo1, wt, 'add a dependency')
  ok(
    t3.outcome === 'merged' && t3.files.join() === 'package.json',
    `only the manifest lands: ${JSON.stringify(t3)}`
  )
  ok(liveDeps() === liveBefore, 'landing moves no node_modules files (the preview installs live)')
  wt.baseSha = t3.newBase
  // The next turn finds manifests its marker does not cover: it reinstalls into its own folder.
  let reinstalled = 0
  await provisionDependencies(repo1, wt.path, async (checkout) => {
    ok(checkout === wt.path, `the reinstall targets the worktree, never live: ${checkout}`)
    reinstalled++
  })
  ok(reinstalled === 1, `changed manifests reinstall in the worktree: ${reinstalled}`)
  ok(liveDeps() === liveBefore, 'the worktree reinstall leaves live node_modules alone')

  // ============================================================================
  // repo2 — mid-turn drift PARKS without clobbering · parked turn 2 re-squashes to 1 commit
  // ============================================================================
  const repo2 = makeRepo('repo2', { 'README.md': 'base\n', 'Extra.tsx': 'x\n' })
  const wt2 = await createChatWorktree(repo2, 'chattwo', worktreesDir)

  // Turn 1: the agent edits README in the worktree, but the USER edits the same file live
  // (mid-turn drift) — the merge must refuse and PARK, leaving the user's edit intact.
  writeFileSync(join(wt2.path, 'README.md'), 'from chat\n')
  writeFileSync(join(repo2, 'README.md'), 'user typed this\n')
  const p1 = await completeTurn(repo2, wt2, 'parked turn 1')
  ok(
    p1.outcome === 'parked',
    `mid-turn drift on a touched file parks: ${JSON.stringify(p1.outcome)}`
  )
  ok(
    readFileSync(join(repo2, 'README.md'), 'utf8') === 'user typed this\n',
    'a parked turn must NOT clobber the concurrent live edit'
  )

  // Turn 2 while parked: agent edits Extra → still drifted → still parked, and the branch
  // re-squashes turn-1 + turn-2 into ONE cumulative commit off base (keeps branchPatch correct).
  writeFileSync(join(wt2.path, 'Extra.tsx'), 'chat extra\n')
  const p2 = await completeTurn(repo2, wt2, 'parked turn 2')
  ok(
    p2.outcome === 'parked',
    `parked chat re-attempts and stays parked while drifted: ${JSON.stringify(p2.outcome)}`
  )
  const p2revs = g(wt2.path, 'rev-list', `${wt2.baseSha}..HEAD`).trim().split('\n').filter(Boolean)
  ok(
    p2revs.length === 1,
    `parked turn 2 re-squashes into a single cumulative commit: ${p2revs.length}`
  )
  ok(
    g(wt2.path, 'show', 'HEAD:README.md') === 'from chat\n' &&
      g(wt2.path, 'show', 'HEAD:Extra.tsx') === 'chat extra\n',
    'the single squash commit carries BOTH parked turns'
  )

  // ============================================================================
  // repo3 — applyParked 3-way applies onto a DIRTY live tree (explicit user Apply)
  // ============================================================================
  const repo3 = makeRepo('repo3', { 'README.md': 'base\n', 'Other.tsx': 'o\n' })
  const wt3 = await createChatWorktree(repo3, 'chatthree', worktreesDir)
  writeFileSync(join(wt3.path, 'README.md'), 'chat readme\n')
  writeFileSync(join(repo3, 'README.md'), 'user drift\n') // drift → the turn parks
  const p3 = await completeTurn(repo3, wt3, 'to be parked')
  ok(p3.outcome === 'parked', `repo3 turn parked as expected: ${JSON.stringify(p3.outcome)}`)

  // User resolves the drift (README back to base) but leaves UNRELATED WIP → dirty tree.
  writeFileSync(join(repo3, 'README.md'), 'base\n')
  writeFileSync(join(repo3, 'Other.tsx'), 'o\n// unrelated WIP\n')
  const ap = await applyParked(repo3, wt3)
  ok(ap.ok, `applyParked applies the parked diff onto a dirty tree: ${JSON.stringify(ap)}`)
  ok(!!ap.newBase, 'a clean applyParked returns a newBase to advance')
  ok(
    readFileSync(join(repo3, 'README.md'), 'utf8') === 'chat readme\n',
    'applyParked landed the parked change on live'
  )
  ok(
    readFileSync(join(repo3, 'Other.tsx'), 'utf8').includes('// unrelated WIP'),
    'applyParked (3-way) preserved the unrelated live WIP'
  )

  // ============================================================================
  // repo4 — discardParked resets the worktree, keeps the branch
  // ============================================================================
  const repo4 = makeRepo('repo4', { 'README.md': 'base\n' })
  const wt4 = await createChatWorktree(repo4, 'chatfour', worktreesDir)
  writeFileSync(join(wt4.path, 'README.md'), 'junk\n')
  writeFileSync(join(wt4.path, 'Junk.tsx'), 'junk\n')
  await discardParked(wt4)
  ok(
    readFileSync(join(wt4.path, 'README.md'), 'utf8') === 'base\n',
    'discardParked reset the tracked file to base'
  )
  ok(!existsSync(join(wt4.path, 'Junk.tsx')), 'discardParked cleaned the stray file')
  // `.trezi/` holds the worktree's dependency marker (Trezi metadata, never captured).
  ok(
    g(wt4.path, 'status', '--porcelain').trim() === '?? .trezi/',
    `discardParked left a clean worktree: ${g(wt4.path, 'status', '--porcelain')}`
  )
  ok(
    g(repo4, 'branch', '--list', wt4.branch).includes(wt4.branch),
    'discardParked did NOT delete the branch (the chat is still live)'
  )

  // ============================================================================
  // repo5 — stageResolve on a NON-overlapping drift merges cleanly (no agent needed),
  //         and a follow-up completeTurn lands the reconciled result on live
  // ============================================================================
  const repo5 = makeRepo('repo5', { 'README.md': 'line1\nline2\nline3\n' })
  const wt5 = await createChatWorktree(repo5, 'chatfive', worktreesDir)
  // Chat appends at the END; the user prepends at the TOP — same file, different regions.
  writeFileSync(join(wt5.path, 'README.md'), 'line1\nline2\nline3\nCHAT\n')
  writeFileSync(join(repo5, 'README.md'), 'USER\nline1\nline2\nline3\n')
  const r5park = await completeTurn(repo5, wt5, 'to be parked')
  ok(r5park.outcome === 'parked', `repo5 file-level drift parks: ${JSON.stringify(r5park.outcome)}`)
  const prep5 = await stageResolve(repo5, wt5)
  ok(
    prep5.clean && prep5.conflicted.length === 0,
    `non-overlapping drift stages clean (no markers): ${JSON.stringify(prep5)}`
  )
  const merged5 = readFileSync(join(wt5.path, 'README.md'), 'utf8')
  ok(
    merged5 === 'USER\nline1\nline2\nline3\nCHAT\n',
    `stageResolve 3-way-merged both regions in the worktree: ${JSON.stringify(merged5)}`
  )
  // baseSha advanced to the live snapshot, so the merge-back is now clean.
  const r5done = await completeTurn(repo5, wt5, 'resolve merge')
  ok(
    r5done.outcome === 'merged',
    `post-stage completeTurn merges onto live: ${JSON.stringify(r5done.outcome)}`
  )
  ok(
    readFileSync(join(repo5, 'README.md'), 'utf8') === 'USER\nline1\nline2\nline3\nCHAT\n',
    'the reconciled result landed on the live tree'
  )

  // ============================================================================
  // repo6 — stageResolve on an OVERLAPPING drift leaves conflict markers for the agent
  // ============================================================================
  const repo6 = makeRepo('repo6', { 'README.md': 'line1\nline2\nline3\n' })
  const wt6 = await createChatWorktree(repo6, 'chatsix', worktreesDir)
  // Chat and user edit the SAME line differently → a real textual conflict.
  writeFileSync(join(wt6.path, 'README.md'), 'line1\nCHAT-EDIT\nline3\n')
  writeFileSync(join(repo6, 'README.md'), 'line1\nUSER-EDIT\nline3\n')
  const r6park = await completeTurn(repo6, wt6, 'to be parked')
  ok(
    r6park.outcome === 'parked',
    `repo6 overlapping drift parks: ${JSON.stringify(r6park.outcome)}`
  )
  const prep6 = await stageResolve(repo6, wt6)
  ok(
    !prep6.clean && prep6.conflicted.includes('README.md'),
    `overlapping drift reports the conflicted file: ${JSON.stringify(prep6)}`
  )
  const marked6 = readFileSync(join(wt6.path, 'README.md'), 'utf8')
  ok(
    marked6.includes('<<<<<<<') &&
      marked6.includes('>>>>>>>') &&
      marked6.includes('CHAT-EDIT') &&
      marked6.includes('USER-EDIT'),
    'stageResolve left conflict markers carrying BOTH sides for the agent to reconcile'
  )
  // The agent resolves the markers (writes a reconciled file); the follow-up completeTurn
  // must commit + merge onto live — proving the marker-apply left no unmerged index entry
  // that would wedge the commit.
  writeFileSync(join(wt6.path, 'README.md'), 'line1\nCHAT-EDIT+USER-EDIT\nline3\n')
  const r6done = await completeTurn(repo6, wt6, 'resolve conflict')
  ok(
    r6done.outcome === 'merged',
    `post-resolution completeTurn merges: ${JSON.stringify(r6done.outcome)}`
  )
  ok(
    readFileSync(join(repo6, 'README.md'), 'utf8') === 'line1\nCHAT-EDIT+USER-EDIT\nline3\n',
    "the agent's reconciled result landed on the live tree"
  )

  // ============================================================================
  // repo7 — a parked DELETION can actually resolve. completeTurn's file-copy
  //         merge refuses deletes FOREVER (readFile on the missing file), which
  //         used to make the conflict card's "Resolve it" a silent infinite
  //         loop; resolveParkedChat now falls back to applyParked (3-way
  //         `git apply`) — this is that exact chain at the primitive level.
  // ============================================================================
  const repo7 = makeRepo('repo7', { 'README.md': 'base\n', 'Doomed.tsx': 'delete me\n' })
  const wt7 = await createChatWorktree(repo7, 'chatseven', worktreesDir)
  // Chat deletes a file and edits README; the user concurrently edits README live → park.
  rmSync(join(wt7.path, 'Doomed.tsx'))
  writeFileSync(join(wt7.path, 'README.md'), 'chat version\n')
  writeFileSync(join(repo7, 'README.md'), 'user version\n')
  const p7 = await completeTurn(repo7, wt7, 'park with deletion')
  ok(p7.outcome === 'parked', `deletion + drift parks: ${p7.outcome}`)
  const prep7 = await stageResolve(repo7, wt7)
  ok(
    prep7.conflicted.includes('README.md'),
    `overlapping README carries markers: ${prep7.conflicted}`
  )
  ok(!existsSync(join(wt7.path, 'Doomed.tsx')), 'the re-laid diff kept the deletion staged')
  // The agent reconciles the markers…
  writeFileSync(join(wt7.path, 'README.md'), 'user version + chat version\n')
  const done7 = await completeTurn(repo7, wt7, 'resolve with deletion')
  // …but the file-copy merge still refuses the deletion — the loop to escape.
  ok(done7.outcome === 'parked', `file-copy merge still refuses a deletion: ${done7.outcome}`)
  const ap7 = await applyParked(repo7, wt7)
  ok(ap7.ok === true, `applyParked fallback lands it: ${JSON.stringify(ap7)}`)
  ok(!existsSync(join(repo7, 'Doomed.tsx')), 'the deletion reached the live tree')
  ok(
    readFileSync(join(repo7, 'README.md'), 'utf8') === 'user version + chat version\n',
    'the reconciled README landed on the live tree'
  )

  // ============================================================================
  // repo8 — stageResolve on a BINARY conflict (a `<<<<<<<` marker can never appear in a
  //         PNG) resolves by policy to the chat's own version instead of silently
  //         keeping the drifted live bytes; completeTurn's file-copy merge still
  //         refuses ANY binary content (same as a deletion), so the applyParked
  //         fallback is what actually lands the resolved image on live.
  // ============================================================================
  const repo8 = makeRepo('repo8', {})
  const baseImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
  writeFileSync(join(repo8, 'plugin.png'), baseImg)
  g(repo8, 'add', '-A')
  g(repo8, 'commit', '-q', '-m', 'add image')
  const wt8 = await createChatWorktree(repo8, 'chateight', worktreesDir)
  const chatImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]) // chat replaces the image
  writeFileSync(join(wt8.path, 'plugin.png'), chatImg)
  const userImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 5, 5, 5]) // user ALSO replaces it live (drift)
  writeFileSync(join(repo8, 'plugin.png'), userImg)
  const p8 = await completeTurn(repo8, wt8, 'replace image')
  ok(p8.outcome === 'parked', `repo8 binary drift parks: ${JSON.stringify(p8.outcome)}`)

  const prep8 = await stageResolve(repo8, wt8)
  ok(
    prep8.clean && prep8.conflicted.length === 0,
    `binary conflict reports clean (no text markers possible): ${JSON.stringify(prep8)}`
  )
  ok(
    readFileSync(join(wt8.path, 'plugin.png')).equals(chatImg),
    "stageResolve resolved the binary conflict to the chat's own version, not the drifted live bytes"
  )
  const done8 = await completeTurn(repo8, wt8, 'resolve merge')
  // The file-copy merge still refuses binary content — same escape hatch as repo7's deletion.
  ok(done8.outcome === 'parked', `file-copy merge still refuses binary content: ${done8.outcome}`)
  const ap8 = await applyParked(repo8, wt8)
  ok(
    ap8.ok === true,
    `applyParked fallback lands the resolved binary conflict: ${JSON.stringify(ap8)}`
  )
  ok(
    readFileSync(join(repo8, 'plugin.png')).equals(chatImg),
    "the chat's resolved image landed on the live tree"
  )

  // repo9 — a trailing-slash node_modules/ rule ignores the live directory (and the
  // worktree's clone). Explicit filtering/clean exclusions keep it runtime-only.
  const repo9 = join(base, 'repo9')
  mkdirSync(repo9, { recursive: true })
  g(repo9, 'init', '-q', '-b', 'main')
  g(repo9, 'config', 'user.name', 'Test')
  g(repo9, 'config', 'user.email', 'test@local')
  writeFileSync(join(repo9, '.gitignore'), 'node_modules/\ndist/\n')
  mkdirSync(join(repo9, 'node_modules'), { recursive: true })
  writeFileSync(join(repo9, 'node_modules', '.marker'), 'dep\n')
  writeFileSync(join(repo9, 'App.tsx'), 'v1\n')
  g(repo9, 'add', '-A')
  g(repo9, 'commit', '-q', '-m', 'init')
  const wt9 = await createChatWorktree(repo9, 'chatnine', worktreesDir)
  ok(
    existsSync(join(wt9.path, 'node_modules', '.marker')),
    'trailing-slash ignored node_modules is cloned'
  )
  writeFileSync(join(wt9.path, 'App.tsx'), 'v2\n')
  const t9 = await completeTurn(repo9, wt9, 'edit app')
  ok(t9.outcome === 'merged', `runtime symlink must not force a park: ${JSON.stringify(t9)}`)
  ok(
    t9.files.length === 1 && t9.files[0] === 'App.tsx',
    `only the real edit enters the turn: ${JSON.stringify(t9.files)}`
  )
  ok(
    existsSync(join(wt9.path, 'node_modules', '.marker')),
    'sync/commit cleanup spares the runtime symlink'
  )

  // repo10 — secrets and generated machine artifacts never enter a synthetic base,
  // turn commit, patch, or live checkout. Env templates remain editable.
  const repo10 = join(base, 'repo10')
  mkdirSync(repo10, { recursive: true })
  g(repo10, 'init', '-q', '-b', 'main')
  g(repo10, 'config', 'user.name', 'Test')
  g(repo10, 'config', 'user.email', 'test@local')
  writeFileSync(join(repo10, 'README.md'), 'base\n')
  writeFileSync(join(repo10, '.env.example'), 'PUBLIC_VALUE=\n')
  g(repo10, 'add', '-A')
  g(repo10, 'commit', '-q', '-m', 'init')
  writeFileSync(join(repo10, '.env'), 'SECRET=live\n')
  mkdirSync(join(repo10, 'node_modules'), { recursive: true })
  writeFileSync(join(repo10, 'node_modules', 'generated.js'), 'generated\n')
  writeFileSync(join(repo10, 'tsconfig.tsbuildinfo'), 'live generated\n')
  const wt10 = await createChatWorktree(repo10, 'chatten', worktreesDir)
  ok(!existsSync(join(wt10.path, '.env')), 'an unignored .env is neither captured nor symlinked')
  ok(
    !existsSync(join(wt10.path, 'node_modules')),
    'unignored node_modules is neither captured nor symlinked'
  )
  ok(
    !existsSync(join(wt10.path, 'tsconfig.tsbuildinfo')),
    '*.tsbuildinfo is excluded from the base'
  )
  writeFileSync(join(wt10.path, '.env.local'), 'SECRET=agent\n')
  mkdirSync(join(wt10.path, 'node_modules'), { recursive: true })
  writeFileSync(join(wt10.path, 'node_modules', 'agent.js'), 'generated\n')
  writeFileSync(join(wt10.path, 'tsconfig.tsbuildinfo'), 'agent generated\n')
  writeFileSync(join(wt10.path, '.env.example'), 'PUBLIC_VALUE=example\n')
  writeFileSync(join(wt10.path, 'Safe.tsx'), 'safe\n')
  const clean10 = await completeTurn(repo10, wt10, 'exclude machine files')
  ok(
    clean10.outcome === 'merged',
    `safe part of artifact-heavy turn still lands: ${clean10.outcome}`
  )
  ok(
    clean10.files.length === 2 &&
      clean10.files.includes('.env.example') &&
      clean10.files.includes('Safe.tsx'),
    `only product files enter the turn commit: ${JSON.stringify(clean10.files)}`
  )
  ok(readFileSync(join(repo10, '.env'), 'utf8') === 'SECRET=live\n', 'live .env is untouched')
  ok(!existsSync(join(repo10, '.env.local')), 'agent .env.local never lands')
  ok(
    readFileSync(join(repo10, 'tsconfig.tsbuildinfo'), 'utf8') === 'live generated\n',
    'agent tsbuildinfo never lands'
  )

  // repo11 — an incomplete AI resolution cannot publish Git conflict markers.
  const repo11 = makeRepo('repo11', { 'README.md': 'base\n' })
  const wt11 = await createChatWorktree(repo11, 'chateleven', worktreesDir)
  writeFileSync(
    join(wt11.path, 'README.md'),
    '<<<<<<< live\nuser version\n=======\nchat version\n>>>>>>> chat\n'
  )
  const marker11 = await completeTurn(repo11, wt11, 'unfinished resolution')
  ok(marker11.outcome === 'parked', 'unresolved markers keep the turn parked')
  ok(readFileSync(join(repo11, 'README.md'), 'utf8') === 'base\n', 'markers never reach live')

  // repo12 — 3-way apply uses a temporary index. The user's real staged version may
  // differ from their working file without producing "does not match index".
  const repo12 = makeRepo('repo12', { 'README.md': 'line1\nline2\nline3\n' })
  const wt12 = await createChatWorktree(repo12, 'chattwelve', worktreesDir)
  writeFileSync(join(wt12.path, 'README.md'), 'line1\nline2\nCHAT\n')
  writeFileSync(join(repo12, 'README.md'), 'STAGED\nline2\nline3\n')
  g(repo12, 'add', 'README.md')
  writeFileSync(join(repo12, 'README.md'), 'WORKING\nline2\nline3\n')
  const p12 = await completeTurn(repo12, wt12, 'park against staged drift')
  ok(p12.outcome === 'parked', 'working-tree drift parks before explicit apply')
  const ap12 = await applyParked(repo12, wt12)
  ok(ap12.ok, `temporary-index 3-way apply succeeds: ${JSON.stringify(ap12)}`)
  ok(
    readFileSync(join(repo12, 'README.md'), 'utf8') === 'WORKING\nline2\nCHAT\n',
    '3-way result combines working-tree and chat edits'
  )
  ok(
    g(repo12, 'show', ':README.md') === 'STAGED\nline2\nline3\n',
    "the user's real staged version is untouched"
  )

  // repo13 — a failed provider turn is preserved for review, never auto-landed.
  const repo13 = makeRepo('repo13', { 'README.md': 'base\n' })
  const wt13 = await createChatWorktree(repo13, 'chatthirteen', worktreesDir)
  writeFileSync(join(wt13.path, 'README.md'), 'partial edit before provider failure\n')
  const failed13 = await completeTurn(repo13, wt13, 'failed turn', { land: false })
  ok(failed13.outcome === 'parked', 'a failed turn with edits parks')
  ok(
    readFileSync(join(repo13, 'README.md'), 'utf8') === 'base\n',
    'failed partial work never lands'
  )
  ok(
    g(wt13.path, 'show', 'HEAD:README.md') === 'partial edit before provider failure\n',
    'failed partial work remains durable on the chat branch'
  )

  // repo14 — the agent-side prepare tool must be the first mutation in a
  // resolution turn. If the model already edited the parked checkout, refuse
  // before reset so those fresh edits are not silently erased.
  const repo14 = makeRepo('repo14', { 'README.md': 'base\n' })
  const wt14 = await createChatWorktree(repo14, 'chatfourteen', worktreesDir)
  writeFileSync(join(wt14.path, 'README.md'), 'chat version\n')
  writeFileSync(join(repo14, 'README.md'), 'user version\n')
  const p14 = await completeTurn(repo14, wt14, 'park before late preparation')
  ok(p14.outcome === 'parked', 'repo14 overlapping turn parks')
  writeFileSync(join(wt14.path, 'README.md'), 'new current-turn edit\n')
  let rejected14 = ''
  try {
    await stageResolve(repo14, wt14)
  } catch (error) {
    rejected14 = error instanceof Error ? error.message : String(error)
  }
  ok(/changed after it was parked/.test(rejected14), 'late preparation refuses a dirty worktree')
  ok(
    readFileSync(join(wt14.path, 'README.md'), 'utf8') === 'new current-turn edit\n',
    'late preparation preserves the model’s current-turn edit'
  )

  // repo15 — a directory-only node_modules/ ignore does not match a linked
  // worktree symlink (a worktree from before LKM-146 keeps one until its next sync).
  // That known runtime artifact must not look like a model edit to the
  // dirty-before-prepare guard.
  const repo15 = join(base, 'repo15')
  mkdirSync(repo15, { recursive: true })
  g(repo15, 'init', '-q', '-b', 'main')
  g(repo15, 'config', 'user.name', 'Test')
  g(repo15, 'config', 'user.email', 'test@local')
  writeFileSync(join(repo15, '.gitignore'), 'node_modules/\n')
  mkdirSync(join(repo15, 'node_modules'), { recursive: true })
  writeFileSync(join(repo15, 'node_modules', '.marker'), 'dep\n')
  writeFileSync(join(repo15, 'README.md'), 'base\n')
  g(repo15, 'add', '-A')
  g(repo15, 'commit', '-q', '-m', 'init')
  const wt15 = await createChatWorktree(repo15, 'chatfifteen', worktreesDir)
  rmSync(join(wt15.path, 'node_modules'), { recursive: true })
  symlinkSync(join(repo15, 'node_modules'), join(wt15.path, 'node_modules'))
  writeFileSync(join(wt15.path, 'README.md'), 'chat version\n')
  writeFileSync(join(repo15, 'README.md'), 'user version\n')
  const p15 = await completeTurn(repo15, wt15, 'park with runtime symlink')
  ok(p15.outcome === 'parked', 'repo15 overlapping turn parks')
  ok(
    g(wt15.path, 'status', '--porcelain').includes('node_modules'),
    'fixture proves the runtime symlink appears dirty to raw git status'
  )
  const prep15 = await stageResolve(repo15, wt15)
  ok(
    prep15.conflicted.includes('README.md'),
    'runtime-only symlink does not block conflict preparation'
  )

  // repo16 — LKM-194: a live package.json with unresolved conflict markers (a publish
  // reconcile left them) syncs into the chat; the turn's sync reports the conflict with
  // the version facts and never runs the install. A failing install is reported too.
  const repo16 = makeRepo('repo16', {
    'package.json': '{\n  "name": "shop",\n  "version": "0.2.6"\n}\n'
  })
  const wt16 = await createChatWorktree(repo16, 'chatsixteen', worktreesDir)
  writeFileSync(
    join(repo16, 'package.json'),
    '{\n  "name": "shop",\n<<<<<<< HEAD\n  "version": "0.2.7"\n=======\n  "version": "0.2.8"\n>>>>>>> origin/trezi/main\n}\n'
  )
  let installs16 = 0
  const counting = async () => {
    installs16++
  }
  const s16 = await syncFromLive(repo16, wt16, { install: counting })
  const c16 = s16.dependencies?.conflict
  ok(s16.synced, 'repo16 the marked package.json syncs into the chat worktree')
  ok(installs16 === 0, `no install is attempted on a marked manifest: ${installs16}`)
  ok(
    c16?.files.join() === 'package.json' && c16.manifests && c16.line === 3,
    `the sync reports the manifest conflict: ${JSON.stringify(s16.dependencies)}`
  )
  ok(
    c16?.version?.ours === '0.2.7' &&
      c16.version.theirs === '0.2.8' &&
      c16.version.keep === '0.2.8',
    `the version conflict offers the higher SemVer: ${JSON.stringify(c16?.version)}`
  )
  // Resolved live: the conflict clears and the changed manifest installs again.
  writeFileSync(join(repo16, 'package.json'), '{\n  "name": "shop",\n  "version": "0.2.8"\n}\n')
  const r16 = await syncFromLive(repo16, wt16, { install: counting })
  ok(
    r16.dependencies === null && installs16 === 1,
    `resolved: ${JSON.stringify(r16)} ${installs16}`
  )
  // An install that fails never fails the sync: the reason comes back for the turn.
  writeFileSync(join(repo16, 'package.json'), '{\n  "name": "shop",\n  "version": "0.2.9"\n}\n')
  const f16 = await syncFromLive(repo16, wt16, {
    install: async () => {
      throw new Error('bun install exited with code 1')
    }
  })
  ok(
    f16.dependencies?.install === 'bun install exited with code 1' && !f16.dependencies.conflict,
    `a failed install is reported, not thrown: ${JSON.stringify(f16.dependencies)}`
  )

  if (failed === 0)
    console.log(
      'CHAT-WORKTREES OK — isolation/resolve/artifact-filter/temp-index/marker-safety/runtime-symlink/dirty-prepare/dependency-conflicts'
    )
  else console.error(`CHAT-WORKTREES: ${failed} assertion(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('CHAT-WORKTREES FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
