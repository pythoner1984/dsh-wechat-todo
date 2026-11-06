/**
 * Board state: which chats are tracked, what the todo cards are, and how far
 * each chat has been read.
 *
 * Everything lives in one JSON document on this machine. The store is
 * deliberately synchronous and dependency-free so the rules below can be tested
 * without a browser, a model, or WeChat.
 *
 * Two invariants matter more than the rest:
 *
 * 1. A card's id is derived from its chat plus the messages it came from. If the
 *    same backlog is summarized twice the second pass updates the existing card
 *    instead of appending a duplicate.
 * 2. Deleting a chat removes every derived record in the same operation, so a
 *    later write from an in-flight task cannot resurrect a ghost card. Writes
 *    therefore go through `#assertAlive`, and deletions bump a per-chat epoch.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The three columns, in display order. */
export const STATUSES = ['todo', 'doing', 'needs-you'];

export const STATUS_LABELS = {
  todo: '待办',
  doing: '进行中',
  'needs-you': '需要你',
};

const VERSION = 1;

/** Bigram overlap above which two card titles count as the same todo. */
const SIMILAR_TITLE_THRESHOLD = 0.55;

export function emptyBoard() {
  return {
    version: VERSION,
    selfUsername: '',
    selfNickname: '',
    chats: {},
    items: [],
  };
}

/** Card ids have to survive a restart, so they are content-addressed. */
export function cardId(chat, sources) {
  const list = (sources || []).filter(Boolean).sort();
  const anchor = list.length ? list[0] : String(Date.now());
  // A short 32-bit hash is not enough: two unrelated cards colliding would look
  // like one card being edited, silently merging two different todos.
  const digest = createHash('sha1').update(`${chat}\u0000${anchor}`, 'utf8').digest('hex');
  return `c${digest.slice(0, 12)}`;
}

/**
 * Reduce a card title to something comparable.
 *
 * The model describes the same event slightly differently on every pass
 * ("开箱前查看教程" / "开箱前先看官方教学视频"), and it anchors each card on a
 * different source message, so a content-addressed id alone produced a new
 * duplicate card per pass. Two cards in one chat whose normalized titles match
 * are the same todo.
 */
export function titleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[。，、；：！？,.;:!?…—·"'“”‘’()（）[\]【】<>《》\-_/\\]/g, '');
}

/** Character bigrams of a normalized title, used for fuzzy matching. */
function bigrams(value) {
  const text = titleKey(value);
  const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

/**
 * Decide whether two card titles describe the same todo.
 *
 * Exact equality is too strict: the model rewords the same event on every pass
 * ("开箱前查看教程" vs "开箱前先看官方教学视频"). Character-bigram overlap is
 * cheap and works for Chinese without a tokenizer.
 */
export function similarTitle(a, b) {
  const left = titleKey(a);
  const right = titleKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  // A short title that is fully contained in the other is the same todo with
  // extra words attached.
  if (left.length >= 4 && right.includes(left)) return true;
  if (right.length >= 4 && left.includes(right)) return true;
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  const union = x.size + y.size - shared;
  return union > 0 && shared / union >= SIMILAR_TITLE_THRESHOLD;
}

export class Board {
  /**
   * @param {string} file Path of the JSON document.
   * @param {object} [seed] Initial document, used when the file is absent.
   */
  constructor(file, seed) {
    this.file = file;
    this.data = seed ? seed : emptyBoard();
    this.dirty = false;
  }

  static load(file) {
    if (!existsSync(file)) return new Board(file);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      // An unreadable board must not take the plugin down; start clean and let
      // the next save replace the damaged file.
      return new Board(file);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Board(file);
    }
    if (!parsed || typeof parsed !== 'object') return new Board(file);
    // Cards written by an earlier version could end up without a status, which
    // made them vanish from every column. Repair on load rather than losing them.
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (!STATUSES.includes(item.status)) item.status = 'todo';
    }
    const board = new Board(file, {
      ...emptyBoard(),
      ...parsed,
      chats: { ...(parsed.chats || {}) },
      items,
    });
    return board;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  // -- chats ------------------------------------------------------------
  chat(username) {
    return this.data.chats[username] || null;
  }

  /**
   * Track a chat, keeping anything already stored for it.
   * @param {string} username
   * @param {object} [patch] Fields such as `label`, `fromDate`, `enabled`.
   */
  ensureChat(username, patch = {}) {
    const current = this.data.chats[username];
    if (current) {
      Object.assign(current, patch);
      // Re-adding a group that was deleted earlier must revive it: `deleteChat`
      // leaves a tombstone, and keeping `deletedAt` would make every later poll
      // and every summarizer write skip the chat forever while the UI still
      // showed it as tracked. Only an explicit tracking patch revives it —
      // `setWatermark` and `setPaused` create-if-missing and must not resurrect
      // a group the user deleted.
      const explicit = Object.keys(patch).length > 0 && patch.enabled !== false;
      if (explicit) {
        if (current.deletedAt) {
          // Reviving invalidates every pass that started before the delete.
          delete current.deletedAt;
          current.epoch = (current.epoch || 0) + 1;
          current.watermark = 0;
        }
        if (patch.paused === undefined) current.paused = false;
      }
      this.dirty = true;
      return current;
    }
    const created = {
      username,
      label: '',
      enabled: true,
      paused: false,
      fromDate: '',
      watermark: 0,
      epoch: 0,
      lastSyncAt: 0,
      lastError: '',
      ...patch,
    };
    this.data.chats[username] = created;
    this.dirty = true;
    return created;
  }

  /**
   * Drop every record derived from a chat: its cards, its watermark, its
   * pause flag, its epoch. The next write from a task that was already running
   * is rejected because its epoch no longer matches.
   */
  deleteChat(username) {
    const existing = this.data.chats[username];
    if (!existing) {
      const before = this.data.items.length;
      this.data.items = this.data.items.filter((item) => item.chat !== username);
      if (this.data.items.length !== before) this.dirty = true;
      return { removed: before - this.data.items.length };
    }
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((item) => item.chat !== username);
    // Keep a tombstone with a bumped epoch rather than forgetting the chat
    // outright: an in-flight summarizer must be able to tell "deleted" from
    // "never seen".
    this.data.chats[username] = {
      ...existing,
      enabled: false,
      paused: true,
      deletedAt: Date.now(),
      epoch: (existing.epoch || 0) + 1,
      watermark: 0,
      lastError: '',
    };
    this.dirty = true;
    return { removed: before - this.data.items.length };
  }

  setPaused(username, paused) {
    const chat = this.ensureChat(username);
    chat.paused = Boolean(paused);
    this.dirty = true;
    return chat;
  }

  setWatermark(username, seq) {
    const chat = this.ensureChat(username);
    const next = Number(seq) || 0;
    if (next > (chat.watermark || 0)) {
      chat.watermark = next;
      this.dirty = true;
    }
    return chat;
  }

  /** Chats the scheduler is allowed to poll: enabled, not paused, not deleted. */
  activeChats() {
    return Object.values(this.data.chats).filter(
      (chat) => chat && chat.enabled !== false && !chat.paused && !chat.deletedAt,
    );
  }

  // -- cards ------------------------------------------------------------
  items(status) {
    const list = this.data.items.slice();
    if (status) return list.filter((item) => item.status === status);
    return list;
  }

  item(id) {
    return this.data.items.find((entry) => entry.id === id) || null;
  }

  /**
   * Insert or update a card.
   *
   * `expectedEpoch` guards against a summarizer that finished after its chat was
   * deleted or reset: the card is dropped instead of being written into a board
   * that no longer has that chat.
   *
   * @param {object} card
   * @returns {object|null} The stored card, or null when rejected.
   */
  upsertItem(card) {
    if (!card || !card.chat) return null;
    const chat = this.data.chats[card.chat];
    if (card.expectedEpoch !== undefined && card.expectedEpoch !== null) {
      const live = chat ? chat.epoch || 0 : 0;
      if (live !== card.expectedEpoch) return null;
    }
    const id = card.id || cardId(card.chat, card.sources);
    let existing = this.data.items.find((entry) => entry.id === id);
    if (!existing) {
      // Same chat, similar title: the model re-described a todo it already
      // reported. Update that card instead of adding a near-duplicate.
      existing = this.data.items.find(
        (entry) => entry.chat === card.chat && similarTitle(entry.title, card.title),
      );
    }
    const now = Date.now();
    if (existing) {
      // Union of the sources so far plus whatever the new pass cited plus any
      // absorbed cards: a merged card has to stay traceable to every message
      // that produced it.
      const sources = new Set(Array.isArray(existing.sources) ? existing.sources : []);
      for (const source of Array.isArray(card.sources) ? card.sources : []) sources.add(source);
      // The model may have decided several existing cards describe one todo.
      // Fold them into the surviving card so the board stops showing the same
      // task three times under three wordings.
      const merged = Array.isArray(card.mergedIds) ? card.mergedIds : [];
      if (merged.length) {
        const ids = new Set(merged.filter((value) => value !== existing.id));
        const absorbed = this.data.items.filter(
          (entry) => ids.has(entry.id) && entry.chat === existing.chat,
        );
        for (const entry of absorbed) {
          for (const source of Array.isArray(entry.sources) ? entry.sources : []) sources.add(source);
        }
        if (absorbed.length) {
          this.data.items = this.data.items.filter(
            (entry) => !ids.has(entry.id) || entry.chat !== existing.chat,
          );
        }
      }
      // Model drafts carry no status, so an update must never overwrite the
      // column: only an explicit valid status (or a human drag) may change it.
      // The one exception is a card that turns out to concern the user while
      // still sitting in the plain backlog: it moves to 需要你 by itself.
      const concernsMe = card.concernsMe === true
        ? true
        : existing.concernsMe === true
          ? true
          : false;
      const keepStatus = existing.movedByUser
        ? existing.status
        : STATUSES.includes(card.status)
          ? card.status
          : concernsMe && existing.status === 'todo'
            ? 'needs-you'
            : existing.status || 'todo';
      // Keep the id the board already published: the UI and any open tab refer
      // to the card by it, and rewriting it here would orphan those references.
      const patch = { ...card };
      delete patch.status;
      delete patch.mergedIds;
      delete patch.sources;
      Object.assign(existing, patch, {
        id: existing.id,
        status: keepStatus,
        sources: Array.from(sources),
        updatedAt: now,
        createdAt: existing.createdAt || card.createdAt || now,
      });
      delete existing.expectedEpoch;
      this.dirty = true;
      return existing;
    }
    const concernsMe = card.concernsMe === true;
    const created = {
      id,
      chat: card.chat,
      chatLabel: card.chatLabel || (chat ? chat.label : '') || card.chat,
      title: card.title || '未命名待办',
      detail: card.detail || '',
      status: STATUSES.includes(card.status) ? card.status : concernsMe ? 'needs-you' : 'todo',
      concernsMe,
      reasons: Array.isArray(card.reasons) ? card.reasons.slice() : [],
      sources: Array.isArray(card.sources) ? card.sources.slice() : [],
      sourceAt: card.sourceAt || 0,
      createdAt: card.createdAt || now,
      updatedAt: now,
      movedByUser: false,
    };
    this.data.items.push(created);
    this.dirty = true;
    return created;
  }

  /** Move a card between columns; this is the only user-driven status change. */
  moveItem(id, status) {
    if (!STATUSES.includes(status)) return null;
    const entry = this.item(id);
    if (!entry) return null;
    entry.status = status;
    entry.movedByUser = true;
    entry.updatedAt = Date.now();
    this.dirty = true;
    return entry;
  }

  deleteItem(id) {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((entry) => entry.id !== id);
    if (this.data.items.length === before) return false;
    this.dirty = true;
    return true;
  }

  /** Cards grouped by column, newest source first inside each column. */
  columns() {
    const out = {};
    for (const status of STATUSES) out[status] = [];
    for (const entry of this.data.items) {
      const bucket = out[entry.status] || out.todo;
      bucket.push(entry);
    }
    for (const status of STATUSES) {
      out[status].sort((a, b) => (b.sourceAt || b.createdAt || 0) - (a.sourceAt || a.createdAt || 0));
    }
    return out;
  }
}

export function defaultBoardPath(dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return join(home, 'wechat-todo', 'board.json');
}
