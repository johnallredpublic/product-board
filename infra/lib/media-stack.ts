import {
  Stack, StackProps, Duration, RemovalPolicy,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_sqs as sqs,
  aws_events as events,
  aws_events_targets as targets,
  aws_s3 as s3,
  aws_logs as logs,
} from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = (name: string) => fileURLToPath(new URL(`../dist/${name}`, import.meta.url))
const layersSharp = fileURLToPath(new URL('../layers/sharp', import.meta.url))

export interface MediaStackProps extends StackProps {
  table: dynamodb.ITable
  bus: events.IEventBus
  assetsBucket: s3.IBucket
}

/**
 * The media service — its own stack, so it deploys, scales, and fails
 * independently of the API (ADR 0012). Different resource profile: more memory
 * and the native Sharp binary (a Lambda layer), isolated from the API's bundle.
 */
export class MediaStack extends Stack {
  constructor(scope: Construct, id: string, props: MediaStackProps) {
    super(scope, id, props)

    const dlq = new sqs.Queue(this, 'MediaDlq', { retentionPeriod: Duration.days(14) })

    // Sharp is native and can't be esbuild-bundled, so it ships as a Lambda layer.
    // `pnpm layer:sharp` builds it (linux/arm64) into infra/layers/sharp; if that
    // hasn't run, fall back to a SHARP_LAYER_ARN env (placeholder keeps synth valid).
    const sharpLayer = existsSync(layersSharp)
      ? new lambda.LayerVersion(this, 'SharpLayer', {
          code: lambda.Code.fromAsset(layersSharp),
          compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
          compatibleArchitectures: [lambda.Architecture.ARM_64],
        })
      : lambda.LayerVersion.fromLayerVersionArn(
          this, 'SharpLayer',
          process.env.SHARP_LAYER_ARN ?? `arn:aws:lambda:${this.region}:000000000000:layer:sharp:1`,
        )

    const processFn = new lambda.Function(this, 'ProcessFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, // match the Sharp layer's binary
      handler: 'index.handler',
      code: lambda.Code.fromAsset(dist('media')),
      memorySize: 1536,             // CPU scales with memory; image work is CPU-heavy
      timeout: Duration.minutes(1),
      layers: [sharpLayer],
      deadLetterQueue: dlq,
      reservedConcurrentExecutions: 20, // bulkhead: bounds a bulk upload's blast radius
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.assetsBucket.bucketName,
        EVENT_BUS_NAME: props.bus.eventBusName,
      },
      logGroup: new logs.LogGroup(this, 'ProcessFnLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    })

    // Media owns asset records (ideally an IAM policy scoped to the ASSET# key space).
    props.table.grantReadWriteData(processFn)
    props.assetsBucket.grantReadWrite(processFn)
    props.bus.grantPutEventsTo(processFn)

    // Trigger on original uploads via EventBridge (the bucket emits Object Created
    // to the default bus; core enabled that). Routing through EventBridge instead of
    // a direct bucket notification keeps the dependency one-way (media -> core).
    new events.Rule(this, 'ObjectCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.assetsBucket.bucketName] },
          object: { key: [{ suffix: '/original' }] },
        },
      },
      targets: [new targets.LambdaFunction(processFn)],
    })

    // Also react to the API's intent event (records the pending asset).
    new events.Rule(this, 'UploadRequestedRule', {
      eventBus: props.bus,
      eventPattern: { source: ['assortment.board'], detailType: ['AssetUploadRequested'] },
      targets: [new targets.LambdaFunction(processFn)],
    })
  }
}
