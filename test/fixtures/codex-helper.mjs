// The real provider helper entry (`provider-helper-entry.ts`), whose Codex adapter runs
// the stand-in `codex` CLI named by the first argument: the helper's environment drops
// every TREZI_* variable, TREZI_CODEX_BIN included. Used by test/codex-model.mjs.
process.env.TREZI_CODEX_BIN = process.argv[2]
await import('../../src/main/backends/provider-helper-entry.ts')
