// LOCAL-WEBKIT-3: Trezi lands a chat's or a spawn's work only after a host check passed on
// its exact source. Landing tests that are not about the gate record that check here, as
// `run_checks` does (test/integration-gate.mjs covers the gate and real checks).
import { setCheckReplayer } from '../../src/main/integration-gate.ts'
import { sourceSnapshot } from '../../src/main/source-snapshot.ts'
import {
  newReceiptId,
  receiptSession,
  recordCommandReceipt
} from '../../src/main/verification-receipts.ts'
import { projectKey } from '../../src/shared/projectKey.ts'

/** Records a host check on `root`'s current source for the session `emitKey` (passing by default). */
export async function passCheck(emitKey, root, check = 'fixture-check', passed = true) {
  const snapshot = await sourceSnapshot(root)
  if (!snapshot.tree) throw new Error(`No source tree for ${root}: ${snapshot.reason}`)
  const receipt = {
    id: newReceiptId(),
    createdAt: new Date().toISOString(),
    kind: 'command',
    check,
    command: ['bun', 'run', check],
    root,
    source: {
      snapshot: snapshot.id,
      tree: snapshot.tree,
      head: snapshot.head,
      dirty: snapshot.dirty
    },
    exitCode: passed ? 0 : 1,
    signal: null,
    timedOut: false,
    cancelled: false,
    output: '',
    verified: passed,
    reason: passed ? null : 'exit 1',
    ms: 1
  }
  recordCommandReceipt(receiptSession(emitKey, projectKey(root)), receipt)
  return receipt
}

/**
 * A clean reconcile replays the session's passing checks on the new source. The fixture
 * check has no script to run, so its replay records the result `passes(scope)` gives
 * (a pass by default), as the real check would. Answers the replays it saw.
 */
export function replayFixtureChecks(passes = () => true) {
  const replays = []
  setCheckReplayer(async (recipe, scope) => {
    replays.push({ recipe, scope })
    const passed = passes(scope)
    await passCheck(scope.emitKey, scope.root, recipe.check ?? 'fixture-check', passed)
    return passed
  })
  return replays
}

/** The candidate tree a direct `completeTurn`/`applyParked` call lands: `root`'s source now. */
export async function candidateOf(root) {
  const snapshot = await sourceSnapshot(root)
  if (!snapshot.tree) throw new Error(`No source tree for ${root}: ${snapshot.reason}`)
  return snapshot.tree
}
