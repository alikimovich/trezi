/**
 * Curated catalog of external "taste" skill packs Trezi can OFFER to install
 * (never bundle, never silently install) into a user's project (`<repo>/.claude/skills/`)
 * or user scope (`~/.claude/skills/`). Once installed with the `skills` CLI's
 * `--copy` mode, the Agent SDK auto-discovers them (Trezi launches with
 * `settingSources: ['user','project','local']`).
 *
 * This module is PURE data + arg-building only — no filesystem, no network, no
 * spawning (the service's workflow owner does that; skills-install.ts is its
 * contract). Keeping it pure makes the catalog and the `npx skills add` argv fully
 * unit-testable.
 *
 * SECURITY: installing a skill fetches a repo whose SKILL.md becomes instructions
 * the agent later follows (a prompt-injection / RCE-adjacent surface). The
 * installer must ONLY act on entries in this allowlist — the model must never be
 * able to funnel an arbitrary repo string into `npx skills add`. `findPack`
 * is the gate: anything not in SKILL_PACKS returns undefined and is rejected.
 *
 * Repo slugs below were verified against GitHub (repo exists; named skills present)
 * on 2026-07. The `skills` CLI is the npm package `skills` (vercel-labs/skills);
 * `npx skills add <owner/repo>` is the install command.
 */

export interface SkillPack {
  /** Stable slug used by tools/UI to reference this pack. */
  id: string
  /** owner/repo passed to `npx skills add`. */
  repo: string
  title: string
  /** One line shown to the user when offering the pack. */
  description: string
  /** Homepage for credit. */
  url: string
  /** Specific skills to install; omit/empty = every skill in the repo. */
  skills?: string[]
  recommendedScope: 'project' | 'user'
}

/**
 * 3–5 curated entries. Each repo slug + named skill verified to exist on GitHub.
 * Add sparingly; every entry here is something the agent may offer to install.
 */
export const SKILL_PACKS: SkillPack[] = [
  {
    id: 'emil-design-eng',
    repo: 'emilkowalski/skills',
    title: 'Design engineering & animation craft (Emil Kowalski)',
    description:
      'Design-engineering taste: interaction/animation craft, UI-library picking, and Apple-grade polish.',
    url: 'https://github.com/emilkowalski/skills',
    // Whole repo: design-eng, animation-vocabulary, improve/review/find-animation, apple-design, pick-ui-library.
    recommendedScope: 'user'
  },
  {
    id: 'anthropic-frontend-design',
    repo: 'anthropics/skills',
    title: 'Frontend design (Anthropic)',
    description: "Anthropic's frontend-design skill for building polished, well-structured web UI.",
    url: 'https://github.com/anthropics/skills/tree/main/skills/frontend-design',
    // The repo bundles many unrelated skills (xlsx, pdf, …) — install only this one.
    skills: ['frontend-design'],
    recommendedScope: 'user'
  },
  {
    id: 'color-expert',
    repo: 'meodai/skill.color-expert',
    title: 'Color expert (meodai)',
    description:
      'Deep color knowledge: naming, theory, spaces, palettes, gradients, and perceptual matching.',
    url: 'https://github.com/meodai/skill.color-expert',
    recommendedScope: 'user'
  }
]

/** Look up a pack by id. Returns undefined for anything not in the catalog — this
 * is the security gate: an off-catalog repo/id can never reach the installer. */
export function findPack(id: string): SkillPack | undefined {
  return SKILL_PACKS.find((p) => p.id === id)
}

/**
 * Pure: build the argv for `npx skills add`. Testable without spawning.
 *
 * Flags (from vercel-labs/skills):
 *  - `-a claude-code` pins the agent (no interactive detection)
 *  - `-y` skips prompts
 *  - `--copy` writes real, portable, commit-able files (default is a symlink)
 *  - `-g` targets user scope (`~/.claude/skills/`); omitted = project (`./.claude/skills/`)
 *  - `--skill <name>` (repeatable) selects specific skills; `--all` installs every skill
 */
export function buildInstallArgs(pack: SkillPack, scope: 'project' | 'user'): string[] {
  return [
    'skills',
    'add',
    pack.repo,
    '-a',
    'claude-code',
    '-y',
    '--copy',
    ...(scope === 'user' ? ['-g'] : []),
    ...(pack.skills?.length ? pack.skills.flatMap((s) => ['--skill', s]) : ['--all'])
  ]
}
