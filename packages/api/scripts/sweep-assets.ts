// Delete abandoned "pending" asset uploads (no object, older than the TTL).
// In prod this runs nightly on an EventBridge schedule (Phase 11); this is the
// manual/local entry point.
//
//   LOCAL=1 pnpm sweep:assets

import { sweepPendingAssets } from '../src/jobs/sweep-assets.js'

const result = await sweepPendingAssets()
console.log('sweep complete:', result)
