// One independent part of service-process; the shared suite owns its fixture and assertions.
process.env.TREZI_SERVICE_PROCESS_PART = 'supervision'
await import('./service-process.mjs')
