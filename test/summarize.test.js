import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SYSTEM_PROMPT, digest, extractJson, parseCards, renderMessage, worthSummarizing } from '../lib/summarize.js';

function message(overrides = {}) {
  return {
    id: 'g@chatroom|message_0|1',
    chat: 'g@chatroom',
    shard: 'message_0',
    localId: 1,
    time: Date.UTC(2026, 9, 27, 5, 30),
    sortSeq: 1000,
    kind: 'text',
    text: '这个合同要付一下',
    sender: 'wxid_a',
    senderName: '张三',
    fromMe: false,
    relationLabels: [],
    quoted: null,
    ...overrides,
  };
}

test('media placeholders and system rows are not worth a model call', () => {
  assert.equal(worthSummarizing(message({ text: '[图片]' })), false);
  assert.equal(worthSummarizing(message({ text: '[表情]' })), false);
  assert.equal(worthSummarizing(message({ kind: 'system' })), false);
  assert.equal(worthSummarizing(message({ fromMe: true })), false);
  assert.equal(worthSummarizing(message({ text: '   ' })), false);
  assert.equal(worthSummarizing(message({ text: '确认合同金额' })), true);
});

test('the rendered line names the sender and marks the relation', () => {
  const line = renderMessage(
    message({ relationLabels: ['@了你'], text: '你看一下' }),
    3,
  );
  assert.match(line, /^\[m3\] /);
  assert.match(line, /张三（@了你）：你看一下$/);
});

test('a quoted message is inlined so the model can see what was replied to', () => {
  const line = renderMessage(
    message({ quoted: { fromUser: 'wxid_b', displayName: '李四', content: '合同呢' } }),
    0,
  );
  assert.match(line, /引用 李四：合同呢/);
});

test('very long messages are truncated instead of dominating the batch', () => {
  const line = renderMessage(message({ text: 'x'.repeat(5000) }), 0);
  assert.ok(line.length < 700, `line was ${line.length} chars`);
});

test('the digest drops noise and keeps stable ids for citations', () => {
  const batch = digest({
    chatLabel: '测试群',
    messages: [
      message({ text: '[图片]' }),
      message({ id: 'g@chatroom|message_0|2', text: '合同要付一下' }),
      message({ id: 'g@chatroom|message_0|3', fromMe: true, text: '好' }),
    ],
  });
  assert.equal(batch.used.length, 1);
  assert.match(batch.text, /群名称：测试群/);
  assert.match(batch.text, /\[m0\]/);
  assert.ok(batch.idByIndex.has('m0'));
  assert.equal(batch.idByIndex.get('m0').id, 'g@chatroom|message_0|2');
});

test('the digest keeps only the newest messages when the batch is capped', () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    message({ id: `g@chatroom|message_0|${index}`, text: `消息${index}` }),
  );
  const batch = digest({ chatLabel: 'x', messages: many, maxMessages: 3 });
  assert.equal(batch.used.length, 3);
  assert.match(batch.text, /消息9/);
  assert.doesNotMatch(batch.text, /消息0/);
});

test('the digest tells the model which cards the board already has', () => {
  // Without this the model invents a fresh title every pass and the board fills
  // with near-duplicates of the same todo.
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|1', text: '开箱教程看一下' })],
    existingCards: [{ title: '开箱前查看官方教程与入门资料' }, { title: '' }],
  });
  assert.match(batch.text, /已有的待办/);
  assert.match(batch.text, /开箱前查看官方教程与入门资料/);
  // Empty titles must not turn into blank bullets.
  assert.doesNotMatch(batch.text, /^- *$/m);
});

test('the digest omits the existing-card section when the board is empty', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|1', text: '在吗' })],
  });
  assert.doesNotMatch(batch.text, /已有的待办/);
});

test('extractJson finds an object wrapped in prose and code fences', () => {
  const reply = '好的，结果如下：\n```json\n{"cards":[{"title":"t"}]}\n```\n希望有用。';
  assert.deepEqual(extractJson(reply), { cards: [{ title: 't' }] });
});

test('extractJson tolerates braces inside strings', () => {
  const reply = '{"cards":[{"title":"a } b","detail":"{嵌套}"}]}';
  assert.deepEqual(extractJson(reply), { cards: [{ title: 'a } b', detail: '{嵌套}' }] });
});

test('extractJson returns null rather than throwing on broken output', () => {
  assert.equal(extractJson('没有 JSON'), null);
  assert.equal(extractJson('{"cards": [}'), null);
  assert.equal(extractJson(''), null);
});

test('parseCards keeps only cards whose sources resolve to real messages', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|2', text: '合同要付一下' })],
  });
  const reply = JSON.stringify({
    cards: [
      { title: '付合同款', detail: '30 台空调', sources: ['m0'], reasons: ['@了你'] },
      { title: '无来源的猜测', detail: '', sources: ['m99'] },
    ],
  });
  const cards = parseCards(reply, {
    chat: 'g@chatroom',
    chatLabel: '群',
    idByIndex: batch.idByIndex,
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '付合同款');
  assert.deepEqual(cards[0].sources, ['g@chatroom|message_0|2']);
  assert.deepEqual(cards[0].reasons, ['@了你']);
  assert.ok(cards[0].sourceAt > 0);
});

test('a card may point at an existing board card instead of inventing a title', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|5', text: '算力舱到了吗' })],
  });
  const reply = JSON.stringify({
    cards: [{ id: 'cabc123456789', title: '评估是否加购算力舱', sources: ['m0'] }],
  });
  const cards = parseCards(reply, {
    chat: 'g@chatroom',
    chatLabel: '群',
    idByIndex: batch.idByIndex,
    existingIds: new Set(['cabc123456789']),
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'cabc123456789');
});

test('a hallucinated card id is ignored rather than written', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|5', text: 'x' })],
  });
  const reply = JSON.stringify({ cards: [{ id: 'cNOTREAL1234', title: '某个待办', sources: ['m0'] }] });
  const cards = parseCards(reply, {
    chat: 'g@chatroom',
    chatLabel: '群',
    idByIndex: batch.idByIndex,
    existingIds: new Set(['crealreal123']),
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, undefined);
});

test('a card bound to an existing card can omit sources and inherits them', () => {
  const context = {
    chat: 'g@chatroom',
    chatLabel: '群',
    idByIndex: new Map(),
    existingIds: new Set(['c1']),
    existingById: new Map([['c1', { id: 'c1', sources: ['g@chatroom|message_0|1'], sourceAt: 42 }]]),
  };
  const cards = parseCards('{"cards":[{"id":"c1","title":"跟进发货"}]}', context);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].sources, ['g@chatroom|message_0|1']);
  assert.equal(cards[0].sourceAt, 42);
});

test('mergedIds only keeps ids the board actually knows', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|5', text: 'x' })],
  });
  const reply = JSON.stringify({
    cards: [{ id: 'c1', title: '合并后的待办', sources: ['m0'], mergedIds: ['c2', 'cZZZ', 'c1'] }],
  });
  const cards = parseCards(reply, {
    chat: 'g@chatroom',
    chatLabel: '群',
    idByIndex: batch.idByIndex,
    existingIds: new Set(['c1', 'c2']),
  });
  assert.deepEqual(cards[0].mergedIds, ['c2']);
});

test('parseCards returns nothing for a malformed or empty reply', () => {
  const context = { chat: 'g@chatroom', chatLabel: '群', idByIndex: new Map() };
  assert.deepEqual(parseCards('抱歉，我无法完成', context), []);
  assert.deepEqual(parseCards('{"cards":[]}', context), []);
  assert.deepEqual(parseCards('{"other":1}', context), []);
});

test('a card without a title is dropped', () => {
  const context = {
    chat: 'g@chatroom',
    chatLabel: '群',
    idByIndex: new Map([['m0', { id: 'x', time: 1 }]]),
  };
  assert.deepEqual(parseCards('{"cards":[{"title":"   ","sources":["m0"]}]}', context), []);
});

test('oversized fields are clamped before they reach the board', () => {
  const context = {
    chat: 'g@chatroom',
    chatLabel: '群',
    idByIndex: new Map([['m0', { id: 'x', time: 1 }]]),
  };
  const cards = parseCards(
    JSON.stringify({ cards: [{ title: '标'.repeat(500), detail: '细'.repeat(2000), sources: ['m0'] }] }),
    context,
  );
  assert.equal(cards[0].title.length, 120);
  assert.equal(cards[0].detail.length, 600);
});

test('the system prompt states the JSON contract', () => {
  assert.match(SYSTEM_PROMPT, /只输出 JSON/);
  assert.match(SYSTEM_PROMPT, /atuserlist|@ 了用户本人/);
});

test('a card built from a message that mentions me starts in 需要你', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|9', related: true, relationLabels: ['@了你'] })],
  });
  const cards = parseCards(
    JSON.stringify({ cards: [{ title: '回复合同金额', sources: ['m0'], reasons: ['@了你'] }] }),
    { chat: 'g@chatroom', chatLabel: '群', idByIndex: batch.idByIndex },
  );
  assert.equal(cards[0].concernsMe, true);
  assert.equal(cards[0].status, 'needs-you');
});

test('a card with no relation to me carries no status of its own', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|10', related: false })],
  });
  const cards = parseCards(
    JSON.stringify({ cards: [{ title: '付合同款', sources: ['m0'] }] }),
    { chat: 'g@chatroom', chatLabel: '群', idByIndex: batch.idByIndex },
  );
  assert.equal(cards[0].concernsMe, false);
  assert.equal(cards[0].status, undefined);
});

test('the model cannot promote a card to 需要你 by claiming a reason', () => {
  const batch = digest({
    chatLabel: '群',
    messages: [message({ id: 'g@chatroom|message_0|11', related: false })],
  });
  const cards = parseCards(
    JSON.stringify({ cards: [{ title: '付合同款', sources: ['m0'], reasons: ['@了你'], status: 'needs-you' }] }),
    { chat: 'g@chatroom', chatLabel: '群', idByIndex: batch.idByIndex },
  );
  // `related` comes from the parsed markup, so a prose claim alone must not
  // move the card into the column that is supposed to mean "you were called".
  assert.equal(cards[0].concernsMe, false);
  assert.equal(cards[0].status, undefined);
});

test('an update that inherits sources from a card that concerns me stays in 需要你', () => {
  const previous = { id: 'cabc123456789', title: '回复合同金额', sources: ['old'], concernsMe: true };
  const cards = parseCards(
    JSON.stringify({ cards: [{ id: 'cabc123456789', title: '回复合同金额并确认税率' }] }),
    {
      chat: 'g@chatroom',
      chatLabel: '群',
      idByIndex: new Map(),
      existingIds: new Set(['cabc123456789']),
      existingById: new Map([['cabc123456789', previous]]),
    },
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].concernsMe, true);
  assert.equal(cards[0].status, 'needs-you');
});
