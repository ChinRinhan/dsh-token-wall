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
lib/turns.js      逐轮/逐会话用量折叠（纯函数，host 侧）
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

## 宿主接口适配（`lib/adapter.js`）

回填原先直接写死了一代 `sessionPersistence` 接口。同机另一份 DSH（`0.1.0-rc.6`）三处都不成立，而且**三处失败全部静默**：

| 期望 | 实际 |
|---|---|
| `list()` → `{header, revision}[]` | `SessionHeader[]`（无包裹）→ `snapshot.header.id` 是 `undefined` → 回填 `sessions: 0` |
| `open(id,'read',{signal})` | 不存在（只有 `load` / `inspect` + `readFrom`） |
| `handle.inheritedEventCount` | 不存在（只有 `header.seedLength` / `session.firstLiveSeq` / `session/end-seed`） |

实测两种形状跑同一批事件：

```
rc.8 真实形状   → sessions=0 entries=0 failed=0   ← 一条 warn 都没有
旧形状          → sessions=1 entries=2 failed=0
```

所以这一层做三件事：

1. **先探测再分支**：`probePersistence()` 返回 `{listKind, readKind}`，按实际存在的成员名走；结果进 `/today` 与 `/summary` 的 `diagnostics.persistence`，出现在设置页诊断区——接口换代时这是第一现场。
2. **认不出来就明说**：列表能力缺失 → 立刻返回并落 `degraded`；读取能力缺失 → 逐会话记 `failed` 并落 `degraded`。两者都会在界面上显示成红色提示，绝不把「读不到」渲染成「你本来就没有」。
3. **继承前缀三种来源**：`header.seedLength`（durable，最权威）→ `handle.inheritedEventCount`（旧版）→ 日志里**最后一个** `session/end-seed` 的 `seq+1`（新版把边界投影成事件）。实时路径同理，退到 `session.firstLiveSeq`。

### 为什么这条纪律值得单独讲

`tools/session-logs.mjs` 的测试替身**自己造了** `inheritedEventCount` 字段，`test/cross-validate.mjs` 又按同一个假设复算期望值——**实现与验证器共享同一个错误前提**，所以交叉校验永远绿。这是 [NOTES.md](NOTES.md) 里「验证器骗过自己」的第五例。

现在 `test/adapter.test.mjs` 用两套按真实形状写的夹具跑同一批事件，断言两边读数一致；再加反向断言：接口认不出来时 `degraded` 必须非空。

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

`test/blocks-cross.test.mjs` 在**同一组输入**上分别跑两份、逐字段比对（桌宠侧比对**池内块数**）。

⚠️ 桌宠的进度条**已不再**参与这条跨端校验：它的语义从「10M 充能」换成了「上下文占用」（见下节），跟 `blockWall` 无关了。硬把它俩比在一起，会把新语义悄悄退回旧语义。上下文条由 `blocks-cross.test.mjs` 末尾一组独立断言覆盖。

## 当前会话用量（桌宠）

桌宠要回答「这次对话花了多少、上下文还剩多少」。这件事有三个真实的难点，每个都有明确取舍。

### 难点一：桌宠问不出「当前会话是哪个」

桌宠是 root scope 的命令式 DOM（挂在 `document.body` 上），拿不到 session-scope 的 props。而 **host 更不知道**——「UI 里选中了哪个会话」是纯客户端状态。

唯一可靠的来源是一个 session-scope 的 slot 组件：它拿得到 `sessionId` prop。所以有 `SessionBridge`——一个**只写不画**的组件，注册在 `conversation.input.dock`，把 id 写进模块级 `focusStore`，桌宠轮询时把它作为 `?session=` 带上。

三个刻意的选择：

| 选择 | 理由 |
|---|---|
| 用**自己独立的 id** | slot 契约里「同 id 即替换」。复用 `-odometer` 会顶掉横幅那个条目 |
| **不受 prefs 控制** | `statusBar` 默认 false。接在 `GatedOdometer` 里等于永远不推数据，**而且不报错** |
| 只传 **sessionId 字符串**，不传数字 | 数字统一由 host 出。两处都算迟早不一致（本文档反复警告的那类事故） |

### 难点二：拿到 id 之后，数据可能根本不在

`ctx.sessions.get(id)` **只返回活会话**；重启后继续旧会话、或切到别的面板时它返回 `undefined`。所以 `sessionUsageOf()` 分三级降级，**任何一级都不许把「读不到」伪装成 0**：

1. **活会话** → `sessionProjections.snapshot()`，便宜且实时；
2. **冷会话** → `sessionQuery.observeSession(id, { projectionMode: 'all' })`，从磁盘折投影（首次要解日志，之后有缓存）。它返回的是**租约**，必须 `dispose()`；
3. **都不可用** → 返回 `{ available: false, reason }`，客户端显示 `—`。

之所以不自己维护一份「每会话合计」当兜底：回填确实能攒出一份，但它只在回填跑过时才有，且对**新会话**永远过期。第 2 级直接问宿主既更准也更省。

### 难点三：逐轮读数 —— 这是相对 harness 的真正改进

harness 自己的「本轮用量」是在**浏览器里**折的：ui-chat 把 `deriveTurnTokenUsage` 内联进 bundle，每次从原始事件重算一整轮。那个实现有一条我们不想继承的性质——**全有全无**：任一生命周期异常（缺 `step/end`、attempt 未闭合、`reasoningTokens > outputTokens`）就让整轮读数消失。

而且它**只在轮次结束后**才出现，所以「本轮实时在涨」它做不到。

我们的做法不同（`lib/turns.js`）：

- `assistant/message` 事件**自带** `turn` / `step` / `usage`（实测 `turn=2 step=1`），增量累加即可，不重放历史 → **O(1)**；
- **容错**：缺边界也能从任意一条带 usage 的消息起算，读数可能偏低，但不会消失；
- 状态只存内存（有界 Map，最近 64 个会话）。「当前会话」在新开会话时本来就该归零，所以**不持久化**是对的。

唯一需要小心的是**重试语义**：

| 情况 | 语义 |
|---|---|
| 同一步骤、没有 `llm/retry-started` 的重复样本 | **替换**（同一笔调用的更好版本） |
| `llm/retry-started` 之后的同一步骤样本 | **累加**（另一次计费尝试） |

替换必须实现成「先撤旧样本、再加新样本」，**不能**先算差值再相加——差值路径一旦为负会被钳制吃掉，增量变 0，读数卡在旧值上。这条有单测锁着（`test/turn-fold.test.mjs`）。

**真实数据交叉校验**：`tools/cross-validate-turns.mjs` 拿本机全部会话日志用我们的折叠算一遍，再和宿主自己持久化的 `tokenUsage` 投影比对。两边口径本就应当相等（同一份 usage，只是折叠方式不同），所以不相等就说明我们漏了或重了。

本机实测：**116 个会话全部一致**，另有 7 个被跳过——它们的投影检查点落后于日志（投影缓存是节流写盘，日志还在增长时盘上的值必然旧）。把这类会话单独计数而不是算作不一致，是这条校验能长期跑下去的关键：否则每次校验都会在「当前正在跑的那个会话」上报假阳性。

### 两个来源，口径不重叠

| 读数 | 来源 | 为什么 |
|---|---|---|
| 本会话总量 | 宿主 `tokenUsage` 投影（退到我们自己折的） | 权威，含整份日志 |
| 本轮 / 上一轮 | 我们自己的增量折叠 | harness 不提供，且我们能实时 |
| 上下文占用 | 宿主 `contextPressure`（`projectedTokens ?? pressureTokens` / `contextWindow`） | 唯一**有后果**的进度：快满会被压缩 |
| 池（N 块） | 本地日聚合，**全时累计** | 插件身份读数，只增不减 |

⚠️ **池绝不能跟随会话**：一个会话通常只有 0.2 块，跟随就会长期显示「0 块」，彻底失去意义。

⚠️ 上下文条的分母 `contextWindow` 必须来自宿主（实测有 1M 与 128K 两种），**不能写死**。

## 为什么不用 `llm/stream`

`llm/stream` 瀑布能看到更多调用（含压缩、标题生成），但：

1. `GenerateOptions.purpose` **不落进日志**，无法区分调用来源
2. 引入它会立刻产生「同一笔调用被两条路径各记一次」的双写风险
3. 日志路径能**回填历史**，`llm/stream` 不能

代价是标题生成的开销不可见。
