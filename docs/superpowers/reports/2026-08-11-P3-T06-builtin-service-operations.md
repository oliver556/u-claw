# P3-T06 Builtin Service Operations Report

## Status

P3-T06 is complete on `codex/p3-t06-builtin-service-operations`.

- Target: `codex/integration-p2-t10-local`
- Base: `13e2cba5e290df439eba4c9c988b4ac3b438eb76`
- Implementation head before this report: `ecd9143667adbf6e23bd0d06a6bc00e730b167d6`
- PR: none
- Push: not executed

The implementation uses strict typed localhost contracts, mocks, and sandbox tests only. It does not contact a real New API, model upstream, license service, or payment service. It does not implement P3-T07 or P3-T08.

## Requirement Map

| Acceptance item | Implementation and evidence |
| --- | --- |
| `enabled/disabled/degraded/maintenance` | Strict `BuiltinServiceStatus` contract; initial `disabled@revision=1`; state/reason transition table and integration coverage. |
| Strict typed contract; reject unknown fields | Zod `.strict()` schemas plus shared and contract fixtures/tests for status, CAS, device controls, health, request, response, and errors. |
| CAS/revision/idempotency/concurrency | Serialized global and device-control mutations; monotonic revisions; sealed replay; payload reuse conflict; concurrent CAS conflict; illegal/no-op transition rejection. |
| Routing closure | Data-plane admission rejects disabled/maintenance. Degraded enforces concurrency `1` and `max(1, floor(RPM/2))`. Router performs no retry or fallback. Domestic/custom routes do not read builtin credentials or call builtin data/upstream. Production assembly pins the typed builtin client and explicitly adapts bounded plain-text chat input/output contracts. |
| License/device/New API closure | Every builtin admission rechecks active mapping, user, token, generation, channel, policy digest, authoritative license/device binding and validity. Revoked, disabled, expired, reissued, stale, or replaced state fails closed without USB reprovisioning. |
| Health/circuit recovery | Typed client implements two-failure open, fixed cooldown, one half-open real model request, concurrent probe rejection, success reset, counted-failure reopen, caller-abort exclusion, timeout counting, and health isolation. |
| Failure classification | Fixed categories/codes distinguish authentication, service state, quota, rate/concurrency, model permission, caller cancellation, client timeout/network, upstream 4xx/5xx, malformed/oversized response, and circuit-open. |
| Management/data authentication separation | Separate localhost listeners. Management credential is accepted only by management endpoints; device bearer only by data endpoints. Strict Bearer parsing and constant-time digest comparison are covered. |
| Secret boundary | Public errors, audit records, fixtures, tests, logs, and this report exclude raw credentials, `Authorization`, token secret, provider/upstream Key, endpoint, username, request body, and raw cause. Secret scan passes. |
| Production fail-closed | Client requires HTTPS. HTTP requires exact loopback and explicit test opt-in. Missing endpoint/client or server dependencies report unavailable and never healthy. Windows provisioning remains fail-closed before P3-T08. |
| Mock acceptance | Localhost tests cover success, idempotency, concurrent CAS, illegal transitions, states, degraded limits, lifecycle changes, auth failures, network/timeout, upstream 4xx/5xx, malformed responses, breaker recovery, and route isolation. |

## Security Boundary

The management plane owns service and device policy mutation authority. Its credential is constructor-injected and is not stored in renderer state, `ProviderStore`, `BuiltinCredentialStore`, ordinary configuration, fixtures, logs, or reports. The data plane receives only the P3-T05 device token and never receives management authority or provider/upstream credentials.

Data admission is authoritative and two-phase: snapshot under the state lock, bounded license read outside the lock, then locked revalidation and atomic reservation. Management CAS never waits on network I/O. Quota, RPM, and concurrency are reserved atomically. Request quota is one unit; token quota uses bounded UTF-8 prompt bytes plus enforced output bounds and never trusts a client estimate.

Audit output contains only server-generated IDs, fixed action/outcome/category, service revision, and timestamp. Authentication failures do not reveal service state or revision.

## Changed Files

- `docs/superpowers/specs/2026-08-11-P3-T06-builtin-service-operations-design.md`
- `docs/superpowers/plans/2026-08-11-P3-T06-builtin-service-operations.md`
- `docs/superpowers/reports/2026-08-11-P3-T06-builtin-service-operations.md`
- `product/shared/src/builtin-service-operations.ts`
- `product/shared/src/index.ts`
- `product/shared/src/new-api-management.ts`
- `product/shared/tests/builtin-service-operations.test.ts`
- `product/shared/tests/exports.test.ts`
- `product/shared/tests/new-api-management.test.ts`
- `product/tests/fixtures/builtin-service-operations-v1.json`
- `product/tests/fixtures/new-api-management-v1.json`
- `product/tests/contract/builtin-service-operations.contract.test.ts`
- `product/desktop/src/index.ts`
- `product/desktop/src/main.ts`
- `product/desktop/src/new-api-management/client.ts`
- `product/desktop/src/new-api-management/local-server.ts`
- `product/desktop/src/providers/builtin-credential-store.ts`
- `product/desktop/src/providers/builtin-service-client.ts`
- `product/desktop/src/providers/model-source-router.ts`
- `product/desktop/src/provisioning/coordinator.ts`
- `product/desktop/tests/builtin-credential-store.test.ts`
- `product/desktop/tests/builtin-service-client.test.ts`
- `product/desktop/tests/model-source-router.test.ts`
- `product/desktop/tests/provisioning-coordinator.test.ts`
- `product/tests/integration/builtin-service-operations-local.test.ts`
- `product/tests/integration/model-source-routing.test.ts`
- `product/tests/integration/new-api-management-local.test.ts`
- `product/tests/integration/provisioning-identity-local.test.ts`

## Fresh Verification

Node.js `24.15.0`:

- `npm run build`: pass; workspace build and dist smoke pass. Vite reports only the existing chunk-size warning.
- `npm run typecheck`: pass.
- `npm test`: pass: Node scripts/packaging `121/121`; contract `19/19`; shared `273/273`; adapter `159/159`; desktop `558/558`; frontend `152/152`.
- `npm run test:integration`: `61/61` pass; builtin operations `21/21`; router closure `2/2`.
- `npm run test:secrets`: pass.

Launcher:

- `go test ./...`: pass.
- `go test -race ./...`: pass.
- `go vet ./...`: pass.
- Windows amd64 production and `licensefixture` executables: cross-compile pass.
- Windows amd64 production and `licensefixture` test binaries: cross-compile pass, not executed.
- `git diff --check 13e2cba..HEAD`: pass.

Scoped independent reviews for contracts, credential initialization, management CAS, authoritative data admission, typed client/circuit, router/lifecycle closure, production client pinning, and the explicit chat contract adapter each finished with `Critical=0 Important=0`.

## Conflict Risk

Highest overlap risk is in `product/desktop/src/new-api-management/local-server.ts`, `product/desktop/src/provisioning/coordinator.ts`, `product/shared/src/new-api-management.ts`, and the provisioning/operations integration fixtures. Router and typed client files are lower-risk additions. Integration should preserve the P3-T03 to P3-T04 gate order and the P3-T05 mapping/token journal semantics.

## P3-T07 Starting State

Start P3-T07 from the final commit of `codex/p3-t06-builtin-service-operations`, targeting `codex/integration-p2-t10-local`. Available foundations are strict operations contracts, management/device CAS, authoritative two-phase data admission, lifecycle-bound P3-T05 credentials, typed client error classification, deterministic circuit recovery, and no-fallback source routing.

P3-T07 must not move management credentials or upstream/provider keys into the renderer, ordinary configuration, public diagnostics, or device storage. It must keep production fail-closed and preserve external/local route isolation.

## Not Verified In A Real Environment

- Real New API and model upstream behavior, TLS certificates, DNS, proxy, and production deployment.
- Live authoritative license/device service and real revoke/reissue propagation latency.
- Real Windows execution, DACL behavior, native pinned-handle helper, and physical USB media.
- Real management credential rotation and operational runbooks.
- P3-T07 orchestration and P3-T08 Windows helper.

Windows amd64 evidence is compile-only and is not a Windows or physical-device acceptance result.
