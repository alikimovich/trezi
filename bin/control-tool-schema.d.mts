import type { ZodTypeAny } from 'zod'

/** Shared runtime schema; all inputs are revalidated by control-manifest.ts. */
export const defineControlsShape: { manifest: ZodTypeAny; engine: ZodTypeAny; prompt: ZodTypeAny }
