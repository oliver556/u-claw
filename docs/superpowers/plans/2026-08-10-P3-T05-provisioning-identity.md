# P3-T05 Provisioning Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind one physical device identity and license to one New API user/token/channel through an idempotent, recoverable manufacturing transaction.

**Architecture:** Add a desktop-only provisioning coordinator over existing P3-T01 and P3-T04 typed clients. Persist a non-secret saga journal and three mode-0600 artifacts; activate mapping only after verified writes, otherwise compensate token and license.

**Tech Stack:** TypeScript 5.9, Node 24, Zod, Vitest, localhost HTTP mocks, Go launcher cross-compilation.

---

### Task 1: Freeze provisioning contract and journal

**Files:**
- Create: `product/shared/src/provisioning-identity.ts`
- Modify: `product/shared/src/index.ts`
- Create: `product/shared/tests/provisioning-identity.test.ts`

- [ ] Write failing strict-schema tests for input, safe result, journal stages, compensation, lifecycle action, binding mismatches, and forbidden secret fields.
- [ ] Run `npm test -w @uclaw/shared -- provisioning-identity.test.ts`; expect failure because exports do not exist.
- [ ] Add schemas with exact identity/resource IDs, public states, channel ID, endpoint/model, and secret-free journal/result shapes.
- [ ] Re-run focused shared test; expect pass.

### Task 2: Implement atomic artifact writer

**Files:**
- Create: `product/desktop/src/provisioning/artifact-writer.ts`
- Create: `product/desktop/tests/provisioning-artifact-writer.test.ts`

- [ ] Write failing tests for mode 0600, same-directory `wx` temp + rename behavior, read-back validation, partial-write cleanup, symlink/non-directory rejection, and journal without secrets.
- [ ] Run `npm test -w @uclaw/desktop -- provisioning-artifact-writer.test.ts`; expect missing module failure.
- [ ] Implement minimal writer using `open`, `sync`, `rename`, `lstat`, bounded JSON and typed fixed errors. Reuse `BuiltinCredentialStore` validation rather than inventing a second credential format.
- [ ] Re-run focused test; expect pass.

### Task 3: Implement idempotent provisioning coordinator

**Files:**
- Create: `product/desktop/src/provisioning/coordinator.ts`
- Create: `product/desktop/src/provisioning/index.ts`
- Modify: `product/desktop/src/index.ts`
- Create: `product/desktop/tests/provisioning-coordinator.test.ts`

- [ ] Write failing tests for strict binding, deterministic step keys, same-request replay, conflicting replay, same-device concurrency, success ordering, and no active result before artifact verification.
- [ ] Run focused desktop test; expect missing coordinator failure.
- [ ] Implement per-device serialization and saga calls: issue license, create user/token/mapping, write files, mark mapping active. Validate every returned relationship before next side effect.
- [ ] Re-run focused test; expect pass.

### Task 4: Implement compensation and recovery

**Files:**
- Modify: `product/desktop/src/provisioning/coordinator.ts`
- Modify: `product/desktop/src/provisioning/artifact-writer.ts`
- Modify: `product/desktop/tests/provisioning-coordinator.test.ts`

- [ ] Add failing tests for auth/network/invalid response, artifact failure, mapping failure, token revoke failure, license revoke failure, restart from persisted journal, and compensation retry.
- [ ] Run focused test and confirm failures occur at expected missing recovery behavior.
- [ ] Implement fixed public errors and journaled compensation: failed mapping, token revoke, license revoke, artifact cleanup; pending remains retryable.
- [ ] Re-run focused test; expect pass.

### Task 5: Align revoke, disable, and reissue

**Files:**
- Modify: `product/desktop/src/provisioning/coordinator.ts`
- Modify: `product/desktop/tests/provisioning-coordinator.test.ts`
- Create: `product/tests/integration/provisioning-identity-local.test.ts`

- [ ] Write failing tests mapping P3-T04 states to New API status/token/user/local credential semantics.
- [ ] Add localhost integration test using both real HTTP mocks, including duplicate and concurrent provisioning.
- [ ] Implement only `revoke`, `disable`, and `reissue` coordinator operations; record expired/P3-T06 control sync as out of scope.
- [ ] Run focused unit and integration tests; expect pass.

### Task 6: Security and production policy

**Files:**
- Modify: `product/tests/integration/provisioning-identity-local.test.ts`
- Modify: `product/scripts/secret-scan.test.mjs` only if a new fixture path must be included

- [ ] Add failing assertions scanning results, errors, journal, audit and ordinary config for management credential, startup secret, token secret, Authorization and provider-key markers.
- [ ] Add endpoint tests proving production HTTPS, explicit localhost-only test policy, and absent endpoint fail-closed through existing typed clients.
- [ ] Fix production code, not assertions, until focused security tests pass.

### Task 7: Review and fresh verification

**Files:**
- Create: `docs/superpowers/reports/2026-08-10-P3-T05-provisioning-identity.md`

- [ ] Dispatch independent spec reviewer and security/code-quality reviewer against base `9bc66f5a...`; fix all Critical and Important findings, then re-review to zero.
- [ ] Run fresh `npm run build`, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run test:secrets` in `product`.
- [ ] Run fresh `go test ./...`, `go test -race ./...`, and `go vet ./...` in `product/launcher`.
- [ ] Cross-compile Windows amd64 production and license fixture without executing them; record as compile evidence only.
- [ ] Write report with requirement map, changed files, exact results, conflict risk, P3-T06 startingState, real-environment gaps, and no-PR state.
