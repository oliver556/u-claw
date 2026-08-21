# Commercial Chain Blackbox Gate Report

Status: needs-input

Date: 2026-08-21

Branch target: `codex/uclaw-refactor-final`

Local HEAD: `a02c3bb08c726c4c281a1c6f9c374140ff3fb126`

Remote integrated HEAD: `a5c5d989881d9fe147215f7d1baf6b1b6b538dbc`

## Scope

Prepare and execute as much of the commercial new-chain E2E gate as possible without using real commercial quota or credentials.

No product code changed. No frozen runtime artifact files changed. No `u-claw-app/` or root `portable/` changes.

## Local Checks Executed

```text
go test -p=1 -count=1 ./internal/modelproxy ./internal/transport
ok   u-claw-activation-server/internal/modelproxy
ok   u-claw-activation-server/internal/transport

npm ci --prefix product
pass

npm run test:secrets --prefix product
pass

npx vitest run tests/contract/openclaw-only-chat.contract.test.ts tests/contract/activation-openapi.contract.test.ts
2 files, 9 tests passed

npx vitest run desktop/tests/builtin-credential-store.test.ts desktop/tests/openclaw-provider-config.test.ts desktop/tests/commercial-openclaw-lifecycle.phase0.test.ts desktop/tests/commercial-openclaw-lifecycle.test.ts desktop/tests/builtin-service-client.test.ts desktop/tests/commercial-image-extension-bootstrap.test.ts desktop/tests/commercial-image-chat-router.test.ts
Initial run: 4 files passed, 3 failed to load because @uclaw/shared was not built.

npm run build -w @uclaw/shared --prefix product
pass

npm run build -w @uclaw/adapter --prefix product
pass

npx vitest run desktop/tests/openclaw-provider-config.test.ts desktop/tests/builtin-service-client.test.ts desktop/tests/commercial-image-chat-router.test.ts
3 files, 66 tests passed
```

## Local Evidence Summary

- Activation credential schema requires `schemaVersion: 2`, `endpoint`, `deviceTokenId`, `model`, and `deviceToken`.
- Default commercial text model path prefers `gpt-5.5`.
- Commercial Provider config writes `uclaw-commercial/<defaultModel>`.
- Commercial secret source is file SecretRef `provider=uclaw_commercial`, `id=/deviceToken`.
- Renderer config redacts secret-like keys and rejects raw secret edits.
- Default production chat route uses `client.chat.send(input, signal)`.
- Production default chat route does not use `local-actions`, direct commercial image router, or OpenClaw image CLI direct injection.
- Model proxy has routes for `/model-api/v1/models`, `/chat/completions`, `/images/generations`, and `/images/edits`.
- Model proxy maps safe error classes: auth, model not allowed, rate limited, balance insufficient, model not found, upstream auth/permission/network/timeout.
- Secret scan passed.

## PASS / FAIL / Blocked Matrix

| Gate | Status | Evidence |
|---|---|---|
| Win final runtime artifact identity | PASS by prior Win gate | `00-runtime-artifact.txt` |
| Activation / License real binding | blocked | needs real activation/license/device/USB |
| credential v2 schema | PASS local contract | `BuiltinCredentialArtifactSchema`, OpenAPI contract, store tests |
| Dynamic `/model-api/v1/models` | PASS local contract, blocked real service | Go transport/modelproxy tests |
| Default `gpt-5.5` | PASS local contract | provider/credential tests |
| `allowed_models` policy | PASS local contract, blocked real service | Go tests plus `09-allowed-models-negative-redacted.txt` |
| Text `chat.send` real multi-frame SSE | blocked | needs real Windows runtime + commercial token/quota |
| Multi-turn context | blocked | needs real OpenClaw session/runtime |
| Background session completion/history recovery | blocked | needs real Windows runtime |
| Tool Calling real event/result | blocked | needs real OpenClaw tool-capable runtime + model |
| Image generation through OpenClaw chain | blocked | needs real image quota/runtime |
| Image edit through OpenClaw chain | blocked | protocol implemented locally; true result needs real service/runtime |
| BYOK isolation | PASS local contract, blocked real config readback | tests plus `08-byok-isolation-redacted.txt` |
| Error classification safe simulated items | PASS local contract | Go transport/modelproxy tests |
| Logging/secret redaction | PASS local scan | `npm run test:secrets --prefix product` |

## Windows Execution Text

Copy this section into the Windows gate note. Do not paste raw secrets back into shared logs.

```powershell
$ErrorActionPreference = "Stop"
$EvidenceRoot = "C:\uclaw-commercial-chain-blackbox-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null

# 1. Use artifact 9443717301 only.
# Confirm zip digest:
# sha256:146681cd27f21f959f599ad8235581c1cd35842fa90dbb86d606957906736f5f

# 2. Launch U-Claw from final Windows runtime on physical USB.
# Do not rebuild final-windows-runtime locally.

# 3. Activate with authorized commercial activation code.
# Save redacted .uclaw\builtin-model-credential.v1.json summary as:
# $EvidenceRoot\01-activation-redacted.json

# 4. Read model list with deviceToken, then redact Authorization/deviceToken/deviceTokenId:
# GET https://<activation-host>/model-api/v1/models
# Save as $EvidenceRoot\02-models-list-redacted.json

# 5. Send text chat from UI.
# Required: OpenClaw chat.send observed, multiple SSE data frames, no direct renderer/Electron model endpoint.
# Save redacted stream as $EvidenceRoot\03-chat-send-sse-redacted.log

# 6. Multi-turn:
# Turn 1: 记住门禁暗号是 UCLAW-E2E-20260821。
# Turn 2: 刚才的门禁暗号是什么？
# Save redacted live/history comparison as $EvidenceRoot\04-multiturn-history-redacted.json

# 7. Background session:
# Start slow/tool run in session A. Switch to session B. Confirm no chat.abort.
# Switch back after completion. Save history evidence.

# 8. Tool calling:
# Trigger one safe OpenClaw tool. Save tool start/result/final/history evidence.

# 9. Image generation:
# Prompt: 生成一张 1024x1024 PNG，内容为 U-Claw 商业链 E2E 绿色通过牌。
# Required: chat.send -> image_generate -> /model-api/v1/images/generations -> managed media.

# 10. Image edit:
# Prompt after image exists: 把上一张图片里的绿色通过牌改成蓝色待复核牌。
# Required: chat.send -> image_generate edit -> /model-api/v1/images/edits -> edited managed media.

# 11. BYOK isolation:
# Confirm BYOK key never appears in uclaw-commercial provider.
# Confirm commercial deviceToken never appears in BYOK provider.

# 12. Negative checks:
# Missing/malformed Authorization, disallowed model, disabled model, invalid image edit multipart.
# Save redacted results as $EvidenceRoot\09-allowed-models-negative-redacted.txt

# 13. Secret scan evidence:
# Search evidence and app logs for raw secret patterns before sharing.
Select-String -Path "$EvidenceRoot\*" -Recurse -Pattern "sk-|Authorization: Bearer [A-Za-z0-9._~+/=-]{8,}|uclaw_dt_[A-Za-z0-9_-]{43}|password=" -ErrorAction SilentlyContinue
# Expected: no matches in shareable evidence.
```

## Blocked Inputs

- Real Windows final runtime extracted from artifact `9443717301`.
- Physical USB with final gate-compatible layout.
- Commercial activation code/license authorized for this device.
- Real deviceToken/deviceTokenId generated by activation.
- Commercial model quota for text, tool-calling model, image generation, and image edit.
- Access to Windows app/Gateway/OpenClaw logs for redacted event capture.
- Server-side audit/usage readback permission if billing evidence is required.

## Need Main Window

- Provide or authorize Windows/operator execution with real credentials/quota.
- Decide whether image edit server/protocol failure, if observed, blocks release or becomes explicit known FAIL.
- Preserve runtime artifact freeze unless commercial E2E finds a defect outside the frozen runtime packaging line.
