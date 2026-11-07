import { z } from 'zod'

// `remember_rule` (LKM-556), shared by Claude's in-process server (src/main/backends/claude.ts)
// and the Codex MCP bridge (trezi-agent-mcp.mjs). Trezi runs it: the rule goes through the
// project-memory owner's update queue (src/main/project-memory-rule.ts).
export const rememberRuleDescription =
  'Save one durable rule or guide to this project\'s memory when the user explicitly asks you to remember it ("remember…", "add to memory…", "always…", "from now on…"). Trezi merges it into the project\'s existing memory, keeps the user\'s own rules, never adds an equal rule twice and injects memory into every new chat in this project only. Write it as one general rule in imperative form with a short reason if not obvious. Saving is never the requested work: still do any change or check the user asked for. Confirm it was saved only when the answer says saved: true; on saved: false say plainly that it was not saved (or that it is unknown, when uncertain) and why. When it reports a similar rule, follow its guidance.'

export const rememberRuleShape = {
  rule: z
    .string()
    .min(1)
    .max(400)
    .describe('One rule, one line, imperative ("Reuse an existing component …").'),
  section: z
    .enum(['Preferences', 'Design rules', 'Constraints', 'Project facts', 'Pitfalls'])
    .optional()
    .describe('Memory heading; default Preferences.'),
  replaces: z
    .string()
    .max(400)
    .optional()
    .describe('Exact text of a saved rule this one updates (the user changed their mind).'),
  distinct: z
    .boolean()
    .optional()
    .describe('true after a similar-rule answer when this rule is genuinely different.')
}
