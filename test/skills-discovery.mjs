/**
 * Unit test for project-skill discovery + "/" menu normalization (LKM-54):
 * SKILL.md frontmatter parsing (safe on malformed input), .claude/skills
 * scanning, and the project-first / dedupe merge. Pure bun — no Electron.
 * Run via: bun run test:skills
 */
import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverProjectSkills, mergeSlashCommands, parseSkillMeta } from '../src/main/skills.ts'
import { rankSlashMatches } from '../src/shared/slash-menu.ts'

// --- parseSkillMeta ---------------------------------------------------------

// Plain frontmatter.
assert.deepStrictEqual(
  parseSkillMeta('---\nname: deploy\ndescription: Ship the app to production\n---\n\n# Deploy'),
  { name: 'deploy', description: 'Ship the app to production' }
)

// Quoted values unquote; extra keys ignored.
assert.deepStrictEqual(
  parseSkillMeta('---\ntitle: x\nname: "review"\ndescription: \'Check the diff\'\n---\nbody'),
  { name: 'review', description: 'Check the diff' }
)

// Block scalar (`>` / `|`) descriptions join their indented lines.
assert.deepStrictEqual(
  parseSkillMeta('---\ndescription: >\n  Long description\n  spanning lines\nname: long\n---\n'),
  { name: 'long', description: 'Long description spanning lines' }
)

// CRLF line endings.
assert.deepStrictEqual(parseSkillMeta('---\r\nname: crlf\r\ndescription: windows\r\n---\r\nbody'), {
  name: 'crlf',
  description: 'windows'
})

// Malformed / missing frontmatter never throws — just yields {}.
assert.deepStrictEqual(parseSkillMeta('# no frontmatter at all'), {})
assert.deepStrictEqual(parseSkillMeta('---\nname: unclosed\ndescription: nope'), {})
assert.deepStrictEqual(parseSkillMeta(''), {})
assert.deepStrictEqual(parseSkillMeta('---\n:::::: not yaml [\n---\n'), {})

// Description missing → omitted, not empty string.
assert.deepStrictEqual(parseSkillMeta('---\nname: bare\n---\n'), { name: 'bare' })

// --- discoverProjectSkills --------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'trezi-skills-'))
try {
  const skills = join(root, '.claude', 'skills')
  // Normal skill.
  mkdirSync(join(skills, 'deploy'), { recursive: true })
  writeFileSync(
    join(skills, 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Ship the app\n---\n# Deploy'
  )
  // No description in frontmatter → name-only item (folder name used: no `name:`).
  mkdirSync(join(skills, 'bare'), { recursive: true })
  writeFileSync(join(skills, 'bare', 'SKILL.md'), 'no frontmatter here')
  // Malformed frontmatter → still listed, description dropped.
  mkdirSync(join(skills, 'broken'), { recursive: true })
  writeFileSync(join(skills, 'broken', 'SKILL.md'), '---\ndescription: unclosed')
  // Nested one level (the `.claude/skills/**/SKILL.md` shape).
  mkdirSync(join(skills, 'group', 'nested'), { recursive: true })
  writeFileSync(
    join(skills, 'group', 'nested', 'SKILL.md'),
    '---\ndescription: A nested skill\n---\n'
  )
  // Frontmatter name with whitespace is not a typable slash token → folder name wins.
  mkdirSync(join(skills, 'spaced'), { recursive: true })
  writeFileSync(join(skills, 'spaced', 'SKILL.md'), '---\nname: has spaces\ndescription: d\n---\n')
  // A stray file (not a dir) and a dot-dir are ignored.
  writeFileSync(join(skills, 'README.md'), 'not a skill')
  mkdirSync(join(skills, '.hidden'), { recursive: true })
  writeFileSync(join(skills, '.hidden', 'SKILL.md'), '---\nname: hidden\n---\n')

  const found = await discoverProjectSkills(root)
  assert.deepStrictEqual(
    found,
    [
      { name: 'bare', source: 'project' },
      { name: 'broken', source: 'project' },
      { name: 'deploy', description: 'Ship the app', source: 'project' },
      { name: 'nested', description: 'A nested skill', source: 'project' },
      { name: 'spaced', description: 'd', source: 'project' }
    ],
    `discovered: ${JSON.stringify(found)}`
  )

  // No .claude/skills dir → [] (never throws).
  const empty = mkdtempSync(join(tmpdir(), 'trezi-noskills-'))
  try {
    assert.deepStrictEqual(await discoverProjectSkills(empty), [])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

// --- mergeSlashCommands -----------------------------------------------------

const project = [
  { name: 'deploy', description: 'Ship the app', source: 'project' },
  { name: 'bare', source: 'project' }
]

// Priority: project skills first, in order; others follow as source:'other'.
assert.deepStrictEqual(mergeSlashCommands(project, ['commit', 'compact']), [
  { name: 'deploy', description: 'Ship the app', source: 'project' },
  { name: 'bare', source: 'project' },
  { name: 'commit', source: 'other' },
  { name: 'compact', source: 'other' }
])

// Duplicate name: the project skill shadows the SDK command entirely.
const merged = mergeSlashCommands(project, ['deploy', 'commit'])
assert.deepStrictEqual(merged, [
  { name: 'deploy', description: 'Ship the app', source: 'project' },
  { name: 'bare', source: 'project' },
  { name: 'commit', source: 'other' }
])

// SDK names arriving with a leading "/" normalize and still dedupe.
assert.deepStrictEqual(mergeSlashCommands(project, ['/deploy', '/init']), [
  { name: 'deploy', description: 'Ship the app', source: 'project' },
  { name: 'bare', source: 'project' },
  { name: 'init', source: 'other' }
])

// No project skills → the plain SDK list, normalized.
assert.deepStrictEqual(mergeSlashCommands([], ['init']), [{ name: 'init', source: 'other' }])

// Duplicate project names collapse to the first.
assert.deepStrictEqual(
  mergeSlashCommands(
    [
      { name: 'x', description: 'first', source: 'project' },
      { name: 'x', description: 'second', source: 'project' }
    ],
    []
  ),
  [{ name: 'x', description: 'first', source: 'project' }]
)

// --- rankSlashMatches (the "/" menu, renderer-side) -------------------------

const menu = [
  { name: 'design-system', description: 'DS', source: 'project' },
  { name: 'deploy', source: 'other' },
  { name: 'debug', source: 'other' },
  { name: 'commit', source: 'other' }
]

// Empty query returns every command, project skills first.
assert.deepStrictEqual(
  rankSlashMatches(menu, '').map((c) => c.name),
  ['design-system', 'deploy', 'debug', 'commit']
)

// Substring filter is case-insensitive and preserves project-first order.
assert.deepStrictEqual(
  rankSlashMatches(menu, 'DE').map((c) => c.name),
  ['design-system', 'deploy', 'debug']
)

// A same-named non-project command is shadowed by its project skill.
assert.deepStrictEqual(
  rankSlashMatches(
    [
      { name: 'deploy', description: 'project deploy', source: 'project' },
      { name: 'deploy', source: 'other' }
    ],
    'deploy'
  ),
  [{ name: 'deploy', description: 'project deploy', source: 'project' }]
)

// No cap: a query matching >8 commands returns all of them (regression — the
// menu used to .slice(0, 8) and hide the rest; the scroll container now owns overflow).
const many = Array.from({ length: 20 }, (_, i) => ({ name: `skill-${i}`, source: 'other' }))
assert.strictEqual(rankSlashMatches(many, 'skill').length, 20)

console.log(
  'SKILLS-DISCOVERY OK — frontmatter parse, .claude/skills scan, project-first merge, uncapped menu rank'
)
