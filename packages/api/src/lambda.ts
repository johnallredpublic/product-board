import awsLambdaFastify from '@fastify/aws-lambda'
import { buildServer } from './server.js'

// API Gateway (HTTP API) -> Lambda entry point. The same Fastify app that runs
// locally (pnpm dev) is adapted to the Lambda event/response shape here; the app
// itself doesn't know it's on Lambda.
export const handler = awsLambdaFastify(buildServer())
