/** The import side of the Settings catalog. Every import is opt-in and resolves a
 * full commit; recommendationMismatch checks the source that was actually stored. */
import type { SkillRecommendation } from './skills-catalog'
import type { SkillGitHubImport, SkillGitHubInput } from './skills-registry'

export type SkillRecommendationCategory =
  | 'Start here'
  | 'UI and motion'
  | 'Type and color'
  | 'Inclusive layout'
  | 'Writing'
  | 'Explore and review'

export interface SkillRecommendationEvidence {
  commit: string
  /** Upstream folder; for static adapters these count retained reference files only. */
  files: number
  bytes: number
  maxFileBytes: number
  adapter?: 'static-markdown'
  upstreamFiles?: number
  upstreamBytes?: number
  /** Non-instruction file omitted from a supported GitHub import. */
  omitted?: 'agents/openai.yaml'
  /** A front matter rule that Trezi cannot preserve. */
  unsupported?: 'disable-model-invocation' | 'dynamic-preprocessing'
}

const EMIL = 'c8a79627b59d72d764d6ab6f2c87c09a48169833'
const JAKUB = '60bf140e43c98b248e6594487384ec967e89d98a'
const IMPECCABLE = '5af4319c4e7a7ee3e5e2b9fe899bcfb21c6190cb'
const emil = (
  category: SkillRecommendationCategory,
  files: number,
  bytes: number,
  maxFileBytes: number
) => ({ category, ref: EMIL, evidence: { commit: EMIL, files, bytes, maxFileBytes } })
const jakub = (
  category: SkillRecommendationCategory,
  files: number,
  bytes: number,
  maxFileBytes: number,
  unsupported = false
) => ({
  category,
  ref: JAKUB,
  evidence: {
    commit: JAKUB,
    files,
    bytes,
    maxFileBytes,
    omitted: 'agents/openai.yaml' as const,
    ...(unsupported ? { unsupported: 'disable-model-invocation' as const } : {})
  }
})

export const SKILL_RECOMMENDATION_IMPORTS: Readonly<
  Record<
    string,
    {
      category: SkillRecommendationCategory
      ref: string
      evidence: SkillRecommendationEvidence
    }
  >
> = Object.freeze({
  'frontend-design': {
    category: 'Start here',
    ref: 'main',
    evidence: {
      commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
      files: 2,
      bytes: 19564,
      maxFileBytes: 10174
    }
  },
  impeccable: {
    category: 'Start here',
    ref: IMPECCABLE,
    evidence: {
      commit: IMPECCABLE,
      files: 17,
      bytes: 90604,
      maxFileBytes: 11313,
      adapter: 'static-markdown',
      upstreamFiles: 58,
      upstreamBytes: 2215692
    }
  },
  'emil-design-eng': emil('Start here', 1, 27509, 27509),
  'better-ui': jakub('UI and motion', 8, 32213, 11122),
  animate: emil('UI and motion', 2, 19867, 11910),
  'better-typography': jakub('Type and color', 8, 29444, 12244),
  'better-colors': jakub('Type and color', 8, 38486, 7698),
  'better-accessibility': jakub('Inclusive layout', 8, 36021, 10949),
  'better-layout': jakub('Inclusive layout', 4, 18301, 8414),
  'better-writing': {
    ...jakub('Writing', 3, 12367, 9414),
    evidence: { ...jakub('Writing', 3, 12367, 9414).evidence, unsupported: 'dynamic-preprocessing' }
  },
  variant: jakub('Explore and review', 3, 14042, 7042, true),
  'state-machine': jakub('Explore and review', 3, 13450, 6978, true),
  'interface-review': jakub('Explore and review', 4, 21124, 10128, true)
})

/** The existing GitHub import, pinned to the reviewed commit for new entries. */
export function recommendationImport(entry: SkillRecommendation): SkillGitHubInput | null {
  if (!entry.importable || !entry.pathVerified) return null
  return {
    url: `https://github.com/${entry.repository}`,
    ref: SKILL_RECOMMENDATION_IMPORTS[entry.id]?.ref ?? 'main',
    ...(entry.path ? { subpath: entry.path } : {})
  }
}

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
  const pinned = SKILL_RECOMMENDATION_IMPORTS[entry.id]?.ref
  if (pinned && /^[0-9a-f]{40}$/.test(pinned) && source.commit !== pinned)
    out.push(`commit is ${source.commit}, not ${pinned}`)
  return out
}
