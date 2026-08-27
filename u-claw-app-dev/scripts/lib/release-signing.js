const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url');
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

function unsignedPayload(payload) {
  const clone = { ...payload };
  delete clone.signature;
  return Buffer.from(canonicalize(clone), 'utf8');
}

function generateKeyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: base64url(pair.privateKey.export({ type: 'pkcs8', format: 'der' })),
    publicKey: base64url(pair.publicKey.export({ type: 'spki', format: 'der' }))
  };
}

function importPrivateKey(privateKey) {
  return crypto.createPrivateKey({ key: fromBase64url(privateKey), type: 'pkcs8', format: 'der' });
}

function importPublicKey(publicKey) {
  return crypto.createPublicKey({ key: fromBase64url(publicKey), type: 'spki', format: 'der' });
}

function signPayload(payload, key) {
  const signature = crypto.sign(null, unsignedPayload(payload), importPrivateKey(key.privateKey));
  return {
    ...payload,
    signature: {
      alg: 'Ed25519',
      keyId: key.keyId,
      value: base64url(signature)
    }
  };
}

function verifyPayload(payload, publicKeys) {
  const signature = payload?.signature;
  if (!signature || signature.alg !== 'Ed25519' || !signature.keyId || !signature.value) {
    throw new Error('Missing Ed25519 signature');
  }
  const key = publicKeys.find(item => item.keyId === signature.keyId && item.alg === 'Ed25519' && item.status !== 'revoked');
  if (!key) throw new Error(`Unknown release key: ${signature.keyId}`);
  const ok = crypto.verify(null, unsignedPayload(payload), importPublicKey(key.publicKey), fromBase64url(signature.value));
  if (!ok) throw new Error(`Invalid signature for ${signature.keyId}`);
  return true;
}

function loadOrCreateMockKey(keyPath, keyId = 'uclaw-release-mock-2026-08-27') {
  if (fs.existsSync(keyPath)) {
    return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = { keyId, alg: 'Ed25519', ...generateKeyPair() };
  fs.writeFileSync(keyPath, JSON.stringify(key, null, 2) + '\n', { mode: 0o600 });
  return key;
}

module.exports = {
  base64url,
  canonicalize,
  generateKeyPair,
  loadOrCreateMockKey,
  signPayload,
  unsignedPayload,
  verifyPayload
};
