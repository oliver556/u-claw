# Bavi-box Agent Instructions

## 1. Mandatory Project Rules

All agents and developers working in this repository must first read and follow:

```txt
docs/多人开发/开发硬性要求.md
```

That document is the source of truth for:

```txt
development directories
archived directories
OpenClaw reuse boundaries
UI ownership
model/API ownership
SkillHub requirements
USB portable packaging
Mac/Windows validation
forbidden changes
```

## 2. Directory Rules

Do not modify archived directories:

```txt
u-claw-app
product
```

Active development must happen in:

```txt
u-claw-app-dev
```

If `u-claw-app-dev` does not exist, create it by copying `u-claw-app` first.

## 3. Core Rule

Reuse original OpenClaw capabilities. Do not rewrite agent/runtime capabilities unless the hard-requirements document explicitly allows it.
