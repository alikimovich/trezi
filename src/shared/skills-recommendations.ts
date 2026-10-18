/**
 * The GitHub import side of the curated recommendations (LKM-285). A recommendation is
 * metadata (`SKILL_RECOMMENDATIONS`, LKM-288) and is never preinstalled: importing one
 * is an explicit `github` import of its folder on `main`, which the service pins to the
 * commit `main` resolves to and checks there. `recommendationMismatch` then compares
 * what was actually imported with what the recommendation claims, so a moved folder,
 * renamed skill or changed license is shown, not hidden.
 *
 * Left out on purpose: `vercel-labs/agent-skills` `skills/web-design-guidelines`
 * declares no license and fetches mutable guidelines from GitHub on every use, so it
 * cannot be offered as a pinned, offline package. No accessibility-specific skill met
 * the same evidence bar yet.
 *
 * Importable only when the folder fits the skills-only scope and `SKILLS_LIMITS`. The
 * evidence below was measured on the upstream tree at the recorded commit; the caps
 * are not weakened to fit a folder, so `vercel-react-best-practices` (76 files, over
 * `maxFiles`) and `swiftui-expert-skill` (scripts, images, a 398841-byte file) are
 * listed but not importable. `test/skills-github.mjs` checks the catalog against this.
 */
import type { SkillRecommendation } from './skills-catalog'
import type { SkillGitHubImport, SkillGitHubInput } from './skills-registry'

export type SkillRecommendationCategory = 'ui-craft' | 'design-systems' | 'react' | 'swiftui'

/** Upstream measurements of a recommendation's folder at `commit`. */
export interface SkillRecommendationEvidence {
  commit: string
  files: number
  bytes: number
  /** The largest single file. */
  maxFileBytes: number
  /** File types other than Markdown, when the folder has any. */
  other?: string
}

/** Per recommendation ID: its category, the ref an import resolves and its upstream evidence. */
export const SKILL_RECOMMENDATION_IMPORTS: Readonly<
  Record<
    string,
    { category: SkillRecommendationCategory; ref: string; evidence: SkillRecommendationEvidence }
  >
> = Object.freeze({
  'frontend-design': {
    category: 'ui-craft',
    ref: 'main',
    evidence: {
      commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
      files: 2,
      bytes: 19564,
      maxFileBytes: 10174
    }
  },
  'vercel-react-best-practices': {
    category: 'react',
    ref: 'main',
    evidence: {
      commit: '063bee94c3f4df8453406c830b0a7df0f2860278',
      files: 76,
      bytes: 230383,
      maxFileBytes: 108261,
      other: '1 .json'
    }
  },
  'vercel-composition-patterns': {
    category: 'design-systems',
    ref: 'main',
    evidence: {
      commit: '063bee94c3f4df8453406c830b0a7df0f2860278',
      files: 14,
      bytes: 50339,
      maxFileBytes: 22627
    }
  },
  'swiftui-view-refactor': {
    category: 'swiftui',
    ref: 'main',
    evidence: {
      commit: 'd602e8ada5e8c73fadcb4d9eaff6d16fa17462db',
      files: 2,
      bytes: 12565,
      maxFileBytes: 7961
    }
  },
  'swiftui-expert-skill': {
    category: 'swiftui',
    ref: 'main',
    evidence: {
      commit: '204dba7c67256a8b707ee3fbc5759a824191974f',
      files: 51,
      bytes: 901559,
      maxFileBytes: 398841,
      other: '13 .py, 2 .png, 1 .svg, 1 .yaml'
    }
  }
})

/** The `github` request that imports a recommendation; null when it is not importable. */
export function recommendationImport(entry: SkillRecommendation): SkillGitHubInput | null {
  if (!entry.importable || !entry.pathVerified) return null
  return {
    url: `https://github.com/${entry.repository}`,
    ref: SKILL_RECOMMENDATION_IMPORTS[entry.id]?.ref ?? 'main',
    ...(entry.path ? { subpath: entry.path } : {})
  }
}

/** What the imported skill does not match of its recommendation (empty when it all does). */
export function recommendationMismatch(
  entry: SkillRecommendation,
  result: Pick<SkillGitHubImport, 'name' | 'source'>
): string[] {
  const out: string[] = []
  const { source } = result
  if (source.repository.toLowerCase() !== entry.repository.toLowerCase())
    out.push(`repository is ${source.repository}, not ${entry.repository}`)
  if (source.subpath !== entry.path)
    out.push(`folder is ${source.subpath || '(root)'}, not ${entry.path}`)
  if (result.name !== entry.id) out.push(`skill is named ${result.name}, not ${entry.id}`)
  if (source.license !== entry.license)
    out.push(`license is ${source.license ?? 'unknown'}, not ${entry.license}`)
  return out
}
