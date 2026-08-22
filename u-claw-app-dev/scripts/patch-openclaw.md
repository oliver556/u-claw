# patch-openclaw.js

## Purpose

Applies deterministic U-Claw product UI patches to the bundled OpenClaw Control UI assets inside `node_modules/openclaw/dist/control-ui`.

## Boundaries

- Source of truth for UI text, branding, PWA manifest metadata, SkillHub dropdown, bundled skill filtering, and lightweight CSS polish.
- The CSS patch owns conservative responsive guards for content padding, table overflow, chat controls, login card sizing, and long-token wrapping.
- The second-batch i18n patch owns user-facing copy for Sessions, Nodes, Tasks, Activity, Logs, Workboard, Worktrees, Instances, shared tabs, and lazy loading states.
- The third-batch i18n patch owns high-signal utility copy for Debug, Terminal, navigation controls, Skill Workshop header, Logbook, Usage overview, and Cron quick create/list/history states.
- The visible tertiary patch extends that coverage to the zh-CN runtime bundle and hard-coded SkillHub Workshop empty states found by connected-page screenshots.
- The brand visual patch owns official icon copying, manifest product metadata, U-Claw color tokens, sidebar active state, chat fallback identity, and high-risk product-name residuals.
- The Brand Visual System patch copies official blue `assets/icon.*` into Control UI favicon/apple-touch assets, replaces default `Assistant` display fallbacks with U-Claw, localizes the failed-run fallback, and owns the U-Claw blue `#1677ff` primary/accent system for sidebar, active state, buttons, links, microphone, SkillHub dropdown, and SkillHub status dots. Auxiliary brand colors must stay in the blue family.
- The workspace background patch owns the cool-gray `--bg-content: #f7f9fc` content surface. Cards remain white so right-side pages keep hierarchy without the previous warm beige cast.
- Does not change OpenClaw Gateway methods, config schema, model/API chain, package version, or portable startup scripts.
- Does not hand-edit archived directories or generated assets outside `u-claw-app-dev`.

## Verification

Run:

```bash
node --check scripts/patch-openclaw.js
npm run patch-openclaw
node scripts/verify-skillhub-branding.js
```

After visible patch changes, restart the local Gateway and smoke-check the Control UI.
