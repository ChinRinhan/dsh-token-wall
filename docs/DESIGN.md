# 架构与设计

这份文档讲「为什么这么实现」。使用者只需要看 [README](../README.md)。

## 整体结构

```
index.js          Host 半：Cordis 插件，注册路由、采集、落盘
client.js         Client 半：手写 ModuleLoader bundle，五个 slot + 桌宠
lib/fold.js       桶键、按日聚合、区间汇总
lib/collect.js    会话日志解析、实时事件解析
lib/store.js      日聚合文档的读写与合并
lib/prefs.js      运行时开关（独立于 Cordis config）
lib/models.js     模型名归一化与归并
lib/blocks.js     方块换算（10M 一格、100 格一页）
```

Host 与 Client 之间只有 HTTP 通信。Client 是手写的 `window.__ModuleLoader__.load({ id, factory })` bundle，**不能 import** `lib/**`——所以像方块换算这类逻辑在两边各有一份实现，靠 `test/blocks-cross.test.mjs` 逐字段比对防漂移。

## 数据流

```
会话日志 (jsonl.zstd)  ──┐
                        ├─→ collect.js ─→ entry ─→ fold.js ─→ store.days
session/event 实时事件 ──┘                              │
                                                        ↓
                                            /today /summary /workspaces /prefs
                                                        │
                                              client.js（轮询 + 渲染）
```

回填与实时**共用**同一个 fold 入口，所以口径不会漂。

## 去重：水位线

会话日志 append-only，`seq` 从 0 连续且永不重写。因此「该会话已计数的最大 seq」这一个数就是完备的去重状态。

回填与实时共用它：每条事件最多入账一次，重启也不重算。

```
watermarks: { "session-abc": 412 }   // 该会话已处理到 seq 412
```

## fork 继承前缀

fork / resume 出来的会话，日志前缀是从父会话**继承**的，那些用量父会话已经计过。

`SessionHandle.inheritedEventCount` 精确给出继承前缀长度，所以只计 `seq >= inheritedEventCount` 的自有事件。

⚠️ 水位线**不能**替代它：水位线按 sessionId 分开存，子会话有自己的水位线，光靠它会把继承前缀当成新事件照单全收。

## 桶键

```
scope | kind | workspace | provider | model
```

- `scope`：`main` / `sub`——**谁发起的**。子代理、团队队友、workflow 子会话都是独立 session，默认计入（要完整反映真实消耗）
- `kind`：`chat` / `aux`——**是不是辅助调用**（压缩摘要）

两者正交（子会话里的压缩既是 sub 又是 aux），所以各给一个开关。

### 4 段 → 5 段的历史兼容

加 `workspace` 时，盘上 400 天的历史全是 4 段。如果 `parseBucketKey` 只认 5 段，那些桶会被当脏数据整体跳过，累计瞬间从 3.05B 跌到 0——这是本插件最不能接受的失效模式。

所以读侧**同时接受 4 段与 5 段**（4 段按 `workspace: ''` 读）。

历史回填无法精确知道旧桶属于哪个工作区（旧桶里没有 sessionId），`tools/migrate-workspace.mjs` 用当天的占比分摊：

- 合计零漂移
- 迁移后分布与独立试算一致
- 幂等：重跑迁移 0 个桶

这是**近似**：某个工作区若只在特定 provider 上用过，按比例分摊会把它摊到别的 provider 桶里。用途是看趋势和分布，这个误差可接受。

## 合计口径

```
totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
```

provider 上报的 `TokenUsage.totalTokens` 通常只是 input+output，**不是一回事**，所以不读那个字段。

`outputTokens` 按 DSH 口径已含思考 token，`reasoningTokens` 只作拆分项。

## 存储

`$DSH_HOME/token-usage/daily.json`：

```json
{
  "schema": "dsh-token-usage/daily/v1",
  "days": { "2026-10-12": { "main|chat|workbuddy|deepseek-v4.1-flash": { } } },
  "watermarks": { "session-abc": 412 }
}
```

几个决定：

- **独立文档**，不进 `state.json`——后者会被别的插件整体重写，不认识的键会静默消失
- **只落日聚合，不落明细**：写入量与请求量解耦（同一格只加数，不增行）
- **增量合并写**：`flush()` 是「重读盘 → 只加相对上次基线的增量 → 原子写」，两个实例并存时不互相抹掉
- **节流落盘**：默认 2 秒防抖。记账在推理关键路径上，每笔都同步写盘会把「一次推理」变成「一次磁盘写」。窗口内崩溃最多丢最近 2 秒
- **保留期**：默认 400 天，落盘时淘汰更早的日键

⚠️ 已知限制：`flush()` 的「读 → 改 → 写」不是跨进程原子操作，两个真实进程密集并发写时后写者可能基于陈旧快照覆盖。根治需要文件锁或改追加日志形态。

## 模型归并

同一个模型会走多个渠道，名字带不同前缀/后缀：

```
deepseek-v4.1-flash             1.54B
workbuddy/deepseek-v4.1-flash   25.6M
deepseek-ai/deepseek-v4.1-flash   52K
deepseek-v4.1-flash-free        23.1M
```

按原名分组会得到 4 行，看不出这是同一个模型。

`lib/models.js` 只做三条**安全**规则，全部是「去掉渠道/计费装饰」：

| 规则 | 例子 |
|---|---|
| 去掉 `vendor/` 前缀 | `workbuddy/deepseek-v4.1-flash` → `deepseek-v4.1-flash` |
| 去掉 `-free` / `:free` 后缀 | `deepseek-v4.1-flash-free` → `deepseek-v4.1-flash` |
| 小写 | `Spark-X2.5-4B` → `spark-x2.5-4b` |

**不合并不同代际**：`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4.1-flash` 是三个版本，合并会掩盖「还在用旧模型」。

**认不出厂商就归 `unknown`（显示为「其他」）**，不猜。`dfmodel` / `qfmodel` 这类名字硬猜会造出假数据。可以在 `config.modelAliases` 里显式声明。

### 归并在读取侧做

桶键仍是 `scope|kind|workspace|provider|model`，历史数据一个字节没动。`groupBy=modelNorm` / `vendor` 是**先按原始 model 聚合、再在 host 侧合并**。

好处：改 `modelAliases` 不需要重算历史、不需要迁移。

为什么在 host 侧：归并需要 `config.modelAliases`（部署期配置），client 拿不到 Config。

## 运行时开关

`cordis.patch.yml` 的 `config` 是**部署期**配置，改了要重启。但「把桌宠关掉」不该重启，所以另存 `$DSH_HOME/token-usage/prefs.json`，host 提供读写端点。

三个开关正交，任意组合合法。

### 为什么「立即生效」的实现分两种

slot 注册是**一次性**的，而开关是运行时可变的。所以：

- **slot 类模块**（主面板、侧栏图标、横幅）：**始终注册**，由包装组件按开关渲染成 `null`。开关一变，组件 re-render，面板立刻出现/消失
- **桌宠**：不是 React 组件（命令式 DOM 挂在 `document.body` 上），所以用**模块级共享 store + 订阅**，开关变化时创建/销毁 DOM

数据流：设置页点开关 → 先本地生效（立刻响应）→ `PUT /prefs` 存盘 → host 是权威 → 下次 `/today` 轮询把权威值灌回 store。

## 为什么桌宠不走 slot

slot 内容渲染在宿主的 React 树里，`position: fixed` 会被任何带 `transform` / `filter` 的**祖先元素**劫持成相对定位（CSS 规范）。桌宠因此被锚死在 slot 容器那一小块区域里，只能在左边窄条里滑动，拖不出来。

profile 里已验证能拖的 `dsh-theme-tarkov` 桌宠根本不走 slot：它把 DOM 直接挂到 `document.body`。本插件照抄这个做法，挂载/拆卸/样式插入都走 `ctx.effect`，随插件生命周期卸载。

## 样式注入

`styles` **不是** Cordis 服务。它是动态插件（`evaluateClientHalf`）的**函数参数**，而本插件走的是 `__ModuleLoader__.load({ id, factory })` 的 bundle 形式，那条路径上没有这个参数。

所以插件自己建 `<style data-plugin="dsh-token-usage">` 挂到 `document.head`，`ctx.effect` 负责卸载移除。

（细节见 [NOTES.md](NOTES.md)——这里曾经出过一个很贵的错。）

## 两个事实来源：props 与 host

「当前工作区/模型」这类信息有两个来源：

| 事实 | 来源 | 谁能拿到 |
|---|---|---|
| `cwd → title` 映射 | 客户端 `useWorkspaces((s) => s)` | root scope 与 session scope 都行 |
| 当前会话的 cwd | 客户端 `useSessions((s) => s.byId[s.current]?.cwd)` | 两者都行 |
| 当前工作区/模型（桌宠用） | host `/today` 的 `current` | 桌宠是命令式 DOM，拿不到 props，只能问 host |

关键点：`useSessions` 的快照里同时有 `current`（当前会话 id）与 `byId`（按 id 索引的会话摘要），**在同一个快照里**，一次读取即可。

`current.model` 下发的是**原始名**（`workbuddy/deepseek-v4.1-flash`）而不是归一化名——client 需要它来在归并行的 `variants` 里定位「当前这一行」。

代码按「拿得到就用、拿不到就降级」处理：拿不到就不高亮，功能主体不受影响。

## 跨端一致性

方块换算（10M 一格、100 格一页）在 `lib/blocks.js` 与 `client.js` 里各有一份。两份漂移会导致「主面板说 68 块、桌宠说 67 块」这种最难查的不一致。

`test/blocks-cross.test.mjs` 在**同一组输入**上分别跑两份、逐字段比对（桌宠侧比对充能比例与池内块数）。

## 为什么不用 `llm/stream`

`llm/stream` 瀑布能看到更多调用（含压缩、标题生成），但：

1. `GenerateOptions.purpose` **不落进日志**，无法区分调用来源
2. 引入它会立刻产生「同一笔调用被两条路径各记一次」的双写风险
3. 日志路径能**回填历史**，`llm/stream` 不能

代价是标题生成的开销不可见。
