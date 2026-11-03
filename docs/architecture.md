# 架构概览

## 分层

```
┌──────────────────────────────────────────────┐
│  src/index.ts                                │
│  ─ load config → init logger → new Bot       │
└──────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│  Bot (core/bot.ts)                           │
│  ─ 编排：adapter + bus + plugins + commands  │
└──────────────────────────────────────────────┘
       │             │              │
       ▼             ▼              ▼
   Adapter       EventBus       PluginManager
   (MTProto)     (pub/sub)      (hot reload)
                   ▲
                   │
            commands + permissions
                   ▲
                   │
            plugins (plugins/<name>/)
```

## 数据流：用户发了一条消息

1. `TelegramDriver` 的 `NewMessage` handler 把 MTProto `Api.Message` 转换为 `IncomingMessage`
2. `Bot` 把它 `emit('message', msg)` 到 `EventBus`
3. `Bot.handleMessage` 订阅 `message` 事件：
   - 用 `CommandParser.parse` 拆出命令
   - `CommandRegistry.resolve` 找到命令（plugin + handler）
   - `PermissionManager.resolve` 检查权限
   - 写一条 `command_usage` 记录
   - 调用 `handler(ctx)`，ctx 暴露 `reply / replyHtml / bot`
4. 监听原始事件的插件也能通过 `ctx.on('message', ...)` 拿到同一份 `IncomingMessage`

## 关键设计

- **Adapter 抽象**：所有平台相关代码都在 `driver/`；插件只依赖 `adapter/types.ts`
- **EventBus 双订阅**：`bot.on('message', ...)` 同时被 `Bot.handleMessage` 和插件共享，
  监听器自动随插件卸载（`PluginManager.buildContext` 收集 `ListenerHandle`）
- **插件配置持久化**：`PluginContext.getConfig/setConfig` 读写 `plugin_state.config_json`
- **权限优先级**：plugin 默认 > user > chat，匹配顺序见 `permission/index.ts`
- **热重载**：`chokidar` 监听 `plugins/*` 的文件变化 → `PluginManager.reload(name)`
  - 旧 handler 通过 `commands.unregister(name)` + listener 卸载
  - 新模块通过 `require()`（dev 下直接 require .ts）

## 表结构（SQLite）

```
schema_migrations          框架迁移版本
users                      已见过的用户（占位，可由插件填充）
chats                      已见过的会话
plugin_state               (name, enabled, config_json)
command_usage              调用审计
permissions                (scope, target_id, plugin, level)
```

scope 含义：
- `plugin` + target_id=0 → 整个插件的默认等级
- `user`   + target_id=N → 该用户对该插件/命令的等级
- `chat`   + target_id=N → 该群对该插件/命令的等级
