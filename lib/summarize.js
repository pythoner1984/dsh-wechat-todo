/**
 * Turning a batch of group messages into board cards.
 *
 * Two things happen here and they are deliberately separate:
 *
 * 1. `digest()` decides *which* messages are worth sending and renders them as
 *    compact text. It is pure, so the token budget can be reasoned about and
 *    tested without a model.
 * 2. `parseCards()` reads the model's reply. Models add prose around JSON, so
 *    the parser scans for the first balanced array instead of demanding a clean
 *    document; a malformed reply becomes zero cards rather than an exception
 *    that would stall the queue.
 *
 * Nothing here calls the network. The host injects a `complete()` function so
 * this module stays testable.
 */

/** Messages that carry no readable content are never worth a token. */
const SKIP_KINDS = new Set(['system', 'type_10000']);

/** Keep one message short enough that a single rant cannot dominate the batch. */
const MAX_TEXT = 600;

const SYSTEM_PROMPT = [
  '你是一个中文群聊待办整理助手。用户会给你某个微信群最近的一批消息，以及看板上已有的待办卡片。',
  '你的任务：把这些消息整理成「可跟进的待办卡片」。',
  '规则：',
  '1. 只有在消息里确实存在某件事需要有人推进、回复、交付、决定或跟进时，才生成卡片。',
  '2. 闲聊、问候、表情、纯转发链接、无后续的信息，不要生成卡片。',
  '3. 每张卡片的 title 是 12-30 字的中文短句，说清"要做什么"，不要以"关于"开头。',
  '4. detail 用 1-2 句话写清背景与已知约束；没有更多信息就留空字符串。',
  '5. sources 必须从消息里给出的 messageId 中挑选，只写与本卡片直接相关的那些。',
  '6. 如果某条消息 @ 了用户本人、回复了用户本人的消息、或提到用户的名字，必须单独成卡，',
  '   并在 reasons 里写清是哪种（"@了你" / "回复了你" / "提到你的名字"）。',
  '7. 「看板上已有的待办」每条都带一个 id。如果新消息只是在推进、补充或换种说法描述其中某一条，',
  '   你必须输出一张卡片并在 id 字段里原样照抄那条待办的 id（一个字都不要改），不要另起新卡片。',
  '8. 如果多张已有待办实际上是同一件事（说法不同但指向同一个动作），把它们合并成一张卡片：',
  '   输出一张卡，id 用其中一张，把其余卡片的 id 全部写进 mergedIds 数组。',
  '9. 没有把握时宁可带上已有 id 也不要新建卡片。',
  '10. 最多输出 8 张卡片。宁可少，也不要凑数。',
  '只输出 JSON，不要任何解释文字。格式：',
  '{"cards":[{"id":"已有卡片的id，新卡片省略","title":"...","detail":"...",',
  ' "sources":["messageId"],"reasons":["@了你"],"mergedIds":["被合并掉的卡片id"]}]}',
].join('\n');

/**
 * Decide whether a message is worth sending to the model at all.
 * @param {object} message Payload produced by the read bridge.
 */
export function worthSummarizing(message) {
  if (!message) return false;
  if (message.fromMe) return false;
  if (SKIP_KINDS.has(message.kind)) return false;
  const text = (message.text || '').trim();
  if (!text) return false;
  // Pure reactions and bare media placeholders carry no task.
  if (/^\[(图片|表情|语音|视频)\]$/.test(text)) return false;
  return true;
}

/** One line per message, with a stable id the model can cite back. */
export function renderMessage(message, index) {
  const stamp = formatStamp(message.time);
  const who = message.senderName || message.sender || '未知成员';
  const text = (message.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const flags = [];
  if (Array.isArray(message.relationLabels) && message.relationLabels.length) {
    flags.push(message.relationLabels.join('/'));
  }
  const quoted =
    message.quoted && message.quoted.content
      ? ` （引用 ${message.quoted.displayName || message.quoted.fromUser || '某人'}：${String(
          message.quoted.content,
        )
          .replace(/\s+/g, ' ')
          .slice(0, 120)}）`
      : '';
  return `[m${index}] ${stamp} ${who}${flags.length ? `（${flags.join('/')}）` : ''}：${text}${quoted}`;
}

function formatStamp(ms) {
  const value = Number(ms) || 0;
  if (!value) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Build the request payload for one chat.
 *
 * @param {object} options
 * @param {string} options.chatLabel
 * @param {Array<object>} options.messages
 * @param {number} [options.maxMessages]
 * @param {Array<{id?: string, title: string}>} [options.existingCards] Cards
 *   already on the board for this chat. Their ids go into the prompt so the
 *   model can point at the card it is updating instead of inventing a new
 *   wording for a todo it already reported (which filled the board with
 *   near-duplicates).
 * @returns {{ text: string, used: Array<object>, idByIndex: Map<string, object> }}
 */
export function digest({ chatLabel, messages, maxMessages = 120, existingCards = [] }) {
  const usable = (messages || []).filter(worthSummarizing).slice(-maxMessages);
  const idByIndex = new Map();
  const lines = [];
  usable.forEach((message, index) => {
    const key = `m${index}`;
    idByIndex.set(key, message);
    lines.push(renderMessage(message, index));
  });
  const header = `群名称：${chatLabel || '未命名群'}。下面是最近 ${usable.length} 条消息，按时间从旧到新排列。`;
  const titles = (existingCards || [])
    .map((card) => ({
      id: String((card && card.id) || '').trim(),
      title: String((card && card.title) || '').trim(),
    }))
    .filter((card) => card.title);
  const known = titles.length
    ? `\n\n看板上已有的待办（若新消息只是在推进或重复描述其中某条，请原样照抄它的 id）：\n${titles
        .map((card) => `- ${card.id ? `[${card.id}] ` : ''}${card.title}`)
        .join('\n')}`
    : '';
  return { text: `${header}${known}\n\n${lines.join('\n')}`, used: usable, idByIndex };
}

/** Extract the first balanced JSON array, tolerating prose and code fences. */
export function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parse the model reply into card drafts.
 *
 * @param {string} reply Raw model output.
 * @param {{ chat: string, chatLabel: string, idByIndex: Map<string, object>,
 *   existingIds?: Set<string>, existingById?: Map<string, object> }} context
 *   `existingIds` limits which ids the model may claim: an id the board does not
 *   know is a hallucination, and honouring it would write a card under a key
 *   nothing can ever update again.
 * @returns {Array<object>} Drafts ready for `Board.upsertItem`.
 */
export function parseCards(reply, context) {
  const payload = extractJson(reply);
  if (!payload || !Array.isArray(payload.cards)) return [];
  const known = context.existingIds || new Set();
  const byId = context.existingById || new Map();
  const out = [];
  for (const raw of payload.cards) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').trim();
    if (!title) continue;
    const claimed = String(raw.id || '').trim();
    const id = claimed && known.has(claimed) ? claimed : '';
    const sourceIds = Array.isArray(raw.sources) ? raw.sources.map(String) : [];
    const used = sourceIds
      .map((key) => context.idByIndex.get(key))
      .filter(Boolean);
    if (!used.length && !id) {
      // A card with no resolvable source cannot be traced back to the chat, and
      // the whole point of the board is that every card is followable. A card
      // that names a real existing card keeps that card's sources instead.
      continue;
    }
    const previous = id ? byId.get(id) : null;
    const mergedIds = (Array.isArray(raw.mergedIds) ? raw.mergedIds.map(String) : [])
      .map((value) => value.trim())
      .filter((value) => value && value !== id && known.has(value));
    const reasons = Array.isArray(raw.reasons) ? raw.reasons.map(String).filter(Boolean) : [];
    // Whether a card concerns the user is decided from the stored messages, not
    // from the model's prose: `related` comes from the parsed <atuserlist> and
    // <refermsg>/<fromusr> markup, so it cannot be hallucinated away. Cards that
    // touch the user start in the 需要你 column instead of the plain backlog.
    const concernsMe = used.some((message) => message.related === true)
      || (Array.isArray(previous?.sources) && previous.sources.length > 0 && previous?.concernsMe === true);
    out.push({
      chat: context.chat,
      chatLabel: context.chatLabel,
      ...(id ? { id } : {}),
      title: title.slice(0, 120),
      detail: String(raw.detail || '').slice(0, 600),
      concernsMe,
      ...(concernsMe ? { status: 'needs-you' } : {}),
      reasons,
      sources: used.length
        ? used.map((message) => message.id)
        : Array.isArray(previous?.sources)
          ? previous.sources.slice()
          : [],
      sourceAt: used.length
        ? Math.max(...used.map((message) => Number(message.time) || 0))
        : Number(previous?.sourceAt) || 0,
      ...(mergedIds.length ? { mergedIds } : {}),
    });
  }
  return out;
}

export { SYSTEM_PROMPT };
