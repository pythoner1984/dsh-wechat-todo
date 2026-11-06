# dsh-wechat-todo

把微信群聊变成可跟进的待办看板。左侧群列表、中间群聊记录、右侧三列看板（待办 / 进行中 / 需要你）。

微信只读：不发送消息、不写微信数据库、不申请密钥、不联网（除把群聊原文发给所选模型做总结）。

## 安装

### 前置

- 已安装 DeepSeek Harness（`dsh`）并初始化好 profile。
- 本机微信已配置只读读取所需的 `~/.config/rion-wechat-reader/config.json` 与 `keys.json`（见下方「配置」）。插件不负责取密钥。

### 方式一：从 GitHub 直接安装（命令行）

```sh
# 默认 profile 名是 web；自定义 profile 就替换 web
dsh plugin --profile web add github:pythoner1984/dsh-wechat-todo
```

装完重启 `dsh web`，然后在侧栏点击「微信群待办」进入。

> `dsh plugin` 会把参数转发给 profile 目录里的 pnpm，`github:owner/repo` 是 pnpm 的标准 git 依赖写法，会克隆本仓库并按其 `package.json` 安装。本插件没有 `postinstall`/`prepare` 脚本，无需构建授权。

### 方式二：通过插件市场安装（图形界面）

先安装官方插件市场 dshmarket：

```sh
dsh plugin --profile web add dshmarket
```

装完市场后，在 **Plugins → Discover**（或侧栏「插件市场」）里搜索 `dsh-wechat-todo` 一键安装。

> 桌面版（DSH Desktop）请勿用命令行装市场——它会装进 `profiles/web` 而不是桌面版使用的 profile。请在应用内 **Settings → Plugins** 里安装 dshmarket，再去市场搜索。

## 组成

```
index.js           Host 半：HTTP 路由、轮询、总结队列
client.js          Client 半：三栏 UI，注册 sidebar.panellist + main slot
lib/board.js       看板数据（<DSH_HOME>/wechat-todo/board.json）
lib/sidecar.js     常驻 Python 子进程的 JSON-lines 客户端
lib/summarize.js   摘要提示词、消息摘要生成、模型回复解析
bridge/server.py   Python 桥：把 wxreader 暴露成 JSON-lines 命令
bridge/wxreader/   读取层（SQLCipher 只读，含 91 项测试）
```

Python 解释器按顺序探测：`WECHAT_TODO_PYTHON` → rion-wechat-reader 的 venv → `python.exe` / `python3`。
需要该解释器装有 `sqlcipher3` 与 `zstandard`。

## 配置

复用已有的读取配置，不额外保存密钥：

- `~/.config/rion-wechat-reader/config.json`（库路径、`self_username`）
- `~/.config/rion-wechat-reader/keys.json`（按数据库 salt 索引的密钥）

看板数据在 `$DSH_HOME/wechat-todo/board.json`，只在本机。

## 行为

- **群列表**取自 `chat_room`（不是 `SessionTable`：后者只有 127 个会话，且 `type` 全是 0，无法区分群与私聊）。
- **消息身份**是 `(群, 分片, local_id)`：`local_id` 在分片之间会重复（本机实测 7346 次冲突）。
- **增量轮询用 `>=`**（`new_messages_inclusive`），因为同一 `sort_seq` 可以有多行，严格 `>` 会永久丢掉第二行。
- **「需要你」由结构化信号决定**，不看模型措辞：解析 `source` 列的 `<atuserlist>`（@我）与 `message_content` 列的 `<refermsg><fromusr>`（回复我）。渲染文本匹配的召回率只有 6.27%，因为微信在昵称里插入了 U+2005。
- **水位只在总结成功后推进**；删除群会让在途任务因 `epoch` 不匹配而写回失败。
- **起始日期**由插件在本地过滤，`wxreader` 没有按 `create_time` 过滤的查询。

## 开发

```powershell
# Node 测试（必须显式写 test/*.test.js）
& 'C:\Program Files\nodejs\node.exe' --test test/*.test.js

# 读取层测试
$vpy = "$env:USERPROFILE\.codex\share\wechat-intelligence-hub\projects\rion-wechat-reader\.venv\Scripts\python.exe"
$env:PYTHONUTF8="1"; $env:PYTHONIOENCODING="utf-8"
& $vpy -m unittest discover -s bridge/wxreader/tests -t bridge

# 真实库联调（不写微信库）
& 'C:\Program Files\nodejs\node.exe' test/live-smoke.mjs
```

改完 `index.js` / `client.js` 后要让宿主重载 bundle：
`plugin_manager` → `set_plugin target=include:wechat-todo` 先 `enabled:false` 再 `enabled:true`，然后刷新页面。

## 边界

- 只读：不发送、不撤回、不控制微信界面。
- 不自己取密钥：只用 `keys.json` 里已有的密钥。
- 总结会把群聊原文发给所选模型服务。
