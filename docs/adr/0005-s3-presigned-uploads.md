# ADR 0005: S3 with presigned uploads and async derivatives

## Status

Accepted (2026-08-11). **Superseded in part by [ADR 0021](0021-asset-delivery-and-canary-deploys.md)**:
the *upload* path (presigned PUT, async derivatives) stands; derivative *delivery* is now
private **presigned GET** (keys stored, URLs signed at read), not public CloudFront/OAC
reads — with origin shield in front.

## Context

Product images are the primary content of the board. They are uploaded by users,
can be several megabytes each, and are rendered hundreds at a time on a canvas
that pans and zooms.

Two problems follow. First, the upload path: routing multi-megabyte files
through the API would consume Lambda duration, and API Gateway caps payloads at
6MB regardless. Second, the render path: a board showing 400 tiles at low zoom
must not fetch 400 full-resolution images.

## Decision

Bytes in S3, metadata in DynamoDB.

**Uploads use presigned PUT URLs.** The client requests a URL from the API, then
PUTs directly to S3. The API is never in the data path. URLs expire in five
minutes and are constrained to a specific key and content type.

**A record is written before the URL is issued**, in `pending` status, so the
system knows an upload was expected.

**Derivatives are generated asynchronously**, triggered by an S3 `ObjectCreated`
event. Two sizes: 128px and 512px, both WebP.

**The canvas selects resolution by zoom level**, using 128px below a scale
threshold and 512px above it.

Objects are served through CloudFront with Origin Access Control. The bucket
blocks all public access.

> **Corrected 2026-08-12 (ADR 0021):** derivative *delivery* changed. The product stores
> derivative **keys**, and the browser reads them via short-lived **presigned GET URLs**
> signed at board load — the bucket stays fully private, with CloudFront + origin shield
> in front. (The upload path above is unchanged.)

## Consequences

- Large uploads never touch compute. No payload limits, no Lambda duration cost.
- The canvas renders hundreds of tiles at low zoom without fetching full-size
  images. **This is the reason two derivative sizes exist:** a storage-layer
  decision made to serve a rendering-layer constraint.
- Derivative keys contain a UUID, so they are immutable and can be cached
  indefinitely.
- **Two systems can now disagree**, and reconciliation is required:
  - Record with no object: the client requested a URL and never uploaded. A sweep
    job deletes `pending` records older than 24 hours.
  - Object with no record: prevented by write ordering, but an S3 lifecycle rule
    aborts incomplete multipart uploads.
  - Derivative generation failed: the record stays `pending` with an object
    present. A DLQ plus a depth alarm catches this.
- Images are not available immediately after upload. The UI must handle a
  `pending` state rather than assuming a URL is ready.
- Presigned URL expiry must be long enough for a slow connection to finish a
  large file. Five minutes is a guess and should be validated.
