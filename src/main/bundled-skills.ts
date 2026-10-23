import { basename, dirname, join } from 'node:path'
import { type DiscoveredSkill, discoverSkillsInDirectory } from './skills'

// Both src/main (unit tests) and out/native are two levels deep.
export const BUNDLED_SKILLS_DIR = join(__dirname, '../../agent-plugin/skills')

export const SURFACE_CONTROLS_SKILL = join(BUNDLED_SKILLS_DIR, 'surface-controls/SKILL.md')
export const DOCTOR_SKILL = join(BUNDLED_SKILLS_DIR, 'trezi-doctor/SKILL.md')

/** Only portable skills: other bundled skills require Claude-only preview tools. */
export async function discoverPortableSkills(): Promise<DiscoveredSkill[]> {
  const skills = await discoverSkillsInDirectory(BUNDLED_SKILLS_DIR, 'other')
  return skills.filter((skill) => skill.name === 'surface-controls')
}

/** The plugin's own name for a portable skill (`trezi:<folder>` in Claude's menu). */
export function bundledSkillFolder(skill: DiscoveredSkill): string {
  return basename(dirname(skill.path))
}
