import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Board, STATUSES, cardId, emptyBoard } from '../lib/board.js';

function tempBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-todo-'));
  const file = join(dir, 'board.json');
  return { dir, file, board: Board.load(file) };
}

test('a missing board file starts empty instead of throwing', () => {
  const { dir, board } = tempBoard();
  try {
    assert.deepEqual(board.items(), []);
    assert.deepEqual(board.activeChats(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt board file is treated as empty, not fatal', () => {
  const { dir, file } = tempBoard();
  try {
    writeFileSync(file, '{ this is not json', 'utf8');
    const board = Board.load(file);
    assert.deepEqual(board.items(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('card ids are stable for the same chat and sources', () => {
  assert.equal(cardId('g@chatroom', ['b', 'a']), cardId('g@chatroom', ['a', 'b']));
  assert.notEqual(cardId('g@chatroom', ['a']), cardId('g@chatroom', ['b']));
  assert.notEqual(cardId('g1@chatroom', ['a']), cardId('g2@chatroom', ['a']));
  // Long enough that two unrelated cards cannot realistically collide.
  assert.ok(cardId('g@chatroom', ['a']).length >= 10);
});

test('summarizing the same backlog twice updates instead of duplicating', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom', { label: '项目群' });
    const draft = {
      chat: 'g@chatroom',
      title: '确认合同金额',
      sources: ['g@chatroom|message_0|41'],
      sourceAt: 1000,
    };
    board.upsertItem(draft);
    board.upsertItem({ ...draft, title: '确认合同金额（改）' });
    assert.equal(board.items().length, 1);
    assert.equal(board.items()[0].title, '确认合同金额（改）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lightly reworded card for the same chat updates instead of duplicating', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom', { label: '项目群' });
    // The model anchors each pass on a different source message, so the id
    // differs. The title fallback catches the near-identical rewording; the
    // prompt asks the model to reuse titles for anything more creative.
    const first = board.upsertItem({
      chat: 'g@chatroom',
      title: '开箱前查看官方教程与入门资料',
      sources: ['g@chatroom|message_0|7'],
      sourceAt: 1000,
    });
    const second = board.upsertItem({
      chat: 'g@chatroom',
      title: '开箱前查看官方教程和入门资料',
      sources: ['g@chatroom|message_0|9'],
      sourceAt: 2000,
    });
    assert.equal(board.items().length, 1, 'a reworded todo must not create a second card');
    assert.equal(second.id, first.id, 'the existing card id must be preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two unrelated todos in one chat stay two cards', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    board.upsertItem({ chat: 'g@chatroom', title: '确认合同金额', sources: ['s1'], sourceAt: 1 });
    board.upsertItem({ chat: 'g@chatroom', title: '安排周三的机房巡检', sources: ['s2'], sourceAt: 2 });
    assert.equal(board.items().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same title in two different chats stays two cards', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('a@chatroom');
    board.ensureChat('b@chatroom');
    board.upsertItem({ chat: 'a@chatroom', title: '确认付款', sources: ['s1'], sourceAt: 1 });
    board.upsertItem({ chat: 'b@chatroom', title: '确认付款', sources: ['s2'], sourceAt: 1 });
    assert.equal(board.items().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cards are grouped into the three columns, newest source first', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    board.upsertItem({ chat: 'g@chatroom', title: 'old', sources: ['a'], sourceAt: 10 });
    board.upsertItem({ chat: 'g@chatroom', title: 'new', sources: ['b'], sourceAt: 20 });
    const columns = board.columns();
    assert.deepEqual(Object.keys(columns).sort(), STATUSES.slice().sort());
    assert.deepEqual(columns.todo.map((item) => item.title), ['new', 'old']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('moving a card marks it as user-moved so a later summary cannot undo it', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const card = board.upsertItem({ chat: 'g@chatroom', title: 't', sources: ['a'], sourceAt: 1 });
    board.moveItem(card.id, 'doing');
    board.upsertItem({ chat: 'g@chatroom', title: 't', sources: ['a'], sourceAt: 1, status: 'todo' });
    assert.equal(board.item(card.id).status, 'doing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an update with no status keeps the card in its column', () => {
  // Model drafts never carry a status. Letting `undefined` through erased the
  // column, and the card disappeared from all three lists.
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const card = board.upsertItem({ chat: 'g@chatroom', title: 't', sources: ['a'], sourceAt: 1 });
    assert.equal(card.status, 'todo');
    board.moveItem(card.id, 'doing');
    board.upsertItem({ chat: 'g@chatroom', title: 't', sources: ['a'], sourceAt: 2, detail: '新进展' });
    const after = board.item(card.id);
    assert.equal(after.status, 'doing');
    assert.equal(after.detail, '新进展');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cards saved without a status are repaired on load instead of vanishing', () => {
  const { dir, file } = tempBoard();
  try {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, chats: {}, items: [{ id: 'c1', chat: 'g@chatroom', title: '旧卡' }] }),
      'utf8',
    );
    const board = Board.load(file);
    assert.equal(board.items().length, 1);
    assert.equal(board.items()[0].status, 'todo');
    assert.equal(board.columns().todo.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown status is rejected instead of creating a fourth column', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const card = board.upsertItem({ chat: 'g@chatroom', title: 't', sources: ['a'], sourceAt: 1 });
    assert.equal(board.moveItem(card.id, 'nonsense'), null);
    board.upsertItem({ chat: 'g@chatroom', title: 'u', sources: ['b'], sourceAt: 1, status: 'nonsense' });
    assert.equal(board.items().find((item) => item.title === 'u').status, 'todo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a card that concerns me is created in 需要你', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const card = board.upsertItem({
      chat: 'g@chatroom',
      title: '回复合同金额',
      sources: ['a'],
      sourceAt: 1,
      concernsMe: true,
    });
    assert.equal(card.concernsMe, true);
    assert.equal(card.status, 'needs-you');
    assert.equal(board.columns()['needs-you'].length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backlog card moves to 需要你 when a later pass finds I was called', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const card = board.upsertItem({ chat: 'g@chatroom', title: '回复合同金额', sources: ['a'], sourceAt: 1 });
    assert.equal(card.status, 'todo');
    board.upsertItem({
      chat: 'g@chatroom',
      title: '回复合同金额',
      sources: ['a'],
      sourceAt: 2,
      concernsMe: true,
    });
    assert.equal(board.item(card.id).status, 'needs-you');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a card I moved by hand is never re-slotted by a later summary', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const card = board.upsertItem({ chat: 'g@chatroom', title: '回复合同金额', sources: ['a'], sourceAt: 1 });
    board.moveItem(card.id, 'doing');
    board.upsertItem({
      chat: 'g@chatroom',
      title: '回复合同金额',
      sources: ['a'],
      sourceAt: 2,
      concernsMe: true,
      status: 'needs-you',
    });
    assert.equal(board.item(card.id).status, 'doing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merging folds the absorbed cards into the survivor and keeps every source', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const keep = board.upsertItem({
      chat: 'g@chatroom',
      title: '评估是否加购算力舱',
      sources: ['s1'],
      sourceAt: 10,
    });
    const drop = board.upsertItem({
      chat: 'g@chatroom',
      title: '确认大模型需要的算力配置',
      sources: ['s2'],
      sourceAt: 20,
    });
    board.upsertItem({
      chat: 'g@chatroom',
      id: keep.id,
      title: '评估是否加购算力舱',
      sources: ['s3'],
      sourceAt: 30,
      mergedIds: [drop.id],
    });
    assert.equal(board.items().length, 1);
    assert.equal(board.item(keep.id).sources.length, 3);
    assert.equal(board.item(drop.id), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a merge cannot absorb a card that belongs to another chat', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('a@chatroom');
    board.ensureChat('b@chatroom');
    const keep = board.upsertItem({ chat: 'a@chatroom', title: '甲群的活', sources: ['s1'], sourceAt: 1 });
    const other = board.upsertItem({ chat: 'b@chatroom', title: '乙群的活', sources: ['s2'], sourceAt: 2 });
    board.upsertItem({
      chat: 'a@chatroom',
      id: keep.id,
      title: '甲群的活',
      sources: ['s3'],
      sourceAt: 3,
      mergedIds: [other.id],
    });
    assert.equal(board.items().length, 2);
    assert.ok(board.item(other.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a chat removes its cards and bumps the epoch', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom', { label: 'x' });
    board.ensureChat('keep@chatroom');
    board.upsertItem({ chat: 'g@chatroom', title: 'gone', sources: ['a'], sourceAt: 1 });
    board.upsertItem({ chat: 'keep@chatroom', title: 'stays', sources: ['b'], sourceAt: 1 });
    const epochBefore = board.chat('g@chatroom').epoch;
    const result = board.deleteChat('g@chatroom');
    assert.equal(result.removed, 1);
    assert.deepEqual(board.items().map((item) => item.title), ['stays']);
    assert.equal(board.chat('g@chatroom').epoch, epochBefore + 1);
    assert.ok(board.chat('g@chatroom').deletedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write from a pass that outlived its chat is rejected', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    const staleEpoch = board.chat('g@chatroom').epoch;
    board.deleteChat('g@chatroom');
    const stored = board.upsertItem({
      chat: 'g@chatroom',
      title: 'ghost',
      sources: ['a'],
      sourceAt: 1,
      expectedEpoch: staleEpoch,
    });
    assert.equal(stored, null);
    assert.deepEqual(board.items(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paused and deleted chats are never polled', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('a@chatroom');
    board.ensureChat('b@chatroom', { paused: true });
    board.ensureChat('c@chatroom');
    board.deleteChat('c@chatroom');
    assert.deepEqual(board.activeChats().map((chat) => chat.username), ['a@chatroom']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tracking a deleted chat again revives it for polling', () => {
  // `deleteChat` leaves a tombstone so an in-flight summarizer can tell
  // "deleted" from "never seen". Re-adding the group has to clear it, otherwise
  // the UI shows the chat as tracked while polling and every write skip it.
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom', { label: 'x' });
    board.setWatermark('g@chatroom', 500);
    const epochBefore = board.chat('g@chatroom').epoch;
    board.deleteChat('g@chatroom');
    assert.equal(board.activeChats().length, 0);

    board.ensureChat('g@chatroom', { label: 'x', enabled: true });
    const revived = board.chat('g@chatroom');
    assert.equal(revived.deletedAt, undefined);
    assert.equal(revived.paused, false);
    assert.equal(revived.watermark, 0);
    assert.equal(revived.epoch, epochBefore + 2);
    assert.deepEqual(board.activeChats().map((chat) => chat.username), ['g@chatroom']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a watermark write does not resurrect a deleted chat', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('g@chatroom');
    board.deleteChat('g@chatroom');
    board.setWatermark('g@chatroom', 999);
    assert.ok(board.chat('g@chatroom').deletedAt);
    assert.equal(board.activeChats().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the watermark only moves forward', () => {
  const { dir, board } = tempBoard();
  try {
    board.ensureChat('a@chatroom');
    board.setWatermark('a@chatroom', 100);
    board.setWatermark('a@chatroom', 50);
    assert.equal(board.chat('a@chatroom').watermark, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving then loading round-trips the whole board', () => {
  const { dir, file, board } = tempBoard();
  try {
    board.ensureChat('a@chatroom', { label: '群' });
    board.upsertItem({ chat: 'a@chatroom', title: 't', sources: ['s'], sourceAt: 5 });
    board.setWatermark('a@chatroom', 42);
    board.save();
    const reloaded = Board.load(file);
    assert.equal(reloaded.items()[0].title, 't');
    assert.equal(reloaded.chat('a@chatroom').watermark, 42);
    assert.equal(reloaded.chat('a@chatroom').label, '群');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emptyBoard is a fresh object every time', () => {
  const a = emptyBoard();
  const b = emptyBoard();
  a.items.push({ id: 'x' });
  assert.deepEqual(b.items, []);
});
