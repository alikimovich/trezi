import { z } from 'zod'

// `open_code` (LKM-363), shared by Claude's in-process server (src/main/backends/claude.ts)
// and the Codex MCP bridge (trezi-agent-mcp.mjs), so both open the same editor the same way.
export const openCodeDescription =
  'Open Trezi’s code editor and select + highlight an exact range. Read-only: never writes. Either file + inclusive 1-based startLine/endLine (read the file first), or source: the selected preview object’s stamp (path:line[:column], from "In the preview I selected … in <source>", also on follow-ups) with target "element" (its markup) or "styles" (inline style, class/CSS rules, CSS module, shared component). When the mapping is several sources or uncertain, nothing opens and candidates with provenance come back: show each as its `link` Markdown (a clickable filename that opens Trezi’s editor at that range) plus its provenance, never claim one as exact.'

export const openCodeShape = {
  file: z.string().max(1000).optional().describe('Repo-relative file (with startLine)'),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  source: z
    .string()
    .max(1000)
    .optional()
    .describe('Selected object’s source stamp path:line[:column], instead of file'),
  target: z
    .enum(['element', 'styles'])
    .optional()
    .describe('With source: element (default) or styles'),
  classes: z
    .array(z.string().max(200))
    .max(40)
    .optional()
    .describe('With source: the runtime classes the preview reported, to find their CSS rules')
}
