// Reconcile board #SUMMARY read models against actual placement counts, repairing
// any drift. Runs nightly on an EventBridge schedule in prod (Phase 15); this is
// the manual/local entry point.
//
//   LOCAL=1 pnpm reconcile:run

import { reconcileBoardSummaries } from '../src/jobs/reconcile.js'

const discrepancies = await reconcileBoardSummaries()
console.log(`reconcile complete: ${discrepancies.length} discrepancy(ies) repaired`)
for (const d of discrepancies) {
  console.log(`  board ${d.boardId.slice(0, 8)}: summary=${d.found} → ${d.expected}`)
}
