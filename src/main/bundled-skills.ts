import { basename, dirname, join } from 'node:path'
import { type DiscoveredSkill, discoverSkillsInDirectory } from './skills'

// Both src/main (unit tests) and out/native are two levels deep.
export const BUNDLED_SKILLS_DIR = join(__dirname, '../../agent-plugin/skills')

export const SURFACE_CONTROLS_SKILL = join(BUNDLED_SKILLS_DIR, 'surface-controls/SKILL.md')
/** LKM-207: the states workbench skill, user-invoked only as `/states`. */
export const STATES_SKILL = join(BUNDLED_SKILLS_DIR, 'component-states/SKILL.md')
export const STATES_COMMAND = 'states'

/** Only portable skills: other bundled skills require Claude-only preview tools. */
export async function discoverPortableSkills(): Promise<DiscoveredSkill[]> {
  const skills = await discoverSkillsInDirectory(BUNDLED_SKILLS_DIR, 'other')
  return skills.flatMap((skill) => {
    if (skill.name === 'surface-controls') return [skill]
    if (skill.name === 'component-states')
      return [
        {
          ...skill,
          name: STATES_COMMAND,
          description: 'Show every state of the selected component in a scratch workbench'
        }
      ]
    return []
  })
}

/** The plugin's own name for a portable skill (`trezi:<folder>` in Claude's menu). */
export function bundledSkillFolder(skill: DiscoveredSkill): string {
  return basename(dirname(skill.path))
}
