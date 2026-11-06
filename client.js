/**
 * Three-column board: groups on the left, the selected group's messages in the
 * middle, and todo / doing / needs-you on the right.
 *
 * Everything is read from the host plugin's HTTP surface. The UI never touches
 * WeChat, never talks to a model, and keeps no state of its own beyond what is
 * on screen — dragging a card is a request, not a local edit, so a failed call
 * leaves the board showing the truth.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-todo',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'wechat-todo';
    const PANEL_ID = 'wechat-todo';
    const BASE = '/wechat-todo';

    const COPY = {
      zh: {
        nav: '微信群待办',
        groups: '群聊',
        messages: '群聊记录',
        board: '看板',
        searchPlaceholder: '搜索群名称',
        pickGroup: '从左侧选择一个群',
        pickGroupHint: '选择后可以查看完整群聊记录，并把它加入看板跟踪。',
        track: '加入看板',
        tracking: '已在看板',
        pause: '暂停',
        resume: '继续',
        remove: '删除本地数据',
        confirmRemove: '删除这个群的本地待办、摘要与同步进度？微信原始聊天不会被修改。',
        summarize: '重新总结',
        summarizing: '总结中…',
        trackAll: '全部启用',
        untrackAll: '全部暂停',
        confirmTrackAll: '对全部 %d 个群启用同步与总结？会按批次慢慢跑完，期间会多次调用模型。',
        confirmUntrackAll: '暂停全部群的同步与总结？已有看板卡片会保留。',
        trackAllDone: '已对 %d 个群启用同步与总结。',
        untrackAllDone: '已暂停全部群。',
        loadMore: '加载更多',
        noMessages: '这个群没有可读的消息。',
        noCards: '还没有卡片',
        noCardsHint: '同步并总结后，这里会出现可跟进的待办。',
        related: '与我相关',
        fromDate: '起始日期',
        totalGroups: '个群',
        withMessages: '个有消息',
        silentGroups: '个群暂无本地消息',
        sources: '来源',
        generatedAt: '生成于',
        openSource: '定位到原文',
        notInPage: '这条原文不在当前范围，已按时间重新加载。',
        messageCount: '条',
        dragHint: '拖动卡片可改变状态',
        selfLabel: '我',
        errorTitle: '出错了',
        retry: '重试',
        statusTodo: '待办',
        statusDoing: '进行中',
        statusNeedsYou: '需要你',
      },
      en: {
        nav: 'WeChat Todos',
        groups: 'Groups',
        messages: 'Messages',
        board: 'Board',
        searchPlaceholder: 'Search groups',
        pickGroup: 'Pick a group on the left',
        pickGroupHint: 'Select one to read its full history and put it on the board.',
        track: 'Track',
        tracking: 'Tracked',
        pause: 'Pause',
        resume: 'Resume',
        remove: 'Delete local data',
        confirmRemove: 'Delete this group’s local todos, summaries and sync progress? The WeChat chat itself is untouched.',
        summarize: 'Summarize',
        summarizing: 'Summarizing…',
        trackAll: 'Track all',
        untrackAll: 'Pause all',
        confirmTrackAll: 'Sync and summarize all %d groups? It runs in batches and calls the model many times.',
        confirmUntrackAll: 'Pause syncing and summarizing for every group? Existing cards stay on the board.',
        trackAllDone: 'Sync and summarize enabled for %d groups.',
        untrackAllDone: 'All groups paused.',
        loadMore: 'Load more',
        noMessages: 'This group has no readable messages.',
        noCards: 'No cards yet',
        noCardsHint: 'Cards appear here once a sync has been summarized.',
        related: 'About you',
        fromDate: 'Start date',
        totalGroups: 'groups',
        withMessages: 'with messages',
        silentGroups: 'without local messages',
        sources: 'sources',
        generatedAt: 'created',
        openSource: 'Show original',
        notInPage: 'That message was outside the page; reloaded by time.',
        messageCount: 'msgs',
        dragHint: 'Drag a card to change its column',
        selfLabel: 'Me',
        errorTitle: 'Something went wrong',
        retry: 'Retry',
        statusTodo: 'Todo',
        statusDoing: 'Doing',
        statusNeedsYou: 'Needs you',
      },
    };

    function languageOf(locale) {
      try {
        const snapshot = locale?.getLocale?.() || locale?.getSnapshot?.() || null;
        const tag = snapshot?.id || snapshot?.locale || snapshot?.language;
        if (tag) return String(tag).toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        /* fall through */
      }
      const nav = globalThis.navigator?.language;
      if (nav) return String(nav).toLowerCase().startsWith('zh') ? 'zh' : 'en';
      return 'zh';
    }

    function textOf(locale, key) {
      const lang = languageOf(locale);
      return COPY[lang]?.[key] ?? COPY.zh[key] ?? key;
    }

    function fill(template, value) {
      return String(template).replace('%d', String(value));
    }

    // -- small helpers -------------------------------------------------
    const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';

    function pad(value) {
      return String(value).padStart(2, '0');
    }

    function formatTime(ms) {
      const value = Number(ms) || 0;
      if (!value) return '';
      const date = new Date(value);
      const now = new Date();
      const sameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      if (sameDay) return clock;
      const sameYear = date.getFullYear() === now.getFullYear();
      return `${sameYear ? '' : `${date.getFullYear()}-`}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
    }

    function dayString(ms) {
      const date = new Date(Number(ms) || Date.now());
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    async function request(path, options) {
      const response = await fetch(`${BASE}${path}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok === false) {
        const code = payload?.code || `http-${response.status}`;
        const detail = payload?.message ? `: ${payload.message}` : '';
        throw new Error(`${code}${detail}`);
      }
      return payload;
    }

    function post(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }

    /**
     * Wait until the host has no summarization pass outstanding.
     *
     * `/summarize` only queues the work and answers immediately, so the caller
     * has no response to await. `pending` in the board payload is the only
     * honest signal that the pass finished (or was dropped).
     */
    async function waitForIdle(reload, options = {}) {
      const { timeoutMs = 180000, intervalMs = 1500 } = options;
      const started = Date.now();
      // Give the queue a moment to pick the job up at all, otherwise the very
      // first read still reports pending 0 and the wait exits instantly.
      await new Promise((resolve) => setTimeout(resolve, 400));
      while (Date.now() - started < timeoutMs) {
        const data = await reload();
        const pending = Number(data?.state?.pending ?? 0);
        if (!pending) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      return false;
    }

    // -- relation chips -------------------------------------------------
    function RelationChips({ labels, compact }) {
      if (!labels || !labels.length) return null;
      return h(
        'span',
        { style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
        labels.map((label) =>
          h(
            'span',
            {
              key: label,
              style: {
                fontSize: compact ? 10 : 11,
                lineHeight: '16px',
                padding: compact ? '0 4px' : '1px 6px',
                borderRadius: 4,
                color: 'var(--dsw-alias-brand-primary)',
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
                whiteSpace: 'nowrap',
              },
            },
            label,
          ),
        ),
      );
    }

    // -- one message ----------------------------------------------------
    function MessageRow({ message, highlighted, locale, rowRef }) {
      const mine = message.fromMe;
      return h(
        'div',
        {
          ref: rowRef,
          'data-message-id': message.id,
          style: {
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 8,
            padding: '6px 10px',
            borderRadius: 8,
            background: highlighted ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            borderLeft: highlighted
              ? '2px solid var(--dsw-alias-brand-primary)'
              : '2px solid transparent',
          },
        },
        h(
          'div',
          {
            style: {
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap',
              paddingTop: 2,
              fontVariantNumeric: 'tabular-nums',
            },
          },
          formatTime(message.time),
        ),
        h(
          'div',
          { style: { minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h(
              'span',
              {
                style: {
                  fontSize: 12,
                  fontWeight: mine ? 600 : 500,
                  color: mine
                    ? 'var(--dsw-alias-brand-primary)'
                    : 'var(--dsw-alias-label-primary)',
                },
              },
              mine ? textOf(locale, 'selfLabel') : message.senderName || message.sender || '—',
            ),
            h(RelationChips, { labels: message.relationLabels, compact: true }),
          ),
          h(
            'div',
            {
              style: {
                fontSize: 13,
                lineHeight: '20px',
                color: 'var(--dsw-alias-label-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                marginTop: 2,
                opacity: message.text ? 1 : 0.6,
              },
            },
            message.text || '',
          ),
          message.quoted
            ? h(
                'div',
                {
                  style: {
                    marginTop: 4,
                    padding: '4px 8px',
                    borderLeft: '2px solid var(--dsw-alias-border-l2)',
                    fontSize: 12,
                    lineHeight: '18px',
                    color: 'var(--dsw-alias-label-secondary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                `${message.quoted.displayName || message.quoted.fromUser || ''}：${message.quoted.content || ''}`,
              )
            : null,
        ),
      );
    }

    // -- the panel ------------------------------------------------------
    function Panel(props) {
      const locale = props?.locale;
      const [, setTick] = React.useState(0);

      const [groups, setGroups] = React.useState([]);
      const [groupMeta, setGroupMeta] = React.useState({ total: 0, silent: 0 });
      const [filter, setFilter] = React.useState('');
      const [selected, setSelected] = React.useState('');
      const [messages, setMessages] = React.useState([]);
      const [page, setPage] = React.useState({ hasMore: false, nextOffset: 0, loading: false });
      const [board, setBoard] = React.useState({ columns: {}, tracked: [], state: {} });
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [dragging, setDragging] = React.useState('');
      const [hoverColumn, setHoverColumn] = React.useState('');
      const [focusId, setFocusId] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [fromDate, setFromDate] = React.useState('');

      const messageRefs = React.useRef(new Map());
      const listRef = React.useRef(null);

      const trackedMap = React.useMemo(() => {
        const map = {};
        for (const record of board.tracked || []) map[record.username] = record;
        return map;
      }, [board.tracked]);

      const boardTrackedCount = React.useMemo(
        () => (board.tracked || []).filter((record) => record.enabled && !record.paused).length,
        [board.tracked],
      );

      const cardsByChat = React.useMemo(() => {
        const map = {};
        for (const status of Object.keys(board.columns || {})) {
          for (const card of board.columns[status] || []) {
            map[card.chat] = (map[card.chat] || 0) + 1;
          }
        }
        return map;
      }, [board.columns]);

      React.useEffect(() => {
        if (!props?.locale?.subscribe) return undefined;
        const off = props.locale.subscribe(() => setTick((value) => value + 1));
        return typeof off === 'function' ? off : undefined;
      }, [props?.locale]);

      const loadGroups = React.useCallback(
        async (refresh) => {
          setError('');
          try {
            const data = await request(`/chats${refresh ? '?refresh=1' : ''}`);
            setGroups(data.chats || []);
            setGroupMeta({ total: data.totalGroups || 0, silent: data.withoutMessages || 0 });
          } catch (failure) {
            setError(String(failure.message || failure));
          }
        },
        [],
      );

      const loadBoard = React.useCallback(async () => {
        try {
          const data = await request('/board');
          setBoard({
            columns: data.columns || {},
            tracked: data.tracked || [],
            state: data.state || {},
          });
          return data;
        } catch (failure) {
          setError(String(failure.message || failure));
          return null;
        }
      }, []);

      React.useEffect(() => {
        loadGroups(false);
        loadBoard();
      }, [loadGroups, loadBoard]);

      React.useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          loadBoard();
        }, 20000);
        if (typeof timer.unref === 'function') timer.unref();
        return () => clearInterval(timer);
      }, [loadBoard]);

      const loadMessages = React.useCallback(async (chat, options = {}) => {
        if (!chat) return;
        const { offset = 0, append = false, since = '', before = '' } = options;
        setPage((current) => ({ ...current, loading: true }));
        try {
          const params = new URLSearchParams({ chat, limit: '60' });
          if (offset) params.set('offset', String(offset));
          if (since) params.set('since', since);
          if (before) params.set('before', before);
          const data = await request(`/messages?${params.toString()}`);
          setMessages((current) => (append ? [...current, ...(data.messages || [])] : data.messages || []));
          setPage({
            hasMore: Boolean(data.hasMore),
            nextOffset: data.nextOffset || 0,
            loading: false,
          });
        } catch (failure) {
          setError(String(failure.message || failure));
          setPage((current) => ({ ...current, loading: false }));
        }
      }, []);

      const selectGroup = React.useCallback(
        (chat) => {
          setSelected(chat);
          setFocusId('');
          setNotice('');
          setMessages([]);
          setPage({ hasMore: false, nextOffset: 0, loading: false });
          loadMessages(chat);
        },
        [loadMessages],
      );

      const jumpToSource = React.useCallback(
        async (card, sourceId) => {
          if (!card || !sourceId) return;
          if (!card.sourceAt) {
            setNotice(textOf(locale, 'notInPage'));
            return;
          }
          const day = 24 * 60 * 60 * 1000;
          const since = dayString(card.sourceAt - day);
          const before = dayString(card.sourceAt + day);
          if (selected !== card.chat) setSelected(card.chat);
          setFocusId(sourceId);
          await loadMessages(card.chat, { since, before });
        },
        [loadMessages, selected, locale],
      );

      React.useEffect(() => {
        if (!focusId) return;
        const node = messageRefs.current.get(focusId);
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, [focusId, messages]);

      const act = React.useCallback(
        async (label, runner) => {
          setBusy(label);
          setError('');
          try {
            await runner();
            await loadBoard();
          } catch (failure) {
            setError(String(failure.message || failure));
          } finally {
            setBusy('');
          }
        },
        [loadBoard],
      );

      const onTrackAll = React.useCallback(
        (enabled) => {
          const template = textOf(locale, enabled ? 'confirmTrackAll' : 'confirmUntrackAll');
          if (typeof window !== 'undefined' && !window.confirm(fill(template, groups.length))) return;
          act('track-all', async () => {
            const result = await post('/track-all', { enabled });
            await loadGroups(false);
            await loadBoard();
            setNotice(
              enabled
                ? fill(textOf(locale, 'trackAllDone'), result?.tracked ?? groups.length)
                : textOf(locale, 'untrackAllDone'),
            );
            setTimeout(() => setNotice(''), 6000);
          });
        },
        [act, groups.length, loadBoard, loadGroups, locale],
      );

      const onTrack = React.useCallback(
        (chat) => {
          const group = groups.find((item) => item.username === chat);
          act('track', async () => {
            await post('/track', {
              chat,
              label: group?.label || chat,
              fromDate,
            });
            await loadBoard();
          });
        },
        [act, groups, loadBoard, fromDate],
      );

      const onTogglePause = React.useCallback(
        (chat) => {
          const record = trackedMap[chat];
          act('pause', () => post('/pause', { chat, paused: !record?.paused }));
        },
        [act, trackedMap],
      );

      const onRemove = React.useCallback(
        (chat) => {
          if (typeof window !== 'undefined' && !window.confirm(textOf(locale, 'confirmRemove'))) return;
          act('remove', async () => {
            await post('/track', { chat, untrack: true });
            setMessages([]);
            setSelected('');
            await loadBoard();
          });
        },
        [act, locale],
      );

      const onSummarize = React.useCallback(
        (chat) => {
          act('summarize', async () => {
            await post('/summarize', { chat });
            setNotice(textOf(locale, 'summarizing'));
            // The queue is drained by the host, so the only way to know the
            // pass ended is to watch `state.pending`. Without this the banner
            // stayed on screen forever after the cards had already appeared.
            await waitForIdle(loadBoard);
            setNotice('');
          });
        },
        [act, loadBoard, locale],
      );

      const onDrop = React.useCallback(
        (status) => {
          const id = dragging;
          setDragging('');
          setHoverColumn('');
          if (!id) return;
          const card = Object.values(board.columns || {})
            .flat()
            .find((entry) => entry.id === id);
          if (!card || card.status === status) return;
          act('move', () => post('/move', { id, status }));
        },
        [act, board.columns, dragging],
      );

      const visibleGroups = React.useMemo(() => {
        const needle = filter.trim().toLowerCase();
        if (!needle) return groups;
        return groups.filter(
          (group) =>
            String(group.label || '').toLowerCase().includes(needle) ||
            String(group.username || '').toLowerCase().includes(needle),
        );
      }, [filter, groups]);

      const selectedGroup = groups.find((group) => group.username === selected) || null;
      const selectedRecord = trackedMap[selected] || null;

      // -- styles ------------------------------------------------------
      const shellStyle = {
        display: 'grid',
        gridTemplateColumns: 'minmax(190px, 0.6fr) minmax(280px, 1.2fr) minmax(380px, 1.6fr)',
        height: '100%',
        minHeight: 0,
        // Another installed plugin paints a `position: fixed`, z-index 1000
        // status strip across the top of the window. It is not part of this
        // panel, so reserve room for it instead of letting it cover the column
        // headers and the first row of messages.
        paddingTop: 34,
        boxSizing: 'border-box',
        fontFamily: FONT,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        overflow: 'hidden',
      };
      const columnStyle = {
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        minWidth: 0,
        borderRight: '1px solid var(--dsw-alias-border-l1)',
      };
      const headerStyle = {
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      };
      const titleStyle = {
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: 'var(--dsw-alias-label-secondary)',
        textTransform: 'uppercase',
      };
      const bodyStyle = { flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 };

      function buttonStyle(primary) {
        return {
          fontFamily: FONT,
          fontSize: 11,
          padding: '3px 9px',
          borderRadius: 6,
          cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap',
        };
      }

      // -- left column --------------------------------------------------
      const leftColumn = h(
        'div',
        { style: columnStyle },
        h(
          'div',
          { style: { ...headerStyle, flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
            h('div', { style: titleStyle }, textOf(locale, 'groups')),
            h(
              'div',
              { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              `${groups.length} / ${groupMeta.total + groupMeta.silent} ${textOf(locale, 'totalGroups')}`,
            ),
          ),
          h('input', {
            value: filter,
            onChange: (event) => setFilter(event.target.value),
            placeholder: textOf(locale, 'searchPlaceholder'),
            style: {
              fontFamily: FONT,
              fontSize: 12,
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-primary)',
              outline: 'none',
            },
          }),
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h(
              'button',
              {
                type: 'button',
                onClick: () => onTrackAll(true),
                disabled: busy === 'track-all' || groups.length === 0,
                title: fill(textOf(locale, 'confirmTrackAll'), groups.length),
                style: buttonStyle(false),
              },
              textOf(locale, 'trackAll'),
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => onTrackAll(false),
                disabled: busy === 'track-all' || boardTrackedCount === 0,
                title: textOf(locale, 'confirmUntrackAll'),
                style: buttonStyle(false),
              },
              textOf(locale, 'untrackAll'),
            ),
            h(
              'div',
              {
                style: {
                  fontSize: 10,
                  color: 'var(--dsw-alias-label-secondary)',
                  marginLeft: 'auto',
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              `${boardTrackedCount}/${groups.length}`,
            ),
          ),
        ),
        h(
          'div',
          { style: bodyStyle },
          visibleGroups.length === 0
            ? h(
                'div',
                {
                  style: {
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-secondary)',
                    padding: '12px 6px',
                    lineHeight: '18px',
                  },
                },
                groups.length === 0
                  ? textOf(locale, 'noMessages')
                  : textOf(locale, 'searchPlaceholder'),
              )
            : visibleGroups.map((group) => {
                const active = group.username === selected;
                const record = trackedMap[group.username];
                const cardCount = cardsByChat[group.username] || 0;
                return h(
                  'button',
                  {
                    key: group.username,
                    type: 'button',
                    onClick: () => selectGroup(group.username),
                    style: {
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      fontFamily: FONT,
                      padding: '7px 8px',
                      marginBottom: 2,
                      borderRadius: 7,
                      cursor: 'pointer',
                      border: '1px solid transparent',
                      background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      color: 'inherit',
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                    h(
                      'div',
                      {
                        style: {
                          fontSize: 13,
                          fontWeight: active ? 600 : 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        },
                      },
                      group.label || group.username,
                    ),
                    cardCount
                      ? h(
                          'span',
                          {
                            style: {
                              fontSize: 10,
                              padding: '0 5px',
                              borderRadius: 8,
                              background: 'var(--dsw-alias-brand-primary)',
                              color: 'var(--dsw-alias-bg-base)',
                              fontVariantNumeric: 'tabular-nums',
                            },
                          },
                          cardCount,
                        )
                      : null,
                  ),
                  h(
                    'div',
                    {
                      style: {
                        fontSize: 11,
                        color: 'var(--dsw-alias-label-secondary)',
                        marginTop: 2,
                        fontVariantNumeric: 'tabular-nums',
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                      },
                    },
                    h('span', null, `${group.messageCount} ${textOf(locale, 'messageCount')}`),
                    group.lastTime ? h('span', null, formatTime(group.lastTime)) : null,
                    record?.paused
                      ? h(
                          'span',
                          { style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                          textOf(locale, 'pause'),
                        )
                      : null,
                  ),
                );
              }),
        ),
      );

      // -- middle column ------------------------------------------------
      const middleColumn = h(
        'div',
        { style: { ...columnStyle, borderRight: '1px solid var(--dsw-alias-border-l1)' } },
        h(
          'div',
          { style: { ...headerStyle, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { flex: 1, minWidth: 120 } },
            h(
              'div',
              { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              selectedGroup?.label || (selected ? selected : textOf(locale, 'messages')),
            ),
            selectedGroup
              ? h(
                  'div',
                  { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 1 } },
                  `${selectedGroup.messageCount} ${textOf(locale, 'messageCount')}`,
                )
              : null,
          ),
          selected
            ? h(
                'div',
                { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                selectedRecord
                  ? null
                  : h(
                      'input',
                      {
                        type: 'date',
                        value: fromDate,
                        title: textOf(locale, 'fromDate'),
                        'aria-label': textOf(locale, 'fromDate'),
                        onChange: (event) => setFromDate(event.target.value),
                        style: {
                          width: 118,
                          padding: '3px 6px',
                          borderRadius: 6,
                          border: '1px solid var(--dsw-alias-border-l2)',
                          background: 'var(--dsw-alias-bg-base)',
                          color: 'var(--dsw-alias-label-primary)',
                          fontFamily: FONT,
                          fontSize: 11,
                        },
                      },
                    ),
                selectedRecord
                  ? null
                  : h(
                      'button',
                      { type: 'button', style: buttonStyle(true), onClick: () => onTrack(selected) },
                      textOf(locale, 'track'),
                    ),
                selectedRecord
                  ? h(
                      'button',
                      { type: 'button', style: buttonStyle(false), onClick: () => onTogglePause(selected) },
                      textOf(locale, selectedRecord.paused ? 'resume' : 'pause'),
                    )
                  : null,
                selectedRecord
                  ? h(
                      'button',
                      { type: 'button', style: buttonStyle(false), onClick: () => onSummarize(selected) },
                      busy === 'summarize' ? textOf(locale, 'summarizing') : textOf(locale, 'summarize'),
                    )
                  : null,
                selectedRecord
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: { ...buttonStyle(false), color: 'var(--dsw-alias-state-error-primary)' },
                        onClick: () => onRemove(selected),
                      },
                      textOf(locale, 'remove'),
                    )
                  : null,
              )
            : null,
        ),
        h(
          'div',
          { style: bodyStyle, ref: listRef },
          !selected
            ? h(
                'div',
                { style: { padding: 16, lineHeight: '20px' } },
                h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, textOf(locale, 'pickGroup')),
                h(
                  'div',
                  { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                  textOf(locale, 'pickGroupHint'),
                ),
              )
            : messages.length === 0 && !page.loading
              ? h(
                  'div',
                  { style: { padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                  textOf(locale, 'noMessages'),
                )
              : messages.map((message) =>
                  h(MessageRow, {
                    key: message.id,
                    message,
                    locale,
                    highlighted: message.related || message.id === focusId,
                    rowRef: (node) => {
                      if (node) messageRefs.current.set(message.id, node);
                      else messageRefs.current.delete(message.id);
                    },
                  }),
                ),
          page.hasMore
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: page.loading,
                  onClick: () =>
                    loadMessages(selected, { offset: page.nextOffset, append: true }),
                  style: { ...buttonStyle(false), width: '100%', marginTop: 8 },
                },
                page.loading ? '…' : textOf(locale, 'loadMore'),
              )
            : null,
        ),
      );

      // -- right column -------------------------------------------------
      const columnOrder = ['todo', 'doing', 'needs-you'];
      const columnLabels = {
        todo: textOf(locale, 'statusTodo'),
        doing: textOf(locale, 'statusDoing'),
        'needs-you': textOf(locale, 'statusNeedsYou'),
      };

      function renderCard(card) {
        const related = Array.isArray(card.reasons) && card.reasons.length > 0;
        return h(
          'div',
          {
            key: card.id,
            'data-card-id': card.id,
            draggable: true,
            onDragStart: (event) => {
              setDragging(card.id);
              try {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', card.id);
              } catch {
                /* some browsers refuse; the dragging state still drives the drop */
              }
            },
            onDragEnd: () => {
              setDragging('');
              setHoverColumn('');
            },
            style: {
              padding: '7px 9px',
              marginBottom: 6,
              borderRadius: 8,
              cursor: 'grab',
              // Flex children shrink by default; inside a bounded column that
              // squeezed cards below their text height and the text spilled over
              // the neighbouring card.
              flex: '0 0 auto',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: `1px solid ${related ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
              opacity: dragging === card.id ? 0.5 : 1,
            },
          },
          h(
            'div',
            {
              style: {
                fontSize: 13,
                fontWeight: 500,
                lineHeight: '19px',
                wordBreak: 'break-word',
              },
            },
            card.title,
          ),
          card.detail
            ? h(
                'div',
                {
                  style: {
                    fontSize: 11,
                    lineHeight: '17px',
                    color: 'var(--dsw-alias-label-secondary)',
                    marginTop: 3,
                    wordBreak: 'break-word',
                  },
                },
                card.detail,
              )
            : null,
          related
            ? h(
                'div',
                { style: { marginTop: 4 } },
                h(RelationChips, { labels: card.reasons, compact: true }),
              )
            : null,
          h(
            'div',
            {
              style: {
                marginTop: 5,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                fontSize: 10,
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            h(
              'span',
              {
                style: {
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 130,
                },
                title: card.chatLabel || card.chat,
              },
              card.chatLabel || card.chat,
            ),
            h('span', { style: { opacity: 0.6 } }, `· ${(card.sources || []).length}`),
            h('span', { style: { opacity: 0.6, fontVariantNumeric: 'tabular-nums' } }, formatTime(card.createdAt)),
            h(
              'button',
              {
                type: 'button',
                title: textOf(locale, 'openSource'),
                onClick: () => jumpToSource(card, (card.sources || [])[0]),
                style: {
                  fontFamily: FONT,
                  fontSize: 10,
                  padding: '0 4px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  marginLeft: 'auto',
                },
              },
              textOf(locale, 'openSource'),
            ),
          ),
        );
      }

      const rightColumn = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 } },
        h(
          'div',
          { style: headerStyle },
          h('div', { style: titleStyle }, textOf(locale, 'board')),
          h(
            'div',
            { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
            textOf(locale, 'dragHint'),
          ),
        ),
        h(
          'div',
          {
            style: {
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
              padding: 8,
              // A real three-lane board: side by side, never wrapping. Each lane
              // scrolls on its own so a long 待办 lane cannot bury 进行中/需要你.
              // Wrapping or a grid here made a long lane paint over its neighbours.
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'stretch',
              gap: 8,
            },
          },
          columnOrder.map((status) => {
            const cards = (board.columns || {})[status] || [];
            const hovered = hoverColumn === status;
            return h(
              'div',
              {
                key: status,
                'data-column': status,
                onDragOver: (event) => {
                  event.preventDefault();
                  if (hoverColumn !== status) setHoverColumn(status);
                },
                onDragLeave: () => setHoverColumn((current) => (current === status ? '' : current)),
                onDrop: (event) => {
                  event.preventDefault();
                  onDrop(status);
                },
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  flex: '1 1 0',
                  minWidth: 0,
                  minHeight: 0,
                  maxHeight: '100%',
                  overflowY: 'auto',
                  borderRadius: 10,
                  padding: 6,
                  background: hovered ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  border: `1px dashed ${hovered ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '2px 4px 6px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                h('span', null, columnLabels[status]),
                h(
                  'span',
                  {
                    style: {
                      fontSize: 10,
                      padding: '0 5px',
                      borderRadius: 8,
                      background: 'var(--dsw-alias-bg-layer-2)',
                      fontVariantNumeric: 'tabular-nums',
                    },
                  },
                  cards.length,
                ),
              ),
              cards.length
                ? cards.map(renderCard)
                : h(
                    'div',
                    {
                      style: {
                        fontSize: 11,
                        lineHeight: '17px',
                        color: 'var(--dsw-alias-label-secondary)',
                        padding: '8px 4px',
                        opacity: 0.75,
                      },
                    },
                    textOf(locale, 'noCards'),
                  ),
            );
          }),
        ),
      );

      const banner =
        error || notice
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: 12,
                  right: 12,
                  bottom: 10,
                  zIndex: 5,
                  padding: '6px 10px',
                  borderRadius: 8,
                  fontSize: 11,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  background: 'var(--dsw-alias-bg-overlay)',
                  border: `1px solid ${error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)'}`,
                  color: error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
                },
              },
              h('span', { style: { flex: 1, wordBreak: 'break-word' } }, error || notice),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    setError('');
                    setNotice('');
                  },
                  style: buttonStyle(false),
                },
                '×',
              ),
            )
          : null;

      return h(
        'div',
        { style: { position: 'relative', height: '100%', minHeight: 0 } },
        h('div', { style: shellStyle }, leftColumn, middleColumn, rightColumn),
        banner,
      );
    }

    // -- crash guard ----------------------------------------------------
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false, message: '' };
      }

      static getDerivedStateFromError(error) {
        return { failed: true, message: String(error?.message || error) };
      }

      componentDidCatch(error) {
        console.warn('[wechat-todo] panel crashed', error);
      }

      render() {
        if (!this.state.failed) return this.props.children;
        return h(
          'div',
          {
            style: {
              padding: 20,
              fontFamily: FONT,
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '微信群待办'),
          h(
            'div',
            { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
            this.state.message,
          ),
        );
      }
    }

    function PanelIcon({ size = 16, active = false }) {
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M4 9.5c0-2 1.8-3.6 4-3.6h8c2.2 0 4 1.6 4 3.6v4c0 2-1.8 3.6-4 3.6h-4.6L8 19.4v-2.5c-2.3-.3-4-1.8-4-3.4z',
          stroke,
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 10.5h8M8 13h5', stroke, strokeWidth: 1.6, strokeLinecap: 'round' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let layout;

        // `inject` names the slot that has to exist before this plugin may
        // register; the panel key it adds is a separate, open-ended value.
        const dispose = ctx.slots.inject('sidebar.panellist', () => {
          const offPanel = ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS },
            () => h(PanelBoundary, null, h(Panel, { locale: ctx.get ? ctx.get('locale') : undefined })),
          );
          const offRow = ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => textOf(ctx.get ? ctx.get('locale') : undefined, 'nav'),
              locale: NS,
            },
            (owner = {}) => h(PanelIcon, { size: owner.size ?? 16, active: Boolean(owner.active) }),
          );
          return () => {
            try {
              if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) {
                layout.selectPanel(null);
              }
            } catch {
              /* the layout may be gone already */
            }
            if (typeof offRow === 'function') offRow();
            if (typeof offPanel === 'function') offPanel();
          };
        });

        try {
          ctx.inject(['layout'], (scoped) => {
            layout = scoped.layout;
          });
        } catch {
          /* layout is optional; only used to clear the panel on unload */
        }

        if (typeof dispose === 'function') {
          ctx.effect(() => dispose);
        }
      },
    };
  },
});
