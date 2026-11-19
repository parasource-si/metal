// node --test apps/site/release-mirror.node-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { byteRange } from './release-mirror.js';

test('byteRange reads one range, and refuses one past the end', () => {
  assert.equal(byteRange(undefined, 10), null);
  assert.deepEqual(byteRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(byteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.equal(byteRange('bytes=10-', 10), false);
  assert.equal(byteRange('bytes=0-1,4-5', 10), null, 'more than one range: the whole file');
});

test('the site server streams a mirrored release file, whole or from a byte, and nothing else from the mirror', async (t) => {
  const mirror = mkdtempSync(join(tmpdir(), 'dusk-mirror-'));
  mkdirSync(join(mirror, '1.2.3'));
  const bytes = Buffer.from('0123456789abcdef');
  writeFileSync(join(mirror, '1.2.3', 'DuskBot-1.2.3-arm64.zip'), bytes);
  writeFileSync(join(mirror, '1.2.3', 'Metal-1.2.3-arm64.zip'), bytes);
  writeFileSync(join(mirror, '1.2.3', 'secret.txt'), 'no');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, ['server.js', 'landing'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: String(port), DUSK_RELEASE_MIRROR: mirror, MONGODB_URI: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { server.kill(); rmSync(mirror, { recursive: true, force: true }); });
  await new Promise((resolve) => server.stdout.once('data', resolve));
  const base = `http://127.0.0.1:${port}/releases/1.2.3`;

  const whole = await fetch(`${base}/Metal-1.2.3-arm64.zip`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.match(whole.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await whole.arrayBuffer()).equals(bytes), true);

  const rest = await fetch(`${base}/DuskBot-1.2.3-arm64.zip`, { headers: { range: 'bytes=10-' } });
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get('content-range'), 'bytes 10-15/16');
  assert.equal(await rest.text(), 'abcdef');

  const past = await fetch(`${base}/DuskBot-1.2.3-arm64.zip`, { headers: { range: 'bytes=16-' } });
  assert.equal(past.status, 416);
  await past.body?.cancel();

  const head = await fetch(`${base}/DuskBot-1.2.3-arm64.zip`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '16');

  for (const name of ['DuskBot-1.2.4-arm64.zip', 'secret.txt', '..%2F..%2Fetc%2Fpasswd', 'DuskBot-1.2.3-x64.zip']) {
    const answer = await fetch(`${base}/${name}`);
    assert.equal(answer.status, 404, name);
    await answer.body?.cancel();
  }
});

test('the site server streams a mirrored voice model by its hash, and nothing else from that mirror', async (t) => {
  const mirror = mkdtempSync(join(tmpdir(), 'dusk-voice-mirror-'));
  const sha = 'a'.repeat(64);
  mkdirSync(join(mirror, sha));
  writeFileSync(join(mirror, sha, 'model_q8f16.onnx'), 'weights');
  writeFileSync(join(mirror, sha, 'notes.txt'), 'no');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, ['server.js', 'landing'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: String(port), DUSK_VOICE_MIRROR: mirror, MONGODB_URI: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { server.kill(); rmSync(mirror, { recursive: true, force: true }); });
  let said = '';
  await new Promise((resolve) => server.stdout.on('data', (chunk) => { said += chunk; if (said.includes(`127.0.0.1:${port}`)) resolve(); }));
  const base = `http://127.0.0.1:${port}/voice`;

  const whole = await fetch(`${base}/${sha}/model_q8f16.onnx`);
  assert.equal(whole.status, 200);
  assert.match(whole.headers.get('cache-control'), /immutable/);
  assert.equal(await whole.text(), 'weights');
  const rest = await fetch(`${base}/${sha}/model_q8f16.onnx`, { headers: { range: 'bytes=3-' } });
  assert.equal(rest.status, 206);
  assert.equal(await rest.text(), 'ghts');

  for (const name of [`${sha}/notes.txt`, `${'b'.repeat(64)}/model_q8f16.onnx`, `${sha}/..%2F..%2Fetc%2Fpasswd`, 'short/model.onnx']) {
    const answer = await fetch(`${base}/${name}`);
    assert.equal(answer.status, 404, name);
    await answer.body?.cancel();
  }
});
