import { z } from 'zod'

export const statesCanvasDescription = 'Register or update a Trezi-owned states recipe for the selected component instance (Next.js or Vite React). Trezi builds the component from its source with the project\'s own React and draws each state in an isolated frame; this writes only Trezi app data, never project files. Use JSON props, an existing provider export for context, actions for internal interactive states and route for next/navigation. Server-only components and async Server Components cannot render in the browser.'
export const statesCanvasShape = {
  id: z.string().optional().describe('Existing canvas: id for a rebuild. Omit to create: the id is derived from source and exportName, so another export of the same file is a new recipe and the same export updates its recipe.'),
  component: z.string(),
  source: z.string().describe('Project-relative source module with the real component export.'),
  exportName: z.string().describe('Named export or default.'),
  provider: z.object({ source: z.string(), exportName: z.string() }).optional().describe('Optional existing component export that wraps children with the providers the component needs (theme, query client, store). Without it Trezi uses a conventional providers.tsx when the app has one.'),
  width: z.number().int().optional().describe('Frame width in CSS pixels (120-1600). Defaults to the selected instance\'s width.'),
  states: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      props: z.record(z.string(), z.unknown()).describe('JSON props. Tagged values: {"$fn":"name"} a no-op callback, {"$date":"ISO"} a Date, {"$pending":true} a never-settling promise, {"$reject":"message"} a rejected promise, {"$node":"text"} rendered text, {"$undefined":true} an absent prop.'),
      actions: z
        .array(
          z.object({
            type: z.enum(['click', 'focus', 'hover', 'press', 'type', 'key']),
            selector: z.string().optional().describe('CSS selector inside the state frame; defaults to the component\'s first element.'),
            text: z.string().optional(),
            key: z.string().optional()
          })
        )
        .optional()
        .describe('Steps run after the state mounts, for internal state props cannot reach (an open menu, a focused field).'),
      route: z
        .object({ pathname: z.string().optional(), search: z.string().optional(), params: z.record(z.string(), z.string()).optional() })
        .optional()
        .describe('What next/navigation and next/router report inside this state.'),
      note: z.string().optional()
    })
  ),
  missing: z.array(z.object({ id: z.string(), label: z.string(), note: z.string() }))
}
