# verify-skillhub-branding.js

## Purpose

Verifies the U-Claw UI patch output produced by `patch-openclaw.js`.

## Checks

- U-Claw first-screen branding.
- U-Claw manifest metadata.
- SkillHub user-facing copy and bundled OpenClaw skill filtering.
- Chat SkillHub dropdown integration tokens.
- Page-level copy tokens for Chat, Skills, Agents, Channels, Config, Overview, Index, CSS, i18n, and second-batch operational pages.
- Service Worker cache markers.
- Targeted high-risk residual English strings that previously made the UI look unpatched.
- Second-batch residual English strings for Sessions, Nodes, Tasks, Activity, Logs, Workboard, Worktrees, Instances, and lazy loading states.
- Third-batch residual English strings for Debug, Terminal, navigation controls, Skill Workshop header, Logbook, Usage overview, and Cron quick create/list/history states.
- Connected-page residual strings for zh-CN Cron/Usage copy and hard-coded SkillHub Workshop empty states.
- Official U-Claw icon files copied into Control UI favicon/apple-touch assets.
- Brand Visual System tokens for U-Claw blue `#1677ff` primary/accent styling and blue logo assets, plus residual checks against orange color tokens, default `Assistant`, visible Config identity leftovers, Chat failure fallback leftovers, Mobile/Worktrees product-name leftovers, and SkillHub risk-copy leftovers.
- Workspace background tokens for the cool-gray right-side content surface (`--bg-content: #f7f9fc`) so the light theme does not fall back to warm beige `#f4f1ec`.
- Responsive CSS guard tokens for content overflow, data tables, chat dropdowns, and narrow-screen layout.

## Boundaries

This verifier intentionally preserves runtime identifiers and contracts such as `openclaw gateway run`, `openclaw dashboard`, `OPENCLAW_GATEWAY_TOKEN`, `onClawHub`, and `clawhub`.
