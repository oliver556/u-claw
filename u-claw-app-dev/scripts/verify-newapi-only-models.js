#!/usr/bin/env node

/**
 * Verifies Bavi-box model defaults come only from the synced New API provider.
 */
const assert = require('assert/strict');
const fs = require('fs');
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

assert.equal(defaultConfig.models?.providers?.xai, undefined, 'default config must not include xai provider');
assert.equal(defaultConfig.agents?.defaults?.videoGenerationModel, undefined, 'default config must not include local video default');

for (const [label, source] of [
  ['Config.html', configHtml],
  ['portable/Config.html', portableConfigHtml],
  ['sync-openclaw-config.js', syncConfigSource],
  ['package-portable.js', packagePortableSource],
]) {
  assert.equal(source.includes('xai/jimeng-video-3-720p'), false, `${label} must not write xai jimeng default`);
  assert.equal(source.includes('providers.xai ='), false, `${label} must not write xai provider`);
}

assert.equal(mainSource.includes('await startVideoAdapter(adapterPort)'), false, 'main startup must not auto-start local video adapter');
assert.equal(mainSource.includes('ensureVideoAdapterConfig(configuredVideoAdapterBaseUrl'), false, 'main startup must not auto-configure xai video adapter');
assert.equal(mainSource.includes('ensureRuntimeVideoAdapterConfig(`http://127.0.0.1:${adapterPort}/xai/v1`)'), false, 'main startup must not expose xai adapter to gateway');

const result = mergeModelCatalogIntoConfig({
  agents: {
    defaults: {
      model: { primary: 'custom/gpt-5.5' },
      imageGenerationModel: { primary: 'litellm/gpt-image-2' },
      imageModel: { primary: 'litellm/gpt-image-2' },
      videoGenerationModel: { primary: 'xai/jimeng-video-3-720p', timeoutMs: 600000 },
    },
  },
  models: {
    providers: {
      custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing' },
      litellm: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing' },
      xai: {
        baseUrl: 'http://127.0.0.1:18808/xai/v1',
        apiKey: 'uclaw-video-adapter',
        models: [{ id: 'jimeng-video-3-720p' }],
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

assert.equal(result.config.models.providers.xai, undefined, 'catalog merge must remove legacy xai video adapter');
assert.equal(result.config.agents.defaults.model.primary, 'newapi/gpt-5.5');
assert.equal(result.config.agents.defaults.imageGenerationModel.primary, 'newapi/gpt-image-2');
assert.equal(result.config.agents.defaults.imageModel.primary, 'newapi/gpt-image-2');
assert.equal(result.config.agents.defaults.videoGenerationModel.primary, 'newapi/seedance-1.5-pro-1080p-10s');

console.log('newapi-only model verifier passed');
