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
  assert.equal(Object.hasOwn(textModel, 'capabilities'), false);
  assert.equal(textModel.contextWindow, 128000);

  const imageModel = normalizeCatalogModel({ id: 'gpt-image-2', capabilities: ['image'] });
  assert.deepEqual(imageModel.input, ['text', 'image']);
  assert.equal(Object.hasOwn(imageModel, 'capabilities'), false);
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
 * Verifies cloud catalog merge is scoped to models.providers.newapi.
 */
function verifyMergeModelCatalogIntoConfig() {
  const config = {
    models: {
      providers: {
        custom: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-existing', models: [{ id: 'local' }] },
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
  assert.equal(result.config.models.providers.custom.models[0].id, 'local');
  assert.equal(result.config.models.providers.xai.apiKey, 'adapter');
  assert.equal(result.config.models.providers.newapi.baseUrl, 'https://api.example.com/v1');
  assert.equal(result.config.models.providers.newapi.apiKey, 'sk-existing');
  assert.equal(result.config.models.providers.newapi.models[0].id, 'gpt-5.5');
  assert.deepEqual(result.config.models.providers.newapi.models[1].input, ['text', 'image']);
  assert.equal(Object.hasOwn(result.config.models.providers.newapi.models[1], 'capabilities'), false);
}

verifyNormalizeCatalogModel();
verifyReusableApiKey();
verifyMergeModelCatalogIntoConfig();
console.log('newapi model catalog verifier passed');
