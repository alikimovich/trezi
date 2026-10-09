import type {
  Experimental_CompositionEvaluator,
  Experimental_CompositionEvent
} from '@json-render/core'
import { z } from 'zod'
import { resolveJevKey } from './jev-credentials'
import { buildCatalog, exportProjectUi, validateProjectUiFile } from './project-ui'
import type { ProjectUiCatalog } from './project-ui-catalog'

export const JEV_MODEL = 'typesafe-ai/jev'
export const jevCompositionInput = z
  .object({
    file: z.string().max(250),
    prompt: z.string().min(1).max(4000),
    candidates: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z][\w-]{0,63}$/),
            description: z.string().min(1).max(500),
            element: z
              .object({ type: z.string(), props: z.record(z.string(), z.unknown()) })
              .strict(),
            root: z.boolean().optional(),
            resource: z.string().max(80).optional()
          })
          .strict()
      )
      .min(1)
      .max(24)
  })
  .strict()

/** Jev chooses topology; prepared props remain unchanged. Only finished, validated output is exported. */
export async function composeProjectUiWithJev(
  project: ProjectUiCatalog,
  input: unknown,
  options: {
    signal?: AbortSignal
    evaluate?: Experimental_CompositionEvaluator
    apiKey?: string
    connectionId?: string
  } = {}
) {
  options.signal?.throwIfAborted()
  const args = jevCompositionInput.parse(input)
  const framework = validateProjectUiFile(args.file)
  if (Buffer.byteLength(JSON.stringify(args)) > 32_000)
    throw new Error('Keep Jev candidates below 32 KB.')
  if (new Set(args.candidates.map((c) => c.id)).size !== args.candidates.length)
    throw new Error('Jev candidate ids must be unique.')
  const catalog = await buildCatalog(project)
  // Validate before network use, including components with required children (validated after composition).
  for (const candidate of args.candidates) {
    const discovered = project.components.find((c) => c.name === candidate.element.type)
    if (discovered && (discovered.framework ?? 'react') !== framework)
      throw new Error(`${discovered.name} cannot compose into ${framework} source.`)
    const component = catalog.data.components[candidate.element.type]
    if (!component) throw new Error(`Unknown component: ${candidate.element.type}`)
    component.props.parse(candidate.element.props)
    if (candidate.element.type === 'Text' && candidate.root !== false)
      throw new Error('Text candidates must use root:false.')
  }
  const { experimental_composeSpec, experimental_createEvaluator } = await import(
    '@json-render/core'
  )
  const apiKey = options.evaluate
    ? undefined
    : (options.apiKey ?? (await resolveJevKey(options.connectionId)))
  const deadline = AbortSignal.timeout(25_000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const evaluate =
    options.evaluate ??
    experimental_createEvaluator({
      apiKey: apiKey ?? '',
      model: JEV_MODEL,
      timeoutMs: 10_000,
      fetch: async (url, init) => {
        try {
          const response = await fetch(url, { ...init, redirect: 'error' })
          if (!response.ok) throw new Error(`Jev request failed (HTTP ${response.status}).`)
          return response
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          if (/^Jev request failed \(HTTP \d{3}\)\.$/.test(message)) throw error
          throw new Error('Jev request failed or was cancelled. No fallback was generated.')
        }
      }
    })
  let complete: Extract<Experimental_CompositionEvent, { type: 'complete' }> | undefined
  for await (const event of experimental_composeSpec({
    catalog,
    candidates: args.candidates,
    prompt: args.prompt,
    evaluate,
    strategy: 'batch',
    maxSteps: 2,
    maxElements: 24,
    maxDepth: 6,
    signal
  })) {
    if (event.type === 'complete') complete = event
  }
  signal.throwIfAborted()
  if (complete?.stopReason !== 'finish' || !complete.spec) {
    return {
      engine: 'jev' as const,
      model: JEV_MODEL,
      stopReason: complete?.stopReason ?? 'unavailable',
      error:
        'Jev did not finish a composition. No source was generated; refine the candidates or request.',
      evaluations: complete?.steps.length ?? 0
    }
  }
  // The composer adds empty state and optional metadata; this exporter supports static trees only.
  const spec = {
    root: complete.spec.root,
    elements: Object.fromEntries(
      Object.entries(complete.spec.elements).map(([id, element]) => [
        id,
        {
          type: element.type,
          props: element.props,
          children: element.children ?? []
        }
      ])
    )
  }
  const output = await exportProjectUi(project, { file: args.file, spec })
  signal.throwIfAborted()
  return {
    ...output,
    spec,
    engine: 'jev' as const,
    model: JEV_MODEL,
    stopReason: complete.stopReason,
    evaluations: complete.steps.length,
    elapsedMs: complete.elapsedMs,
    inputTokens: complete.inputTokens
  }
}
