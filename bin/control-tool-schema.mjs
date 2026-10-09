import { z } from 'zod'

export const defineControlsShape = {
  engine: z.enum(['agent', 'jev', 'auto']).optional(),
  prompt: z.string().max(4000).optional().describe('User request; required when Jev selects and orders prepared params'),
  manifest: z.object({
    presentation: z.literal('animation').optional().describe('Persistent Trezi panel independent of selection; all params must use literal strategy'),
    replay: z.boolean().optional().describe('True after wiring trezi:animation-replay, whose detail is the component name, to restart this animation'),
    file: z.string().describe('Repo-relative path of the source file the params live in'),
    component: z.string().describe('The component the panel targets (its exported name)'),
    title: z.string().describe('Panel heading shown to the user (≤80 chars)'),
    params: z
      .array(
        z.object({
          id: z.string().describe('Stable id, unique in the panel: ^[a-z0-9][a-z0-9-]{0,40}$'),
          label: z.string().describe('Human label rendered next to the control (≤80 chars)'),
          kind: z.enum(['number', 'color', 'select', 'toggle', 'text', 'bezier']),
          unit: z.string().optional().describe("Display unit for kind 'number', e.g. 'px' | 'ms'"),
          min: z.number().optional().describe("Clamp minimum (kind 'number' only)"),
          max: z.number().optional().describe("Clamp maximum (kind 'number' only)"),
          step: z.number().optional().describe("Scrub increment (kind 'number' only)"),
          options: z
            .array(z.string())
            .optional()
            .describe("Allowed values (kind 'select' only, 1-20 entries)"),
          apply: z
            .discriminatedUnion('strategy', [
              z.object({
                strategy: z.literal('prop'),
                propName: z.string().describe('Component prop to edit (per-instance values)')
              }),
              z.object({
                strategy: z.literal('style'),
                styleProp: z
                  .string()
                  .describe("CSS longhand routed through the Styles engine, e.g. 'border-radius'")
              }),
              z.object({
                strategy: z.literal('literal'),
                anchor: z
                  .string()
                  .describe(
                    'Unique substring of the file (4-200 chars) ending immediately before the ' +
                      "literal to edit — ideal shape: 'const STAGGER_MS = '. Must occur exactly once."
                  )
              })
            ])
            .describe('How the param writes back to source')
        })
      )
      .min(1)
      .max(12)
  })
}
