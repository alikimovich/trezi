/**
 * worktrees.ts through the Swift repository owner (run by test/repository-owner.mjs with
 * the owner preloaded). The F1 crux: each comment-spawned agent edits in its OWN git
 * worktree so parallel runs never cross-write, the spawn leaves a durable branch, and
 * its change applies back onto the live (possibly dirty) working tree via 3-way patch —
 * NOT `git merge` (which fails on uncommitted WIP).
 *
 * Asserts: the fork point snapshots live WIP; create forks WIP without touching the
 * main tree; a custom branchName scheme (per-chat isolation) lands on the expected
 * branch; two concurrent creates are isolated; commit captures the authoritative file
 * list; the branch's change lands onto a DIRTY main tree; remove reclaims the checkout
 * (keeping the branch); pruneOrphans reclaims leftovers and reports each as
 * `{id, dirty, branch, repoRoot}` and FOLDS a parked chat squash's recovery commit into
 * one commit; pruneIntegratedChatBranches removes only unattached/unparked chat refs
 * whose patch already exists on live HEAD. Uses real temp git repos.
 *
 * Run with: bun test/repository-owner.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyBranchToWorkingTree,
  autoApplyWorktree,
  branchPatch,
  commitWorktree,
  createWorktree,
  pruneIntegratedChatBranches,
  pruneOrphans,
  removeWorktree
} from '../src/main/worktrees.ts'

const base = mkdtempSync(join(tmpdir(), 'trezi-wt-'))
const repo = join(base, 'repo')
const worktreesDir = join(base, 'worktrees')
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

try {
  // --- temp repo with one committed file + a branch ---
  mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-q', '-b', 'main')
  g(repo, 'config', 'user.name', 'Test')
  g(repo, 'config', 'user.email', 'test@local')
  const appFile = join(repo, 'App.tsx')
  writeFileSync(appFile, 'export const App = () => <div className="root">hi</div>\n')
  // Real projects gitignore node_modules/.env, so the worktree's symlinks to them are
  // ignored (never staged, never leaked into the live tree by an apply). Without this a
  // clean orphan's dangling symlinks show as untracked → a false "dirty".
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', 'init')

  // Simulate the interactive main agent having UNCOMMITTED WIP in the live tree.
  writeFileSync(appFile, 'export const App = () => <div className="root">hi</div>\n// WIP\n')
  // ...AND an UNTRACKED new file — the trezi agent constantly creates files; the fork
  // base must include these (git stash create would silently drop them).
  writeFileSync(join(repo, 'Untracked.tsx'), 'export const New = () => null\n')
  const dirtyBefore = readFileSync(appFile, 'utf8')

  // --- create: forks the WIP, and does NOT disturb the main tree ---
  const wtA = await createWorktree(repo, worktreesDir, { label: 'make it blue' })
  ok(wtA.branch === 'trezi/comment-' + wtA.id, `branch name: ${wtA.branch}`)
  ok(existsSync(wtA.path), 'worktree checkout exists')
  ok(readFileSync(appFile, 'utf8') === dirtyBefore, 'create did NOT touch the main working tree')
  // The worktree forked from the live WIP — tracked modification...
  ok(
    readFileSync(join(wtA.path, 'App.tsx'), 'utf8').includes('// WIP'),
    'worktree forked from the live WIP (tracked), not just HEAD'
  )
  // ...AND the untracked new file (the captureBase fix; stash-create would drop it).
  ok(
    existsSync(join(wtA.path, 'Untracked.tsx')),
    'worktree base includes UNTRACKED live files (new components the agent just made)'
  )

  // --- the fork point is a real commit snapshotting the live tree ---
  ok(/^[0-9a-f]{40}$/.test(wtA.baseSha), `the base is a sha: ${wtA.baseSha}`)
  ok(
    g(repo, 'show', `${wtA.baseSha}:App.tsx`).includes('// WIP'),
    'the base snapshot includes the live WIP'
  )

  // --- createWorktree honors a custom branchName scheme (per-chat isolation) ---
  const wtChat = await createWorktree(repo, worktreesDir, { branchName: (id) => `chat-${id}` })
  ok(
    wtChat.branch === `trezi/chat-${wtChat.id}`,
    `custom branchName lands on trezi/chat-<id>: ${wtChat.branch}`
  )
  await removeWorktree(repo, wtChat, {})

  // --- two concurrent creates are isolated (distinct dirs + branches) ---
  const [w1, w2] = await Promise.all([
    createWorktree(repo, worktreesDir, {}),
    createWorktree(repo, worktreesDir, {})
  ])
  ok(
    w1.id !== w2.id && w1.path !== w2.path && w1.branch !== w2.branch,
    'concurrent creates distinct'
  )
  // Edit each independently — no cross-write.
  writeFileSync(join(w1.path, 'App.tsx'), 'one\n')
  writeFileSync(join(w2.path, 'App.tsx'), 'two\n')
  ok(readFileSync(join(w1.path, 'App.tsx'), 'utf8') === 'one\n', 'w1 isolated')
  ok(readFileSync(join(w2.path, 'App.tsx'), 'utf8') === 'two\n', 'w2 isolated')
  await removeWorktree(repo, w1, {})
  await removeWorktree(repo, w2, {})

  // --- the spawn edits its tree → commit captures the authoritative file list ---
  writeFileSync(
    join(wtA.path, 'App.tsx'),
    'export const App = () => <div className="root accent">hi</div>\n// WIP\n'
  )
  writeFileSync(join(wtA.path, 'New.tsx'), 'export const New = () => null\n')
  // A stray .trezi write (a spawn runs bypassPermissions, so the sidecar deny is off)
  // must be excluded from the commit — the sidecar is trezi-managed, not the agent's.
  mkdirSync(join(wtA.path, '.trezi'), { recursive: true })
  writeFileSync(join(wtA.path, '.trezi', 'annotations.json'), '[{"sneaky":true}]\n')
  const committed = await commitWorktree(wtA, 'make it blue')
  ok(committed.committed, 'commitWorktree committed')
  ok(
    committed.files.includes('App.tsx') && committed.files.includes('New.tsx'),
    `committed files: ${JSON.stringify(committed.files)}`
  )
  ok(
    !committed.files.some((f) => f.startsWith('.trezi')),
    `.trezi must be excluded from a spawn commit: ${JSON.stringify(committed.files)}`
  )

  // --- the branch's change → apply onto the DIRTY live tree (tolerates WIP) ---
  const patch = await branchPatch(repo, wtA.branch)
  ok(/accent/.test(patch) && /New\.tsx/.test(patch), 'the branch carries both changes')
  const applied = await applyBranchToWorkingTree(repo, wtA.branch)
  ok(applied.ok && !applied.conflict, `apply onto dirty tree: ${JSON.stringify(applied)}`)
  const liveApp = readFileSync(appFile, 'utf8')
  ok(liveApp.includes('accent'), 'live App.tsx got the spawn edit')
  ok(liveApp.includes('// WIP'), "the main agent's WIP survived the apply")
  ok(existsSync(join(repo, 'New.tsx')), 'new file landed in the live tree')

  // --- remove reclaims the checkout but keeps the branch (durable record) ---
  await removeWorktree(repo, wtA, { keepBranch: true })
  ok(!existsSync(wtA.path), 'worktree checkout removed')
  const branches = g(repo, 'branch', '--list', wtA.branch)
  ok(branches.includes(wtA.branch), 'branch kept as the durable record')

  // --- data-loss guard: an agent that COMMITS its own work (+ leaves WIP) must
  // still be captured as ONE commit off the fork point, not reported "no changes" ---
  const wtC = await createWorktree(repo, worktreesDir, { label: 'self-commit' })
  writeFileSync(join(wtC.path, 'Committed.tsx'), 'export const C = () => null\n')
  // The spawned agent commits its own change (nothing forbids it) …
  g(wtC.path, '-c', 'user.name=A', '-c', 'user.email=a@l', 'add', '-A')
  g(
    wtC.path,
    '-c',
    'user.name=A',
    '-c',
    'user.email=a@l',
    'commit',
    '-q',
    '-m',
    'agent self-commit'
  )
  // … then leaves further uncommitted WIP on top.
  writeFileSync(join(wtC.path, 'Extra.tsx'), 'export const E = () => null\n')
  const c = await commitWorktree(wtC, 'self-commit run')
  ok(c.committed, 'commitWorktree reports the agent-committed work (not "no changes")')
  ok(
    c.files.includes('Committed.tsx') && c.files.includes('Extra.tsx'),
    `both the agent commit AND the later WIP are captured: ${JSON.stringify(c.files)}`
  )
  // Exactly one commit off base → branchPatch (branch^..branch) sees the WHOLE change.
  const revs = g(wtC.path, 'rev-list', `${wtC.baseSha}..HEAD`).trim().split('\n').filter(Boolean)
  ok(revs.length === 1, `squashed to a single commit off base: ${revs.length}`)
  await removeWorktree(repo, wtC, { keepBranch: true })
  const bp = await branchPatch(repo, wtC.branch)
  ok(
    /Committed\.tsx/.test(bp) && /Extra\.tsx/.test(bp),
    'branchPatch carries both files (not a truncated last-commit-only patch)'
  )
  await removeWorktree(repo, wtC, { keepBranch: false })

  // --- pruneOrphans reclaims a leftover checkout, recovering its dirty work to the
  // branch — but SKIPS a checkout named as live (an active spawn this session) ---
  const orphan = await createWorktree(repo, worktreesDir, {})
  writeFileSync(join(orphan.path, 'Scratch.tsx'), 'leftover\n')
  const orphanClean = await createWorktree(repo, worktreesDir, {}) // untouched — nothing to recover
  const live = await createWorktree(repo, worktreesDir, {}) // pretend this one is active
  const reclaimed = await pruneOrphans(repo, worktreesDir, new Set([live.id]))
  const reclaimedOrphan = reclaimed.find((r) => r.id === orphan.id)
  const reclaimedClean = reclaimed.find((r) => r.id === orphanClean.id)
  ok(!!reclaimedOrphan, `pruneOrphans reclaimed the orphan: ${JSON.stringify(reclaimed)}`)
  ok(!existsSync(orphan.path), 'orphan checkout removed by prune')
  ok(existsSync(live.path), 'pruneOrphans must SKIP a live (active) spawn checkout')
  ok(!reclaimed.some((r) => r.id === live.id), 'live spawn id not reclaimed')
  // {id, dirty, branch, repoRoot} shape: dirty true for the orphan with uncommitted
  // changes, false for the untouched one — checked via `status --porcelain`, not commit
  // success/failure. branch + owning repoRoot are captured BEFORE the checkout is gone.
  ok(
    reclaimedOrphan?.dirty === true,
    `dirty orphan reports dirty:true: ${JSON.stringify(reclaimedOrphan)}`
  )
  ok(
    reclaimedOrphan?.branch === orphan.branch,
    `reclaimed reports the branch: ${JSON.stringify(reclaimedOrphan)}`
  )
  ok(
    !!reclaimedOrphan?.repoRoot && existsSync(join(reclaimedOrphan.repoRoot, '.git')),
    `reclaimed reports the owning repoRoot: ${JSON.stringify(reclaimedOrphan)}`
  )
  ok(!!reclaimedClean, `pruneOrphans also reclaimed the clean orphan: ${JSON.stringify(reclaimed)}`)
  ok(
    reclaimedClean?.dirty === false,
    `clean orphan reports dirty:false: ${JSON.stringify(reclaimedClean)}`
  )
  // The orphan's dirty work was committed to its branch before removal (not lost).
  ok(
    g(repo, 'show', `${orphan.branch}:Scratch.tsx`).includes('leftover'),
    'orphan work recovered to its branch'
  )
  await removeWorktree(repo, live, {})

  // --- W2: a PARKED chat orphan (tip = cumulative trezi squash, a `chatpark-<id>` record
  // exists) that crashed mid-turn must FOLD the recovery commit into that squash, so
  // branchPatch stays the full diff (a stacked recovery commit would hide the parked work
  // from the record's Apply). The fold is gated on the `isParked` predicate. ---
  const chatWt = await createWorktree(repo, worktreesDir, { branchName: (i) => `chat-${i}` })
  // Turn 1 parked: the isolation layer squashes it into ONE trezi commit off base.
  writeFileSync(join(chatWt.path, 'Parked.tsx'), 'export const P = () => null\n')
  const pc = await commitWorktree(chatWt, 'parked turn one')
  ok(pc.committed && pc.files.includes('Parked.tsx'), 'parked squash committed')
  // Turn 2 crashed mid-run — leaves uncommitted WIP on top of the parked squash.
  writeFileSync(join(chatWt.path, 'Parked.tsx'), 'export const P = () => null\n// turn two\n')
  const chatReclaim = await pruneOrphans(repo, worktreesDir, new Set(), (id) => id === chatWt.id)
  const rc = chatReclaim.find((r) => r.id === chatWt.id)
  ok(
    rc?.dirty === true && rc?.branch === chatWt.branch,
    `chat orphan reclaimed: ${JSON.stringify(rc)}`
  )
  // Folded → exactly ONE commit off base, carrying BOTH the parked turn and turn two.
  const chatRevs = g(repo, 'rev-list', `${chatWt.baseSha}..${chatWt.branch}`)
    .trim()
    .split('\n')
    .filter(Boolean)
  ok(chatRevs.length === 1, `parked squash + recovery folded into one commit: ${chatRevs.length}`)
  ok(
    g(repo, 'show', `${chatWt.branch}:Parked.tsx`).includes('turn two'),
    'the crashed turn-two WIP was recovered'
  )
  const chatBp = await branchPatch(repo, chatWt.branch)
  ok(
    /Parked\.tsx/.test(chatBp) && /turn two/.test(chatBp),
    'branchPatch still carries the full parked diff'
  )
  await removeWorktree(repo, chatWt, { keepBranch: false })

  // --- W2 regression: a chat orphan whose tip is a previously-MERGED turn (baseSha has
  // ADVANCED to that tip, NO park record → NOT parked) that crashed mid-turn must NOT fold.
  // Folding would splice the already-live merged commit into the recovery, so its Apply
  // would re-apply live content and surface spurious 3-way conflicts. branchPatch must carry
  // ONLY the genuinely-unmerged crash WIP, committed ON TOP of the merged tip. ---
  const mergedWt = await createWorktree(repo, worktreesDir, { branchName: (i) => `chat-${i}` })
  // Turn 1 merged: one commit, then baseSha advances to that tip (mirrors afterTurn's
  // base-advance on a successful auto-apply). This is the merged content — already live.
  writeFileSync(join(mergedWt.path, 'Merged.tsx'), 'export const M = 1\n')
  const mc = await commitWorktree(mergedWt, 'merged turn one')
  ok(mc.committed && mc.files.includes('Merged.tsx'), 'merged turn committed')
  const mergedTip = g(mergedWt.path, 'rev-parse', 'HEAD').trim()
  mergedWt.baseSha = mergedTip // baseSha advanced to the merged tip (nothing pending now)
  // Turn 2 crashed mid-run — uncommitted WIP in a NEW file on top of the merged tip.
  writeFileSync(join(mergedWt.path, 'Crash.tsx'), 'export const C = 2\n')
  // No `chatpark-<id>` record for this worktree → predicate returns false → no fold.
  const mergedReclaim = await pruneOrphans(repo, worktreesDir, new Set(), () => false)
  const mrc = mergedReclaim.find((r) => r.id === mergedWt.id)
  ok(
    mrc?.dirty === true && mrc?.branch === mergedWt.branch,
    `merged-tip orphan reclaimed: ${JSON.stringify(mrc)}`
  )
  // NOT folded → recovery commit sits ON TOP of the merged tip (base..branch = 2 commits).
  const mergedRevs = g(repo, 'rev-list', `${mergedTip}~1..${mergedWt.branch}`)
    .trim()
    .split('\n')
    .filter(Boolean)
  ok(
    mergedRevs.length === 2,
    `merged tip preserved + recovery on top (not folded): ${mergedRevs.length}`
  )
  // The merged tip's parent IS the merged commit — so branchPatch (branch^..branch) carries
  // ONLY the crash WIP, NOT the already-live Merged.tsx (which would cause re-apply conflicts).
  const mergedBp = await branchPatch(repo, mergedWt.branch)
  ok(/Crash\.tsx/.test(mergedBp), 'branchPatch carries the genuinely-unmerged crash WIP')
  ok(
    !/Merged\.tsx/.test(mergedBp),
    'branchPatch does NOT re-include the already-merged (live) content'
  )
  await removeWorktree(repo, mergedWt, { keepBranch: false })

  // --- Branch-only cleanup: a successful chat turn is usually NOT an ancestor of
  // live HEAD. Trezi records the same patch as a separate live commit, so patch-id
  // equivalence must prune it; unique, parked, attached, and non-chat refs stay. ---
  const pruneRepo = join(base, 'prune-repo')
  mkdirSync(pruneRepo, { recursive: true })
  const gp = (...a) => execFileSync('git', a, { cwd: pruneRepo, encoding: 'utf8' }).trim()
  gp('init', '-q', '-b', 'main')
  gp('config', 'user.email', 'test@local')
  gp('config', 'user.name', 'Test')
  writeFileSync(join(pruneRepo, 'README.md'), 'base\n')
  gp('add', '-A')
  gp('commit', '-qm', 'init')

  const integratedWt = await createWorktree(pruneRepo, worktreesDir, {
    id: 'integrated',
    branchName: (id) => `chat-${id}`
  })
  writeFileSync(join(integratedWt.path, 'Integrated.tsx'), 'export const integrated = true\n')
  await commitWorktree(integratedWt, 'private chat commit')
  await removeWorktree(pruneRepo, integratedWt, { keepBranch: true })
  // Same patch, different SHA/message on live HEAD — exactly commitLiveTurn's shape.
  writeFileSync(join(pruneRepo, 'Integrated.tsx'), 'export const integrated = true\n')
  gp('add', 'Integrated.tsx')
  gp('commit', '-qm', 'live turn commit')

  const uniqueWt = await createWorktree(pruneRepo, worktreesDir, {
    id: 'unique',
    branchName: (id) => `chat-${id}`
  })
  writeFileSync(join(uniqueWt.path, 'Unique.tsx'), 'do not lose me\n')
  await commitWorktree(uniqueWt, 'unique chat work')
  await removeWorktree(pruneRepo, uniqueWt, { keepBranch: true })

  const protectedWt = await createWorktree(pruneRepo, worktreesDir, {
    id: 'parked',
    branchName: (id) => `chat-${id}`
  })
  writeFileSync(join(protectedWt.path, 'Integrated.tsx'), 'export const integrated = true\n')
  await commitWorktree(protectedWt, 'already-live but parked')
  await removeWorktree(pruneRepo, protectedWt, { keepBranch: true })

  const attachedWt = await createWorktree(pruneRepo, worktreesDir, {
    id: 'attached',
    branchName: (id) => `chat-${id}`
  })
  gp('branch', 'backup/keep-me')

  const pruned = await pruneIntegratedChatBranches(pruneRepo, (id) => id === 'parked')
  ok(
    pruned.deleted.includes('trezi/chat-integrated'),
    `patch-equivalent branch-only ref pruned: ${JSON.stringify(pruned)}`
  )
  ok(!gp('branch', '--list', 'trezi/chat-integrated'), 'integrated chat branch no longer exists')
  ok(
    gp('branch', '--list', 'trezi/chat-unique').includes('trezi/chat-unique'),
    'unique chat work is preserved'
  )
  ok(
    gp('branch', '--list', 'trezi/chat-parked').includes('trezi/chat-parked'),
    'persisted parked branch is protected even when its patch is integrated'
  )
  ok(
    gp('branch', '--list', 'trezi/chat-attached').includes('trezi/chat-attached'),
    'a branch checked out in a live worktree is preserved'
  )
  ok(
    gp('branch', '--list', 'backup/keep-me').includes('backup/keep-me'),
    'non-chat backup branches are outside the cleanup scope'
  )
  await removeWorktree(pruneRepo, attachedWt, {})
  await removeWorktree(pruneRepo, uniqueWt, { keepBranch: false })
  await removeWorktree(pruneRepo, protectedWt, { keepBranch: false })

  // --- autoApplyWorktree: land a spawn's change straight on the live tree (v8 F1) ---
  // Fresh repo so the live README is unchanged since the worktree forked.
  const repo2 = join(base, 'repo2')
  mkdirSync(repo2, { recursive: true })
  const g2 = (...a) => execFileSync('git', a, { cwd: repo2, encoding: 'utf8' }).trim()
  g2('init', '-q')
  g2('config', 'user.email', 't@t.t')
  g2('config', 'user.name', 'T')
  // Real projects gitignore node_modules/.env, so the worktree's symlinks to them
  // never enter a spawn's commit (and thus never reach autoApply).
  writeFileSync(join(repo2, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(join(repo2, 'README.md'), 'hello world\n')
  g2('add', '-A')
  g2('commit', '-qm', 'init')
  const wt2 = await createWorktree(repo2, worktreesDir, { label: 'edit readme' })
  writeFileSync(join(wt2.path, 'README.md'), 'hello TREZI\n') // the "agent" edits in the worktree
  const c2 = await commitWorktree(wt2, 'edit readme')
  const auto = await autoApplyWorktree(repo2, wt2, c2.files)
  ok(auto.applied, `autoApply should apply onto an unchanged live tree: ${JSON.stringify(auto)}`)
  ok(
    readFileSync(join(repo2, 'README.md'), 'utf8') === 'hello TREZI\n',
    'autoApply wrote the live file'
  )
  ok(
    auto.edits.length === 1 &&
      auto.edits[0].before === 'hello world\n' &&
      auto.edits[0].after === 'hello TREZI\n',
    `autoApply returns before/after for the undo history: ${JSON.stringify(auto.edits)}`
  )

  // --- autoApply REFUSES when the live file drifted (concurrent user edit) ---
  const wt3 = await createWorktree(repo2, worktreesDir, { label: 'edit again' })
  writeFileSync(join(wt3.path, 'README.md'), 'from spawn\n')
  const c3 = await commitWorktree(wt3, 'edit again')
  writeFileSync(join(repo2, 'README.md'), 'user typed this themselves\n') // drift under us
  const refused = await autoApplyWorktree(repo2, wt3, c3.files)
  ok(!refused.applied, 'autoApply must refuse when the live file changed concurrently')
  ok(
    readFileSync(join(repo2, 'README.md'), 'utf8') === 'user typed this themselves\n',
    'refused autoApply must NOT clobber the user edit'
  )
  await removeWorktree(repo2, wt2, {})
  await removeWorktree(repo2, wt3, {})

  if (failed === 0) console.log('WORKTREES OK — create/commit/diff/apply/auto-apply/remove/prune')
  else console.error(`WORKTREES: ${failed} assertion(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('WORKTREES FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
