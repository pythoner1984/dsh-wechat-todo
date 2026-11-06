import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Sidecar } from '../lib/sidecar.js';

/**
 * A stand-in bridge that speaks the real JSON-lines protocol.
 *
 * Using Node as the "interpreter" keeps the protocol under test without needing
 * Python, the WeChat databases, or a key store.
 */
const FAKE_BRIDGE = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const args = request.args || {};
  switch (request.cmd) {
    case 'health':
      send({ id: request.id, ok: true, data: { ok: true, selfUsername: 'wxid_me', selfNickname: '我' } });
      break;
    case 'echo':
      send({ id: request.id, ok: true, data: { value: args.value } });
      break;
    case 'big':
      send({ id: request.id, ok: true, data: { blob: 'x'.repeat(400000) } });
      break;
    case 'fail':
      send({ id: request.id, ok: false, error: { code: 'key-missing', message: 'no key for this database' } });
      break;
    case 'noise':
      process.stdout.write('this line is not json\\n');
      send({ id: request.id, ok: true, data: { after: 'noise' } });
      break;
    case 'sleep':
      setTimeout(() => send({ id: request.id, ok: true, data: { slept: true } }), 200);
      break;
    case 'die':
      process.exit(3);
      break;
    default:
      send({ id: request.id, ok: false, error: { code: 'unknown-command', message: request.cmd } });
  }
});
`;

function startFake(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-todo-bridge-'));
  const script = join(dir, 'bridge.cjs');
  writeFileSync(script, FAKE_BRIDGE, 'utf8');
  const sidecar = new Sidecar({ script, python: process.execPath, ...options });
  return {
    sidecar,
    cleanup() {
      sidecar.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a call returns the data the bridge replied with', async () => {
  const { sidecar, cleanup } = startFake();
  try {
    const data = await sidecar.call('echo', { value: '你好' });
    assert.equal(data.value, '你好');
  } finally {
    cleanup();
  }
});

test('one process serves many calls', async () => {
  const { sidecar, cleanup } = startFake();
  try {
    const first = await Promise.all([
      sidecar.call('echo', { value: 'a' }),
      sidecar.call('echo', { value: 'b' }),
      sidecar.call('echo', { value: 'c' }),
    ]);
    assert.deepEqual(first.map((item) => item.value), ['a', 'b', 'c']);
  } finally {
    cleanup();
  }
});

test('an error reply becomes a rejection with the bridge code', async () => {
  const { sidecar, cleanup } = startFake();
  try {
    await assert.rejects(
      () => sidecar.call('fail'),
      (error) => {
        assert.equal(error.code, 'key-missing');
        assert.match(error.message, /no key/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('a large reply is reassembled across chunks', async () => {
  const { sidecar, cleanup } = startFake();
  try {
    const data = await sidecar.call('big');
    assert.equal(data.blob.length, 400000);
  } finally {
    cleanup();
  }
});

test('an unsolicited non-JSON line is logged and does not break the call', async () => {
  const lines = [];
  const { sidecar, cleanup } = startFake({ onLog: (line) => lines.push(line) });
  try {
    const data = await sidecar.call('noise');
    assert.equal(data.after, 'noise');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /non-JSON/);
  } finally {
    cleanup();
  }
});

test('a call that never answers times out instead of hanging forever', async () => {
  const { sidecar, cleanup } = startFake({ timeoutMs: 50 });
  try {
    await assert.rejects(
      () => sidecar.call('sleep'),
      (error) => {
        assert.equal(error.code, 'bridge-timeout');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('a dead child rejects the calls that were waiting on it', async () => {
  const { sidecar, cleanup } = startFake();
  try {
    const pending = sidecar.call('die');
    await assert.rejects(
      () => pending,
      (error) => {
        assert.equal(error.code, 'bridge-exited');
        assert.match(error.message, /code 3/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('the next call restarts the bridge after a crash', async () => {
  const { sidecar, cleanup } = startFake();
  try {
    await assert.rejects(() => sidecar.call('die'));
    // The child is gone; a fresh one has to be spawned on demand.
    const data = await sidecar.call('echo', { value: 'back' });
    assert.equal(data.value, 'back');
  } finally {
    cleanup();
  }
});

test('reset drops pending work and lets a later call start clean', async () => {
  const { sidecar, cleanup } = startFake();
  try {
    await sidecar.call('echo', { value: 'warm' });
    const pending = sidecar.call('sleep');
    await sidecar.reset();
    await assert.rejects(() => pending, (error) => error.code === 'bridge-reset');
    const data = await sidecar.call('echo', { value: 'again' });
    assert.equal(data.value, 'again');
  } finally {
    cleanup();
  }
});

test('a missing interpreter fails loudly instead of silently', async () => {
  const sidecar = new Sidecar({ script: 'does-not-matter.py', python: '' });
  try {
    await assert.rejects(
      () => sidecar.call('health'),
      (error) => error.code === 'python-missing',
    );
  } finally {
    sidecar.dispose();
  }
});
