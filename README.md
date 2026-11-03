# TGuserBOT Framework

一个基于 **MTProto** 的 Telegram userbot 框架（TypeScript）。
插件化、命令化、权限化、轻量持久化，开箱即用。

> ⚠️ Telegram userbot 账号有被封风险。请使用专用小号，不要在生产/重要账号上运行。

---

## ✨ 特性

- **MTProto 登录**（`telegram` 库，纯 JS），无需 Bot Token
- **插件系统**：从 `plugins/` 自动加载，支持**热重载**、按需启用/禁用
- **命令解析器**：多前缀（`.` `/` 可配），支持引号参数和别名
- **三级权限控制**：全局 / 用户 / 群组 / 插件
- **持久化**：`better-sqlite3`，自动迁移；插件配置 + 使用记录
- **结构化日志**：`pino` 写入 `data/logs/bot.log`
- **平台无关的 Adapter**：未来可换成 Bot API 或其他 IM 而不改插件代码

---

## 📁 项目结构

```
.
├── src/                        # 框架核心代码 (TypeScript)
│   ├── index.ts                # 入口
│   └── bot/
│       ├── adapter/            # 平台无关的事件与消息模型
│       ├── config/             # 配置加载 (.env)
│       ├── core/               # Bot 编排 + EventBus
│       ├── database/           # SQLite 持久化 + migrations
│       ├── driver/             # Telegram MTProto 实现
│       ├── logger/             # pino 日志
│       ├── parser/             # 命令解析 & 注册表
│       ├── permission/         # 权限模型
│       └── plugin/             # 插件 API + 加载器
├── plugins/                    # 用户插件（每个子目录 = 一个插件）
│   ├── hello/                  # /hello 问候
│   ├── echo/                   # /echo /ping
│   ├── welcome/                # 入群欢迎
│   └── plugins/                # /plugins 插件管理
├── data/                       # 运行时数据
│   ├── db/                     # SQLite 文件
│   ├── logs/                   # 日志文件
│   └── sessions/               # MTProto StringSession
├── docs/                       # 设计文档
├── scripts/                    # 运维脚本
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 🚀 快速开始

### 1. 安装

```bash
npm install
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`，填入：

| 字段 | 说明 |
| --- | --- |
| `TG_API_ID` / `TG_API_HASH` | 在 https://my.telegram.org/apps 获取 |
| `TG_OWNER_ID` | 你的 Telegram 数字 ID（可通过 @userinfobot 获取） |

其余字段可保留默认。

### 3. 构建

```bash
npm run build
```

### 4. 启动方式

#### 🐧 方式 0：Linux 一键安装与全自动启动（Linux 服务器强烈推荐 🌟）

在任何 Linux 系统（Ubuntu / Debian / CentOS / Alpine / Arch）上，仅需执行一条命令：

```bash
chmod +x start.sh && ./start.sh
```

脚本将全自动处理：
- 🔍 检测系统包管理器并自动安装 C++ 编译工具链（`build-essential`, `python3` 等，保障 `better-sqlite3` 编译）
- ⚡ 自动检测 Node.js 环境（无 Node.js 时支持一键引导安装 NodeSource LTS 22）
- 📦 自动补充并安装 npm 依赖
- ⚙️ 自动检测并初始化 `.env` 配置文件
- 🔨 自动执行 TypeScript 编译构建
- 🚀 提供开箱即用选择菜单：**Web GUI 面板** / **单实例控制台** / **PM2 后台常驻守护**

> **进阶自由端口与快捷用法**：
> ```bash
> ./start.sh 3001          # 直接以 3001 端口启动 Web GUI (自由端口)
> ./start.sh gui 8080      # 指定 8080 端口启动
> ./start.sh pm2 3001      # 指定 3001 端口使用 PM2 在后台常驻运行
> ./start.sh stop          # 停止 PM2 后台常驻
> ./start.sh build         # 仅检查依赖与编译，不启动
> ```

#### 方式 A：现代 Web GUI 多实例管理控制台（跨平台推荐 🌟）

```bash
npm run gui
```

启动后控制台会自动在默认浏览器打开 **`http://localhost:3000`**：
- 🤖 **多实例托管**：支持同时托管多个 Telegram 账号，各实例独立 Session、SQLite 与网络代理，进程强隔离。
- 🔑 **Web 端免终端登录**：直接在网页弹窗输入手机号、验证码与 2FA 密码，彻底脱离命令行。
- 📊 **实时监控**：查看宿主机与各实例的 CPU、内存占用、消息吞吐量与在线状态。
- 🧩 **实时插件中心**：在线安装新插件、一键彻底卸载、按实例独立开关与热重载、可视化修改持久化配置。
- 📜 **全屏日志流**：支持按实例、级别（INFO/WARN/ERROR）过滤与关键字搜索。

#### 方式 B：单实例命令行模式

```bash
npm start
```

首次启动会要求在终端输入手机号、验证码（以及二步验证密码）。登录信息会保存到 `data/sessions/bot.session`，下次启动自动复用。

> 开发模式（自动重启）：
> ```bash
> npm run dev
> ```

---

## 🧩 编写一个插件

每个插件 = `plugins/<name>/` 下的一个目录，至少包含：

- `plugin.json` — 清单
- `index.js`（或 `index.ts`）— 入口

### `plugin.json`

```json
{
  "name": "hello",
  "version": "1.0.0",
  "description": "Friendly greeting command.",
  "entry": "index.js"
}
```

### `index.js`

```js
'use strict';

module.exports = {
  manifest: { name: 'hello', version: '1.0.0' },

  activate(ctx) {
    // 注册命令
    ctx.command(
      { name: 'hello', description: 'Say hi.' },
      async ({ command, reply }) => {
        await reply(`Hello, ${command.args[0] || 'friend'}!`);
      },
    );

    // 监听消息事件（自动随插件卸载）
    ctx.on('message', async (msg) => {
      if (msg.text === 'ping') await ctx.bot.sendMessage(msg.chat.id, 'pong');
    });

    // 读写插件配置（自动持久化到 SQLite）
    ctx.setConfig({ greeting: 'Hi' });
    console.log(ctx.getConfig()); // { greeting: 'Hi' }
  },

  async deactivate() {
    // 可选：清理外部资源
  },
};
```

修改 `index.js` 后保存，框架会在几百毫秒内**热重载**该插件（无需重启）。

### 内置插件

| 插件 | 命令 / 功能 | 说明 |
| --- | --- | --- |
| **help** | `.help [cmd/plugin]` | 交互式命令菜单与详细用法说明 |
| **media** | `.send` / `.dl` / `.pin` / `.unpin` / `.fwd` | 媒体文件收发、附件下载到本地、消息静默置顶与跨会话转发 |
| **admin** | `.ban` / `.unban` / `.kick` / `.mute` / `.unmute` / `.promote` / `.demote` / `.members` / `.settitle` / `.setdesc` / `.leave` | 强大完整的群组/频道管理套件 |
| **status** | `.online` / `.offline` / `.typing` / `.name` / `.bio` / `.setphoto` | 个人在线隐身状态、正在输入触发、姓名/简介修改与一键换头像 |
| **note** | `.note` / `.get` / `.notes` / `.delnote` | 跨对话云端便签与快捷常用语回复系统 (SQLite 持久化) |
| **history** | `.search` / `.getmsg` | 对话历史消息全文检索与指定消息详情深度提取 |
| **reaction** | `.react` / `.unreact` | Telegram 原生消息 Emoji 快速反应互动 |
| **sticker** | `.stickerpack` / `.getsticker` | 贴纸包详情查询与贴纸提取转换为静态图片 |
| **contacts**| `.dialogs` / `.contacts` / `.chatinfo` / `.userinfo` | 对话列表看板、通讯录名录与会话/用户元数据探查 |
| **schedule**| `.schedule`（别名 `.sch`/`.timer`）`<add/addto/list/del/run/clear>` | 定时发送与自动循环重复广播调度器 (SQLite持久化，重启不丢失) |
| **system** | `.ping` / `.status` / `.restart` | 延迟测速、系统与硬件状态监控、平滑重启 |
| **purge** | `.del`（别名 `.d`）/ `.purge <count>` | 单条回复撤回与批量快速清理 |
| **afk** | `.afk [reason]` | 离开状态自动防刷屏回复与上线全量汇报 |
| **tools** | `.id` / `.calc` / `.time` / `.tr` / `.qr` | 实体 ID 查询、数学计算、多时区时钟、免 Key 文本翻译、二维码生成 |
| **eval** | `.eval <code>` / `.sh <cmd>` | 运行时 JavaScript 及 Shell 执行（严格 Owner Only） |
| **plugins** | `.plugins <list/enable/disable/reload>` | 插件状态管理与热重载控制（Owner Only） |
| **welcome** | 进群事件监听 / `.setwelcome` | 新成员进群自定义模版欢迎 |
| **hello** | `.hello` / `.setgreeting` | 打招呼问候演示插件 |
| **echo** | `.echo <text>` | 消息回显示例 |

---

## 🛡 权限模型

`AccessLevel`：数值越小权限越高。

| 级别 | 值 | 含义 |
| --- | --- | --- |
| `OWNER` | 0 | 完全放行（默认 ownerId 用户或自身发出消息） |
| `ADMIN` | 1 | 管理员级别（受限放行） |
| `USER` | 2 | 普通用户默认级别 |
| `DENIED` | 3 | 完全禁止 |

修改权限（在 `.env` 加载后通过 SQL 或插件 API）：

```ts
import { AccessLevel, PermissionManager } from 'tguserbot-framework';

permissions.grant('user',  123456, 'hello',  AccessLevel.OWNER); // 让某用户对 hello 插件用 OWNER 权限
permissions.grant('chat', -1001234567890, 'echo', AccessLevel.DENIED); // 在某群禁用 echo
permissions.grant('plugin', 0, 'ban', AccessLevel.OWNER);           // ban 插件全局只允许 owner
permissions.revoke('user', 123456, 'hello');
```

---

## 📜 命令解析

- 支持多前缀（`COMMAND_PREFIXES=.,/`，默认）
- 引号参数：`/say "hello world" foo` → `args = ['hello world', 'foo']`
- 别名：

  ```js
  ctx.commands.alias('h', 'hello');
  ```

- 通过 `command.rawArgs` 拿到原始字符串。

---

## 🔌 Adapter 与扩展

`BotAdapter` 是平台无关接口。框架默认提供 `TelegramDriver`（MTProto）。
你可以在 `src/bot/driver/` 下加新的 adapter（Bot API、Slack、Discord……）
并在 `Bot` 构造时注入。

---

## 🛠 常用脚本

```bash
npm run build      # tsc 编译到 dist/
npm run dev        # ts-node-dev 热重载（仅源码，插件需单独 watch）
npm start          # 启动编译产物
npm run typecheck  # 类型检查
npm run clean      # 删除 dist/ 与 data/sessions/
```

---

## ⚠️ 安全与网络隔离规范 (Web Security Specification)

- **控制台本地回路锁定 (Loopback Isolation)**：
  - TGuserBOT Web 控制台属于高权限特权控制面，拥有会话收发、数据持久化与插件代码执行能力。
  - **默认强制监听 `127.0.0.1`**（本地回环地址），**严禁默认绑定到 `0.0.0.0`**，禁止直接暴露在公网接口。
  - 远程服务器访问推荐采用 SSH 端口转发隧道：
    ```bash
    ssh -L 10001:127.0.0.1:10001 root@<远程服务器IP>
    ```
    本地浏览器直通访问 `http://127.0.0.1:10001`，实现端到端安全传输。
- **凭据与隐私保护**：
  - 切勿在框架代码或公开仓库中硬编码任何敏感凭据（API ID、API Hash、2FA 密码、Session）；`.env` 已被 `.gitignore`。
  - 使用 userbot 模式登录个人账号违反 Telegram TOS，请使用专用小号。
  - 框架仅供个人学习与开发使用，禁止用于骚扰、批量群发广告等违规用途。

---

## 📚 进阶

- 详见 `docs/architecture.md`
- **中间件机制**：使用 `ctx.use((msg, next) => ...)` 在命令解析执行前拦截过滤全量消息
- **过滤器 DSL**：使用 `ctx.filters` 灵活组合消息筛选器（`Filters.and(Filters.photo(), Filters.group())` 等）
- **会话状态机**：使用 `ctx.conversation(chatId, userId).ask('请输入你的名字:')` 实现多轮问答向导
- **速率限制器**：使用 `ctx.ratelimit.check(userId, actionKey, { windowMs, maxRequests })` 杜绝刷屏
- **媒体收发快捷方式**：使用 `ctx.sendPhoto` / `ctx.sendVideo` / `ctx.sendFile` / `ctx.sendSticker` / `ctx.downloadMedia` / `ctx.pinMessage` 等
- **插件定时任务**：使用 `ctx.scheduler.delay`、`ctx.scheduler.interval` 或 `ctx.scheduler.schedule`，插件卸载时会自动清理，杜绝句柄泄漏
- **交互式编辑**：使用 `ctx.editOrReply(text, options)`，自身发送的消息原地编辑，避免刷屏
- **自定义 Adapter**？参考 `src/bot/driver/telegram.ts` 实现 `BotAdapter`
