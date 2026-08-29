#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { generateKeyPair } = require('./lib/release-signing');
const { parseEnvFile, setEnvValues } = require('./lib/local-env');

const appDir = path.resolve(__dirname, '..');
const defaultEnvPath = path.join(appDir, '.env');
const defaultKeyDir = path.join(appDir, 'release', '.release-signing');
const defaultKeyPath = path.join(defaultKeyDir, 'release-signing-key.json');
const defaultPublicKeysPath = path.join(appDir, 'release', 'bootstrap', 'release-public-keys.json');
const defaultKeyId = 'uclaw-release-2026-08-28';

function usage() {
  console.log(`Usage:
  node scripts/hard-update-release-key.js create --env .env
  node scripts/hard-update-release-key.js public --env .env --out release/bootstrap/release-public-keys.json

Options:
  --env <file>       Local env file. Defaults to .env.
  --key-file <file>  Private key file. Defaults to release/.release-signing/release-signing-key.json.
  --key-id <id>      Release key id. Defaults to ${defaultKeyId}.
  --out <file>       Public keys output for public mode.
`);
}

function parseArgs(argv) {
  const command = argv.shift();
  const options = {
    command,
    env: defaultEnvPath,
    keyFile: null,
    keyId: defaultKeyId,
    out: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--env') options.env = readValue();
    else if (arg === '--key-file') options.keyFile = readValue();
    else if (arg === '--key-id') options.keyId = readValue();
    else if (arg === '--out') options.out = readValue();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readKey(keyPath) {
  return JSON.parse(fs.readFileSync(keyPath, 'utf8'));
}

function writePrivateKey(keyPath, key) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, JSON.stringify(key, null, 2) + '\n', { mode: 0o600 });
}

function publicKeysFromKey(key) {
  return {
    keys: [{
      keyId: key.keyId,
      alg: 'Ed25519',
      publicKey: key.publicKey,
      status: 'active'
    }]
  };
}

function create(options) {
  const keyPath = path.resolve(options.keyFile || defaultKeyPath);
  if (fs.existsSync(keyPath)) throw new Error(`Private key already exists: ${keyPath}`);
  const key = { keyId: options.keyId, alg: 'Ed25519', ...generateKeyPair() };
  writePrivateKey(keyPath, key);
  setEnvValues(path.resolve(options.env), {
    UCLAW_RELEASE_KEY_ID: key.keyId,
    UCLAW_RELEASE_PRIVATE_KEY_PATH: keyPath,
    UCLAW_RELEASE_PUBLIC_KEYS_PATH: path.resolve(options.out || defaultPublicKeysPath)
  });
  console.log(`[hard-update-release-key] created private key ${keyPath}`);
  console.log(`[hard-update-release-key] key id ${key.keyId}`);
  console.log('[hard-update-release-key] private key value not printed');
}

function publicCommand(options) {
  const env = parseEnvFile(path.resolve(options.env));
  const keyPath = path.resolve(options.keyFile || env.UCLAW_RELEASE_PRIVATE_KEY_PATH || defaultKeyPath);
  const outPath = path.resolve(options.out || env.UCLAW_RELEASE_PUBLIC_KEYS_PATH || defaultPublicKeysPath);
  const key = readKey(keyPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(publicKeysFromKey(key), null, 2) + '\n');
  console.log(`[hard-update-release-key] wrote public keys ${outPath}`);
  console.log(`[hard-update-release-key] key id ${key.keyId}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    usage();
    return;
  }
  if (options.command === 'create') create(options);
  else if (options.command === 'public') publicCommand(options);
  else throw new Error(`Unknown command: ${options.command}`);
}

try {
  main();
} catch (error) {
  console.error(`[hard-update-release-key] ${error.message}`);
  process.exit(1);
}
