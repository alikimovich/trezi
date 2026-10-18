import { posix } from 'node:path'
import type { NativeTargetChoice } from '../shared/api'
import type { NativeContainer, NativeGraph, NativeTarget } from './graph'

/**
 * Which target a project with no manifest previews (LKM-276): the one choice the user
 * makes only when it is ambiguous. Candidates are the macOS Swift targets that are not
 * tests and not a dependency of another candidate in the same container (a framework
 * the app links is built anyway, and its previews are listed with the app's); a local
 * package another container of the repo uses counts as such a dependency. One candidate
 * is chosen automatically; a saved choice (`selection.json`) wins while it still
 * exists. Pure.
 */
export type TargetChoice = NativeTargetChoice

export interface TargetSelection {
  project?: string
  target?: string
}

export type TargetDecision =
  | { status: 'chosen'; choice: TargetChoice; reason: string; choices: TargetChoice[] }
  | { status: 'ambiguous' | 'none'; reason: string; choices: TargetChoice[] }

function isMacSwift(target: NativeTarget): boolean {
  const sdk = target.settings.SDKROOT ?? ''
  const mac = !sdk || sdk === 'macosx' || /macosx/.test(target.settings.SUPPORTED_PLATFORMS ?? '')
  return mac && target.kind !== 'test' && target.sources.some((s) => s.endsWith('.swift'))
}

/** Package folders that another container references as a local package. */
function usedPackages(graph: NativeGraph): Set<string> {
  const used = new Set<string>()
  for (const container of graph.containers)
    for (const ref of container.packages)
      if (ref.kind === 'local' && ref.path) used.add(posix.normalize(ref.path))
  return used
}

function closure(container: NativeContainer, target: NativeTarget): string[] {
  const byName = new Map(container.targets.map((t) => [t.name, t]))
  const seen: string[] = []
  const visit = (current: NativeTarget) => {
    for (const name of current.dependencies) {
      const dependency = byName.get(name)
      if (dependency && !seen.includes(name)) {
        visit(dependency)
        seen.push(name)
      }
    }
  }
  visit(target)
  return seen
}

export function previewTargets(graph: NativeGraph): TargetChoice[] {
  const used = usedPackages(graph)
  const choices: TargetChoice[] = []
  for (const container of graph.containers) {
    if (container.kind === 'workspace') continue
    if (container.kind === 'package' && used.has(posix.dirname(container.path))) continue
    const candidates = container.targets.filter(isMacSwift)
    const dependedOn = new Set(candidates.flatMap((t) => closure(container, t)))
    for (const target of candidates)
      if (!dependedOn.has(target.name))
        choices.push({
          project: container.path,
          target: target.name,
          kind: target.kind,
          module: target.module,
          includes: closure(container, target)
        })
  }
  return choices
}

export function chooseTarget(graph: NativeGraph, selection: TargetSelection): TargetDecision {
  const choices = previewTargets(graph)
  if (selection.target) {
    const saved = choices.find(
      (c) =>
        c.target === selection.target && (!selection.project || c.project === selection.project)
    )
    if (saved) return { status: 'chosen', choice: saved, reason: 'your choice', choices }
  }
  if (choices.length === 1)
    return { status: 'chosen', choice: choices[0], reason: 'the only previewable target', choices }
  if (!choices.length) {
    const found = graph.containers.flatMap((c) => c.targets.map((t) => `${t.name} (${t.kind})`))
    return {
      status: 'none',
      reason: `No macOS Swift target to preview${found.length ? ` (found ${found.join(', ')})` : ''}.`,
      choices
    }
  }
  const stale = selection.target ? ` The saved choice ${selection.target} no longer exists.` : ''
  return {
    status: 'ambiguous',
    reason: `Choose what to preview: ${choices.map((c) => `${c.target} (${c.project})`).join(', ')}.${stale}`,
    choices
  }
}
