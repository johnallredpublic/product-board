import { App } from 'aws-cdk-lib'
import { CoreStack } from '../lib/core-stack.js'
import { MediaStack } from '../lib/media-stack.js'

const app = new App()
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
}

const core = new CoreStack(app, 'AssortmentCore', { env })

// Media depends on core: it processes objects in the shared assets bucket, writes
// asset records in the shared table, and publishes to the shared bus. The bucket
// lives in core (not media) to avoid a cross-stack dependency cycle — the API
// presigns uploads to it, and media reads/writes derivatives.
new MediaStack(app, 'AssortmentMedia', {
  env,
  table: core.table,
  bus: core.bus,
  assetsBucket: core.assetsBucket,
})
