// The real provider helper entry (`provider-helper-entry.ts`) with stand-in Claude CLIs:
// the first argument is the "bundled" one, the second the "installed" one. Unlike
// tools-helper.mjs nothing is probed here: the adapter probes (or takes the owner's
// cached choice) as in the app. Used by test/provider-cold-start.mjs. The turn heartbeat
// (LKM-147) is shortened to 200 ms so a stalled turn receives several before its deadline.
const [bundled, installed] = process.argv.slice(2)
const { setClaudeCandidates } = await import('../../src/main/backends/claude-login.ts')
setClaudeCandidates({ bundled, installed: [installed] })
const { setHelperHeartbeat } = await import('../../src/main/backends/helper-host.ts')
setHelperHeartbeat(200)
await import('../../src/main/backends/provider-helper-entry.ts')
