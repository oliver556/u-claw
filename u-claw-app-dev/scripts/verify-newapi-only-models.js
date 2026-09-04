#!/usr/bin/env node

/**
 * Verifies Bavi-box keeps OpenClaw provider routes while syncing New API model names.
 */
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  mergeModelCatalogIntoConfig,
} = require('../src/model-catalog');

const root = path.resolve(__dirname, '..');
const defaultConfigPath = path.join(root, 'resources', 'default-openclaw.json');
const configHtmlPath = path.join(root, 'resources', 'Config.html');
const portableConfigHtmlPath = path.join(root, '..', 'portable', 'Config.html');
const mainPath = path.join(root, 'src', 'main.js');
const syncConfigPath = path.join(root, 'scripts', 'sync-openclaw-config.js');
const packagePortablePath = path.join(root, 'scripts', 'package-portable.js');

const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
const configHtml = fs.readFileSync(configHtmlPath, 'utf8');
const portableConfigHtml = fs.readFileSync(portableConfigHtmlPath, 'utf8');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const syncConfigSource = fs.readFileSync(syncConfigPath, 'utf8');
const packagePortableSource = fs.readFileSync(packagePortablePath, 'utf8');

function verifyDevSyncUsesOneNewApiCredential() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclaw-newapi-sync-'));
  const dest = path.join(tmpDir, 'openclaw.json');
  try {
    const run = spawnSync(process.execPath, [
      syncConfigPath,
      '--dest',
      dest,
    ], {
      cwd: root,
      env: {
        ...process.env,
        UCLAW_NEW_API_BASE_URL: 'https://api.example.com/v1/',
        UCLAW_NEW_API_KEY: 'sk-dev-test',
        UCLAW_VIDEO_ADAPTER_BASE_URL: '',
        UCLAW_VIDEO_ADAPTER_API_KEY: '',
      },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const generated = JSON.parse(fs.readFileSync(dest, 'utf8'));
    const providers = generated.models?.providers || {};
    assert.equal(providers.custom.baseUrl, 'https://api.example.com/v1');
    assert.equal(providers.litellm.baseUrl, 'https://api.example.com/v1');
    assert.equal(providers.xai.baseUrl, 'https://api.example.com/v1');
    assert.equal(providers.custom.apiKey, 'sk-dev-test');
    assert.equal(providers.litellm.apiKey, 'sk-dev-test');
    assert.equal(providers.xai.apiKey, 'sk-dev-test');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

assert.equal(defaultConfig.agents?.defaults?.model?.primary, 'custom/gpt-5.5');
assert.equal(defaultConfig.agents?.defaults?.imageGenerationModel?.primary, 'litellm/gpt-image-2');
assert.equal(defaultConfig.agents?.defaults?.imageModel?.primary, 'litellm/gpt-image-2');
assert.equal(defaultConfig.agents?.defaults?.videoGenerationModel?.primary, 'xai/seedance-1.5-pro-1080p-5s');

for (const [label, source] of [
  ['Config.html', configHtml],
  ['portable/Config.html', portableConfigHtml],
  ['sync-openclaw-config.js', syncConfigSource],
  ['package-portable.js', packagePortableSource],
]) {
  assert.equal(source.includes('newapi/gpt-image-2'), false, `${label} must not route image generation through newapi`);
  assert.equal(source.includes('newapi/seedance-1.5-pro-1080p-5s'), false, `${label} must not route video generation through newapi`);
}

assert.equal(mainSource.includes('delete config.models.providers.newapi'), true, 'activation config must not keep newapi as send route');
assert.equal(mainSource.includes('delete providers.newapi'), true, 'runtime config must not keep newapi as send route');
assert.equal(mainSource.includes('env.XAI_API_KEY = env.UCLAW_NEW_API_KEY'), true, 'gateway env must expose the New API key to OpenClaw xai video_generate');

const result = mergeModelCatalogIntoConfig({
  agents: {
    defaults: {
      model: { primary: 'custom/gpt-5.5' },
      imageGenerationModel: { primary: 'litellm/gpt-image-2' },
      imageModel: { primary: 'litellm/gpt-image-2' },
      videoGenerationModel: { primary: 'xai/seedance-1.5-pro-1080p-5s', timeoutMs: 600000 },
    },
  },
  models: {
    providers: {
      custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing' },
      litellm: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing' },
      xai: {
        baseUrl: 'http://127.0.0.1:18808/xai/v1',
        apiKey: 'uclaw-video-adapter',
        models: [{ id: 'seedance-1.5-pro-1080p-5s' }],
      },
    },
  },
}, {
  provider: { id: 'newapi', baseUrl: 'https://api.example.com/v1/', api: 'openai-completions' },
  models: [
    { id: 'gpt-5.5', capabilities: ['text'] },
    { id: 'gpt-image-2', capabilities: ['image'] },
    { id: 'seedance-1.5-pro-1080p-10s', capabilities: ['video'] },
  ],
});

assert.equal(result.config.models.providers.newapi, undefined, 'catalog merge must not keep newapi as send route');
assert.equal(result.config.models.providers.custom.models[0].id, 'gpt-5.5');
assert.equal(result.config.models.providers.litellm.models[0].id, 'gpt-image-2');
assert.equal(result.config.models.providers.xai.models[0].id, 'seedance-1.5-pro-1080p-10s');
assert.equal(result.config.agents.defaults.model.primary, 'custom/gpt-5.5');
assert.equal(result.config.agents.defaults.imageGenerationModel.primary, 'litellm/gpt-image-2');
assert.equal(result.config.agents.defaults.imageModel.primary, 'litellm/gpt-image-2');
assert.equal(result.config.agents.defaults.videoGenerationModel.primary, 'xai/seedance-1.5-pro-1080p-10s');

verifyDevSyncUsesOneNewApiCredential();

console.log('routed model provider verifier passed');
