# Electron Production DevTools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable Electron DevTools in packaged `product/desktop` windows while preserving development access.

**Architecture:** Window factories accept an explicit `devTools` policy and copy it into `BrowserWindow.webPreferences`. Production wiring derives the policy once from `app.isPackaged` and passes it to both main and advanced-console windows.

**Tech Stack:** Electron, TypeScript, Vitest

---

### Task 1: Apply packaged DevTools policy

**Files:**
- Modify: `product/desktop/tests/window.test.ts`
- Modify: `product/desktop/src/window.ts`
- Modify: `product/desktop/src/main.ts`

- [ ] **Step 1: Write failing window tests**

Pass `devTools: false` to `createMainWindow` and `createAdvancedConsoleWindow`, then assert each captured `BrowserWindow` option contains `webPreferences.devTools: false`.

- [ ] **Step 2: Verify tests fail**

Run: `npm test -w @uclaw/desktop -- tests/window.test.ts`

Expected: TypeScript/Vitest failure because window option types do not yet accept `devTools`.

- [ ] **Step 3: Implement minimal policy plumbing**

Add required `devTools: boolean` fields to both window factory option types and controller options. Copy the value into each `BrowserWindow` configuration. In `startElectronMain`, compute `const devTools = !app.isPackaged` and pass it to the main-window factory and advanced-console controller.

- [ ] **Step 4: Verify focused tests pass**

Run: `npm test -w @uclaw/desktop -- tests/window.test.ts`

Expected: all `window.test.ts` tests pass.

- [ ] **Step 5: Verify desktop package**

Run: `npm run typecheck -w @uclaw/desktop`

Expected: TypeScript exits with code 0.

Run: `npm test -w @uclaw/desktop`

Expected: all desktop tests pass.

Run: `npm run build -w @uclaw/desktop`

Expected: desktop build exits with code 0.
