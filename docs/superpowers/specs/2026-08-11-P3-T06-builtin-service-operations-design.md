# P3-T06 Builtin Service Operations Design

## Scope And Source

This task delivers `SVC-002` on top of locally integrated P3-T01 through P3-T05. The original requirements were read from the main workspace without modifying its uncommitted Chinese documents:

- `docs/第三阶段需求.md`: per-device quota, rate/concurrency limits, model permissions, user or token disablement, usage, anomaly audit, server-only upstream credentials, and changes taking effect without rebuilding the USB device.
- `docs/客户端改造实施计划.md`: P3-T06 owns per-device quota, rate limits, model permissions, disablement, usage, and anomaly audit after P3-T05 mapping exists.
- The delegated acceptance adds global `enabled | disabled | degraded | maintenance` service state, CAS/revision/idempotency, routing closure, circuit breaking, health recovery, strict failure classification, and production fail-closed behavior.

No UI, real New API, real upstream, Stripe/payment, P3-T07 convergence, P3-T08 native Windows helper, deployment, push, or PR is included.

## Requirement Map

| Requirement | Design response |
| --- | --- |
| Four operational states | Strict versioned schemas; unknown fields rejected. |
| CAS, revision, idempotency | Global state and device controls require `expectedRevision` and `idempotencyKey`; conflicting concurrent writes fail. |
| Illegal transitions | Explicit transition table; same idempotency replay returns the sealed prior response. |
| Quota/rate/model/disable | Device control record wraps the existing `NewApiPolicy` with its own revision. Lookup and update work by device ID or New API user ID. |
| Routing closure | Builtin data plane authoritatively checks global state, mapping, token, user, policy, quota, rate and model before dispatch. External/local routes never query builtin state and never fall back. |
| Lifecycle closure | A server-side authoritative P3-T04 reader must return an active, time-valid license for the exact mapping. Non-active mapping, revoked token, disabled user/policy, stale generation/policy digest, and reissued old binding are rejected on every builtin request. |
| Health/circuit recovery | Typed builtin data client has closed/open/half-open states. Only transport, configured-service unavailable, retryable upstream 5xx, and invalid responses count toward opening. Authentication, service disabled/maintenance, policy, quota, rate, and upstream 4xx do not. |
| Plane separation | Management HTTP accepts only management credential. Data HTTP accepts only device token. Credentials are never interchangeable. |
| Secret boundary | Public errors/audit contain fixed codes and categories only. No management credential, device token, provider/upstream Key, Authorization, request headers/body, endpoint, username, or raw cause. |
| Production fail-closed | HTTPS is mandatory. HTTP requires exact loopback plus explicit test opt-in. Missing client/endpoint never reports healthy. |

## Chosen Architecture

Extend the existing local New API fixture as two separate loopback listeners sharing in-memory authoritative state:

1. Management plane keeps P3-T01 endpoints and adds global service status plus device control read/update endpoints.
2. Data plane authenticates the P3-T05 device token, calls an injected server-side authoritative license reader, performs authoritative checks, exposes typed health and model request endpoints, and records bounded non-secret audit events.
3. A new builtin data client validates all request/response bodies, enforces HTTPS policy, classifies errors, and owns a deterministic circuit breaker.
4. Existing `model-source-router` remains the only source selector. Tests inject the builtin data client as the builtin executor; domestic/custom execution remains unchanged.

Rejected alternatives:

- Client-side management preflight: leaks management authority into the data path and creates TOCTOU between preflight and request.
- Router-only cached state: cannot provide immediate revocation, authoritative quota, or concurrent CAS semantics.

## Contracts

Global status contains `state`, monotonic `revision`, `reasonCode`, and `updatedAt`. Mutation contains `idempotencyKey`, `expectedRevision`, target `state`, and `reasonCode`.

Allowed transitions:

- `enabled -> degraded | maintenance | disabled`
- `degraded -> enabled | maintenance | disabled`
- `maintenance -> enabled | disabled`
- `disabled -> enabled | maintenance`

All other transitions, including a new-key no-op, fail with `SERVICE_STATE_TRANSITION_INVALID`. An exact idempotency replay returns its original result even after later writes; key reuse with different input fails. State/reason pairs are strict: disabled uses `OPERATOR_DISABLED`, degraded uses `DEGRADED_HEALTH`, maintenance uses `SCHEDULED_MAINTENANCE`, and enabled uses `OPERATOR_ENABLED` or `RECOVERY_COMPLETE`.

Device controls contain immutable `deviceId`/`userId`, monotonic `revision`, strict `policy`, current generation/license/token binding, and `updatedAt`. Mutations use CAS and idempotency and pin `expectedGeneration`, `expectedLicenseId`, and `expectedTokenId`. One serialized server transaction updates `user.policy`, `user.status`, current `mapping.policyDigest`, and current `token.policyDigest`; it does not rotate the token secret or rewrite the USB. The response is followed by an authoritative GET in integration tests. Provisioning's existing non-CAS policy setup remains limited to pre-activation initialization; P3-T06 operational changes use the new CAS endpoint.

Data request and response schemas are strict and bounded. Health returns only `acceptingBuiltin`, current public service state, and revision. It never returns account, credential, endpoint, or upstream details.

## State And Routing Semantics

- `enabled`: accepts new builtin requests under device policy.
- `degraded`: accepts builtin requests; effective concurrent limit is `1`; effective RPM is `max(1, floor(configuredRPM / 2))`; no automatic retry and no fallback.
- `maintenance`: rejects new builtin requests with non-retryable service-maintenance classification.
- `disabled`: rejects new builtin requests with non-retryable service-disabled classification.

External `domestic` and `custom` routes do not contact management or builtin data planes. Their failures remain on the selected route. A local/custom model therefore consumes no builtin quota.

## Data-Plane Authorization

Every model request uses two-phase admission so no network I/O occurs while holding the state lock:

1. Under lock, authenticate and capture service revision, control revision, mapping generation/license/token/policy digest, and quota/rate/concurrency counters.
2. Release lock and perform the authoritative license read with a strict timeout and bounded response.
3. Re-enter the lock, revalidate every captured revision/binding/current credential and global state, then atomically reserve quota/RPM/concurrency. Any change restarts once or fails with a fixed conflict; it never admits against a stale snapshot.

A state change therefore never waits on lifecycle network I/O and prevents every reservation committed after its CAS commit; already admitted work may finish. Every request checks:

1. Global operational state accepts new builtin work and server-side upstream/channel execution is configured.
2. Token exists and is `active`.
3. Current device mapping is `active` and points to this token/user.
4. Mapping generation, channel, and policy digest match the current token and current user policy digest.
5. The injected server-side lifecycle reader reports the exact license/device binding `active`, not replaced, and within its validity interval. Reader unavailable or malformed is fail-closed.
6. User is active and policy is not disabled.
7. Requested model is allowed.
8. Quota, effective RPM, and effective concurrency permit the request.

Admission reserves quota and a concurrency slot atomically. For request-unit quota, reservation is exactly `1`. For token-unit quota, the server computes a conservative upper bound from bounded UTF-8 prompt bytes plus server-enforced `maxOutputTokens`; it never trusts a client-supplied token count. The upstream executor must honor that output bound and return strict usage no greater than the reservation. Missing/excess usage is an invalid upstream response and consumes the full reservation fail-closed. RPM is charged at admission. Successful execution commits actual bounded usage; ordinary failed execution releases quota reservation without consuming it; concurrency always releases in `finally`. This makes revoke, disable, reissue, and token revocation authoritative without rewriting the USB credential and prevents concurrent quota oversubscription.

## Errors, Audit, And Circuit Breaker

Stable classification matrix:

| Failure | Category/code behavior | Retryable | Breaker counted |
| --- | --- | --- | --- |
| Invalid device bearer | `authentication` | no | no |
| Device/user disabled | `disabled` | no | no |
| Global disabled/maintenance | dedicated fixed service code under `unavailable` | no | no |
| Configured data service/upstream absent | `unavailable` with fixed `SERVICE_UNAVAILABLE` | yes | yes |
| Device quota | `quota` | no | no |
| Device RPM/concurrency | `rate-limit` | yes | no |
| Device model permission | `model-permission` | no | no |
| Caller `AbortSignal` cancellation | fixed `cancelled` / `OPERATION_CANCELLED` | no | no |
| DNS/TLS/socket/timeout | `transport` | yes | yes |
| Malformed/oversized data response | `invalid-response` | no | yes |
| Upstream 4xx, including 429 | `upstream` with fixed `UPSTREAM_4XX` | no | no |
| Upstream 5xx | `upstream` with fixed `UPSTREAM_5XX` | yes | yes |
| Open-circuit fast failure | `unavailable` / `CIRCUIT_OPEN` | yes | no |

Caller cancellation and internal timeout use composed signals with distinct provenance; only the internal timeout counts as transport failure. Raw response bodies, HTTP status details, and causes are discarded.

Circuit policy is deterministic and injectable for tests: open after two consecutive counted failures; reject while open; after cooldown, exactly one real normal request becomes the half-open probe and all concurrent contenders fast-fail. A successful request closes the circuit. A counted failure reopens it. A non-counted business/auth failure closes the transport circuit and returns that original error. Caller cancellation never opens, reopens, or extends cooldown. `CIRCUIT_OPEN` fast failures do not move `reopenAt`. The separate authenticated health endpoint is informational and never closes a circuit opened by upstream failures.

Authenticated health reuses active token plus current mapping/user/generation/channel/policy binding checks, but skips quota, RPM, concurrency, model permission, and upstream execution. Revoked, disabled, replaced, or stale credentials receive the same fixed authentication failure and cannot read service state or revision.

Audit records only server-generated IDs, fixed action/outcome/category, service revision, and timestamp. It excludes prompts, model output, headers, URLs, credentials, attacker-supplied authentication subjects, and raw errors. It reuses the existing 1,000-event retention and 100-item page bound. Exact idempotent replay does not append a duplicate mutation event.

`reasonCode` is a fixed enum: `OPERATOR_ENABLED`, `OPERATOR_DISABLED`, `DEGRADED_HEALTH`, `SCHEDULED_MAINTENANCE`, and `RECOVERY_COMPLETE`; it is never free text.

## Assembly And Credential Boundaries

The localhost fixture defaults to `disabled`. It may enter `enabled` only when an upstream executor/channel and authoritative license reader are configured. Health reports `acceptingBuiltin=true` only when configuration exists and state is `enabled` or `degraded`; TCP/JSON reachability alone is not availability.

Production constructs an unavailable builtin data client unless an HTTPS endpoint is explicitly configured. The management client is instantiated only inside a dedicated operator/backend process through constructor injection. Its credential must never enter shared IPC, renderer state, `ProviderStore`, `BuiltinCredentialStore`, ordinary configuration, environment variables, committed fixtures, logs, or reports. The data client consumes only `BuiltinModelCredential` loaded from P3-T05's mode-0600 store. Both listeners compare Bearer values in constant time; cross-plane credentials return the same fixed 401 without request data.

## Verification Boundary

Localhost tests cover strict schemas, success, idempotency, concurrency, CAS conflict, illegal transition, dynamic device controls, all global states, lifecycle closure, route isolation, auth separation, network failure, upstream 4xx/5xx, malformed response, circuit open/half-open/recovery, health, and secret scanning. Production assembly remains unavailable without configured HTTPS data endpoint. Windows evidence is compile/static only; real Windows, physical USB, real New API, real upstream, TLS certificates, deployment, and live revoke propagation remain P3-T08.
