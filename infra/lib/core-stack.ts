import {
  Stack, StackProps, Duration, RemovalPolicy, Fn, CfnOutput,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_event_sources as sources,
  aws_sqs as sqs,
  aws_events as events,
  aws_events_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cw,
  aws_apigatewayv2 as apigwv2,
  aws_logs as logs,
  aws_opensearchservice as opensearch,
} from 'aws-cdk-lib'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Construct } from 'constructs'
import { fileURLToPath } from 'node:url'

const dist = (name: string) => fileURLToPath(new URL(`../dist/${name}`, import.meta.url))

export class CoreStack extends Stack {
  readonly table: dynamodb.Table
  readonly bus: events.EventBus
  readonly assetsBucket: s3.Bucket

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // ─── Single-table DynamoDB with Streams (the transactional outbox) ─────────
    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN, // never destroy production data
    })
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    this.bus = new events.EventBus(this, 'Bus')

    // Shared assets bucket. Lives in core (not media) so the API can presign
    // uploads to it without a cross-stack cycle; media reads/writes derivatives.
    this.assetsBucket = new s3.Bucket(this, 'Assets', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // Emit object events to EventBridge so the media stack can subscribe without
      // a direct bucket->function notification (which would create a stack cycle).
      eventBridgeEnabled: true,
    })

    // Catalog search read model (ADR 0017). The stream consumer indexes products
    // into it; the API queries it. Small single-node domain — size up for real load.
    //
    // The managed domain is the one resource here that isn't free-tier, so it's
    // optional: `SEARCH_ENABLED=false pnpm ... deploy` skips it and the API falls
    // back to a DynamoDB-backed catalog (search/client.ts). Enabled by default.
    const searchEnabled = process.env.SEARCH_ENABLED !== 'false'
    const search = searchEnabled
      ? new opensearch.Domain(this, 'Search', {
          version: opensearch.EngineVersion.openSearch('2.17'),
          capacity: { dataNodes: 1, dataNodeInstanceType: 't3.small.search' },
          ebs: { volumeSize: 10 },
          nodeToNodeEncryption: true,
          encryptionAtRest: { enabled: true },
          enforceHttps: true,
          removalPolicy: RemovalPolicy.DESTROY,
        })
      : undefined

    const commonEnv = {
      TABLE_NAME: this.table.tableName,
      EVENT_BUS_NAME: this.bus.eventBusName,
      BUCKET_NAME: this.assetsBucket.bucketName,
      SEARCH_ENABLED: String(searchEnabled),
      ...(search ? { OPENSEARCH_ENDPOINT: `https://${search.domainEndpoint}` } : {}),
    }
    const nodeFn = (fnId: string, name: string, opts: Partial<lambda.FunctionProps> = {}) =>
      new lambda.Function(this, fnId, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(dist(name)),
        memorySize: 512,
        timeout: Duration.seconds(30),
        environment: commonEnv,
        // 14-day retention — indefinite retention is a top surprise cost.
        logGroup: new logs.LogGroup(this, `${fnId}Logs`, {
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        ...opts,
      })

    // ─── API: Fastify on Lambda behind an HTTP API ────────────────────────────
    const apiFn = nodeFn('ApiFn', 'api', { timeout: Duration.seconds(29) })
    // Auth verifies bearer tokens against the IdP's JWKS (ADR 0020). Pass the IdP
    // config through when set; without JWKS_URI the API fails closed in prod.
    for (const k of ['JWKS_URI', 'JWT_ISSUER', 'JWT_AUDIENCE'] as const) {
      if (process.env[k]) apiFn.addEnvironment(k, process.env[k]!)
    }
    this.table.grantReadWriteData(apiFn)
    this.bus.grantPutEventsTo(apiFn)
    this.assetsBucket.grantPut(apiFn) // presigned PUTs
    search?.grantRead(apiFn) // catalog search (absent when search is disabled)

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', apiFn),
    })

    // ─── Stream consumer + event source mapping + DLQ ─────────────────────────
    // Bulkheads (ADR 0018 / DESIGN.md §6.3): each async consumer gets a reserved
    // concurrency slice, so one tenant's bulk import can't starve the others (and no
    // consumer can exhaust the account's pool). Per-tenant-tier queues are the next
    // step for finer isolation.
    const streamDlq = new sqs.Queue(this, 'StreamDlq', { retentionPeriod: Duration.days(14) })
    const streamFn = nodeFn('StreamFn', 'stream', { reservedConcurrentExecutions: 10 })
    this.table.grantStreamRead(streamFn)
    this.table.grantReadWriteData(streamFn)
    this.bus.grantPutEventsTo(streamFn)
    search?.grantReadWrite(streamFn) // projects products into the search index (absent when disabled)
    streamFn.addEventSource(new sources.DynamoEventSource(this.table, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      maxBatchingWindow: Duration.seconds(2),
      retryAttempts: 3,
      bisectBatchOnError: true,          // one poison record can't fail 99 good ones
      reportBatchItemFailures: true,     // partial batch response
      maxRecordAge: Duration.hours(6),   // don't block the shard forever
      onFailure: new sources.SqsDlq(streamDlq),
    }))

    // ─── Notifications: EventBridge rule -> SQS (own DLQ) -> Lambda ────────────
    const notifyDlq = new sqs.Queue(this, 'NotifyDlq', { retentionPeriod: Duration.days(14) })
    const notifyQueue = new sqs.Queue(this, 'NotifyQueue', {
      visibilityTimeout: Duration.seconds(180), // >= 6x the consumer timeout, or duplicates
      deadLetterQueue: { queue: notifyDlq, maxReceiveCount: 5 },
    })
    const notifyFn = nodeFn('NotifyFn', 'notify', { reservedConcurrentExecutions: 10 })
    this.table.grantReadWriteData(notifyFn)
    notifyFn.addEventSource(new sources.SqsEventSource(notifyQueue, {
      batchSize: 10,
      maxBatchingWindow: Duration.seconds(5), // accumulate so a bulk update -> one digest
      reportBatchItemFailures: true,
    }))
    new events.Rule(this, 'NotifyRule', {
      eventBus: this.bus,
      eventPattern: {
        source: ['assortment.board', 'assortment.catalog'],
        detailType: ['PlacementMoved', 'ProductPriceChanged'],
      },
      targets: [new targets.SqsQueue(notifyQueue)],
    })

    // ─── Apply media's AssetProcessed to the product (API owns products) ──────
    const assetProcessedFn = nodeFn('AssetProcessedFn', 'asset-processed', { reservedConcurrentExecutions: 5 })
    this.table.grantReadWriteData(assetProcessedFn)
    new events.Rule(this, 'AssetProcessedRule', {
      eventBus: this.bus,
      eventPattern: { source: ['assortment.media'], detailType: ['AssetProcessed'] },
      targets: [new targets.LambdaFunction(assetProcessedFn)],
    })

    // ─── Reconciliation on a nightly schedule ─────────────────────────────────
    const reconcileFn = nodeFn('ReconcileFn', 'reconcile', { timeout: Duration.minutes(5), reservedConcurrentExecutions: 2 })
    this.table.grantReadWriteData(reconcileFn)
    new events.Rule(this, 'ReconcileSchedule', {
      schedule: events.Schedule.cron({ hour: '3', minute: '0' }),
      targets: [new targets.LambdaFunction(reconcileFn)],
    })

    // ─── Web: Angular build in S3, served through CloudFront (same origin) ─────
    const site = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })
    const apiDomain = Fn.select(1, Fn.split('://', httpApi.apiEndpoint)) // strip https://
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        // Same-origin API: no CORS, first-party cookies.
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomain),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      // Client-side routing: a deep-link refresh returns index.html, not a 404.
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    })
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [s3deploy.Source.asset(fileURLToPath(new URL('../../packages/web/dist/web/browser', import.meta.url)))],
      destinationBucket: site,
      distribution: cdn,
      distributionPaths: ['/*'],
    })

    // ─── Alarms: alert on symptoms, not causes ────────────────────────────────
    const alarm = (aid: string, metric: cw.IMetric, threshold = 1) =>
      new cw.Alarm(this, aid, {
        metric, threshold, evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      })
    alarm('StreamDlqDepth', streamDlq.metricApproximateNumberOfMessagesVisible())
    alarm('NotifyDlqDepth', notifyDlq.metricApproximateNumberOfMessagesVisible())
    alarm('StreamIteratorAge', streamFn.metric('IteratorAge', { statistic: 'Maximum' }), 60_000)
    alarm('ApiServerErrors', httpApi.metricServerError(), 1)
    alarm('TableThrottles', this.table.metricThrottledRequestsForOperations({
      operations: [
        dynamodb.Operation.GET_ITEM, dynamodb.Operation.QUERY, dynamodb.Operation.BATCH_GET_ITEM,
        dynamodb.Operation.PUT_ITEM, dynamodb.Operation.UPDATE_ITEM,
        dynamodb.Operation.TRANSACT_WRITE_ITEMS, dynamodb.Operation.SCAN,
      ],
    }), 1)

    new CfnOutput(this, 'CdnUrl', { value: `https://${cdn.distributionDomainName}` })
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint })
  }
}
