// One independent part of resolved-lessons; the shared suite owns its fixture and assertions.
process.env.TREZI_RESOLVED_LESSONS_PART = '2'
await import('./resolved-lessons.mjs')
