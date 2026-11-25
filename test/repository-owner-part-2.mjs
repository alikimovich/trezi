// One independent part of repository-owner; the shared suite owns its fixture and assertions.
process.env.TREZI_REPOSITORY_OWNER_PART = '2'
await import('./repository-owner.mjs')
