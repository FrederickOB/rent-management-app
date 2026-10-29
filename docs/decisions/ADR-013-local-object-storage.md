# ADR-013: Local object storage with SeaweedFS

- **Status:** Accepted, 2026-10-28 (M1 plan, decision 3, approved by the founder)
- **Amends:** ADR-001 (`CLAUDE.md` section 3, "MinIO locally") and ADR-006 (write-once storage)

## Context

`CLAUDE.md` and ADR-006 named MinIO as the local S3-compatible store. On 2026-10-28 MinIO's GitHub repository was archived and its Docker Hub image no longer existed, so it can no longer be installed the way the docs assumed. Local development and CI need an S3 API with Object Lock (retention modes and legal hold) so the write-once tests mean something. Production uses AWS S3 with Object Lock (ADR-006) and is unaffected.

## Decision

- Use **SeaweedFS** (Apache-2.0, maintained since 2015) as the local and CI object store, through its S3 gateway, with Object Lock enabled on the evidence bucket.
- Application code talks only to the S3 API through the `StoragePort` adapter (`@aws-sdk/client-s3`), so the store can change without code changes.
- RustFS (Apache-2.0, a MinIO-compatible store that reached 1.0 in October 2026) is the second choice if SeaweedFS's Object Lock falls short in the storage tests.

## Consequences

- Local write-once behaviour is tested against a real Object Lock implementation.
- SeaweedFS and AWS S3 may differ in edge cases. The storage tests also run against AWS S3 at first deployment.

## Alternatives considered

- **The last published MinIO image.** Unmaintained, and no longer on Docker Hub.
- **LocalStack.** Its repository was also archived in 2026.
- **Garage.** Light, but no Object Lock.

## Revisit when

- SeaweedFS stops being maintained, or its Object Lock behaviour diverges from S3's.
