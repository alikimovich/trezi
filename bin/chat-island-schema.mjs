import { z } from 'zod'
import { defineControlsShape } from './control-tool-schema.mjs'
export const chatIslandShape = {
  action: z.enum(['catalog', 'define', 'read', 'show', 'clone']),
  id: z.string().optional().describe('Existing island id or #island-… name when updating, reading, showing or cloning'),
  revision: z.number().int().optional().describe('Expected island revision when updating'),
  prompt: z.string().max(4000).optional().describe('User request when explicitly selecting engine:jev'),
  engine: z.enum(['auto', 'jev', 'agent']).optional(),
  planned: z.boolean().optional().describe('define/clone: reserve a pending island before its literals exist. Validated at once; activates after this turn lands and every binding resolves'),
  manifest: defineControlsShape.manifest.optional().describe('Literal bindings only, in one source file. Expose clean constants consumed by the project.'),
  blocks: z.array(z.object({
    id: z.string(), title: z.string().max(80), kind: z.enum(['group', 'point', 'shadow']),
    output: z.enum(['css', 'tailwind']).optional().describe('Shadow only: output literal is CSS or a Tailwind class list'),
    params: z.array(z.string()).min(1).max(12)
  })).min(1).max(12).optional().describe('Prepared groups; point requires exactly two bounded number bindings for x/y. The auto engine keeps these blocks; explicit engine:jev may select and order them. Compound blocks retain all bindings.'),
  rebind: z.object({
    file: z.string().optional().describe('Project-relative file every binding moves to'),
    params: z.array(z.object({ id: z.string(), anchor: z.string().min(1) })).max(12).optional()
      .describe('New literal anchors for params the code no longer supports')
  }).optional().describe('clone only: point the new island at the current code')
}
export const chatIslandDescription = 'Generate an interactive native island INSIDE this chat. Call catalog first: check its readiness, then the control-purpose, binding, replay and verification rules. Inspect only the code that computes the values, then define against existing literals or use planned:true before adding new ones. Prepared blocks appear without a separate model request; engine:jev explicitly asks Jev to select/order them. Supports numbers, toggles, text, color, select, Bezier and 2D points (light position). Read current values before revising an island. Source becomes editable after successful landing. No model calls on control gestures. show {id} shows an existing island again at the end of the chat; clone {id, rebind?} makes a new island with the same params, rebinding ones the code no longer supports.'
