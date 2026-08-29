#!/usr/bin/env node

/**
 * Verifies Cloud API plain-text failures surface actionable UI errors.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'src', 'main.js');
const main = fs.readFileSync(mainPath, 'utf8');

/**
 * Returns a source slice between two stable markers.
 */
function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) throw new Error(`Missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  if (endIndex === -1) throw new Error(`Missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

const helperSource = sliceBetween(main, 'function parseActivationResponseJSON', '/**\n * Posts JSON');
const context = {};
vm.runInNewContext(`${helperSource}; this.parseActivationResponseJSON = parseActivationResponseJSON;`, context);

const parsed = context.parseActivationResponseJSON('{"ok":true}', {
  pathname: '/v1/newapi/models/catalog',
  status: 200,
});
if (parsed.ok !== true) {
  throw new Error('activation JSON parser did not parse valid JSON');
}

try {
  context.parseActivationResponseJSON('404 page not found', {
    pathname: '/v1/newapi/models/catalog',
    status: 404,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('Cloud API /v1/newapi/models/catalog 返回非 JSON 响应（HTTP 404）')
    && message.includes('404 page not found')
    && !message.includes('Unexpected non-whitespace character')
  ) {
    console.log('activation JSON error handling verified');
    process.exit(0);
  }
  throw new Error(`activation JSON parser returned weak error: ${message}`);
}

throw new Error('activation JSON parser accepted plain text as JSON');
