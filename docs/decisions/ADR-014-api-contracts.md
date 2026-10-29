# ADR-014: API contracts with oRPC

- **Status:** Accepted, 2026-10-28 (M1 plan, section 4.15)
- **Settles:** the choice ADR-001 left to M1 ("ts-rest or OpenAPI code generation")

## Context

`apps/web`, `apps/links` and `apps/tenant` share zod schemas and a typed client from `packages/contracts`. ADR-001 deferred the tool to M1. In October 2026, ts-rest had had no release since June 2025, and nestjs-zod (the usual way to validate zod in NestJS) did not support NestJS 12.

## Decision

- **oRPC, contract first.** Routes and zod schemas are defined once in `packages/contracts` with `@orpc/contract`, using plain REST methods and paths.
- `apps/api` implements them with `@orpc/nest`, so NestJS guards (actor and policy) still run on every route.
- Clients use `@orpc/client` with the OpenAPI link, so requests are ordinary JSON over HTTP.
- `@orpc/openapi` publishes `/openapi.json` for review and for third parties.
- Better Auth routes and provider webhooks stay plain NestJS routes outside the contracts.
- **Fallback** if oRPC fails in M1: zod schemas, zod-to-openapi, openapi-typescript and openapi-fetch.

## Consequences

- One source of truth for request and response shapes, checked at compile time in every client.
- The API stays plain REST, so switching tools later does not change the wire format.

## Alternatives considered

- **ts-rest.** The closest fit, but no release for 16 months.
- **NestJS DTOs with Swagger and generated clients.** Duplicates zod schemas as classes, and needs a code-generation step in CI.

## Revisit when

- oRPC stops being maintained, or a NestJS major version breaks its integration.
