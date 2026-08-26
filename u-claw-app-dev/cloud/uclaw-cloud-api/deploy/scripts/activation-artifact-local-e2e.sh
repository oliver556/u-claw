#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ADDR="${UCLAW_ACCEPTANCE_ADDR:-127.0.0.1:18081}"
BASE_URL="http://${ADDR}"
USERNAME="${UCLAW_ACCEPTANCE_USERNAME:-UCLAW-BIANCHENG}"
ACTIVATION_CODE="${UCLAW_ACCEPTANCE_CODE:-ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ}"
USB_SUMMARY="${UCLAW_ACCEPTANCE_USB_SUMMARY:-PREVIEW-ONLY}"
IDEMPOTENCY_KEY="${UCLAW_ACCEPTANCE_IDEMPOTENCY_KEY:-acceptance-local-$(date +%s)}"
OUT_DIR="${UCLAW_ACCEPTANCE_OUT_DIR:-dist/activation-acceptance}"

mkdir -p "$OUT_DIR"

TMP_LOG="$(mktemp)"
UCLAW_HTTP_ADDR="$ADDR" go run ./cmd/api serve >"$TMP_LOG" 2>&1 &
SERVER_PID="$!"
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" >/dev/null 2>&1 || true; rm -f "$TMP_LOG"' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "activation API exited before health check" >&2
    cat "$TMP_LOG" >&2
    exit 1
  fi
  sleep 0.2
done

curl -fsS "${BASE_URL}/healthz" >/dev/null
curl -fsS "${BASE_URL}/readyz" >/dev/null

activation_json="$(
  curl -fsS -X POST "${BASE_URL}/v1/activations" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${USERNAME}\",\"activationCode\":\"${ACTIVATION_CODE}\",\"usbFingerprintSummary\":\"${USB_SUMMARY}\",\"idempotencyKey\":\"${IDEMPOTENCY_KEY}\"}"
)"

activation_id="$(
  ACTIVATION_JSON="$activation_json" OUT_DIR="$OUT_DIR" node - <<'NODE'
const fs = require('node:fs');
const outDir = process.env.OUT_DIR;
const payload = JSON.parse(process.env.ACTIVATION_JSON);
const artifact = payload.licenseArtifact;
const failures = [];
if (!payload.ok) failures.push('ok must be true');
if (payload.status !== 'server_bound') failures.push('status must be server_bound');
if (payload.artifactStatus !== 'pending_client_write') failures.push('artifactStatus must be pending_client_write');
if (!payload.activationId) failures.push('activationId must be present');
if (!artifact?.payload) failures.push('licenseArtifact.payload must be present');
if (!artifact?.signature) failures.push('licenseArtifact.signature must be present');
if (artifact?.payload?.schemaVersion !== 'uclaw.license.v1') failures.push('schemaVersion must be uclaw.license.v1');
if (artifact?.payload?.activationId !== payload.activationId) failures.push('license activationId must match response activationId');
if (artifact?.signature?.algorithm !== 'Ed25519') failures.push('signature algorithm must be Ed25519');
if (!artifact?.signature?.value) failures.push('signature value must be present');
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
fs.writeFileSync(`${outDir}/activation-response.json`, JSON.stringify(payload, null, 2));
fs.writeFileSync(`${outDir}/license-artifact.json`, JSON.stringify(artifact, null, 2));
process.stdout.write(payload.activationId);
NODE
)"

commit_json="$(
  curl -fsS -X POST "${BASE_URL}/v1/activations/${activation_id}/commit" \
    -H 'Content-Type: application/json' \
    -d '{"writeStatus":"verified"}'
)"

COMMIT_JSON="$commit_json" OUT_DIR="$OUT_DIR" BASE_URL="$BASE_URL" node - <<'NODE'
const fs = require('node:fs');
const outDir = process.env.OUT_DIR;
const baseUrl = process.env.BASE_URL;
const payload = JSON.parse(process.env.COMMIT_JSON);
if (!payload.ok || payload.status !== 'committed' || !payload.activationId) {
  console.error(`unexpected commit payload: ${JSON.stringify(payload)}`);
  process.exit(1);
}
const activation = JSON.parse(fs.readFileSync(`${outDir}/activation-response.json`, 'utf8'));
const summary = {
  ok: true,
  baseUrl,
  activationId: payload.activationId,
  activationStatus: activation.status,
  artifactStatus: activation.artifactStatus,
  commitStatus: payload.status,
  licenseSchema: activation.licenseArtifact.payload.schemaVersion,
  licenseSubject: activation.licenseArtifact.payload.subject,
  signatureAlgorithm: activation.licenseArtifact.signature.algorithm,
  signaturePresent: Boolean(activation.licenseArtifact.signature.value),
  files: {
    activationResponse: `${outDir}/activation-response.json`,
    licenseArtifact: `${outDir}/license-artifact.json`,
    summary: `${outDir}/latest-summary.json`
  }
};
fs.writeFileSync(`${outDir}/latest-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
NODE
