import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Board, STATUSES } from '../lib/board.js';

function tempBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-todo-'));
  const path = join(dir, 'board.json');
  const board = Board.load(path);
  return {
    board,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('enabling every group tracks them without summarizing anything yet', () => {
  const { board, cleanup } = tempBoard();
  try {
    const chats = [
      { username: 'a@chatroom', label: 'A', messageCount: 10 },
      { username: 'b@chatroom', label: 'B', messageCount: 0 },
    ];
    for (const chat of chats) {
      board.ensureChat(chat.username, { label: chat.label, enabled: true });
    }
    const active = board.activeChats();
    assert.equal(active.length, 2);
    assert.equal(active.every((chat) => chat.watermark === 0), true);
    // A group with no local messages still gets tracked so its first new
    // message is picked up later; it just has nothing to summarize now.
    assert.equal(board.chat('b@chatroom').enabled, true);
  } finally {
    cleanup();
  }
});

test('pausing every group keeps its cards on the board', () => {
  const { board, cleanup } = tempBoard();
  try {
    board.ensureChat('a@chatroom', { label: 'A', enabled: true });
    board.upsertItem({
      id: 'c1',
      chat: 'a@chatroom',
      title: 'ship it',
      detail: 'do the thing',
      sources: ['a@chatroom|message_0|1'],
      status: 'todo',
    });
    board.setPaused('a@chatroom', true);
    assert.equal(board.activeChats().length, 0);
    assert.equal(board.items().length, 1);
    assert.ok(STATUSES.includes(board.items()[0].status));
  } finally {
    cleanup();
  }
});
