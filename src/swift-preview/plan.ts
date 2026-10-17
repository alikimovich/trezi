import { posix } from 'node:path'
import type { NativeContainer, NativeGraph, NativeTarget } from './graph'

/**
 * The target-graph build (LKM-273): which modules to compile, in which order, from the
 * manifest's `target` and the project's graph. Each module is a target of the same
 * container: its dependencies are built first, every one into its own `.swiftmodule`
 * and dylib, and app-entry files (`@main`, `main.swift`) are left out so the preview
 * host owns `main`. Pure: the caller reads file contents.
 */
export interface ModulePlan {
  target: string
  /** The Swift module name `import` uses. */
  module: string
  kind: NativeTarget['kind']
  /** Project-relative sources compiled into the module. */
  sources: string[]
  /** App-entry files left out of the module. */
  entries: string[]
  /** Module names this one links, already built earlier in the plan. */
  dependencies: string[]
}

export interface BuildPlan {
  container: string
  target: string
  /** Dependencies first; the selected target last. */
  modules: ModulePlan[]
  /** What stops this build in Stage 1 (packages, C targets, iOS, tests). */
  blockers: string[]
  /** What builds but may not compile or render as in Xcode. */
  warnings: string[]
}

const ENTRY = /^[ \t]*@(main|NSApplicationMain|UIApplicationMain)\b/m
const PREVIEW_MACRO = /^[ \t]*#Preview\b/m

/** A file that defines the program's entry point. */
export function isEntryFile(path: string, text: string): boolean {
  return posix.basename(path) === 'main.swift' || ENTRY.test(text)
}

/** The container to build `target` from: the manifest's `project`, else the first defining it. */
export function findTarget(
  graph: NativeGraph,
  target: string,
  project?: string
): { container: NativeContainer; target: NativeTarget } {
  const candidates = graph.containers.filter((c) => !project || c.path === project)
  if (project && !candidates.length) {
    const known = graph.containers.map((c) => c.path).join(', ') || 'none'
    throw new Error(`The project "${project}" was not found (found: ${known}).`)
  }
  for (const container of candidates) {
    const found = container.targets.find((t) => t.name === target)
    if (found) return { container, target: found }
  }
  const names = candidates.flatMap((c) => c.targets.map((t) => t.name))
  const errors = candidates.flatMap((c) => c.errors)
  throw new Error(
    `No target "${target}" in ${project ?? 'this project'}. Targets: ${names.join(', ') || 'none'}.` +
      (errors.length ? ` ${errors.join(' ')}` : '')
  )
}

export function planTargetBuild(
  graph: NativeGraph,
  select: {
    target: string
    project?: string
    exclude?: string[]
    /** The selected toolchain's `#Preview` capability (LKM-274, `toolchain.ts`). */
    preview?: { status: string; message: string }
  },
  read: (path: string) => string
): BuildPlan {
  const { container, target } = findTarget(graph, select.target, select.project)
  const byName = new Map(container.targets.map((t) => [t.name, t]))
  const excluded = (select.exclude ?? []).map((p) => posix.normalize(p))
  const isExcluded = (path: string) => excluded.some((p) => path === p || path.startsWith(`${p}/`))
  const order: NativeTarget[] = []
  const blockers: string[] = []
  const warnings: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (current: NativeTarget, chain: string[]) => {
    if (state.get(current.name) === 'done') return
    if (state.get(current.name) === 'visiting')
      throw new Error(`The targets depend on each other: ${[...chain, current.name].join(' → ')}.`)
    state.set(current.name, 'visiting')
    for (const name of current.dependencies) {
      const dependency = byName.get(name)
      if (dependency) visit(dependency, [...chain, current.name])
      else blockers.push(`${current.name} depends on "${name}", which is not in ${container.path}.`)
    }
    state.set(current.name, 'done')
    order.push(current)
  }
  visit(target, [])

  const modules = order.map((t): ModulePlan => {
    for (const product of t.packageProducts)
      blockers.push(`${t.name} needs the Swift package product ${product} (packages are Stage 2).`)
    for (const note of t.notes)
      if (/ClangTarget|BinaryTarget|SystemLibraryTarget/.test(note))
        blockers.push(`${t.name} is a ${note}; only Swift targets are built in Stage 1.`)
    const sdk = t.settings.SDKROOT ?? ''
    if (sdk && sdk !== 'macosx' && !/macosx/.test(t.settings.SUPPORTED_PLATFORMS ?? ''))
      blockers.push(
        `${t.name} builds for ${sdk}; only macOS targets are previewed (iOS is Stage 8).`
      )
    if (t.kind === 'test') blockers.push(`${t.name} is a test target.`)
    const sources: string[] = []
    const entries: string[] = []
    const previews: string[] = []
    for (const file of t.sources) {
      if (isExcluded(file)) continue
      let text = ''
      try {
        text = read(file)
      } catch {
        blockers.push(`${file} (${t.name}) could not be read.`)
        continue
      }
      if (isEntryFile(file, text)) entries.push(file)
      else sources.push(file)
      if (PREVIEW_MACRO.test(text)) previews.push(file)
    }
    if (!sources.length) blockers.push(`${t.name} has no Swift sources left to build.`)
    if (previews.length) {
      const files = `${previews.length} file${previews.length === 1 ? '' : 's'} use #Preview`
      const preview = select.preview
      warnings.push(
        preview?.status === 'supported'
          ? `${t.name}: ${files}; they compile with the selected Xcode, but #Preview bodies are not shown as previews yet (Stage 3): ${previews.join(', ')}`
          : `${t.name}: ${files}, which needs PreviewsMacros from a full Xcode selected for Trezi's processes (${preview?.message ?? 'no toolchain was checked'}): ${previews.join(', ')}`
      )
    }
    if (t.resources.length)
      warnings.push(
        `${t.name}: resources are not bundled into the preview (Stage 3): ${t.resources.join(', ')}`
      )
    return {
      target: t.name,
      module: t.module,
      kind: t.kind,
      sources,
      entries,
      dependencies: t.dependencies.flatMap((name) => byName.get(name)?.module ?? [])
    }
  })
  const seen = new Set<string>()
  for (const module of modules) {
    if (seen.has(module.module) || module.module === 'TreziPreviewHost')
      blockers.push(`Two modules would be named ${module.module}.`)
    seen.add(module.module)
  }
  return { container: container.path, target: target.name, modules, blockers, warnings }
}
