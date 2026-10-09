import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverPortableSkills } from '../bundled-skills'
import { type DiscoveredSkill, discoverSkillsInDirectory } from '../skills'
import type { ModelProvider } from './types'

/** Project skills shadow user skills; native locations shadow compatible ones. */
export async function discoverProviderSkills(
  root: string,
  provider: string,
  home = homedir(),
  codexHome = process.env.CODEX_HOME || join(home, '.codex')
): Promise<DiscoveredSkill[]> {
  const native = provider === 'gemini' ? '.gemini' : '.codex'
  const locations = [
    [join(root, '.agents', 'skills'), 'project'],
    [join(root, native, 'skills'), 'project'],
    [join(root, '.claude', 'skills'), 'project'],
    [join(home, '.agents', 'skills'), 'other'],
    [join(provider === 'gemini' ? join(home, native) : codexHome, 'skills'), 'other'],
    [join(home, '.claude', 'skills'), 'other']
  ] as const
  const groups = await Promise.all(
    locations.map(([dir, source]) => discoverSkillsInDirectory(dir, source, true))
  )
  const seen = new Set<string>()
  return [...groups.flat(), ...(await discoverPortableSkills())].filter((skill) => {
    if (seen.has(skill.name)) return false
    seen.add(skill.name)
    return true
  })
}

/** Explicit file references make /skills usable by harnesses without slash commands. */
export function withSkillReferences(text: string, skills: DiscoveredSkill[]): string {
  const names = new Set(Array.from(text.matchAll(/(?:^|\s)\/([^\s/]+)/g), (match) => match[1]))
  const selected = skills.filter((skill) => names.has(skill.name))
  if (!selected.length) return text
  return `${text}\n\nThe user invoked these skills. Read each SKILL.md and follow its instructions:\n${selected.map((skill) => `- /${skill.name}: ${JSON.stringify(skill.path)}`).join('\n')}`
}

/** Share discovery across Codex, custom endpoints, and experimental Gemini. */
export function withSkillMenu(provider: ModelProvider): ModelProvider {
  return {
    ...provider,
    async startSession(root, options, getWindow, ctx) {
      const skillsPromise = discoverProviderSkills(ctx?.liveRoot ?? root, provider.id)
      const session = await provider.startSession(root, options, getWindow, ctx)
      const skills = await skillsPromise
      session.emit({ type: 'commands', commands: skills.map(({ path: _path, ...item }) => item) })
      const send = session.send.bind(session)
      session.send = (text, images) => send(withSkillReferences(text, skills), images)
      return session
    }
  }
}
