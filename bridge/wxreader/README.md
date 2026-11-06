# wxreader — 微信只读读取层

把本机已授权的微信数据库读成结构化数据，供上层插件消费。**只读，不联网，不取密钥。**

## 为什么需要这一层

直接读库能拿到数据，但有五件事不会自动正确。每一条都是先在真实库上测出失败、才写进来的：

| 问题 | 实测 | 本层的做法 |
|---|---|---|
| 群列表不全 | `SessionTable` 只有 127 个群，`chat_room` 有 325 个 | `list_groups()` 走 `chat_room` 取全集 |
| 没有日期过滤 | helper 层无 `create_time` 谓词 | 自己把 `YYYY-MM-DD` 翻成 `create_time` 上下界 |
| `local_id` 不唯一 | 前 60 群 7346 次冲突，31 群跨 2~3 分片 | 身份用 `(chat, shard, local_id)` |
| 发送者会解错 | 369 个 rowid 在各分片指向不同的人 | 按消息所在分片查该分片的 `Name2Id` |
| @我 会大量漏检 | 文本匹配召回率 6.27%（36/574） | 解析 `source` 里的 `<atuserlist>` 与 `message_content` 里的 `<refermsg><fromusr>` |

## 用法

用装了 SQLCipher 驱动的解释器。本机现成的就是 Reader 的 venv：

```powershell
$vpy = "$env:USERPROFILE\.codex\share\wechat-intelligence-hub\projects\rion-wechat-reader\.venv\Scripts\python.exe"
$env:PYTHONUTF8="1"; $env:PYTHONIOENCODING="utf-8"
```

```python
from wxreader import WeChatReader

# 复用 rion-wechat-cli 已授权的配置与密钥，不重新取 key
r = WeChatReader.from_files(
    r"C:\Users\<you>\.config\rion-wechat-reader\config.json",
    r"C:\Users\<you>\.config\rion-wechat-reader\keys.json",
)

r.health()                      # 就绪状态，可安全展示到 UI
groups = r.list_groups()        # 全集，带群名/群主/成员数
page = r.history(groups[0].username, limit=100, since="2026-10-01")

for m in page.messages:
    rep = r.relation(m)
    if rep.related:
        print(m.text[:40], rep.labels())    # ['@了你'] / ['回复了你']

r.close()
```

## 接口

| 方法 | 说明 |
|---|---|
| `from_files(config, keys)` | 从已有的 config/keys 构造；`keys` 省略时用 config 里 `keys_file` |
| `health()` | 就绪检查：驱动、库文件、群数、分片数 |
| `list_chats(limit, include_hidden)` | 会话表里最近活跃的会话（**不是**全集） |
| `list_groups()` | 通讯录里的全部群（**用这个**） |
| `chats_with_messages()` | 每个会话实际有多少条消息 |
| `history(chat, limit, offset, since, before, ascending)` | 分页历史，日期闭区间 |
| `new_messages(chat, since_seq, limit)` | `sort_seq >` 增量，升序 |
| `new_messages_inclusive(chat, watermark, limit)` | **推荐**：`>=` 增量，回看一档 |
| `relation(message)` | 是否与我相关，及原因 |
| `mentioned_ids(message)` | 这条消息 @ 了谁 |

`Page` 返回 `messages / has_more / next_offset / scanned`。

`Message` 同时带 `text`（可读正文）、`content_xml`、`source_xml`（原始解码结果），所以判定相关性不用二次查库。

## 两个必须遵守的约定

**1. 轮询用 `new_messages_inclusive`，不要用 `new_messages`。**

`sort_seq` 会并列（真实库最新 200 条里出现 14 次）。用 `>` 时，水位停在并列值上会让该值的消息**永久不可见**——三组实测全部复现，旧写法命中并列行 = 0。

```python
rows = r.new_messages_inclusive(chat, watermark=last_seq)   # 回看一档
for m in rows:
    if m.key in processed:      # 按 (chat, shard, local_id) 去重
        continue
    ...
```

**2. 不要依赖任何「一次投递一次」的保证。**

语义是 at-least-once。按 `MessageKey` 去重，回调里只做入队，模型调用放异步队列。

## 测试

```powershell
& $vpy -m unittest discover -s wxreader/tests -t .        # 74 项，全离线
& $vpy -m wxreader.live_check --groups 40 --deep          # 真实库验证
```

- `test_codec_mentions.py`（36 项）：纯函数，无需数据库。
- `test_reader.py`（38 项）：在**真实 SQLCipher 加密库**上跑，fixture 复刻真实 schema，包括「两分片同 `local_id` 不同内容」「rowid 跨分片指向不同人」「`sort_seq` 并列」。
- `live_check.py`：对真实库做同样断言，并用独立正则复核解析器（报 `false_negatives`）。

最新真实库结果（2026-11-02）：40 群 / 2962 条消息，sender 错配 0、分页重叠 0、日期过滤生效、解析器误漏 0；全库 49896 行中 @我 301、回复我 177。

## 结构

```
wxreader/
  config.py     配置与密钥（salt→key 匹配）
  codec.py      zstd / UTF-8 解码（纯函数）
  mentions.py   @我 / 回复我 判定（纯函数）
  models.py     Chat / Message / MessageKey / Page
  store.py      WeChatReader，连接、分片、分页、增量
  live_check.py 真实库验证脚本
  tests/
    fixtures.py 生成加密合成库
    test_codec_mentions.py
    test_reader.py
```

## 边界

- 不发送消息、不控制 UI、不写微信库（连接一律 `PRAGMA query_only=ON`）。
- 不提取密钥；密钥只来自传入的 `keys.json`。
- 不访问网络。
- 明文库（无 salt）自动不需要密钥。
