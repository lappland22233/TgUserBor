# Plugin Development Cookbook

## 最小骨架

```js
'use strict';
module.exports = {
  manifest: { name: 'demo', version: '1.0.0' },
  activate(ctx) {
    ctx.command({ name: 'demo' }, async ({ reply }) => reply('demo online'));
  },
};
```

放到 `plugins/demo/` 下，附 `plugin.json`：

```json
{ "name": "demo", "version": "1.0.0", "entry": "index.js" }
```

保存即热重载。

## PluginContext API

| 字段 | 用途 |
| --- | --- |
| `ctx.logger` | pino 子 logger，自动带 `plugin=<name>` |
| `ctx.bot` | `BotAdapter`：发消息、编辑消息、删消息、查用户/群组 |
| `ctx.bus` | 全局 `EventBus` |
| `ctx.db` | `Database` 原始句柄（`ctx.db.raw()`） |
| `ctx.permissions` | `PermissionManager`，可动态 grant/revoke |
| `ctx.commands` | `CommandRegistry` |
| `ctx.scheduler` | 插件作用域调度器（`delay`, `interval`, `schedule`, `cancel`），随插件卸载自动清理 |
| `ctx.getConfig<T>() / ctx.setConfig(...)` | 插件私有持久配置 |
| `ctx.command(def, handler)` | 注册命令（推荐写法） |
| `ctx.on(event, fn)` | 订阅事件，自动随插件卸载 |
| `ctx.onAny(fn)` | 订阅所有事件 |
| `ctx.getUser(id)` | 查用户 |
| `ctx.ownerId` | 拥有者 ID |

## CommandContext API

```ts
{
  command: { name, args, rawArgs, message },
  reply(text, options?): Promise<void>          // 自动 reply-to
  replyHtml(text, options?): Promise<void>
  editOrReply(text, options?): Promise<void>    // outgoing 消息原地编辑，incoming 消息回复（支持 autoDeleteMs）
  bot: Bot                                      // 访问框架对象
}
```

## 订阅事件

```js
ctx.on('message', async (msg) => { /* ... */ });
ctx.on('message:edited', async (msg) => { /* ... */ });
ctx.on('chat:participant:joined', async ({ chat, participant }) => { /* ... */ });
ctx.onAny(async (event, payload) => { /* ... */ });
```

事件名见 `src/bot/adapter/types.ts → AdapterEventMap`。

## 异步与定时任务

推荐使用内置的 `ctx.scheduler`，插件重载或卸载时会自动注销，杜绝内存泄漏：

```js
activate(ctx) {
  // 延迟 5 秒执行
  ctx.scheduler.delay(5000, async () => {
    ctx.logger.info('Delayed task executed');
  });

  // 每分钟执行一次
  ctx.scheduler.interval(60_000, async () => {
    ctx.logger.info('Periodic heartbeat');
  });
}
```
