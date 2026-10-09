// The second half of test/workflow-owner.mjs: the Swift workflow owner's tool and
// durability checks (test/helpers/workflow-tools-checks.mjs, workflow-durability.mjs) on
// the same scratch worlds and fixture, in a process of their own so they run next to the
// scenarios (LKM-167).
process.env.TREZI_WORKFLOW_PART = 'durability'
await import('./workflow-owner.mjs')
