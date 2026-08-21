export const releaseAuthorizationArtifactNames = [
  "inventory.json",
  "runtime-manifest.json",
  "runtime-tree.sha256",
  "runtime.pkg",
  "sbom.spdx.json",
];

export function pointerSwitchAuthorizationSigningPayload(proof) {
  const names = [...releaseAuthorizationArtifactNames].sort();
  return Buffer.from(JSON.stringify([
    "uclaw-pointer-switch-authorization-v1", proof.schemaVersion, proof.allowed, proof.gate,
    proof.releaseId, proof.requiredReleaseSequence, proof.commitSha, proof.manifestUrl, proof.manifestSha256, proof.runtimeSha256,
    names.map((name) => [name, proof.artifacts[name].bytes, proof.artifacts[name].sha256]),
    names.map((name) => [name, proof.cdnReadback[name].bytes, proof.cdnReadback[name].sha256, proof.cdnReadback[name].url]),
    proof.evidence.buildCompletedAt, proof.evidence.finalRuntimeSmokeCompletedAt, proof.evidence.promotionsCompletedAt,
    proof.evidence.uploadCompletedAt, proof.evidence.cdnReadbackCompletedAt,
    proof.issuedAt, proof.expiresAt, proof.signature.algorithm, proof.signature.keyId,
  ]));
}
