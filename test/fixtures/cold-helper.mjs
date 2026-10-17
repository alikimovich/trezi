// The real provider helper entry (`provider-helper-entry.ts`) with stand-in Claude CLIs:
// the first argument is the "bundled" one, the second the "installed" one. Unlike
// tools-helper.mjs nothing is probed here: the adapter probes (or takes the owner's
// cached choice) as in the app. Used by test/provider-cold-start.mjs. The turn heartbeat
// (LKM-147) is shortened to 200 ms so a stalled turn receives several before its deadline.
const [bundled, installed] = process.argv.slice(2)
const { setClaudeCandidates } = await import('../../src/main/backends/claude-login.ts')
// The stand-in `auth` sleeps 2 s to overlap; the production 4 s kill leaves a loaded host
// little room to cold-start Bun, and a killed stand-in never logs its probe.
setClaudeCandidates({ bundled, installed: [installed], probeTimeout: 30_000 })
const { setHelperHeartbeat } = await import('../../src/main/backends/helper-host.ts')
setHelperHeartbeat(200)
await import('../../src/main/backends/provider-helper-entry.ts')
