// The real provider helper entry (`provider-helper-entry.ts`) with stand-in CLIs: the
// first argument is a `claude` (chosen as the logged-in installed CLI, so no bundled one
// runs), the second a `codex`. The helper's environment drops every TREZI_* variable, so
// they are set here. Used by test/provider-helper-tools.mjs.
const [claude, codex] = process.argv.slice(2)
process.env.TREZI_CODEX_BIN = codex
const { resolveClaudeCli } = await import('../../src/main/backends/claude-login.ts')
await resolveClaudeCli(false, { bundled: null, installed: [claude] })
await import('../../src/main/backends/provider-helper-entry.ts')
