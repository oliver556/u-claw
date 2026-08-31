#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server-video-adapter');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function main() {
  let seenNewApi;
  let seenFlashCreate = '';
  let adapterPort;
  let flashCreates = 0;
  let newApiCreates = 0;

  const flash = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const statusMatch = req.url.match(/^\/v1\/videos\/(task_flash_\d+)$/);
      if (req.method === 'GET' && statusMatch) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: statusMatch[1],
          task_id: statusMatch[1],
          status: 'completed',
          video_url: 'https://example.test/video.mp4',
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/videos') {
        flashCreates += 1;
        seenFlashCreate = Buffer.concat(chunks).toString('utf8');
        const taskId = `task_flash_${flashCreates}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: taskId, task_id: taskId, status: 'processing' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `flash route not found: ${req.method} ${req.url}` } }));
    });
  });
  const flashPort = await listen(flash);

  const newApi = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const statusMatch = req.url.match(/^\/v1\/videos\/(task_newapi_\d+)$/);
      if (req.method === 'GET' && statusMatch) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: statusMatch[1],
          status: 'completed',
          progress: 100,
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/videos') {
        seenNewApi = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const response = await fetch(`http://127.0.0.1:${adapterPort}/v1/videos`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer adapter-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(seenNewApi),
        });
        const payload = await response.json();
        assert.match(payload.task_id, /^task_flash_\d+$/);
        newApiCreates += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `task_newapi_${newApiCreates}`, status: 'processing' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `new api route not found: ${req.method} ${req.url}` } }));
    });
  });
  const newApiPort = await listen(newApi);
  const taskStorePath = path.join(os.tmpdir(), `uclaw-adapter-mock-tasks-${process.pid}.json`);
  fs.rmSync(taskStorePath, { force: true });
  const adapter = createServer({
    newApiUpstreamBaseUrl: `http://127.0.0.1:${newApiPort}`,
    flashBaseUrl: `http://127.0.0.1:${flashPort}`,
    flashApiKey: 'flash-key',
    configPath: '/tmp/uclaw-adapter-missing-config.json',
    taskStorePath,
    adapterTokens: 'adapter-token',
  });
  adapterPort = await listen(adapter);

  try {
    const response = await fetch(`http://127.0.0.1:${adapterPort}/v1/videos/generations`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
        'X-UClaw-NewAPI-Compat': '1',
      },
      body: JSON.stringify({
        model: 'seedance-1.5-pro-1080p-5s',
        prompt: 'mock',
        size: '4:3',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      request_id: 'task_newapi_1',
      status: 'processing',
      error: null,
    });
    assert.deepEqual(seenNewApi, {
      model: 'seedance-1.5-pro-1080p-5s',
      prompt: 'mock',
      seconds: '5',
      duration: '5',
    });
    assert.match(seenFlashCreate, /name="seconds"\r\n\r\n5\r\n/);

    const testResponse = await fetch(`http://127.0.0.1:${adapterPort}/v1/videos/generations`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
        'X-UClaw-NewAPI-Compat': '1',
      },
      body: JSON.stringify({
        model: 'seedance-1.5-pro-1080p-4s-test',
        prompt: 'mock',
        seconds: '99',
        duration: '99',
      }),
    });
    assert.equal(testResponse.status, 200);
    assert.deepEqual(await testResponse.json(), {
      request_id: 'task_newapi_2',
      status: 'processing',
      error: null,
    });
    assert.deepEqual(seenNewApi, {
      model: 'seedance-1.5-pro-1080p-4s-test',
      prompt: 'mock',
      seconds: '4',
      duration: '4',
    });
    assert.match(seenFlashCreate, /name="seconds"\r\n\r\n4\r\n/);

    const fullCompatCreate = await fetch(`http://127.0.0.1:${adapterPort}/v1/videos/generations`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer newapi-key',
        'Content-Type': 'application/json',
        'X-UClaw-NewAPI-Compat': '1',
      },
      body: JSON.stringify({
        model: 'seedance-1.5-pro-1080p-4s-test',
        prompt: 'full loop',
        seconds: '99',
      }),
    });
    assert.equal(fullCompatCreate.status, 200);
    assert.deepEqual(await fullCompatCreate.json(), {
      request_id: 'task_newapi_3',
      status: 'processing',
      error: null,
    });
    assert.deepEqual(seenNewApi, {
      model: 'seedance-1.5-pro-1080p-4s-test',
      prompt: 'full loop',
      seconds: '4',
      duration: '4',
    });

    const fullCompatStatus = await fetch(`http://127.0.0.1:${adapterPort}/v1/videos/task_newapi_3`, {
      headers: {
        Authorization: 'Bearer newapi-key',
        'X-UClaw-NewAPI-Compat': '1',
      },
    });
    assert.equal(fullCompatStatus.status, 200);
    assert.deepEqual(await fullCompatStatus.json(), {
      request_id: 'task_newapi_3',
      status: 'done',
      video: { url: 'https://example.test/video.mp4' },
    });
  } finally {
    await close(adapter);
    await close(newApi);
    await close(flash);
    fs.rmSync(taskStorePath, { force: true });
  }
}

main()
  .then(() => console.log('newapi video compat verifier passed'))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
