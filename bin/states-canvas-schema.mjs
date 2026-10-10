import { z } from 'zod'

export const statesCanvasDescription = 'Register or update a Trezi-owned component canvas recipe for the selected instance. Use existing Vite-served React modules and JSON props; this writes only Trezi app data, never project files. Components with loaders, live stores, or server-only context are unsupported.'
export const statesCanvasShape = {
  id: z.string().optional().describe('Existing canvas: id for a rebuild; omit to create.'),
  component: z.string(),
  source: z.string().describe('Project-relative source module with the real component export.'),
  exportName: z.string().describe('Named export or default.'),
  provider: z.object({ source: z.string(), exportName: z.string() }).optional().describe('Optional existing provider component export.'),
  react: z.string().describe('Same-origin Vite URL for the project React module, such as /node_modules/.vite/deps/react.js.'),
  reactDom: z.string().describe('Same-origin Vite URL for react-dom/client.'),
  width: z.number().int(),
  states: z.array(z.object({ id: z.string(), label: z.string(), props: z.record(z.string(), z.unknown()) })),
  missing: z.array(z.object({ id: z.string(), label: z.string(), note: z.string() }))
}
