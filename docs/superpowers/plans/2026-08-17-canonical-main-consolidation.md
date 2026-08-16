# Canonical Main Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one tested local main line containing the complete modern UI, activation security path, and chat queue/multimodal work, then retire redundant clean worktrees without losing uncommitted changes.

**Architecture:** Start from `codex/unified-latest` because it retains the complete UI. Merge the activation integration and chat queue integration histories, resolving conflicts by preserving current UI capabilities while accepting activation and queue contracts, runtime wiring, and tests. Keep dirty worktrees untouched until their changes are backed up and reviewed.

**Tech Stack:** Git worktrees, TypeScript, React, Electron, Vitest, Playwright, Go.

---

### Task 1: Establish Protected Integration Workspace

**Files:**
- Create: `docs/superpowers/plans/2026-08-17-canonical-main-consolidation.md`

- [ ] **Step 1: Create isolated integration branch**

Run:
```bash
git worktree add /Users/jamison/.config/superpowers/worktrees/u-claw/canonical-main-20260817 -b codex/canonical-main-20260817 codex/unified-latest
```

Expected: worktree at `d857694` on `codex/canonical-main-20260817`.

- [ ] **Step 2: Install locked dependencies**

Run:
```bash
cd product && npm install
```

Expected: dependency installation exits 0 without changing the lockfile.

- [ ] **Step 3: Verify baseline**

Run:
```bash
cd product && npm test
```

Expected: baseline test suite exits 0.

### Task 2: Merge Activation Integration Without Regressing UI

**Files:**
- Modify: conflict files reported by Git under `product/desktop/`, `product/frontend/`, `product/shared/`, and packaging/configuration paths.
- Test: existing tests under `product/**/tests/` and `product/tests/`.

- [ ] **Step 1: Merge activation history without committing**

Run:
```bash
git merge --no-ff --no-commit codex/activation-final-local-integration-20260813
```

Expected: Git reports the known conflict set and leaves a merge in progress.

- [ ] **Step 2: Resolve conflicts by product ownership**

Preserve activation branch implementations for activation API, credentials, model proxy, startup mode, launcher, and deployment. Preserve unified branch implementations for billing, image interactions, Skill workbench, local actions, task artifacts, and full primary navigation. Reconcile shared contracts and IPC wiring so both surfaces compile.

- [ ] **Step 3: Run focused validation**

Run:
```bash
cd product && npm run typecheck && npm run test -w @uclaw/desktop && npm run test -w @uclaw/frontend
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit activation merge**

Run:
```bash
git commit -m "merge: integrate activation system with complete client"
```

### Task 3: Merge Chat Queue and Multimodal Integration

**Files:**
- Modify: queue, attachment, adapter, desktop dispatcher, and frontend chat files reported by Git.
- Test: existing chat queue, adapter, desktop, and frontend tests.

- [ ] **Step 1: Merge queue integration**

Run:
```bash
git merge --no-ff codex/integration-chat-queue-multimodal
```

Expected: queue contracts, attachment cleanup, dispatcher, session rename, and multimodal UI enter canonical history.

- [ ] **Step 2: Apply independent stability fixes when absent**

Check patch equivalence for `a981ccb` and `ce84a1f`; cherry-pick only patches not already represented by the merged tree.

- [ ] **Step 3: Run focused validation**

Run:
```bash
cd product && npm run typecheck && npm test
```

Expected: all commands exit 0.

### Task 4: Verify Release Surface

**Files:**
- Modify only defects found by validation.
- Test: complete product suite and browser acceptance.

- [ ] **Step 1: Build complete product**

Run:
```bash
cd product && npm run build
```

Expected: build and distribution smoke tests exit 0.

- [ ] **Step 2: Run browser acceptance**

Run the local renderer and inspect desktop and mobile screenshots. Confirm navigation includes work, files, memory, capabilities, connections, automation, usage, balance, and system. Confirm no overlap or blank renderer.

- [ ] **Step 3: Launch canonical Electron client**

Stop only the obsolete `e93f` client process, then launch from the canonical worktree. Confirm process CWD and renderer path point at `canonical-main-20260817`.

### Task 5: Promote and Clean Up

**Files:**
- Modify: Git refs and worktree registrations only.

- [ ] **Step 1: Preserve dirty worktrees**

Create patch and untracked-file inventory backups for `649f` and `7c78`. Do not remove either worktree until their state is recoverable.

- [ ] **Step 2: Promote canonical result**

Move local `main` to the verified canonical commit, then switch the primary project directory to `main`.

- [ ] **Step 3: Remove redundant clean worktrees**

Remove clean worktrees whose branch tips are ancestors of canonical `main`. Prune stale registrations. Keep any non-ancestor or dirty worktree and report it.

- [ ] **Step 4: Delete redundant merged branches**

Delete only local branches proven to be ancestors of canonical `main` and no longer checked out.

- [ ] **Step 5: Verify final state**

Run:
```bash
git status --short --branch
git branch -vv
git worktree list
```

Expected: primary directory on clean `main`; canonical client running from primary directory; only protected non-merged work remains.
