/**
 * Host half of the WeChat group → todo board plugin.
 *
 * Responsibilities, and deliberately nothing else:
 *   - own the Python read bridge and the JSON board on disk
 *   - expose a small HTTP surface under `/wechat-todo/`
 *   - run the summarizer queue off the polling loop
 *
 * The UI is entirely in `client.js`; the host never registers a slot. WeChat is
 * only ever read: no message is sent, no database is written, and the key store
 * is opened read-only.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Board, STATUSES, STATUS_LABELS, defaultBoardPath } from './lib/board.js';
import { Sidecar } from './lib/sidecar.js';
import { SYSTEM_PROMPT, digest, parseCards } from './lib/summarize.js';

export const name = 'dsh-wechat-todo';

export const inject = ['webServer', 'connection'];

/** Polling cadence for the summarizer queue. */
const TICK_MS = 30000;

/** Hard ceiling on how many messages one summarization pass may cover. */
const MAX_BATCH = 120;

/**
 * Summarization passes to run per tick. With every group tracked the first poll
 * can queue more than a hundred chats; draining them all back to back would
 * spend an hour of model calls before the UI ever breathes.
 */
const MAX_PASSES_PER_TICK = 3;

const HERE = fileURLToPath(new URL('.', import.meta.url));

function serviceOf(ctx, key) {
  try {
    const value = typeof ctx.get === 'function' ? ctx.get(key) : undefined;
    if (value) return value;
  } catch {
    /* a missing optional service must not be fatal */
  }
  return undefined;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function rejectUntrusted(ctx, req, res) {
  const connection = serviceOf(ctx, 'connection');
  if (!connection || typeof connection.requestRejection !== 'function') {
    sendJson(res, 503, { ok: false, code: 'local-auth-unavailable' });
    return true;
  }
  try {
    // `requestRejection` answers with a status number, not an object.
    const code = connection.requestRejection(req);
    if (code === undefined || code === null) return false;
    const status = code === 401 ? 401 : 403;
    sendJson(res, status, { ok: false, code: status === 401 ? 'local-auth-rejected' : 'forbidden' });
    return true;
  } catch {
    sendJson(res, 403, { ok: false, code: 'local-auth-failed' });
    return true;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function apply(ctx, config = {}) {
  const webServer = serviceOf(ctx, 'webServer');
  if (!webServer) {
    ctx.logger?.warn?.('wechat-todo: webServer is unavailable, the board will not be served');
    return;
  }

  const boardPath = config.boardPath || defaultBoardPath(process.env.DSH_HOME);
  const board = Board.load(boardPath);
  const bridge = new Sidecar({
    script: join(HERE, 'bridge', 'server.py'),
    python: config.python || undefined,
    onLog: (line) => ctx.logger?.warn?.(`wechat-todo: ${line}`),
  });

  let disposed = false;
  let timer = null;
  let working = false;
  /** Chats waiting for a summarization pass, and the epoch they were queued at. */
  const queue = [];
  const state = {
    lastPollAt: 0,
    lastError: '',
    lastSummaryAt: 0,
    summaryCount: 0,
  };

  /** How many summarization passes are still outstanding, right now. */
  function pendingCount() {
    return queue.length + (working ? 1 : 0);
  }

  function requireChat(username) {
    if (!username) throw Object.assign(new Error('chat is required'), { code: 'chat-required' });
    return username;
  }

  // -- summarization ---------------------------------------------------
  function enqueue(chat, options = {}) {
    const record = board.chat(chat);
    if (!record || record.deletedAt || record.paused) return;
    if (queue.some((entry) => entry.chat === chat)) return;
    queue.push({ chat, epoch: record.epoch || 0, force: Boolean(options.force) });
  }

  async function summarizeOne(entry) {
    const llm = serviceOf(ctx, 'llm');
    if (!llm || typeof llm.stream !== 'function') {
      throw Object.assign(new Error('the model service is unavailable'), { code: 'llm-unavailable' });
    }
    const record = board.chat(entry.chat);
    // The chat may have been deleted or reset while this pass was queued.
    if (!record || record.deletedAt || (record.epoch || 0) !== entry.epoch) return { skipped: true };

    // Summarize forward from the watermark. Reading "the newest 120" instead
    // re-summarized the same backlog on every pass and produced duplicate
    // cards; `poll` returns the rows at or above the watermark, oldest first.
    // A forced pass ignores the watermark so the user can re-read the tail.
    const page = await bridge.call('poll', {
      chats: [entry.chat],
      watermarks: entry.force ? {} : { [entry.chat]: record.watermark || 0 },
      fromDates: record.fromDate ? { [entry.chat]: record.fromDate } : {},
      limit: MAX_BATCH,
    });
    const event = (page.events || []).find((item) => item.chat === entry.chat) || null;
    const messages = event?.messages || [];
    if (!messages.length) {
      // Nothing new: do not call the model, and do not move the watermark.
      const idle = board.chat(entry.chat);
      if (idle) {
        idle.lastSyncAt = Date.now();
        idle.lastError = '';
      }
      return { cards: 0, unchanged: true };
    }

    const batch = digest({
      chatLabel: record.label || entry.chat,
      messages,
      maxMessages: MAX_BATCH,
      existingCards: board.items().filter((card) => card.chat === entry.chat),
    });
    const maxSeq = messages.reduce((acc, message) => Math.max(acc, Number(message.sortSeq) || 0), 0);
    if (!batch.used.length) {
      // Every row in the window was noise (images, stickers, system notices).
      // The watermark still has to move, otherwise the next poll returns the
      // same rows and the chat is re-queued forever without ever progressing.
      board.setWatermark(entry.chat, maxSeq);
      const quiet = board.chat(entry.chat);
      if (quiet) {
        quiet.lastSyncAt = Date.now();
        quiet.lastError = '';
      }
      return { cards: 0, skipped: true };
    }

    const selection = selectionOf(ctx);
    let reply = '';
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: batch.text }] }],
      maxTokens: 2000,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') reply += chunk.text;
      else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw Object.assign(new Error(chunk.reason.failure?.message || 'the model call failed'), {
          code: chunk.reason.failure?.code || 'llm-error',
        });
      }
    }

    const existingCards = board.items().filter((card) => card.chat === entry.chat);
    const drafts = parseCards(reply, {
      chat: entry.chat,
      chatLabel: record.label || entry.chat,
      idByIndex: batch.idByIndex,
      existingIds: new Set(existingCards.map((card) => card.id)),
      existingById: new Map(existingCards.map((card) => [card.id, card])),
    });
    let written = 0;
    for (const draft of drafts) {
      // `expectedEpoch` makes the board reject writes for a chat that was
      // deleted while the model was thinking.
      const stored = board.upsertItem({ ...draft, expectedEpoch: entry.epoch });
      if (stored) written += 1;
    }
    // Watermark only advances after the pass succeeded, so a failure retries
    // instead of silently skipping the backlog.
    board.setWatermark(entry.chat, maxSeq);
    const chat = board.chat(entry.chat);
    if (chat) {
      chat.lastSyncAt = Date.now();
      chat.lastError = '';
    }
    state.summaryCount += written;
    state.lastSummaryAt = Date.now();
    return { cards: written };
  }

  async function drainQueue() {
    if (working || disposed) return;
    working = true;
    let passes = 0;
    try {
      while (queue.length && !disposed && passes < MAX_PASSES_PER_TICK) {
        const entry = queue.shift();
        passes += 1;
        try {
          await summarizeOne(entry);
        } catch (error) {
          state.lastError = String(error?.message || error);
          const record = board.chat(entry.chat);
          if (record && !record.deletedAt) {
            record.lastError = state.lastError;
            board.dirty = true;
          }
          ctx.logger?.warn?.(`wechat-todo: summarization failed for ${entry.chat}: ${state.lastError}`);
        }
      }
      if (board.dirty) board.save();
    } finally {
      working = false;
    }
  }

  function selectionOf(context) {
    const modelService = serviceOf(context, 'agentDefaultModel');
    try {
      const current = modelService?.currentSelection?.();
      if (current && current.provider && current.model) {
        return { provider: current.provider, model: current.model };
      }
    } catch {
      /* fall through to the configured default */
    }
    const fallback = config.model || {};
    return {
      provider: fallback.provider || 'deepseek',
      model: fallback.model || 'deepseek-chat',
    };
  }

  // -- polling ---------------------------------------------------------
  async function pollOnce() {
    const active = board.activeChats();
    if (!active.length) return { events: 0 };
    const watermarks = {};
    const fromDates = {};
    for (const chat of active) {
      watermarks[chat.username] = chat.watermark || 0;
      if (chat.fromDate) fromDates[chat.username] = chat.fromDate;
    }
    const reply = await bridge.call('poll', {
      chats: active.map((chat) => chat.username),
      watermarks,
      fromDates,
      limit: MAX_BATCH,
    });
    let count = 0;
    for (const event of reply.events || []) {
      const record = board.chat(event.chat);
      if (!record || record.deletedAt || record.paused) continue;
      // The poll is inclusive on purpose (`sort_seq >= watermark`), so the row
      // sitting exactly on the watermark always comes back. Treating that as
      // news re-queued every tracked chat on every tick and never drained.
      if (Number(event.maxSortSeq) <= (record.watermark || 0)) continue;
      if (Array.isArray(event.messages) && event.messages.length) {
        count += event.messages.length;
        enqueue(event.chat);
      }
    }
    state.lastPollAt = Date.now();
    return { events: count };
  }

  async function tick() {
    if (disposed || working) return;
    try {
      await pollOnce();
    } catch (error) {
      state.lastError = String(error?.message || error);
    }
    await drainQueue();
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((error) => ctx.logger?.warn?.(`wechat-todo: tick failed: ${error}`));
    }, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // -- HTTP surface ----------------------------------------------------
  const register = (path, handler, methods = ['GET']) =>
    webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (disposed) return;
        if (rejectUntrusted(ctx, req, res)) return;
        if (!methods.includes(req.method || 'GET')) {
          sendJson(res, 405, { ok: false, code: 'method-not-allowed' });
          return;
        }
        try {
          await handler(req, res);
        } catch (error) {
          const code = error?.code || 'internal-error';
          const status = code === 'chat-required' ? 400 : 500;
          if (status === 500) ctx.logger?.warn?.(`wechat-todo: ${path} failed: ${error?.message || error}`);
          sendJson(res, status, { ok: false, code, message: String(error?.message || error) });
        }
      },
    });

  ctx.effect(() => {
    const disposers = [];
    const cleanup = () => {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      bridge.dispose();
      if (board.dirty) {
        try {
          board.save();
        } catch {
          /* shutting down; nothing useful left to do */
        }
      }
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
    try {
      disposers.push(
        register('/wechat-todo/health', async (req, res) => {
          const health = await bridge.call('health', {});
          sendJson(res, 200, { ok: true, ...health, boardPath, state });
        }),
        register('/wechat-todo/chats', async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost');
          const refresh = url.searchParams.get('refresh') === '1';
          const data = await bridge.call('chats', { refresh });
          const tracked = {};
          for (const chat of Object.values(board.data.chats)) {
            if (chat.deletedAt) continue;
            tracked[chat.username] = chat;
          }
          sendJson(res, 200, { ok: true, ...data, tracked });
        }),
        register('/wechat-todo/messages', async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost');
          const chat = requireChat(url.searchParams.get('chat'));
          const data = await bridge.call('messages', {
            chat,
            limit: Number(url.searchParams.get('limit') || 60),
            offset: Number(url.searchParams.get('offset') || 0),
            since: url.searchParams.get('since') || '',
            before: url.searchParams.get('before') || '',
          });
          sendJson(res, 200, { ok: true, ...data });
        }),
        register('/wechat-todo/board', async (req, res) => {
          sendJson(res, 200, {
            ok: true,
            columns: board.columns(),
            statuses: STATUSES,
            statusLabels: STATUS_LABELS,
            selfUsername: board.data.selfUsername || '',
            selfNickname: board.data.selfNickname || '',
            tracked: Object.values(board.data.chats).filter((chat) => !chat.deletedAt),
            state: { ...state, pending: pendingCount() },
          });
        }),
        register(
          '/wechat-todo/track',
          async (req, res) => {
            const body = await readBody(req);
            const chat = requireChat(body.chat);
            if (body.untrack) {
              const result = board.deleteChat(chat);
              board.save();
              sendJson(res, 200, { ok: true, ...result });
              return;
            }
            const record = board.ensureChat(chat, {
              label: body.label || '',
              fromDate: body.fromDate || '',
              enabled: true,
              paused: Boolean(body.paused),
            });
            board.save();
            if (body.paused) sendJson(res, 200, { ok: true, chat: record });
            else {
              enqueue(chat);
              drainQueue().catch(() => {});
              sendJson(res, 200, { ok: true, chat: record });
            }
          },
          ['POST'],
        ),
        register(
          '/wechat-todo/pause',
          async (req, res) => {
            const body = await readBody(req);
            const chat = requireChat(body.chat);
            const record = board.setPaused(chat, Boolean(body.paused));
            board.save();
            sendJson(res, 200, { ok: true, chat: record });
          },
          ['POST'],
        ),
        register(
          '/wechat-todo/move',
          async (req, res) => {
            const body = await readBody(req);
            const item = board.moveItem(String(body.id || ''), String(body.status || ''));
            if (!item) {
              sendJson(res, 400, { ok: false, code: 'unknown-card' });
              return;
            }
            board.save();
            sendJson(res, 200, { ok: true, item });
          },
          ['POST'],
        ),
        register(
          '/wechat-todo/delete-card',
          async (req, res) => {
            const body = await readBody(req);
            const removed = board.deleteItem(String(body.id || ''));
            if (removed) board.save();
            sendJson(res, 200, { ok: true, removed });
          },
          ['POST'],
        ),
        register(
          '/wechat-todo/track-all',
          async (req, res) => {
            const body = await readBody(req);
            const enabled = body.enabled !== false;
            const data = await bridge.call('chats', { refresh: false });
            const chats = Array.isArray(data.chats) ? data.chats : [];
            let tracked = 0;
            for (const chat of chats) {
              if (!chat?.username) continue;
              const record = board.ensureChat(chat.username, {
                label: chat.label || chat.username,
                enabled,
                ...(enabled ? { paused: false } : {}),
              });
              if (record) tracked += 1;
            }
            board.save();
            // The poller picks these up on its next tick, a few at a time, so
            // enabling everything does not fire a hundred model calls at once.
            sendJson(res, 200, { ok: true, enabled, tracked });
          },
          ['POST'],
        ),
        register(
          '/wechat-todo/summarize',
          async (req, res) => {
            const body = await readBody(req);
            const chat = requireChat(body.chat);
            // The button means "look at the current tail again", so it ignores
            // the watermark. The automatic poller stays incremental.
            enqueue(chat, { force: true });
            drainQueue().catch(() => {});
            sendJson(res, 200, { ok: true, queued: true });
          },
          ['POST'],
        ),
      );
    } catch (error) {
      cleanup();
      throw error;
    }
    startTimer();
    return cleanup;
  });

  return { board, bridge };
}

export default { name, inject, apply };
