import { Logger } from '@aws-lambda-powertools/logger'
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics'
import { getCorrelationId } from './correlation.js'

// Lambda Powertools is close to the default answer for observability in a
// TypeScript Lambda shop. In the real Lambda runtime you'd wrap handlers with
// middy: injectLambdaContext(logger, { correlationIdPath }), captureLambdaHandler
// (X-Ray Tracer), and logMetrics(metrics) to flush EMF per invocation. Here we use
// the same primitives directly so the code runs in tests and the local poller too.

const SERVICE = process.env.SERVICE_NAME ?? 'assortment-api'
const SILENT = process.env.POWERTOOLS_LOG_LEVEL === 'SILENT'

export const logger = new Logger({ serviceName: SERVICE })
const metrics = new Metrics({ namespace: 'Assortment', serviceName: SERVICE })

/** Structured info log, always tagged with the current correlation id. */
export function log(message: string, data: Record<string, unknown> = {}) {
  logger.info(message, { correlationId: getCorrelationId(), ...data })
}

export function logError(message: string, err: unknown, data: Record<string, unknown> = {}) {
  logger.error(message, { correlationId: getCorrelationId(), err, ...data })
}

/** Add correlation metadata to an outgoing event payload so it survives the hop. */
export function withCorrelationId<T extends Record<string, unknown>>(detail: T): T {
  const correlationId = getCorrelationId()
  return correlationId ? { ...detail, correlationId } : detail
}

type Unit = (typeof MetricUnit)[keyof typeof MetricUnit]

export function recordMetric(name: string, value = 1, unit: Unit = MetricUnit.Count) {
  metrics.addMetric(name, unit, value)
}

/**
 * Flush metrics as an EMF log line — CloudWatch parses it into metrics, so there's
 * no synchronous metrics API call in the request path. Call once per invocation.
 */
export function flushMetrics() {
  if (SILENT) {
    metrics.clearMetrics()
    return
  }
  metrics.publishStoredMetrics()
}

export { MetricUnit }
