# U-Claw prod hard update closure

- Date: 2026-08-29 CST
- Scope: prod R2 release, prod update check, HTTP client verification
- Release: v1.0.1
- Control plane: https://updates.yiyong.me/uclaw/update/check
- R2 bucket: u-claw-updates-prod
- R2 public base: https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases

## Publish

Published objects:

- releases/bootstrap/release-public-keys.json
- releases/packages/v1.0.1/darwin-arm64/runtime.pkg
- releases/packages/v1.0.1/darwin-arm64/runtime.pkg.sha256
- releases/packages/v1.0.1/darwin-arm64/sbom.json
- releases/packages/v1.0.1/darwin-arm64/manifest.json
- releases/packages/v1.0.1/darwin-x64/runtime.pkg
- releases/packages/v1.0.1/darwin-x64/runtime.pkg.sha256
- releases/packages/v1.0.1/darwin-x64/sbom.json
- releases/packages/v1.0.1/darwin-x64/manifest.json
- releases/packages/v1.0.1/win32-x64/runtime.pkg
- releases/packages/v1.0.1/win32-x64/runtime.pkg.sha256
- releases/packages/v1.0.1/win32-x64/sbom.json
- releases/packages/v1.0.1/win32-x64/manifest.json
- releases/production.json

`production.json` was published last after immutable release objects and control-plane deployment.

## Public Object Check

All public R2 URLs returned HTTP 200:

- production.json: size 1107
- release-public-keys.json: size 206
- darwin-arm64 manifest.json: size 1154
- darwin-arm64 runtime.pkg: size 221152850
- darwin-arm64 runtime.pkg.sha256: size 65
- darwin-arm64 sbom.json: size 1708
- darwin-x64 manifest.json: size 1150
- darwin-x64 runtime.pkg: size 226887577
- darwin-x64 runtime.pkg.sha256: size 65
- darwin-x64 sbom.json: size 1702
- win32-x64 manifest.json: size 1148
- win32-x64 runtime.pkg: size 235493783
- win32-x64 runtime.pkg.sha256: size 65
- win32-x64 sbom.json: size 1509

## Release Digest

- productionSha256: 1336e8ea9bb1da852e8073eb2319f62d38193cb24dbe609302fc6bc8a3bb9296
- requiredVersion: 1.0.1
- releaseId: v1.0.1

Platform package digests:

- darwin-arm64
  - packageSha256: 3cac033fc170c8af12edc323b42766aa2b96e512e34fcfe65bdc819994f85dc5
  - packageSize: 221152850
  - treeDigest: 6c51c05b97d47479838c0c326e1f3cc68dbc6c75e6c0d8e4764e6b494e2b9914
- darwin-x64
  - packageSha256: acfef0c509556632173a95269b0a95936c045b68996399044fdd825882de4f8f
  - packageSize: 226887577
  - treeDigest: 42805fa45e1381a7c03f09fdb99289c282e5ec2b9ab781217428ed9f608ba45c
- win32-x64
  - packageSha256: eb62a30dfc4de35608dc8b1b8e154557c2e290d72039cae9d405d47d8e3dddc6
  - packageSize: 235493783
  - treeDigest: 830168894557b598a6d2f62fd5a29ff9d815d8b31c7f8df7e55ece7e7437f67a

## Prod Update Check

Public request to `https://updates.yiyong.me/uclaw/update/check` with `Authorization: Bearer <device_token>` and matching `body.deviceId` returned:

- HTTP: 200
- allowed: true
- requiredVersion: 1.0.1
- releaseId: v1.0.1
- forceUpdate: true
- productionUrl: https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases/production.json
- manifestUrl: https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases/packages/v1.0.1/darwin-arm64/manifest.json
- packageUrl: https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases/packages/v1.0.1/darwin-arm64/runtime.pkg
- shortConfig.tokenExpiresAt: null
- shortConfig.aliyunControlPlane: true
- shortConfig.r2StaticDownloads: true
- shortConfig.rollout: all
- shortConfig.containsSecret: false

The device identifier is not recorded here. The device token is not recorded here.

## Client HTTP Verification

Command path used for each platform:

```bash
node scripts/hard-update-client.js mock-update \
  --usb <temporary U-Claw root> \
  --update-check-url https://updates.yiyong.me/uclaw/update/check \
  --device <matching device_id> \
  --platform darwin-arm64
```

Result:

- productionUrl: https://pub-4f24fbbe718b4c75955440700c70bdeb.r2.dev/releases/production.json
- darwin-arm64
  - updateRequired: true
  - updated: true
  - transactionState: complete
  - targetVersion: 1.0.1
  - releaseId: v1.0.1
  - productionSha256: 1336e8ea9bb1da852e8073eb2319f62d38193cb24dbe609302fc6bc8a3bb9296
  - manifestSha256: cac7f8c7e39bf5c1050a193bac2d72e0051a229ecd38b10be2fc4deb8bde6aa5
  - packageSha256: 3cac033fc170c8af12edc323b42766aa2b96e512e34fcfe65bdc819994f85dc5
  - packageSize: 221152850
  - treeDigest: 6c51c05b97d47479838c0c326e1f3cc68dbc6c75e6c0d8e4764e6b494e2b9914
  - openclawJsonPreserved: true
- darwin-x64
  - updated: true
  - transactionState: complete
  - targetVersion: 1.0.1
  - releaseId: v1.0.1
  - packageSha256: acfef0c509556632173a95269b0a95936c045b68996399044fdd825882de4f8f
  - packageSize: 226887577
  - treeDigest: 42805fa45e1381a7c03f09fdb99289c282e5ec2b9ab781217428ed9f608ba45c
  - openclawJsonPreserved: true
- win32-x64
  - updated: true
  - transactionState: complete
  - targetVersion: 1.0.1
  - releaseId: v1.0.1
  - packageSha256: eb62a30dfc4de35608dc8b1b8e154557c2e290d72039cae9d405d47d8e3dddc6
  - packageSize: 235493783
  - treeDigest: 830168894557b598a6d2f62fd5a29ff9d815d8b31c7f8df7e55ece7e7437f67a
  - openclawJsonPreserved: true

This covers HTTP download, Ed25519 signature verification, manifestSha256, runtime.pkg sha256, runtime.pkg size, treeDigest, path safety, and data preservation for all release platforms.

## Secret Handling

- No R2 secret, Cloudflare token, device token, New API key, or server password was written to code, manifest, package, docs, or logs by this acceptance record.
- Release scan result: suspicious release paths = 0.
- Client package and update manifest contain prod R2 public URLs only.

## Remaining Manual Confirmation

- Confirm production rollout window and customer-facing announcement timing.
- Confirm whether prod control plane should keep using direct Postgres auth with local `psql`, or migrate to the non-superuser read-only DB credential path before wider rollout.
