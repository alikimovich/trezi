// One independent part of peer-coordination; the shared suite owns its fixture and assertions.
process.env.TREZI_PEER_COORDINATION_PART = '2'
await import('./peer-coordination.mjs')
