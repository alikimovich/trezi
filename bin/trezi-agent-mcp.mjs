#!/usr/bin/env node
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('PRAXIS_')) process.env[key.replace(/^PRAXIS_/, 'TREZI_')] ??= value
}

import { request } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { chatIslandDescription, chatIslandShape } from './chat-island-schema.mjs'
import { chatUiDescription, chatUiShape } from './chat-ui-schema.mjs'
import { previewToolShapes, previewToolText } from './preview-tool-schema.mjs'

const socketPath = process.env.TREZI_AGENT_TOOL_SOCKET
const token = process.env.TREZI_AGENT_TOOL_TOKEN

if (!socketPath || !token) {
  process.stderr.write('Trezi agent tool bridge is not configured.\n')
  process.exit(1)
}

const invoke = async (action, args) => {
  const payload = JSON.stringify({ action, args })
  const body = await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/invoke',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        },
        // LKM-203: above the synchronous tools' worst case (land 60 s, push/merge, workflow
        // polling bounded at 180 s from the call); `SYNC_TOOL_TIMEOUT_SEC` in codex-mcp.ts.
        timeout: 300_000
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (response.statusCode !== 200 || !parsed?.ok) {
            reject(
              new Error(parsed?.error || `Trezi tool bridge returned HTTP ${response.statusCode}.`)
            )
            return
          }
          resolve(parsed)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Trezi tool bridge timed out.')))
    req.on('error', reject)
    req.end(payload)
  })
  return body.result
}

const result = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  isError: !!value?.error
})

const server = new McpServer({ name: 'trezi', version: '1.0.0' })

server.registerTool(
  'workspace_state',
  {
    title: 'Trezi workspace state',
    description:
      'Inspect Trezi authoritative landing/worktree state for this chat. Call this whenever a merge, conflict, worktree, landing, or stale-preview issue is suspected; do not infer state from `git status` in the private worktree.'
  },
  async () => result(await invoke('workspace_state'))
)

server.registerTool(
  'prepare_conflict_resolution',
  {
    title: 'Prepare Trezi conflict resolution',
    description:
      'Ask Trezi to safely combine the current live checkout with this chat’s parked changes inside this chat worktree. Call when workspace_state says `parked`. If files are returned, resolve every marker in them; the normal turn completion will ask Trezi to land the resolved result.'
  },
  async () => result(await invoke('prepare_conflict_resolution'))
)

server.registerTool(
  'git_sync_base',
  {
    description:
      'Fetch an origin base branch and merge it into this chat worktree. Conflicts remain in the files for you to resolve.',
    inputSchema: { ref: z.string().optional() }
  },
  async (args) => result(await invoke('git_sync_base', args))
)
server.registerTool(
  'git_merge_continue',
  {
    description:
      'After resolving every conflict, create the real two-parent merge commit in this chat worktree.',
    inputSchema: {}
  },
  async () => result(await invoke('git_merge_continue'))
)
server.registerTool(
  'git_merge_abort',
  {
    description: 'Abort the in-progress base merge in this chat worktree.',
    inputSchema: {}
  },
  async () => result(await invoke('git_merge_abort'))
)
server.registerTool(
  'pr_status',
  {
    description: 'Read mergeability, checks, and branch information for an existing pull request.',
    inputSchema: { number: z.number().int().positive().optional() },
    annotations: { readOnlyHint: true }
  },
  async (args) => result(await invoke('pr_status', args))
)
server.registerTool(
  'publish_update',
  {
    description:
      'Land current edits and synchronously push the existing PR branch through Trezi Publish. Never force-pushes.',
    inputSchema: { number: z.number().int().positive().optional() }
  },
  async (args) => result(await invoke('publish_update', args))
)
server.registerTool(
  'land_now',
  {
    description:
      'Land current chat edits into the live checkout now and return the commit, park or conflict, and preview state. Later edits land again at turn end.',
    inputSchema: { message: z.string().optional() }
  },
  async (args) => result(await invoke('land_now', args))
)
server.registerTool(
  'publish_merge',
  {
    description:
      'Publish and squash merge the existing PR now when Agent can merge pull requests is on.',
    inputSchema: {
      number: z.number().int().positive().optional(),
      confirmed: z.boolean().optional()
    }
  },
  async (args) => result(await invoke('publish_merge', args))
)

server.registerTool(
  'chat_island',
  { description: chatIslandDescription, inputSchema: chatIslandShape },
  async (args) => result(await invoke('chat_island', args))
)

// LKM-208: native answer components; Codex asks structured questions with its form.
server.registerTool(
  'chat_ui',
  { description: chatUiDescription, inputSchema: chatUiShape },
  async (args) => result(await invoke('chat_ui', args))
)

server.registerTool(
  'open_code',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      'Open the mini code editor in the exact project file and highlight inclusive source lines. Read the file first; use when asked to show code or an implementation.',
    inputSchema: {
      file: z.string(),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1).optional()
    }
  },
  async (args) => result(await invoke('open_code', args))
)

server.registerTool(
  'open_preview',
  {
    annotations: { destructiveHint: false, openWorldHint: false },
    description:
      'Open a project page in the private agent browser. target: user reveals it in the visible preview only when idle.',
    inputSchema: {
      path: z.string(),
      target: z.enum(['agent', 'user']).optional(),
      engine: z.enum(['webkit', 'chromium']).optional()
    }
  },
  async (args) => result(await invoke('open_preview', args))
)

server.registerTool(
  'reload_preview',
  {
    annotations: { destructiveHint: false, openWorldHint: false },
    description:
      'Reload the private agent browser, keeping its route. target: user reloads the visible preview only when idle.',
    inputSchema: {
      hard: z.boolean().optional(),
      target: z.enum(['agent', 'user']).optional(),
      engine: z.enum(['webkit', 'chromium']).optional()
    }
  },
  async (args) => result(await invoke('reload_preview', args))
)

server.registerTool(
  'restart_dev_server',
  {
    annotations: { destructiveHint: false, openWorldHint: false },
    description:
      "Restart the project's dev server (Trezi owns it; never start one yourself). cleanCache: true first removes its dependency caches (Vite node_modules/.vite, Next .next/cache) and reloads the preview without cache on the same route. Returns the new server URL, the load result and CSS/JS freshness.",
    inputSchema: { cleanCache: z.boolean().optional() }
  },
  async (args) => result(await invoke('restart_dev_server', args))
)

// Observation results already contain MCP content blocks. Preserve images as images.
server.registerTool(
  'preview_location',
  {
    description: 'Read the private agent browser route. target: user reads the visible preview.',
    inputSchema: {
      target: z.enum(['agent', 'user']).optional(),
      engine: z.enum(['webkit', 'chromium']).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  async (args) => invoke('preview_location', args)
)
// LKM-138: isolated-world inspection of the live preview (preview-tool-schema.mjs).
for (const name of [
  'preview_screenshot',
  'preview_inspect',
  'preview_evaluate',
  'preview_console',
  'preview_viewport',
  'preview_speed'
]) {
  server.registerTool(
    name,
    {
      description: previewToolText[name],
      inputSchema: previewToolShapes[name],
      annotations: {
        readOnlyHint: name !== 'preview_viewport' && name !== 'preview_speed',
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async (args) => invoke(name, args)
  )
}

server.registerTool(
  'project_ui_catalog',
  {
    description:
      'Discover supported React and Svelte components, literal props and styles for UI composition. Requires Experimental Gen UI enabled.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  async () => result(await invoke('project_ui_catalog'))
)
server.registerTool(
  'compose_project_ui',
  {
    description:
      'Return project-component source: .tsx for React or .svelte for Svelte. Do not mix frameworks. For the current chat model provide file and spec. With Jev selected provide file, prompt and atomic candidates; Jev chooses the composition. Apply returned source with ordinary edit tools. Never silently fall back if Jev fails.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      file: z.string(),
      prompt: z.string().optional(),
      candidates: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            element: z.object({ type: z.string(), props: z.record(z.string(), z.unknown()) }),
            root: z.boolean().optional(),
            resource: z.string().optional()
          })
        )
        .optional(),
      spec: z
        .object({
          root: z.string(),
          elements: z.record(
            z.string(),
            z
              .object({
                type: z.string(),
                props: z.record(z.string(), z.unknown()),
                children: z.array(z.string())
              })
              .strict()
          )
        })
        .strict()
        .optional()
    }
  },
  async (args) => result(await invoke('compose_project_ui', args))
)

// LKM-199: the same question card as Claude's AskUserQuestion. It returns at once; the
// answer arrives as the user's next message.
server.registerTool(
  'ask_user',
  {
    description:
      "Ask the user a choice that is truly theirs, on a question card in this chat. Returns at once: then end your turn and wait; the answer arrives as the user's next message. When the choice is not the user's, do not ask: proceed with a stated default.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      questions: z
        .array(
          z.object({
            question: z.string().describe('The full question sentence.'),
            header: z.string().describe('A very short label (12 characters at most).'),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .min(2)
              .max(4),
            multiSelect: z.boolean().optional()
          })
        )
        .min(1)
        .max(4)
    }
  },
  async (args) => result(await invoke('ask_user', args))
)

await server.connect(new StdioServerTransport())
