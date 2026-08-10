# P3-T06 Builtin Service Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver strict, authoritative, localhost-testable builtin service operations control without exposing management or upstream credentials.

**Architecture:** Extend the existing P3-T01 local New API fixture into separate management and data listeners backed by shared authoritative state. Add CAS-controlled global/device operations contracts and a typed builtin data client with deterministic circuit breaking, then verify closure through the existing P3-T02 router and P3-T05 lifecycle mappings.

**Tech Stack:** TypeScript 5.9, Node.js 24, Zod 4, Vitest 3, localhost HTTP fixtures, existing `@uclaw/shared` and `@uclaw/desktop` workspaces.

---

### Task 1: Strict Operations Contracts

**Files:**
- Create: `product/shared/src/builtin-service-operations.ts`
- Modify: `product/shared/src/new-api-management.ts`
- Modify: `product/shared/src/index.ts`
- Create: `product/shared/tests/builtin-service-operations.test.ts`
- Modify: `product/shared/tests/exports.test.ts`
- Create: `product/tests/fixtures/builtin-service-operations-v1.json`
- Create: `product/tests/contract/builtin-service-operations.contract.test.ts`

- [ ] Write RED tests for strict global states, status/update envelopes, device locator/control CAS envelopes, health/model request/response, bounded fields, and rejection of every unknown field.
- [ ] Run `npm run test -w @uclaw/shared -- builtin-service-operations.test.ts` and `npm run test:contract -- builtin-service-operations.contract.test.ts`; verify failures are missing exports/schemas.
- [ ] Implement version `1` Zod schemas and types. Extend `NewApiManagementClient` with `getServiceStatus`, `updateServiceStatus`, `getDeviceControls`, and `updateDeviceControls` using concrete typed inputs/outputs.
- [ ] Re-run focused shared and contract tests; expected `0` failures.

Required contract shape:

```ts
type BuiltinServiceState = "enabled" | "disabled" | "degraded" | "maintenance";
type BuiltinServiceStatus = {
  schemaVersion: 1;
  state: BuiltinServiceState;
  revision: number;
  reasonCode: "OPERATOR_ENABLED" | "OPERATOR_DISABLED" | "DEGRADED_HEALTH" | "SCHEDULED_MAINTENANCE" | "RECOVERY_COMPLETE";
  updatedAt: string;
};
type BuiltinDeviceControlUpdate = {
  idempotencyKey: string;
  expectedRevision: number;
  expectedGeneration: number;
  expectedLicenseId: string;
  expectedTokenId: string;
  policy: NewApiPolicy;
};
```

### Task 2: Management CAS And Dual-Plane Local Mock

**Files:**
- Modify: `product/desktop/src/new-api-management/client.ts`
- Modify: `product/desktop/src/new-api-management/local-server.ts`
- Modify: `product/desktop/src/new-api-management/index.ts`
- Modify: `product/tests/integration/new-api-management-local.test.ts`
- Create: `product/tests/integration/builtin-service-operations-local.test.ts`

- [ ] Write RED integration tests for initial `disabled@revision=1` with `OPERATOR_DISABLED`, configured transition to enabled, valid transitions, exact idempotent replay, idempotency conflict, concurrent CAS conflict, new-key no-op/illegal transition rejection, and device/user locator policy CAS.
- [ ] Add RED tests proving management credential cannot authenticate data requests, device token cannot authenticate management, and malformed/unknown request fields fail safely.
- [ ] Run the two integration files; verify expected missing-method/endpoint failures.
- [ ] Implement client methods and separate exact-loopback management/data listeners. Keep existing provisioning endpoints compatible. Store idempotent results sealed and serialize state mutations through CAS checks.
- [ ] Implement authoritative data checks for operational state, mapping/token/user/policy binding, quota, effective RPM/concurrency, and model permission. Record bounded non-secret audit events.
- [ ] Re-run focused integration tests; expected `0` failures.

The local server options and admission result must be explicit:

```ts
interface AuthoritativeLicenseState {
  licenseId: string;
  deviceId: string;
  status: "active" | "provisioning" | "revoked" | "reissued" | "expired" | "disabled";
  replacementLicenseId: string | null;
  notBefore: string;
  expiresAt: string;
}
interface BuiltinServerDependencies {
  readLicense(licenseId: string): Promise<AuthoritativeLicenseState>;
  execute(request: BuiltinModelRequest): Promise<BuiltinUpstreamResult>;
}
```

Use two-phase admission: capture all revisions/bindings under the serialized state lock; release it for a bounded authoritative license read; re-enter and revalidate every captured value plus credential/global state before atomic quota/RPM/concurrency reservation. Management CAS never waits on network I/O. Request-unit quota reserves `1`; token-unit quota uses bounded UTF-8 prompt bytes plus enforced `maxOutputTokens`, never a client token estimate. Release concurrency and unused quota reservation in `finally`; missing/excess upstream usage consumes the reservation and fails closed.

### Task 3: Typed Builtin Client And Circuit Breaker

**Files:**
- Create: `product/desktop/src/providers/builtin-service-client.ts`
- Modify: `product/desktop/src/index.ts`
- Create: `product/desktop/tests/builtin-service-client.test.ts`

- [ ] Write RED tests for HTTPS-only production endpoint, exact-loopback opt-in, missing/unconfigured fail-closed client, strict response parsing, and fixed error classification for auth, disabled, quota, rate, model permission, caller cancellation, client timeout/network, upstream 4xx/5xx, and malformed response.
- [ ] Write RED tests for two-failure open, open fast rejection without moving cooldown, one half-open real model request after injected cooldown, concurrent probe fast-fail, successful close/reset, failed probe reopen, and non-counted policy/auth failures. Prove two caller aborts do not open, caller abort during half-open does not extend cooldown, two client timeouts do open, and authenticated health does not change an open breaker.
- [ ] Run `npm run test -w @uclaw/desktop -- builtin-service-client.test.ts`; verify missing module/API failures.
- [ ] Implement minimal client with bounded JSON, redirect disabled, credential-only data Authorization, raw-cause removal, injected clock, and deterministic circuit state.
- [ ] Re-run focused desktop test; expected `0` failures.

Circuit transition required by tests:

```ts
if (state === "open" && now() < reopenAt) throw circuitOpen();
if (state === "open") state = "half-open"; // one caller only
try {
  const result = await sendRealRequest();
  state = "closed";
  consecutiveFailures = 0;
  return result;
} catch (error) {
  if (breakerCounted(error)) reopen();
  else closeCircuit();
  throw error;
}
```

The separate authenticated health call reports configuration/state but never closes an upstream-open circuit. It requires an active token with current mapping/user/generation/channel/policy binding; revoked, disabled, replaced, and stale credentials receive fixed authentication failure without service state/revision.

### Task 4: Router And Lifecycle Closure

**Files:**
- Modify: `product/desktop/src/providers/model-source-router.ts`
- Modify: `product/desktop/tests/model-source-router.test.ts`
- Modify: `product/tests/integration/model-source-routing.test.ts`
- Modify: `product/tests/integration/provisioning-identity-local.test.ts`

- [ ] Write RED tests that route builtin through the data client and immediately reject disabled/maintenance, apply degraded limits, and preserve no-fallback behavior.
- [ ] Write RED tests proving domestic/custom/local requests do not contact builtin planes or consume builtin usage.
- [ ] Add RED lifecycle cases for disabled mapping, revoked token, reissue old token, policy disable/re-enable, and authoritative revision changes without USB reprovisioning.
- [ ] Run focused desktop/integration tests; verify failures expose missing closure only.
- [ ] Add the minimal adapter/classification needed by the router. Do not add fallback, renderer exposure, UI, or P3-T07 orchestration.
- [ ] Re-run focused tests; expected `0` failures.

Route invariant under test:

```ts
const provider = await providers.getSelectedForRuntime();
if (provider !== null) return executors[externalSource(provider)](request, provider, signal);
const credential = await credentials.loadActive();
return builtinDataClient.execute(request, credential, signal);
```

No management preflight exists in this path. The data server's authoritative license reader fails closed for revoked, reissued, expired, disabled, unavailable, or malformed status.

### Task 5: Security And Full Verification

**Files:**
- Modify: `product/scripts/secret-scan.mjs` only if a new sensitive field name requires scanner coverage
- Create: `docs/superpowers/reports/2026-08-11-P3-T06-builtin-service-operations.md`

- [ ] Add/extend tests that serialize public errors, audit, fixture, logs, and reports and reject management credential, token secret, `Authorization`, provider/upstream Key names and values, endpoint, username, headers, body, and raw cause.
- [ ] Run focused RED if scanner coverage changes, then minimal GREEN without weakening existing assertions.
- [ ] Run fresh verification: `npm run build`, `npm run typecheck`, `npm test`, `npm run test:contract`, `npm run test:integration`, `npm run test:secrets`, `go test ./...`, `go test -race ./...`, `go vet ./...`, and Windows amd64 cross-compilation from `product/launcher`.
- [ ] Run `git diff --check`, inspect changed files, and map every original/delegated acceptance item to code/test evidence.
- [ ] Request independent spec/security/code review. Fix every Critical and Important via RED -> GREEN and repeat fresh affected/full gates until `Critical=0 Important=0`.
- [ ] Write the final report with branch/base/head, changed files, exact test results, safety boundary, conflict risk, target `codex/integration-p2-t10-local`, P3-T07 startingState, real-environment gaps, and explicit `PR: none`, `push: not executed`.
