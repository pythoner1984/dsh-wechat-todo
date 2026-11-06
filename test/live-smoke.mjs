/**
 * Smoke test for the host half against the *real* WeChat databases.
 *
 * This is the only test that touches live data, so it is not part of `npm test`:
 * it is opt-in via `node test/live-smoke.mjs`. It proves three things the unit
 * tests cannot — that the bridge spawns with a real interpreter, that the
 * databases decrypt, and that a card written against a real chat survives a
 * save/load cycle.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Board } from '../lib/board.js';
import { Sidecar, resolveInterpreter } from '../lib/sidecar.js';
import { digest, parseCards } from '../lib/summarize.js';

// `URL.pathname` percent-encodes this workspace's non-ASCII directory name, so
// the path has to come from `fileURLToPath`.
const scriptPath = fileURLToPath(new URL('../bridge/server.py', import.meta.url));

const python = resolveInterpreter();
assert.ok(python, 'no Python interpreter with the reader dependencies was found');
console.log('interpreter:', python);

const bridge = new Sidecar({ script: scriptPath, python });
const dir = mkdtempSync(join(tmpdir(), 'wechat-todo-live-'));

try {
  const health = await bridge.call('health');
  console.log('health:', JSON.stringify(health.health));
  assert.ok(health.health.driver === 'ok', 'the SQLCipher driver is not ready');
  assert.ok(health.health.message_dbs > 0, 'no message database was configured');
  assert.equal(health.health.missing_files.length, 0, 'a configured database is missing');

  const chats = await bridge.call('chats');
  assert.ok(chats.chats.length > 0, 'no group with readable messages');
  console.log('groups with messages:', chats.chats.length, 'silent:', chats.withoutMessages);

  const first = chats.chats[0];
  console.log('first group:', first.label, first.messageCount, 'messages');

  const page = await bridge.call('messages', { chat: first.username, limit: 40, ascending: true });
  assert.ok(page.messages.length > 0, 'the selected group returned no messages');
  for (const message of page.messages) {
    assert.ok(message.id.includes('|'), 'a message id must carry its shard');
    assert.ok(typeof message.time === 'number');
    // The render layer must never leak raw XML into the UI.
    assert.ok(!String(message.text).trim().startsWith('<'), `unrendered XML leaked: ${message.text.slice(0, 60)}`);
    // Group payloads carry a "wxid_xxx:" / "123@chatroom:" speaker prefix that
    // the reader already resolves from Name2Id, so it must not reach the UI.
    assert.ok(
      !/^(?:wxid_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{2,64}@(?:chatroom|openim|im\.chatroom|app)):/.test(String(message.text)),
      `sender prefix leaked into the body: ${message.text.slice(0, 60)}`,
    );
  }
  console.log('messages read:', page.messages.length, 'hasMore:', page.hasMore);

  const related = page.messages.filter((message) => message.related);
  console.log('messages about me on this page:', related.length);

  // Rendering bugs show up in the long tail, not in the first page of one
  // group: sweep every group's newest page and count anything unreadable.
  const prefixRe = /^(?:wxid_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{2,64}@(?:chatroom|openim|im\.chatroom|app)):/;
  let swept = 0;
  let rawXml = 0;
  let prefixed = 0;
  let blank = 0;
  for (const group of chats.chats) {
    const sweep = await bridge.call('messages', { chat: group.username, limit: 40 });
    for (const message of sweep.messages) {
      swept += 1;
      const text = String(message.text || '');
      if (!text.trim()) blank += 1;
      if (text.trim().startsWith('<')) rawXml += 1;
      if (prefixRe.test(text)) prefixed += 1;
    }
  }
  console.log('swept messages:', swept, 'raw xml:', rawXml, 'prefixed:', prefixed, 'blank:', blank);
  assert.equal(rawXml, 0, 'the render layer leaked raw XML somewhere');
  assert.equal(prefixed, 0, 'a sender prefix leaked into a message body');
  assert.equal(blank, 0, 'a message rendered to an empty string');

  const batch = digest({ chatLabel: first.label, messages: page.messages });
  console.log('digest lines:', batch.used.length, 'chars:', batch.text.length);

  const context = { chat: first.username, chatLabel: first.label, idByIndex: batch.idByIndex };
  const sample = JSON.stringify({
    cards: [{ title: '确认合同付款进度', detail: '群里在催合同款', sources: ['m0'], reasons: [] }],
  });
  const cards = parseCards(sample, context);
  assert.equal(cards.length, 1);

  const board = new Board(join(dir, 'board.json'));
  board.ensureChat(first.username, { label: first.label });
  const stored = board.upsertItem({ ...cards[0], expectedEpoch: board.chat(first.username).epoch });
  assert.ok(stored, 'a card for a live chat must be accepted');
  board.save();

  const reloaded = Board.load(join(dir, 'board.json'));
  assert.equal(reloaded.items().length, 1);
  assert.equal(reloaded.items()[0].title, '确认合同付款进度');
  console.log('board round-trip ok, card id:', stored.id);

  // Deleting the chat must invalidate a summary that was already running.
  const staleEpoch = board.chat(first.username).epoch;
  reloaded.deleteChat(first.username);
  assert.equal(reloaded.upsertItem({ ...cards[0], expectedEpoch: staleEpoch }), null);
  console.log('stale write rejected after delete');
} finally {
  bridge.dispose();
  rmSync(dir, { recursive: true, force: true });
}

console.log('live smoke: ok');
