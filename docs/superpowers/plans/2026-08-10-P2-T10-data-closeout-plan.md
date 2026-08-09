# P2-T10 Data Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close production workspace open/reveal and define a truthful optimistic concurrency boundary for workspace and memory mutations.

**Architecture:** Keep renderer IPC unchanged. Inject a controlled Electron shell adapter and a minimal mutation coordinator into `createDataService`; validate filesystem identity at the last controllable boundary and report external version conflicts without claiming strict cross-process linearizability.

**Tech Stack:** TypeScript, Electron shell, `@openclaw/fs-safe`, Vitest, Node filesystem APIs.

---

### Task 1: Freeze Internal Boundaries

**Files:**
- Modify: `product/desktop/src/data/data-service.ts`
- Test: `product/desktop/tests/data-service.test.ts`

- [ ] Add failing tests proving an injected mutation coordinator wraps every versioned workspace/memory mutation.
- [ ] Run `npm test -w @uclaw/desktop -- data-service.test.ts` and confirm missing coordinator calls fail.
- [ ] Add minimal `WorkspaceShell` and `DataMutationCoordinator` interfaces to data-service options.
- [ ] Replace direct `mutationQueue` usage with the default coordinator implementation.
- [ ] Re-run focused tests and confirm pass.

### Task 2: Controlled Open And Reveal

**Files:**
- Modify: `product/desktop/src/data/data-service.ts`
- Modify: `product/desktop/src/main.ts`
- Test: `product/desktop/tests/data-service.test.ts`
- Test: `product/desktop/tests/main.test.ts`

- [ ] Replace existing UNAVAILABLE assertions with failing success tests for injected `openPath` and `showItemInFolder` behavior.
- [ ] Add failing tests for traversal, symlink, hardlink, and replacement before shell invocation.
- [ ] Run focused tests and verify expected failures.
- [ ] Resolve an opened fs-safe target to a path-free identity record, revalidate immediately before adapter action, and fail closed on mismatch.
- [ ] Wire Electron `shell.openPath` and `shell.showItemInFolder` only in production main-process construction; convert non-empty `openPath` errors to controlled failures.
- [ ] Re-run focused tests and confirm pass.

### Task 3: External Conflict Detection

**Files:**
- Modify: `product/desktop/src/data/data-service.ts`
- Test: `product/desktop/tests/data-service.test.ts`

- [ ] Add failing tests for an old version, external content change after initial validation, and path replacement during mutation.
- [ ] Run focused tests and verify conflicts are not yet detected at the intended boundary.
- [ ] Add pre-commit identity/version revalidation and post-commit result verification for versioned operations.
- [ ] Re-run focused tests and DATA-002 regression tests.

### Task 4: Verify And Commit

**Files:**
- Verify all files changed by Tasks 1-3.

- [ ] Run `npm test -w @uclaw/desktop -- data-service.test.ts main.test.ts data-ipc.test.ts`.
- [ ] Run `npm test -w @uclaw/shared -- data.test.ts`.
- [ ] Run `npm run typecheck` from `product/`.
- [ ] Run `npm run build` from `product/`.
- [ ] Run `npm run test:integration` from `product/`.
- [ ] Inspect `git diff --check`, changed files, and status.
- [ ] Commit all task-owned changes on `codex/p2-t10-data-closeout`; do not push or create a PR.
