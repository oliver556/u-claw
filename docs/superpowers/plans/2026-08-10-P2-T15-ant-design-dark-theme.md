# P2-T15 Ant Design Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent `light`, `dark`, and `system` themes across the full U-Claw Electron renderer without first-frame white flash or light-mode regressions.

**Architecture:** A focused theme module owns preference parsing, U-Claw settings persistence, system resolution, Ant Design algorithm selection, semantic CSS variables, and document metadata. `AppProviders` exposes this through one context. The system center renders the only preference control. `index.html` applies the persisted effective mode before the renderer bundle runs, while Electron uses a neutral dark-aware window background.

**Tech Stack:** React 19, TypeScript, Ant Design 5 `ConfigProvider`, CSS custom properties, Vitest/Testing Library, Playwright, Electron.

---

### Task 1: Theme Contract And Persistence

**Files:**
- Create: `product/frontend/src/theme/settings.ts`
- Create: `product/frontend/src/theme/ThemeProvider.tsx`
- Create: `product/frontend/tests/Theme.test.tsx`
- Modify: `product/frontend/src/theme/tokens.ts`

- [x] Write failing tests for invalid preference fallback, persisted preference restore, `system` media-query changes, document `data-theme`/`color-scheme`, and `darkAlgorithm` selection.
- [x] Run `npm test -w @uclaw/frontend -- Theme.test.tsx` and confirm failures describe missing theme contract.
- [x] Add `ThemePreference`, storage key, safe storage adapter, effective-theme resolver, frozen light/dark semantic maps, and theme context/provider.
- [x] Re-run focused tests and confirm pass.

### Task 2: First-Frame Bootstrap And Electron Surface

**Files:**
- Modify: `product/frontend/index.html`
- Modify: `product/desktop/src/window.ts`
- Modify: `product/desktop/tests/window.test.ts`
- Modify: `product/frontend/tests/index.test.ts`

- [x] Write failing tests proving bootstrap runs before React and Electron no longer forces a light-only background.
- [x] Run focused frontend and desktop tests; confirm expected failure.
- [x] Add a small synchronous head bootstrap that reads the U-Claw preference, resolves `system`, and sets `data-theme`, `color-scheme`, and initial background before module load.
- [x] Make Electron window background compatible with the restored surface while retaining custom native controls.
- [x] Re-run focused tests and confirm pass.

### Task 3: System Theme Setting

**Files:**
- Create: `product/frontend/src/features/system/AppearanceSettings.tsx`
- Modify: `product/frontend/src/layout/WorkspaceShell.tsx`
- Modify: `product/frontend/tests/App.test.tsx`

- [x] Write failing interaction tests for opening appearance settings, selecting all three modes, persistence, and reload restore.
- [x] Run the focused app test; confirm it fails because no appearance control exists.
- [x] Add a compact Ant Design segmented control under the existing system center, with `Monitor`, `Sun`, and `Moon` icons and clear Chinese labels.
- [x] Re-run focused interaction tests and confirm pass.

### Task 4: Full Surface Token Audit

**Files:**
- Modify: `product/frontend/src/theme/global.css`
- Modify as required: `product/frontend/src/layout/AppTitlebar.tsx`
- Modify: `product/frontend/tests/index.test.ts`

- [x] Add failing static tests that reject undefined semantic variables and hard-coded business white/black colors outside the theme module or documented QR exception.
- [x] Run the static test and confirm existing undefined variables and leaks fail.
- [x] Define missing semantic tokens in both palettes; replace hard-coded text/background values; set document `color-scheme`; keep WeChat QR render surface intentionally white for scan reliability.
- [x] Re-run static tests and full frontend unit suite.

### Task 5: Visual And Interaction Verification

**Files:**
- Create: `product/tests/e2e/theme.spec.ts`
- Create: `output/playwright/p2-t15-theme/work-light.png`
- Create: `output/playwright/p2-t15-theme/work-dark.png`
- Create: `output/playwright/p2-t15-theme/appearance-dark.png`

- [x] Add Playwright tests for light/dark/system switching, reload persistence, live system-mode change, all primary routes, overlays, and absence of light surface leakage.
- [x] Run focused theme E2E tests and correct false-positive interaction and alpha-channel assertions.
- [x] Capture representative 1440x900 light/dark work and dark appearance screenshots; cover all six routes and overlays with automated style assertions. Label them browser evidence, not Windows-native evidence.
- [x] Run `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run build`, and `npm run test:e2e` from `product/`.
- [x] Review changed files, fixed-color scan, screenshots, and requirement checklist; commit one scoped P2-T15 change without push or PR.
