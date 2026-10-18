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
 */
import type { SkillRecommendation } from './skills-catalog'
import type { SkillGitHubImport, SkillGitHubInput } from './skills-registry'

export type SkillRecommendationCategory = 'ui-craft' | 'design-systems' | 'react' | 'swiftui'

/** Per recommendation ID: its category and the ref an import resolves. */
export const SKILL_RECOMMENDATION_IMPORTS: Readonly<
  Record<string, { category: SkillRecommendationCategory; ref: string }>
> = Object.freeze({
  'frontend-design': { category: 'ui-craft', ref: 'main' },
  'vercel-react-best-practices': { category: 'react', ref: 'main' },
  'vercel-composition-patterns': { category: 'design-systems', ref: 'main' },
  'swiftui-expert-skill': { category: 'swiftui', ref: 'main' }
})

/** The `github` request that imports a recommendation. */
export function recommendationImport(entry: SkillRecommendation): SkillGitHubInput {
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
