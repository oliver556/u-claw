#!/usr/bin/env node

const assert = require('assert/strict');
const {
  findReusableApiKey,
  mergeModelCatalogIntoConfig,
  normalizeCatalogModel,
} = require('../src/model-catalog');

/**
 * Verifies one normalized model keeps OpenClaw-compatible metadata.
 */
function verifyNormalizeCatalogModel() {
  const textModel = normalizeCatalogModel({ id: 'gpt-5.5', capabilities: ['text'] });
  assert.deepEqual(textModel.input, ['text']);
  assert.deepEqual(textModel.capabilities, ['text']);
  assert.equal(textModel.contextWindow, 128000);

  const imageModel = normalizeCatalogModel({ id: 'gpt-image-2', capabilities: ['image'] });
  assert.deepEqual(imageModel.input, ['text', 'image']);
  assert.deepEqual(imageModel.capabilities, ['image']);

  const videoModel = normalizeCatalogModel({ id: 'seedance-1.5-pro-1080p-10s', capabilities: ['text'] });
  assert.deepEqual(videoModel.input, ['text', 'image']);
  assert.deepEqual(videoModel.capabilities, ['video']);
}

/**
 * Verifies provider API keys are reused instead of copied from cloud payloads.
 */
function verifyReusableApiKey() {
  const config = {
    models: {
      providers: {
        custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing' },
      },
    },
  };
  assert.equal(findReusableApiKey(config, 'newapi', 'https://api.example.com/v1/'), 'sk-existing');
}

/**
 * Verifies cloud catalog model names sync into routed OpenClaw providers.
 */
function verifyMergeModelCatalogIntoConfig() {
  const config = {
    models: {
      providers: {
        custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing', models: [{ id: 'local' }] },
        litellm: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing', models: [] },
        xai: { baseUrl: 'http://127.0.0.1:18808/xai/v1', apiKey: 'adapter' },
      },
    },
  };
  const catalog = {
    provider: { id: 'newapi', baseUrl: 'https://api.example.com/v1/', api: 'openai-completions' },
    models: [
      { id: 'gpt-image-2', capabilities: ['image'] },
      { id: 'gpt-5.5', capabilities: ['text'] },
    ],
  };
  const result = mergeModelCatalogIntoConfig(config, catalog);

  assert.equal(result.changed, true);
  assert.equal(result.count, 2);
  assert.equal(result.config.models.providers.newapi, undefined);
  assert.equal(result.config.models.providers.custom.baseUrl, 'https://api.example.com/v1');
  assert.equal(result.config.models.providers.custom.apiKey, 'sk-existing');
  assert.equal(result.config.models.providers.custom.models[0].id, 'gpt-5.5');
  assert.equal(result.config.models.providers.litellm.models[0].id, 'gpt-image-2');
  assert.equal(Object.hasOwn(result.config.models.providers.litellm.models[0], 'capabilities'), false);
  assert.equal(result.config.models.providers.xai.apiKey, 'sk-existing');
}

/**
 * Verifies synced catalog models keep OpenClaw's routed providers.
 */
function verifyMergeRebasesCloudManagedDefaults() {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'custom/gpt-5.5' },
        imageGenerationModel: { primary: 'litellm/gpt-image-2', timeoutMs: 180000 },
        imageModel: { primary: 'litellm/gpt-image-2', timeoutMs: 180000 },
        videoGenerationModel: { primary: 'xai/jimeng-video-3-720p', timeoutMs: 600000 },
      },
    },
    models: {
      providers: {
        custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing' },
        litellm: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing' },
        xai: { baseUrl: 'http://127.0.0.1:18808/xai/v1', apiKey: 'adapter' },
      },
    },
  };
  const catalog = {
    provider: { id: 'newapi', baseUrl: 'https://api.example.com/v1/', api: 'openai-completions' },
    models: [
      { id: 'gpt-5.5', capabilities: ['text'] },
      { id: 'gpt-image-2', capabilities: ['image'] },
      { id: 'jimeng-video-3-720p', capabilities: ['video'] },
    ],
  };

  const result = mergeModelCatalogIntoConfig(config, catalog);

  assert.equal(result.config.agents.defaults.model.primary, 'custom/gpt-5.5');
  assert.equal(result.config.agents.defaults.imageGenerationModel.primary, 'litellm/gpt-image-2');
  assert.equal(result.config.agents.defaults.imageModel.primary, 'litellm/gpt-image-2');
  assert.equal(result.config.agents.defaults.videoGenerationModel.primary, 'xai/jimeng-video-3-720p');
}

/**
 * Verifies an empty cloud catalog keeps the last local routed model lists.
 */
function verifyMergeKeepsLocalCatalogWhenCloudEmpty() {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'custom/gpt-5.5' },
      },
    },
    models: {
      providers: {
        custom: {
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-existing',
          models: [
            { id: 'gpt-5.5', input: ['text'] },
          ],
        },
        xai: {
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-existing',
          models: [
            { id: 'seedance-1.5-pro-1080p-10s', input: ['text'] },
          ],
        },
      },
    },
  };
  const catalog = {
    provider: { id: 'newapi', baseUrl: 'https://api.example.com/v1/', api: 'openai-completions' },
    models: [],
  };

  const result = mergeModelCatalogIntoConfig(config, catalog);

  assert.equal(result.count, 0);
  assert.equal(result.availableCount, 2);
  assert.equal(result.usedLocalCatalog, true);
  assert.equal(result.config.models.providers.custom.models.length, 1);
  assert.equal(result.config.models.providers.xai.models.length, 1);
  assert.deepEqual(result.config.models.providers.xai.models[0].input, ['text', 'image']);
}

verifyNormalizeCatalogModel();
verifyReusableApiKey();
verifyMergeModelCatalogIntoConfig();
verifyMergeRebasesCloudManagedDefaults();
verifyMergeKeepsLocalCatalogWhenCloudEmpty();
console.log('newapi model catalog verifier passed');
