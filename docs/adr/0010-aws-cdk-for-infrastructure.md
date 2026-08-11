# ADR 0010: AWS CDK for infrastructure

## Status

Accepted (2026-08-11)

## Context

The system requires a DynamoDB table with a GSI and Streams, several Lambda
functions with distinct configurations, S3 buckets with event notifications,
CloudFront with origin routing, an EventBridge bus with rules, SQS queues with
dead letter queues, and the IAM policies connecting them.

Managing this by hand in the console is not viable: it is not reproducible, not
reviewable, and not recoverable.

The options are raw CloudFormation (verbose YAML, no abstraction), Terraform
(multi-cloud, large ecosystem, separate state management, its own language), or
CDK (TypeScript that synthesizes CloudFormation).

The project is entirely AWS and entirely TypeScript.

## Decision

AWS CDK in TypeScript. Two stacks, matching the service boundary from ADR 0012:
`core-stack` and `media-stack`.

Shared configuration expressed as constructs rather than duplicated.

## Consequences

- Infrastructure is written in the same language as the application, with type
  checking, autocomplete, and the ability to factor out repetition.
- CDK's L2 constructs supply sensible defaults and wire IAM permissions
  automatically via `grant*` methods, which is where hand-written policies most
  often go wrong.
- A reusable construct encoding project conventions is a concrete way to make
  standards the default rather than a document.
- **CloudFormation's limitations are inherited**, including slow deployments,
  occasionally cryptic failures, and stack resource limits.
- **Some property changes cause resource replacement**, which can mean data loss.
  This requires care on stateful resources and is not always obvious from the
  diff.
- Cross-stack references create deployment ordering dependencies. Removing an
  exported value while another stack still imports it will fail.
- Less portable than Terraform. Acceptable given no multi-cloud requirement.
- CDK's abstraction can obscure what is actually being created. `cdk synth`
  should be read, not just trusted.
