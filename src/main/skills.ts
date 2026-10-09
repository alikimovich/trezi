/**
 * Project-skill discovery for the composer's "/" menu (LKM-54).
 *
 * The opened repo's `.claude/skills/<name>/SKILL.md` files are the *project*
 * skills. The renderer must stay free of filesystem reads, so this module (main
 * process) discovers them, pulls the `description` out of each SKILL.md's YAML
 * frontmatter, and merges them ahead of whatever command names the backend SDK
 * advertises — deduped so a project skill shadows a same-named SDK command.
 *
 * Parsing is deliberately defensive: a malformed/missing frontmatter, an
 * unreadable file, or no `.claude/skills` dir at all must never break the menu —
 * every failure degrades to "skill without a description" or "no project skills".
 */
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SlashCommandItem } from '../shared/api'

/** Strip matching single/double quotes around a YAML scalar. */
const unquote = (v: string): string => {
  const t = v.trim()
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * Pull `name` / `description` out of a SKILL.md's YAML frontmatter without a
 * YAML dependency. Handles plain scalars, quoted scalars, and block scalars
 * (`description: >` / `|` followed by indented lines — joined with spaces,
 * which is fine because the menu truncates to one visual line anyway).
 * Anything unparseable yields `{}` rather than throwing.
 */
export function parseSkillMeta(content: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content)
  if (!m) return {}
  const lines = m[1].split(/\r?\n/)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1] as 'name' | 'description'
    let value = kv[2].trim()
    if (value === '' || value === '>' || value === '|' || value === '>-' || value === '|-') {
      // Block scalar (or empty): gather the following indented lines.
      const parts: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++
        if (lines[i].trim()) parts.push(lines[i].trim())
      }
      value = parts.join(' ')
    } else {
      value = unquote(value)
    }
    if (value && out[key] === undefined) out[key] = value
  }
  return out
}

// Skill names are slash-command tokens — anything with whitespace or a "/"
// couldn't be typed after the composer's "/" and is dropped.
const validName = (name: string): boolean => /^[^\s/]+$/.test(name)

/**
 * Discover skills beneath a supplied skills directory (nested directories and
 * installed symlinks tolerated, shallow depth cap). The
 * skill name is the frontmatter `name` when present, else the containing
 * folder's name. Returns [] on any failure — never throws.
 */
export interface DiscoveredSkill extends SlashCommandItem {
  path: string
}

export async function discoverSkillsInDirectory(
  directory: string,
  source: SlashCommandItem['source'],
  includeHidden = false
): Promise<DiscoveredSkill[]> {
  const found: DiscoveredSkill[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith('.')) continue
      const sub = join(dir, e.name)
      if (!e.isDirectory()) {
        if (!e.isSymbolicLink()) continue
        try {
          if (!(await stat(sub)).isDirectory()) continue
        } catch {
          continue
        }
      }
      let meta: { name?: string; description?: string } = {}
      let hasSkill = false
      try {
        meta = parseSkillMeta(await readFile(join(sub, 'SKILL.md'), 'utf8'))
        hasSkill = true
      } catch {
        /* no SKILL.md here — recurse below */
      }
      if (hasSkill) {
        const name = meta.name && validName(meta.name) ? meta.name : e.name
        if (validName(name)) {
          found.push({
            name,
            ...(meta.description ? { description: meta.description } : {}),
            source,
            path: join(sub, 'SKILL.md')
          })
        }
      } else {
        await walk(sub, depth + 1)
      }
    }
  }
  await walk(directory, 0)
  found.sort((a, b) => a.name.localeCompare(b.name))
  return found
}

export async function discoverProjectSkills(root: string): Promise<SlashCommandItem[]> {
  const skills = await discoverSkillsInDirectory(join(root, '.claude', 'skills'), 'project')
  return skills.map(({ path: _path, ...item }) => item)
}

/**
 * Merge project skills ahead of the backend's advertised command names.
 * Duplicates collapse to the project skill (first occurrence wins within each
 * group too), so `/foo` from `.claude/skills/foo` shadows the SDK's own `foo`.
 */
export function mergeSlashCommands(
  projectSkills: SlashCommandItem[],
  otherNames: string[]
): SlashCommandItem[] {
  const seen = new Set<string>()
  const out: SlashCommandItem[] = []
  for (const s of projectSkills) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  for (const raw of otherNames) {
    const name = raw.replace(/^\//, '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, source: 'other' })
  }
  return out
}
