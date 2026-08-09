# P2-T11/P2-T13 Runtime Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close production snapshot/CAS, authoritative Doctor repair, and factory-reset runtime coordination gaps without changing renderer capabilities.

**Architecture:** Add one production coordinator that counts desktop mutations, serializes exclusive leases, and controls the managed Gateway lifecycle. Backup, restore, factory reset, and the fixed Doctor `gateway-restart` action reuse it. Doctor repair uses a typed local executor registry; upstream output may advertise an action but never supplies executable commands.

**Tech Stack:** TypeScript, Electron main process, Zod contracts, Vitest.

---

### Task 1: Runtime consistency coordinator

**Files:**
- Create: `product/desktop/src/data/production-consistency-coordinator.ts`
- Create: `product/desktop/tests/production-consistency-coordinator.test.ts`
- Modify: `product/desktop/src/data/maintenance-service.ts`

- [ ] Write tests for draining in-flight writes, concurrent leases, stop failure, operation failure, restart failure, cancellation, and recovery.
- [ ] Run the focused test and confirm missing-module/API failures.
- [ ] Implement the minimal state machine and pass operation signals into lease acquisition.
- [ ] Run the focused test and maintenance regressions.

### Task 2: Production lifecycle wiring

**Files:**
- Modify: `product/desktop/src/main.ts`
- Modify: `product/desktop/tests/main.test.ts`

- [ ] Write production wiring tests proving backup, restore, and factory reset no longer fail with `UNAVAILABLE`.
- [ ] Run the focused test and confirm failure.
- [ ] Bind coordinator stop/start to the owned Gateway process and readiness probe.
- [ ] Run main and data tests.

### Task 3: Doctor authority registry

**Files:**
- Modify: `product/shared/src/diagnostics.ts`
- Modify: `product/shared/src/client.ts`
- Modify: `product/desktop/src/diagnostics/diagnostics-service.ts`
- Modify: `product/desktop/tests/diagnostics-service.test.ts`
- Modify: `product/shared/tests/diagnostics.test.ts`

- [ ] Write tests for the fixed action ID, local executor, audit events, confirmation, timeout, concurrency, cancellation, and unknown-action rejection.
- [ ] Run focused tests and confirm failure.
- [ ] Replace upstream repair dispatch with the controlled executor registry.
- [ ] Run shared and diagnostics tests.

### Task 4: Verification and commit

**Files:**
- Review all changed files.

- [ ] Run desktop unit tests, shared contracts, integration tests, typecheck, and build.
- [ ] Review diff against DATA-007, OPS-003, OPS-007, DATA-008, and OPS-004.
- [ ] Commit on `codex/p2-t11-t13-consistency`; do not push or create a PR.
