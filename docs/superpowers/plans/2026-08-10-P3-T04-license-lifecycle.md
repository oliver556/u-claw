# P3-T04 License Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver LIC-002 signing, query, revoke, reissue, typed states, and bounded 24-hour offline tolerance without weakening the P3-T03 startup gate.

**Architecture:** Add an independent v1 shared contract and localhost-only Node issuer/status test server. Extend the Go launcher gate with an HTTPS status client, Ed25519 receipt verification, and startup-secret-derived authenticated cache; runtime work remains unreachable until both local and lifecycle checks pass.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js 24.15 HTTP/crypto, Vitest 3, Go standard library, Ed25519, AES-GCM.

---

### Task 1: Freeze lifecycle v1 contract

**Files:**
- Create: `product/shared/src/license-lifecycle.ts`
- Modify: `product/shared/src/index.ts`
- Create: `product/shared/tests/license-lifecycle.test.ts`
- Create: `product/tests/fixtures/license-lifecycle-v1.json`
- Create: `product/tests/contract/license-lifecycle.contract.test.ts`

- [ ] **Step 1: Write failing shared and contract tests**

Test exact states `provisioning|active|revoked|reissued|expired|disabled`, strict issue/query/revoke/reissue inputs, opaque receipt, typed errors, and rejection of `startupSecret`, token, fingerprint, signature, or Authorization fields in status summaries.

```ts
expect(LicenseLifecycleStatusSchema.options).toEqual([
  "provisioning", "active", "revoked", "reissued", "expired", "disabled",
]);
expect(() => LicenseStatusSummarySchema.parse({ ...summary, startupSecret: "leak" })).toThrow();
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @uclaw/shared -- --run tests/license-lifecycle.test.ts`
Expected: FAIL because `license-lifecycle.ts` does not exist.

- [ ] **Step 3: Implement minimal strict v1 schemas and client interface**

Define `LICENSE_LIFECYCLE_CONTRACT_VERSION = 1`, identifiers/timestamps, `LicenseArtifact`, `IssuedLicense`, `LicenseStatusSummary`, `LicenseStatusReceipt`, inputs, audit events, safe error body, and `LicenseLifecycleClient` methods `issueLicense`, `getLicenseStatus`, `revokeLicense`, `reissueLicense`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -w @uclaw/shared -- --run tests/license-lifecycle.test.ts && npm run test:contract -- --run tests/contract/license-lifecycle.contract.test.ts`
Expected: both test files pass.

### Task 2: Build localhost issuer and typed client

**Files:**
- Create: `product/desktop/src/license-lifecycle/client.ts`
- Create: `product/desktop/src/license-lifecycle/local-server.ts`
- Create: `product/desktop/src/license-lifecycle/index.ts`
- Modify: `product/desktop/src/index.ts`
- Create: `product/tests/integration/license-lifecycle-local.test.ts`

- [ ] **Step 1: Write failing lifecycle HTTP tests**

Cover issue/query/revoke/reissue, unique ID/secret/artifact rotation, old `reissued`, expired derivation, identical idempotency replay, key conflict, same-device concurrent issue/reissue conflict, and audit/result redaction.

```ts
const issued = await client.issueLicense(issueInput);
expect(await client.getLicenseStatus(issued.license.licenseId)).toMatchObject({ status: "active" });
const replacement = await client.reissueLicense(issued.license.licenseId, { idempotencyKey: "reissue-001" });
expect(replacement.license.licenseId).not.toBe(issued.license.licenseId);
expect(await client.getLicenseStatus(issued.license.licenseId)).toMatchObject({ status: "reissued" });
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:integration -- --run tests/integration/license-lifecycle-local.test.ts`
Expected: FAIL because lifecycle desktop module does not exist.

- [ ] **Step 3: Implement client transport**

Reuse P3-T01 policies: HTTPS only except exact loopback HTTP, bounded JSON, redirect disabled, fixed timeout, Authorization redaction, typed distinction between status failures and transport/unavailable.

- [ ] **Step 4: Implement localhost server**

Inject ephemeral Ed25519 private key through constructor only. Store hashed startup secrets and encrypted idempotency responses in memory; serialize mutating operations; sign P3-T03-compatible `license.json` artifacts and opaque status receipts; never expose issuer private key or request credentials.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:integration -- --run tests/integration/license-lifecycle-local.test.ts`
Expected: lifecycle integration tests pass.

### Task 3: Expose verified local license material

**Files:**
- Modify: `product/launcher/license.go`
- Modify: `product/launcher/license_test.go`

- [ ] **Step 1: Write failing compatibility test**

Add `VerifyStartupLicenseMaterial` tests proving valid local verification returns only `deviceId`, `licenseId`, startup secret, and expiry for internal lifecycle use, while public `VerifyStartupLicense` keeps its existing error-only API and all P3-T03 failures unchanged.

- [ ] **Step 2: Verify RED**

Run: `go test ./... -run 'TestVerifyStartupLicenseMaterial'`
Expected: FAIL because material-returning helper does not exist.

- [ ] **Step 3: Refactor minimally**

Move existing verification body behind an internal material-returning function. Keep validation order, strict reads, payload, error values, and `VerifyStartupLicense` signature stable.

- [ ] **Step 4: Verify GREEN**

Run: `go test ./... -run 'TestVerifyStartupLicense|TestLicense'`
Expected: all local license tests pass.

### Task 4: Add online status and authenticated offline cache

**Files:**
- Create: `product/launcher/license_lifecycle.go`
- Create: `product/launcher/license_lifecycle_test.go`

- [ ] **Step 1: Write failing status and cache tests**

Cover online active; provisioning/revoked/reissued/expired/disabled; online transport versus revoked; first offline; grace `min(server,24h,license expiry)`; exact boundary; clock rollback; cache ciphertext/tag/nonce mutation; receipt signature mutation; old license rejection; terminal cache never accepted offline; fixed errors contain no secret, fingerprint, receipt, signature, Authorization, path, or raw remote body.

```go
if err := fixture.verifyOnline(activeReceipt); err != nil { t.Fatal(err) }
fixture.transportErr = ErrLicenseStatusUnavailable
fixture.now = fixture.checkedAt.Add(24 * time.Hour)
if err := fixture.verify(); !errors.Is(err, ErrLicenseOfflineGraceExpired) { t.Fatalf("returned %v", err) }
```

- [ ] **Step 2: Verify RED**

Run: `go test ./... -run 'TestLicenseLifecycle|TestVerifyLicenseLifecycle'`
Expected: FAIL because lifecycle verifier does not exist.

- [ ] **Step 3: Implement receipt verification and typed states**

Use canonical JSON array domain `uclaw-license-status-v1`; verify bounded opaque receipt with trusted Ed25519 public key; require matching license/device, monotonic revision, timestamps, grace no later than 24 hours, and effective expiry.

- [ ] **Step 4: Implement cache**

Derive AES-256 key with `SHA-256("uclaw-license-cache-aead-v1\0" || startupSecret)`. Store strict outer JSON `{schemaVersion,nonce,ciphertext}` at `.uclaw/license/.lifecycle-cache.json`; encrypt receipt and `lastObservedAt` with AES-GCM additional data bound to schema/license/device. Use safe handle reads and atomic same-directory write/rename. Mutation and rollback fail closed.

- [ ] **Step 5: Implement HTTP query**

Require configured HTTPS endpoint in production; allow exact loopback HTTP only via test option. Send license ID path and startup secret only in Authorization over HTTPS/test loopback; bounded response; classify transport/unavailable separately from auth/status/invalid response. Never include response body or credentials in returned errors.

- [ ] **Step 6: Verify GREEN**

Run: `go test ./... -run 'TestLicenseLifecycle|TestVerifyLicenseLifecycle'`
Expected: lifecycle tests pass.

### Task 5: Preserve launcher ordering and production fail-closed config

**Files:**
- Modify: `product/launcher/main.go`
- Modify: `product/launcher/main_test.go`
- Modify: `product/launcher/state.go`
- Modify: `product/launcher/state_test.go`
- Modify: `.github/workflows/portable-launcher.yml`
- Modify: `product/scripts/portable-launcher-workflow.test.mjs`

- [ ] **Step 1: Write failing gate/static tests**

Assert lifecycle failure happens before instance lock, host cache, manifest, runtime preparation, or process; production missing HTTPS endpoint/status public key fails closed; workflow injects only endpoint and public receipt keys, never issuer private key.

- [ ] **Step 2: Verify RED**

Run: `go test ./... -run 'TestRun.*License|TestProduction.*License' && node --test scripts/portable-launcher-workflow.test.mjs`
Expected: new assertions fail.

- [ ] **Step 3: Wire combined gate and diagnostics**

Keep `Dependencies.VerifyLicense` at its current location. Production verifier performs P3-T03 local verification then P3-T04 lifecycle verification. Add fixed diagnostic mappings for unavailable/cache/clock/grace and six lifecycle states without raw errors.

- [ ] **Step 4: Wire release build public config**

Require HTTPS lifecycle endpoint and Ed25519 receipt public-key JSON in production workflow. Inject only `main.licenseStatusEndpoint` and `main.trustedLicenseStatusKeys` via ldflags. Fixture cross-build uses loopback/test dependency and ephemeral test key.

- [ ] **Step 5: Verify GREEN**

Run: `go test ./... && node --test scripts/portable-launcher-workflow.test.mjs`
Expected: all targeted tests pass.

### Task 6: Full gates, review, report, and atomic implementation commit

**Files:**
- Create: `docs/superpowers/reports/2026-08-10-P3-T04-license-lifecycle.md`
- Modify only files listed above if review finds defects.

- [ ] **Step 1: Run formatting and diff checks**

Run: `gofmt -w product/launcher/*.go && git diff --check && git status --short`
Expected: no whitespace errors; only planned files changed.

- [ ] **Step 2: Run full Node 24.15 gates**

Run in `product` with Node 24.15.0 PATH: `npm run build && npm run typecheck && npm test && npm run test:contract && npm run test:integration && npm run test:portable-launcher && npm run test:secrets`
Expected: every command exits 0.

- [ ] **Step 3: Run full Go and Windows cross-build gates**

Run in `product/launcher`: `go test ./... && go test -race ./... && go vet ./...`; then `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test ./...`, production `go build`, and fixture-tag `go build -tags licensefixture` with test public-key/loopback config only.
Expected: every command exits 0; these are cross-compiles, not real Windows/U-disk acceptance.

- [ ] **Step 4: Request independent review**

Review commit range `b2d76561..HEAD/worktree` against design and LIC-002. Fix every Critical/Important finding with a new failing test, rerun targeted and full gates, and repeat review until zero Critical/Important.

- [ ] **Step 5: Write delivery report**

Record status machine, 24h offline policy and worst-case revoke propagation, reissue semantics, secret boundaries, exact commands/results, branch/base/commit range, changed files, P3-T08 deferrals, conflict risk, and P3-T05 `startingState`.

- [ ] **Step 6: Commit implementation atomically**

Run: `git add <planned implementation/test/report files> && git commit -m "feat(license): 完成许可证生命周期"`
Expected: one implementation commit; `git status --short` empty. Do not push or create PR.
