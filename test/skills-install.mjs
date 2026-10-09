/**
 * Unit test for the curated skill-pack catalog + arg builder (src/main/skill-packs.ts)
 * — the PURE half of the `list_recommended_skills` / `install_skills` agent tools.
 * No Electron, no network; runs under bun so the .ts import resolves:
 *   bun test/skills-install.mjs
 *
 * SCOPE: this tier exercises only the pure data + `buildInstallArgs` argv + the
 * allowlist gate. It deliberately does NOT spawn `npx skills add` — the service's
 * workflow owner does (test/workflow-owner.mjs runs it against a scripted npx).
 */
import assert from 'node:assert'
import { buildInstallArgs, findPack, SKILL_PACKS } from '../src/main/skill-packs.ts'

// --- catalog integrity ------------------------------------------------------

assert.ok(Array.isArray(SKILL_PACKS) && SKILL_PACKS.length >= 1, 'catalog is non-empty')

const seenIds = new Set()
for (const p of SKILL_PACKS) {
  for (const field of ['id', 'repo', 'title', 'description', 'url']) {
    assert.ok(
      typeof p[field] === 'string' && p[field].length > 0,
      `pack ${p.id ?? '?'} has non-empty ${field}`
    )
  }
  assert.ok(
    p.recommendedScope === 'project' || p.recommendedScope === 'user',
    `pack ${p.id} has valid recommendedScope (got ${p.recommendedScope})`
  )
  assert.match(p.repo, /^[^/\s]+\/[^/\s]+$/, `pack ${p.id} repo is owner/repo (got ${p.repo})`)
  if (p.skills !== undefined) {
    assert.ok(
      Array.isArray(p.skills) && p.skills.every((s) => typeof s === 'string' && s.length > 0),
      `pack ${p.id} skills is a non-empty string array when present`
    )
  }
  assert.ok(!seenIds.has(p.id), `pack id ${p.id} is unique`)
  seenIds.add(p.id)
}

// The plan's required seed entry must be present.
assert.ok(
  SKILL_PACKS.some((p) => p.repo === 'emilkowalski/skills'),
  'seed catalog includes emilkowalski/skills'
)

// --- findPack ---------------------------------------------------------------

const first = SKILL_PACKS[0]
assert.strictEqual(findPack(first.id), first, 'findPack returns the matching entry')
assert.strictEqual(findPack('nope'), undefined, "findPack('nope') is undefined")

// --- buildInstallArgs: shared flags -----------------------------------------

for (const pack of SKILL_PACKS) {
  for (const scope of ['project', 'user']) {
    const args = buildInstallArgs(pack, scope)
    assert.ok(args.includes('add'), `${pack.id}/${scope}: has add`)
    assert.ok(args.includes(pack.repo), `${pack.id}/${scope}: has repo`)
    assert.ok(args.includes('--copy'), `${pack.id}/${scope}: uses --copy (portable files)`)
    assert.ok(args.includes('-y'), `${pack.id}/${scope}: has -y`)
    // -a claude-code is an adjacent pair.
    const ai = args.indexOf('-a')
    assert.ok(ai !== -1 && args[ai + 1] === 'claude-code', `${pack.id}/${scope}: -a claude-code`)

    // -g iff user scope.
    assert.strictEqual(
      args.includes('-g'),
      scope === 'user',
      `${pack.id}/${scope}: -g present iff user scope`
    )

    // --all when no specific skills; --skill X pairs otherwise.
    if (pack.skills?.length) {
      assert.ok(!args.includes('--all'), `${pack.id}/${scope}: no --all when skills specified`)
      for (const s of pack.skills) {
        const si = args.indexOf('--skill')
        assert.ok(si !== -1, `${pack.id}/${scope}: has --skill`)
        assert.ok(args.includes(s), `${pack.id}/${scope}: includes skill ${s}`)
        // every skill name is immediately preceded by --skill
        let ok = false
        for (let i = 0; i < args.length - 1; i++)
          if (args[i] === '--skill' && args[i + 1] === s) ok = true
        assert.ok(ok, `${pack.id}/${scope}: --skill ${s} is a proper pair`)
      }
    } else {
      assert.ok(args.includes('--all'), `${pack.id}/${scope}: uses --all when no skills`)
      assert.ok(!args.includes('--skill'), `${pack.id}/${scope}: no --skill when installing all`)
    }
  }
}

// Exact argv shape for the seed pack (project scope, whole repo).
{
  const emil = SKILL_PACKS.find((p) => p.repo === 'emilkowalski/skills')
  assert.deepStrictEqual(
    buildInstallArgs(emil, 'project'),
    ['skills', 'add', 'emilkowalski/skills', '-a', 'claude-code', '-y', '--copy', '--all'],
    'emil project-scope argv is exact'
  )
  assert.deepStrictEqual(
    buildInstallArgs(emil, 'user'),
    ['skills', 'add', 'emilkowalski/skills', '-a', 'claude-code', '-y', '--copy', '-g', '--all'],
    'emil user-scope argv adds -g'
  )
}

// --- SECURITY: arbitrary repos can't reach the installer --------------------

// The tool validates the caller-supplied id via findPack; an off-catalog repo
// string (even a real GitHub repo) is not an id and must resolve to undefined,
// so it can never be turned into `npx skills add` argv.
for (const evil of [
  'attacker/malicious-skills',
  'emilkowalski/skills', // a real repo slug, but a slug is not an id
  '../../etc/passwd',
  '',
  'rm -rf ~'
]) {
  assert.strictEqual(
    findPack(evil),
    undefined,
    `off-catalog string rejected: ${JSON.stringify(evil)}`
  )
}

console.log(
  `SKILLS-INSTALL OK — ${SKILL_PACKS.length} packs, findPack gate, buildInstallArgs flags (-g/--all/--skill), allowlist rejects off-catalog repos`
)
