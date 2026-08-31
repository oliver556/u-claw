# Bavi-box Scripts

This directory contains repository-owned helper scripts for the active `u-claw-app-dev` tree.

## Scope

- `patch-openclaw.js` is the source of truth for deterministic Bavi-box UI patches applied to generated OpenClaw Control UI assets.
- `verify-skillhub-branding.js` checks that patched assets still contain required Bavi-box / SkillHub tokens and do not regress high-risk visible copy.
- `verify-ecommerce-workflow.js` checks the Prompt-only ecommerce workflow entry, bundled Skill contract, and generated Workflows page tokens.
- `verify-skillhub-store-connected-ui.js` runs read-only browser acceptance for the SkillHub store homepage, tabs, category chips, and search reset.
- Runtime asset files under `node_modules/openclaw/dist/control-ui` are patch outputs, not permanent source.

## Rules

- Do not modify archived project directories from these scripts.
- Do not rewrite OpenClaw Gateway, model, agent, or skill runtime behavior here.
- Preserve real runtime contracts such as `openclaw gateway run`, `openclaw dashboard`, `OPENCLAW_GATEWAY_TOKEN`, `onClawHub`, and `clawhub`.
- Bump the Service Worker cache marker when visible UI patch output changes.
