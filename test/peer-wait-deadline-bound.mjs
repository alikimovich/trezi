// One independent part of peer-wait-deadline; the shared suite owns its fixture and assertions.
process.env.TREZI_PEER_WAIT_PART = 'bound'
await import('./peer-wait-deadline.mjs')
