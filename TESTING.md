# Testing Strategy

## Current Commands

- `make dev`
- `make test`
- `make test-api`
- `make test-worker`

## What We Can Test Locally Right Now

### Control Plane

The `Express + Prisma + Postgres` control plane is covered with API integration tests in:

- [control-plane.test.ts](/Users/fuyofulo/code/stablecoin_intelligence/api/tests/control-plane.test.ts)

These tests validate:

- health checks
- workspace creation
- watched address creation
- label creation and attachment
- business object creation
- address-object mapping creation
- onboarding snapshot retrieval

### Data Plane

The Rust worker currently has unit tests for:

- workspace registry construction
- workspace event classification
- direction classification
- USDC amount formatting

These tests live in:

- [control_plane.rs](/Users/fuyofulo/code/stablecoin_intelligence/yellowstone/src/control_plane.rs)
- [mod.rs](/Users/fuyofulo/code/stablecoin_intelligence/yellowstone/src/yellowstone/mod.rs)

## Important Constraint: Surfpool Is Not Yellowstone

Surfpool is useful for local Solana development because it exposes local RPC and WebSocket interfaces.
But our worker is not consuming RPC or WebSocket subscriptions. It consumes Yellowstone gRPC.

That means:

- `Surfpool` is good for local Solana transaction generation and program testing.
- `Surfpool` alone is not enough to test the Yellowstone worker end to end.
- To test Yellowstone end to end locally, we need a validator that runs a Geyser plugin compatible with Yellowstone.

## Practical Testing Layers

### Layer 1: Unit Tests

Use pure unit tests for:

- classification
- matching
- formatting
- registry building
- helper functions

### Layer 2: API Integration Tests

Use Postgres-backed integration tests for:

- onboarding endpoints
- Prisma model assumptions
- snapshot responses

### Layer 3: Worker Integration Tests Without a Live Validator

The next recommended step is to add synthetic worker tests that feed mocked `SubscribeUpdate` payloads into the worker logic.

This gives us deterministic tests for:

- raw observation persistence
- canonical mutation creation
- canonical transaction flush behavior
- workspace relevance linking
- operational event generation
- reconciliation row generation

This is the most important missing test layer.

### Layer 4: Full End-to-End Local Validator Tests

For true end-to-end local testing of the Yellowstone pipeline, we need:

- a local validator
- a Geyser plugin
- Yellowstone gRPC exposed from that validator

Only then can we generate a local Solana transaction and assert that the worker sees it through Yellowstone and writes all tables correctly.

## Recommended Next Testing Work

1. Add mocked `SubscribeUpdate` integration tests for the Rust worker.
2. Add ClickHouse-backed assertions for worker outputs.
3. Add a `make test-e2e` target later for local validator + Geyser plugin testing.

## Source Notes

The current understanding is based on:

- Surfpool docs: local RPC and WebSocket interfaces
- Yellowstone gRPC repo: validator must run with `--geyser-plugin-config`

So the correct conclusion is:

`Surfpool is useful for Solana app testing, but not sufficient by itself for Yellowstone gRPC end-to-end testing.`
