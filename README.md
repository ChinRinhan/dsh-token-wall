# dsh-token-usage

DSH（DeepSeek Harness）插件：按**本机时区**记录每次模型调用的 token 用量，并汇总任意时间段。

- **方块墙主面板**（侧栏图标进入）：每 10M tokens 填一格，顶部总量实时跟进
- **桌宠**（可拖动的小方块窗口）：单充能块 + 池，常驻在窗口上任意位置
- **消耗分布**：按工作区 / 模型 / 厂商三档切换（同一模型的多个渠道自动归并）
- **设置页**：今日 + 累计卡片、区间汇总表（按天 / 周 / 月 / 渠道 / 模型 / 类型）
- **历史回填**：从已有的会话日志补齐历史（不是从装上那天才开始记）
- **实时捕获**：之后每次模型调用即时入账
- **运行时开关**：桌宠 / 主面板 / 横幅三个模块可在设置页独立开关，改动立即生效

## 安装

本插件以 **Cordis bundle** 形式发布，宿主是 DSH 的 Web profile。

### 方式一：放进 profile 的 node_modules（推荐）

```bash
# 1. 把仓库放到 profile 的依赖目录下
#    <profile> 通常是 ~/.dsh/profiles/<名字>（Windows: %USERPROFILE%\.dsh\profiles\<名字>）
cd ~/.dsh/profiles/<profile>/node_modules
git clone <本仓库地址> dsh-token-usage

# 2. 在 profile 的 cordis.patch.yml 里插入本 bundle
#    （或者用下面的方式二让 DSH 自己写）
```

### 方式二：用 DSH 的插件管理

在 DSH 会话里让 agent 执行：

```
plugin_manager  install_bundle  target=<本仓库的包名或本地路径>
plugin_manager  set_bundle      target=dsh-token-usage  enabled=true
```

### 验证装上了

启用后，宿主会注册四条路由。用你的 Web GUI 端口替换 `<port>`：

```bash
curl http://127.0.0.1:<port>/dsh-token-usage/today
# → {"ok":true,"totals":{...},"allTime":{...},"run":{...},"current":{...},...}
```

界面上应该能看到：侧栏多出一个方块图标、右下角出现桌宠、设置页多出「Token 用量」一节。

### 首次启动会回填历史

`backfillOnStart: true`（默认）会在启动时扫描 `$DSH_HOME/sessions` 下的会话日志，
把装上之前的用量补进来。本机实测回填了 22 天、116 个会话、8,410 条记录。

## 三个模块与开关

| 模块 | 位置 | 默认 | 说明 |
|---|---|---|---|
| **桌宠** | 页面右下角浮动面板 | 开 | 承载全部读数 + 动效 |
| **方块墙主面板** | 侧栏图标 → 中间面板 | 开 | 大图 + 工作区分布 + 设置 |
| **横幅** | 输入框上方 | **关** | 内容已并入桌宠，默认不显示 |

### 为什么开关要做成「运行时偏好」而不是 Config

`cordis.patch.yml` 里的 `config` 是**部署期**配置：改它要重启 DSH。而用户想要的是
「在设置页点一下就生效」。所以另存一份 `$DSH_HOME/token-usage/prefs.json`
（见 `lib/prefs.js`），host 端提供 `GET/PUT /dsh-token-usage/prefs`。

三个开关**正交**，任意组合都合法。

### 开关如何「立即生效」

slot 注册是**一次性**的，而开关是运行时可变的。所以：

- **slot 类模块**（主面板、侧栏图标、横幅）：**始终注册**，由包装组件
  （`GatedBlockPanel` / `GatedPanelIcon` / `GatedOdometer`）按开关渲染成 `null`。
  开关一变，组件 re-render，面板立刻出现/消失。
- **桌宠**：不是 React 组件（命令式 DOM 挂在 `document.body` 上），所以用
  **模块级共享 store + 订阅**：`prefsStore` 变化时按开关创建/销毁 DOM。

数据流：设置页点开关 → 先本地生效（立刻响应）→ `PUT /prefs` 存盘 → host 是权威
→ 下次 `/today` 轮询把权威值灌回 store。

## 方块墙的视觉改进

### 里程碑刻度

每 10 格（= 1 亿 tokens）画一道竖线，首行与末行标出量级（`2.01B` / `2.91B`）。

之前 100 个方块没有任何量级提示 —— 看到「第 3 页」时无从判断那到底是 2 亿还是
200 亿。刻度让「量级」成为**空间信息**而不是需要心算的数字。

⚠️ 竖线与标签都放在**网格层**（都是网格的直接子元素），用同一套百分比定位，
所以两者必然对齐。标签不塞进方块里 —— 方块只有 26px，装不下 `2.01B`（实测被
截断成 `2.01`）。

### 灰阶而非纯黑

真实浅色主题里 `--dsw-alias-brand-primary` 是**近黑** `rgb(15,17,21)`。97 个纯黑
方块连成一片黑墙，压抑且没有层次。改法：

- 已填满 → 浅灰实心（`label-tertiary` + 55% 不透明度）
- **正在填 → 品牌色实心**（全场唯一的品牌色，视线自然落在最新进度上）
- 空白 → 浅灰描边

于是「实心 vs 描边」仍能区分三态，但画面是灰阶的，黑色只留给进度。

### 桌宠升级为迷你仪表盘

不再是「方块 + 数字」，而是常驻可见的迷你面板。**横幅的全部内容都并进来了**：

```
┌─ Token 方块墙  ● dafeiyu  ─┐
│ 累计 2.98B                  │   ← 累计（带口径标签）
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░  94%       │   ← 充能块：当前这块填了多少
│ ■ 297 块                    │   ← 池：已攒下的整块数
│ 今日 31.44M 1.1% ·          │   ← 仪表行
│ 速度 4.0K/s  昨日 127.79M   │
└─────────────────────────────┘
```

- 宽度收窄到 **196px**
- 标题栏加**当前工作区 chip**
- 仪表行：今日量 + 占比条 + 速度 + 昨日参照（从横幅搬过来的）

### 速度指标：从「累计变化率」改成「本次运行平均」

⚠️ 这是修过的真实缺陷。原来的速度是「累计值的相邻采样变化率」，而**累计值只在有新
调用时才变**——于是空闲时它恒为 0，**99% 的时间显示「—」**，等于没有这个指标
（用户实测截图里两个地方都显示「速度 —」）。

现在改成 **本次运行的总消耗 ÷ 已运行时长**（host 在 `/today` 的 `run` 字段里给）：
用过就有数，不用时是稳定均值，不跳变。分子只算**本次运行内**入账的 token，不含
历史回填——否则会算出一个巨大且误导的数。

### 桌宠：单充能块 + 池（不再铺 30 格）

桌宠只有 ~196px 宽，30 格（10×3）挤在里面每格不到 16px，既看不清又占高度；
而方块墙主面板已经有 100 格的大图了——桌宠再铺一遍是重复。

现在只用一个方块的面积表达「越攒越多」：

```
┌─ Token 方块墙  ● dafeiyu  ─┐
│ 累计 2.98B                  │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░  94%       │  ← 充能块：当前这块填了多少
│ ■ 297 块                    │  ← 池：已攒下的整块数
│ 今日 31.44M 1.1% ·          │
│ 速度 4.0K/s  昨日 127.79M   │
└─────────────────────────────┘
```

**为什么这个表达更好**：「充能 → 满 → 推进池里」这个动作本身就是最直观的积累，
而且只占一块的面积。30 格网格里读者要自己数「亮了几块」，这里直接给数字。

宽度从 268px 收窄到 **196px**（网格没了，268 太空）。

### 桌宠动效

| 动效 | 触发 | 效果 |
|---|---|---|
| **呼吸** | 充能 ≥ 90% | 充能块轻微脉动，提示「马上要攒到一块了」 |
| **池弹跳** | 跨过 10M 整数 | 池（`297 块`）弹一下（`scale` 1 → 1.12 → 1） |

全部尊重 `prefers-reduced-motion`——有人对动效敏感，那就不该有。

⚠️ 动效类名必须**追加**而不是覆盖：早先桌宠用
`el.cell.className = \`dsh-tu-block is-${state}\`` **整个覆盖**，于是 `is-new`
从来没生效过（只有主面板的 React 渲染有）。现在改成显式 `classList.add`。

### 桌宠配色

背景从 `--dsw-alias-bg-overlay` 改为 `--dsw-alias-bg-layer-1` + 更深的
`border-l2`：真实浅色主题里 `bg-overlay` 是 `rgb(233,236,242)`——一块偏蓝的灰，
浮在暖白页面上很突兀（用户实测截图就是这个问题）。

## 消耗分布：三个维度

「花在哪儿」有三个互不相同的答案，所以做成可切换的三档：

| 维度 | 回答的问题 | 数据来源 |
|---|---|---|
| **工作区** | 我在哪个项目花得多 | `/workspaces`（轻量，只回 top N） |
| **模型** | 我在用哪个模型花 | `/summary?groupBy=modelNorm` |
| **厂商** | 我在给哪家公司送钱 | `/summary?groupBy=vendor` |

### 为什么「模型」维度需要归并

本机实测的真实模型名有 16 个，但同一个模型散成了多个变体：

```
deepseek-v4.1-flash             1.54B   ← 主名
workbuddy/deepseek-v4.1-flash   25.6M   ← 带渠道前缀
deepseek-ai/deepseek-v4.1-flash   52K   ← 另一种前缀
deepseek-v4.1-flash-free        23.1M   ← 带 free 后缀
```

按原始名字分组会得到 4 行，读者看不出「这其实是同一个模型、走了 4 个渠道」。
归并后合成一行：**1.62B · 4 个变体**（占总消耗 46%）。

### 归并只做**安全**的事

`lib/models.js` 的归一化只有三条规则，全部是「去掉渠道/计费装饰」：

| 规则 | 例子 |
|---|---|
| 去掉 `vendor/` 前缀 | `workbuddy/deepseek-v4.1-flash` → `deepseek-v4.1-flash` |
| 去掉 `-free` / `:free` 后缀 | `deepseek-v4.1-flash-free` → `deepseek-v4.1-flash` |
| 小写 | `Spark-X2.5-4B` → `spark-x2.5-4b` |

⚠️ **不合并不同代际**。`deepseek-flash`(593M) / `deepseek-v4-flash`(21M) /
`deepseek-v4.1-flash`(1.62B) 是三个不同版本，合并会掩盖「还在用旧模型」这个
信息。用户明确要求不合并，所以它们在「按模型」视角下各自独立——但在「按厂商」
视角下都归 DeepSeek。

⚠️ **认不出厂商就归「其他」**，不猜。`dfmodel` / `qfmodel` / `space-bunny`
从名字看不出厂商，硬猜会造出假数据。它们合计 8.7%，显示为「其他」。

### 别名表（Config，重启生效）

认不出的模型可以显式声明：

```yaml
modelAliases:
  dfmodel:
    vendor: deepseek
    model: deepseek-v4.1-flash
  qfmodel:
    vendor: deepseek
    model: deepseek-v4.1-flash
```

形状校验很宽松：`vendor` / `model` 都可省略，形状不对的条目**静默丢弃**
（一条别名写错不该让插件起不来）。

### 归并在读取侧做，不改落盘格式

桶键仍是 `scope|kind|workspace|provider|model`，历史数据一个字节都没动。
`groupBy=modelNorm` / `vendor` 是**先按原始 model 聚合、再在 host 侧合并**。
好处：改 `modelAliases` 不需要重算历史、不需要迁移。

### 维度串档（修过的真实缺陷）

切档时 `useJson` 换了 URL，但**新数据回来之前 `rows` 还是上一档的**。若不挡住，
切到「模型」的那一帧会拿 workspace 的行按 model 渲染——名字全空、数字还是
工作区的（实测前 5 行名称为空、数值 842M）。

现在 `DistributionBars` 有**形状守卫**：只渲染「带当前维度判别字段」的行
（workspace 档要 `r.workspace`、model 档要 `r.model`、vendor 档要 `r.vendor`）。
不匹配时显示占位而不是错乱数据。

### 副标题把数字挤出可视区（修过的真实缺陷）

「按模型/厂商」档每行多一列副标题（`4 个变体` / `3 个模型`）。早先四列都是
**固定宽度**：`132 + 240 + 86 + 46 = 504`，加 3 个 gap(30) = **534px**，已经
超过容器 520px；再加一列副标题（5 列 4 gap）直接溢出 **70px+**，后面的数值
与占比被挤出可视区。

两处修法：

1. **条形改成弹性**（`flex: 1 1 auto`），固定列之和（328px）永远小于容器，
   条吃剩余 192px。
2. **副标题给固定宽度 62px**（而不是 `auto`）——`auto` 会随文案长短变化
   （「4 个变体」与「3 个模型」宽度不同），不同维度下条的左边缘会跳。

⚠️ 还有一个连带问题：副标题缺失时若返回 `null`，那一行就**少一列**，条会多
吃 62px+gap——实测同一张图里第一行条形是 `327→519`、其余行 `327→589`，
条长不一致看着像画错。现在副标题**总是渲染**（没有内容就渲染空串）。

修完实测（`test/distribution.test.mjs` 从真实 CSS 读列宽后断言）：

```
溢出        = 0px（三档 + 窄屏 640/520/420 全部为 0）
条形左边缘  = 327（所有行一致）
条形右边缘  = 519（所有行一致）
数值左边缘  = 597（所有行一致）
```

⚠️ 这个测试的列宽数字是**从 `client.js` 的 CSS 里正则读出来的**，不是硬编码。
硬编码会让测试与实际样式漂移，变成「测试永远绿但界面仍然溢出」。
已验证：把样式改回旧的固定宽度后，测试有 **4 处变红**。

## 工作区维度

「哪个工作区烧得最多」是方块墙之外的另一个问题：方块墙回答**总量在涨**，
工作区横条回答**涨在哪儿**。两者互补，所以放在同一页。

本机实测 8 个工作区，分布均匀（不是长尾），所以这个维度有真实信息量：

```
27.6%  F:\HD222game     842,373,593
23.1%  F:\dsh-work       702,839,440
21.5%  F:\dafeiyu        656,068,057
17.3%  F:\HD2game        527,475,379
 7.6%  F:\HD2tafang      231,580,537
 2.9%  F:\文案            88,858,720
```

### 三处落地

| 位置 | 形态 |
|---|---|
| **方块墙主面板** | 横向堆叠条：每行一个工作区，长度按占比，右侧标 token 与百分比。**当前工作区高亮**。只显示前 6 行，其余折叠成「其他 N」 |
| **底部面板**（输入框上方） | 一个小圆点 + 当前工作区名的 chip，放在次行末尾 |
| **设置页** | 维度选择器加「工作区」，复用已有的汇总表 |

### 桶键从 4 段扩到 5 段（兼容性是重点）

```
旧： scope|kind|provider|model
新： scope|kind|workspace|provider|model
```

⚠️ **盘上 400 天的历史全是 4 段**。如果 `parseBucketKey` 只认 5 段，那些桶会被当成
脏数据整体跳过，累计瞬间从 3.05B 跌到 0——这是本插件最不能接受的失效模式。
所以读侧**同时接受 4 段与 5 段**（4 段按 `workspace: ''` 读，见 `lib/fold.js`）。

### 历史回填：比例分摊（近似，如实说明）

新事件天然带 `header.cwd`，但**旧桶里没有 sessionId**，无法直接知道它属于哪个工作区。
`tools/migrate-workspace.mjs` 用「当天各工作区的用量占比」把旧桶摊到各工作区：

- 合计**零漂移**（3,049,222,064 → 3,049,222,064，误差 0）
- 迁移后分布与独立试算完全一致（27.8% / 23.2% / 21.0% / 17.4% / 7.6% / 2.9%）
- 幂等：重跑迁移 0 个桶

⚠️ 这是**近似**，不是精确重放：某个工作区若只在特定 provider 上用过，按比例分摊会把它
摊到别的 provider 桶里。旧桶本来就是「主会话 + 全部子会话」的混合体，缺 sessionId
这一维时无论如何都无法精确还原。用途是「看趋势、看分布」，这两件事误差可接受。

```bash
node tools/migrate-workspace.mjs --home "$DSH_HOME"            # dry-run
node tools/migrate-workspace.mjs --home "$DSH_HOME" --write    # 落盘
```

### 展示名用 Workspace 标题

host 只下发 `cwd`；Workspace 的**标题**（用户自己起的名字）只能从客户端的
`useWorkspaces` 拿（`cwd → title` 映射）。拿不到就退回 `cwd` 的 basename
（`F:\dsh-work` → `dsh-work`）——**降级路径是一等公民，功能不依赖它**。

⚠️ 本机实测：宿主的 title **就是 basename**（见 `$DSH_HOME/storages/workspace.json`：
`path: "F:\dsh-work", title: "dsh-work"`），所以「标题」与「路径末级」在这里
没有区别。代码两条路都留着——将来用户给 Workspace 起了真正的名字就会自动生效。

### 「当前工作区」怎么拿

两个 facts 都来自宿主的 slot **standardProps**（`useWorkspaces` / `useSessions`），
不是 Cordis 服务，也不是 React context。

| 事实 | 来源 | 谁能拿到 |
|---|---|---|
| `cwd → title` 映射 | `useWorkspaces((s) => s)` → `s.items` | root scope（`main`）与 session scope（`conversation.input.dock`）都行 |
| 当前会话的 cwd | 客户端：`useSessions((s) => s.byId[s.current]?.cwd)` | **两者都行** |
| 当前工作区（桌宠用） | host：`/today` 的 `current.workspace` | 桌宠是 root scope 命令式 DOM，拿不到 props，只能问 host |

⚠️ 第二条的关键是 `useSessions` 的快照里同时有 `current`（当前会话 id）与 `byId`
（按 id 索引的会话摘要），**两者在同一个快照里**，一次读取即可。早先只读
`props.sessionId`——那是 session scope 才有的，于是 root scope 的 `main` 面板
拿不到「当前工作区」，横条永远不高亮。

⚠️ 第三条是给桌宠的：它是命令式 DOM，不在 React 树里，**拿不到任何 props**。所以
host 记下「最近一次产生用量的会话的 cwd」并下发。这比「用户在 UI 里选中了哪个
会话」更贴近意图——你刚在这个项目里干活，chip 就该显示它。

`main` 是 root scope、`conversation.input.dock` 是 session scope，但 `current`
这条两者通用，所以**主面板与底部里程表都能高亮当前工作区**。

代码按「拿得到就用、拿不到就降级」处理：拿不到就不高亮，功能主体不受影响。

## 方块墙（主面板 + 桌宠）

**每 10M tokens 一个方块**，累计只增不减，所以填满的格子只会越来越多——
这是「越花越多」最直白的表达。

```
总消耗 684,561,075 tokens   已获得 68 块 · 第 1 页
██ ██ ██ ██ ██ ██ ██ ██ ██ ██
██ ██ ██ ██ ██ ██ ██ ██ ██ ██
██ ██ ██ ██ ██ ██ ██ ██ ██ ██
██ ██ ██ ██ ██ ██ ██ ██ ██ ██
██ ██ ██ ██ ██ ██ ██ ██ ██ ██
██ ██ ██ ██ ██ ██ ██ ██ ██ ██
██ ██ ██ ██ ██ ██ ██ ██ ▓░ ░░   ← 第 69 块填了 45.6%
░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░
░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░
░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░
```

### 为什么是 10M

用真实数据量过：每轮对话消耗**中位 1.41M / 平均 4.04M / p90 10.4M**，典型活跃日
2-3 块、重度日 7-9 块。所以 10M/块既不会快到麻木，也不会慢到没有反馈。

### 三件东西

| 元素 | 作用 |
|---|---|
| **方块网格** | 已填 / 正在填（按比例渐进填充）/ 空白，三态一眼分清 |
| **空位始终可见** | 「还能填」的期待感全在这里；没有空白就没有积累感 |
| **顶部总量** | 实时跟进（1 秒轮询），等宽数字不抖 |

### 桌宠

一个可拖动的小方块窗口（**单充能块 + 池**，见上文的说明）：

- **拖动**：`position:fixed` + `translate` + `setPointerCapture`（指针移出元素也能继续拖），
  与 profile 里已验证的 `dsh-theme-tarkov` 桌宠同款实现
- **单击**：折叠 / 展开（折叠后只剩一行数字，仍可拖动）
- **位置记忆**：写入 `localStorage`，并钳制在视口内；窗口缩放时重新钳制
- **窄屏隐藏**：≤768px 隐藏（拖拽手势会与页面滚动打架，与 tarkov 桌宠同一取舍）

### 累计 / 今日 可切换

两个维度语义不同，必须让人明确知道在看哪个：**累计**是只增不减的历史总量，
**今日**是午夜归零的当天量。切换只影响方块墙，顶部两个卡片始终同时显示两者。

### 分页

累计只增不减，10M/块意味着每年约 +500 格，不封顶会把界面撑爆。所以
**100 格一页 = 10 亿 tokens**；当前格决定页码，页内始终 100 格。

### 一次跨多块怎么办

实测单轮对话最多花 **37.8M = 3.8 块**，所以重活干完时不是优雅地 +1，而是一次蹦好几格。
主面板的方块墙**逐个错开点亮**（每 120ms 一格），像得分连击，而不是一次全亮；
桌宠那边则是「池」的数字跳一下 + 弹一次。

### 跨端一致性

`lib/blocks.js`（host 侧，可单测）与 `client.js` 里各有一份等价换算——客户端是手写
ModuleLoader bundle，**不能 import** 那个模块。两份实现漂移会导致「主面板说 68 块、
桌宠说 67 块」这种最难查的不一致，所以 `test/blocks-cross.test.mjs` 在**同一组输入**
上分别跑两份、逐字段比对（桌宠侧比对的是**充能比例**与**池内块数**）。

## 累计里程表（输入框上方）

要传达的是「token 越花越多」。**纯数字传达不了这个**——数字再怎么涨，一眼看上去仍是
静态文本。所以用**三件互相印证的东西**：

```
┌──────────────────────────────────────────────────────────┐
│  ╱╲                                                      │
│ ╱  ╲___   累计 623,892,036 tokens                        │
│           今日 183.51M 29.4% ▓▓▓▓▓▓░░░░  速度 5.0K/s     │
│           昨日 2.80M                                     │
└──────────────────────────────────────────────────────────┘
   ↑上升曲线      ↑递增数字            ↑占比条
```

| 元素 | 作用 |
|---|---|
| **上升曲线**（SVG sparkline） | 左低右高本身就是「在涨」的形状——这是最强的信号 |
| **递增数字** | 带千分位、不缩写，每位都在走 |
| **今日占比条** | 今天占累计的比例，随使用变长 |

### 曲线数据从哪来

**纯客户端采样**：每次轮询把累计值压进一个 40 点的定长缓冲，画成折线。
所以它反映「打开页面之后」的走势，**不是历史**——不需要 host 支持，也不会在
刷新页面时画出一条假的斜线（缓冲从零重新累积）。

### 四个刻意的设计决定

| 决定 | 理由 |
|---|---|
| **累计用等宽数字**（`font-variant-numeric: tabular-nums`） | 否则每次进位整行宽度都会跳，看着很毛躁 |
| **累计不缩写，今日才缩写** | 里程表要的是「一位一位往上走」的实感；把累计缩成 `623.89M` 会把低位变化全吃掉 |
| **速率做指数滑动平均**（新样本权重 0.35） | 真实消耗本来就一阵一阵；1 秒轮询下用裸瞬时值会闪得很吵 |
| **不显示「今日 vs 昨日」百分比** | 今天是**进行中**的，拿部分天比昨天整天，早上必然大幅负值、下午又虚高——那是误导。存储只到「日」粒度，做不到「昨日同一时刻」的对齐比较，所以只把昨日全天原样摆出来 |

另有两条实现细节：

- **按信息单元分组**（每个单元 `white-space: nowrap`）：不做「一堆 span 加
  `flex-wrap`」——那样换行时会出现孤立的「·」，还会把数字和单位拆开
  （曾出现「623,892,036tokens」挤在一起）。
- **速率用累计值求差**，而不是读「今日」——跨午夜时「今日」会归零，
  而累计是连续的，不会在换日瞬间产生一个假的巨大负速率。

### 更新频率

默认 **1 秒轮询** `GET /dsh-token-usage/today`（该端点只做 O(日×桶) 的加总，
不下发整张聚合表）。要改就设 `statusBarRefreshMs`。

## 数据从哪来

会话日志里 `assistant/message` 事件的 `usage` 字段。它**是持久化的**，所以「历史回填」
与「实时捕获」读的是同一份数据，不存在两套口径漂移。

| 事件 | 类型 | 说明 |
|---|---|---|
| `assistant/message` | 对话调用 | 主力来源，带 `usage` |
| `compaction/summary` | 辅助调用 | 压缩摘要也是真实模型调用，**必须计入**（本机历史有 613,328 tokens 来自它） |

`session/title-llm-request` 只记录请求、不带 `usage`，因此标题生成的开销**无法从日志恢复**
（如实说明，不是遗漏）。

### 为什么不用 `llm/stream`

`llm/stream` 瀑布能看到更多调用（含压缩、标题生成），但：

1. `GenerateOptions.purpose` **不落进日志**，无法区分调用来源；
2. 引入它会立刻产生「同一笔调用被两条路径各记一次」的双写风险；
3. 日志路径能**回填历史**，`llm/stream` 不能。

第一版只用日志这一条路径。代价是标题生成的开销不可见。

## 关键设计

### 去重：水位线让重复计数结构上不可能

会话日志 append-only，`seq` 从 0 连续且**永不重写**。因此「该会话已计数的最大 seq」
这一个数就是完备的去重状态。回填与实时**共用**它，所以无论两条路径以什么顺序、
交叠多少次运行，每条事件最多入账一次；重启也不重算。

### fork 继承前缀

fork / resume 出来的会话，其日志前缀是从父会话**继承**的，那些用量父会话已计过。
`SessionHandle.inheritedEventCount` 精确给出继承前缀长度，因此只计
`seq >= inheritedEventCount` 的自有事件。

⚠️ 水位线**不能**替代它：水位线按 sessionId 分开存，子会话有自己的水位线，光靠它会把
继承前缀当成子会话的新事件照单全收。

### 合计口径

```
totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
```

即「这次调用实际过了一遍的 token 总量」。它与 provider 上报的 `TokenUsage.totalTokens`
（通常只是 input+output）**不是一回事**，所以本插件不读那个字段，只按上述定义自算。
`outputTokens` 按 dsh 口径**已含思考 token**，`reasoningTokens` 只作拆分项，不重复计入。

### 「没测到」≠「用了 0」

没带 `usage` 的调用（中断、上游提前断开、失败）**不写 0**，而是根本不入桶。
覆盖率（扫描了多少、其中多少带用量）在设置页的诊断区如实展示。

### 存储

`$DSH_HOME/token-usage/daily.json`：

```json
{
  "schema": "dsh-token-usage/daily/v1",
  "days": { "2026-10-12": { "main|chat|workbuddy|deepseek-v4.1-flash": { "…合计…" } } },
  "watermarks": { "session-abc": 412 }
}
```

- **独立文档**，不进 `state.json`（后者会被别的插件整体重写，不认识的键会被静默抹掉）。
- **只落日聚合，不落明细**：写入量与请求量解耦（同一格只加数，不增行）。
- **增量合并写**：`flush()` 是「重读盘 → 只加相对上次基线的增量 → 原子写」，两个实例
  并存时不会互相抹掉。
- **节流落盘**：默认 2 秒防抖。记账在推理关键路径上，每笔都同步写盘会把「一次推理」
  变成「一次磁盘写」。窗口内崩溃最多丢最近 2 秒的计数。
- **保留期**：默认 400 天，落盘时淘汰更早的日键。

⚠️ **已知限制**：`flush()` 的「读 → 改 → 写」不是跨进程原子操作，两个**真实进程**密集
并发写时后写者可能基于陈旧快照覆盖。桌面场景通常单进程单 profile，影响面有限；根治需要
文件锁或改追加日志形态。

### 两个正交的过滤维度

- `scope`：`main` / `sub` —— **谁发起的**（子代理 / 团队队友 / workflow 子会话都是独立
  session，默认计入，因为要完整反映真实消耗）
- `kind`：`chat` / `aux` —— **是不是辅助调用**（压缩摘要）

二者正交（子会话里的压缩既是 sub 又是 aux），所以各给一个开关，互不干扰。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖，升级不丢：

```yaml
- id: dsh-token-usage
  name: 'dsh-token-usage'
  config:
    keepDays: 400              # 保留天数（落盘时淘汰更早的日键）
    includeSubagents: true     # 计入子代理 / 团队 / workflow 子会话
    includeAuxiliary: true     # 计入压缩等辅助调用
    statusBarEnabled: true     # 显示输入框上方的里程表
    statusBarRefreshMs: 1000   # 轮询间隔（最小 1000；与随包 patch 的默认值一致）
    backfillOnStart: true      # 启动时回填历史
```

## HTTP 接口（只读）

| 路径 | 说明 |
|---|---|
| `GET /dsh-token-usage/today` | 今日 + 昨日 + **累计** + `run`（本次运行平均速度）+ `current`（当前工作区**与当前模型**）+ `prefs` + `diagnostics`（1 秒级轮询） |
| `GET /dsh-token-usage/summary` | 区间汇总，支持 `groupBy` / `from` / `to` / `includeSub` / `includeAux`。`groupBy` 白名单：`day` `week` `month` `provider` `model` `providerModel` `kind` `workspace` **`modelNorm`** **`vendor`** |
| `GET /dsh-token-usage/workspaces` | **工作区分布**（只回 top N，支持 `limit` / `from` / `to`） |
| `GET/PUT /dsh-token-usage/prefs` | **运行时开关**（`statusBar` / `pet` / `wallPanel`）。唯一会**写**的端点 |

### 为什么归并维度要在 host 侧算

`modelNorm` / `vendor` 需要 `config.modelAliases`（部署期配置），而 client 拿不到
Config。所以 host 先按原始 `model` 聚合、再用 `lib/models.js` 合并后下发。

### 为什么 `current.model` 给的是**原始名**

`current.model` 下发 `workbuddy/deepseek-v4.1-flash` 这种原始名，而不是归一化后的。
原因：归一化规则依赖 `modelAliases`，而 client 只需要知道「当前在用什么」来高亮
一行——它按同一套前缀规则推 vendor、按 `variants` 匹配归并行。若下发归一化名，
client 就无法在 `variants` 里定位到底哪一行是「当前」。

### 为什么工作区要单独一个端点

主面板切到「今日」时也用它（它支持 `from`/`to`），所以主面板与桌宠拉的是同一个
轻量端点。`/summary?groupBy=workspace` 也能给这个数据，但它会下发**整张聚合表**。

### 为什么 prefs 是唯一可写的端点

其余全是只读。`prefs` 写的是「用户想看到什么」，不是「数据是什么」——它不影响
任何统计口径，所以可以随时改、随时改回。写入前严格校验（非对象 / 非法 JSON →
400；错类型的值 → 钳制到默认），未知键丢弃。

## 开发

```bash
npm test          # 全部不依赖本机数据的测试（= check + test:unit + test:client + test:host）
npm run test:data # 需要本机会话日志：交叉校验 + 存储端到端（传 $DSH_HOME/sessions）
npm run visual    # 生成视觉验证 HTML，再用浏览器截图
```

### 逐条运行

```bash
node --test test/fold.test.mjs                        # 纯逻辑单测（24 项）
node --test test/blocks.test.mjs                      # 方块换算单测（14 项）
node test/client.smoke.mjs                            # client 半结构 + 渲染冒烟
node test/odometer.text.mjs                           # 桌宠可见文案（累计/今日/速度/昨日/工作区）
node test/sparkline.test.mjs                          # 上升曲线的几何（左低右高、不除零）
node test/blocks-cross.test.mjs                       # 方块换算的跨端一致性
node test/host.routes.test.mjs                        # host 路由 JSON 契约（53 项）
node test/prefs.test.mjs                              # 运行时开关的存储（6 项）
node --test test/models.test.mjs                      # 模型归并：归一化/代际不合并/别名（9 项）
node test/distribution.test.mjs                       # 消耗分布：形状守卫/列宽预算/当前项高亮
node test/cross-validate.mjs "$DSH_HOME/sessions"     # 与独立实现交叉校验真实日志
node test/store.e2e.mjs "$DSH_HOME/sessions"          # 存储端到端（回填/落盘/幂等/并发）
node tools/usage-cli.mjs --sessions "$DSH_HOME/sessions" --group-by provider
node tools/usage-cli.mjs --sessions "$DSH_HOME/sessions" --group-by workspace
node tools/rehearse.mjs                               # 用真实 home 跑一遍完整回填并落盘
node tools/preview-blocks.mjs                         # 用真实数据字符画方块墙
node tools/analyze-blocks.mjs                         # 分析「10M 一格」的填充速度
node tools/migrate-workspace.mjs --home "$DSH_HOME"   # 桶键 4 段 → 5 段（dry-run）
node tools/visual-check.mjs                           # 生成视觉验证 HTML（再截图，见下）
node tools/check-stray-backticks.mjs client.js index.js tools/visual-check.mjs

⚠️ `test/cross-validate.mjs` 与 `test/store.e2e.mjs` 需要**本机已有的会话日志**，
所以不在 `npm test` 里（否则别人克隆下来会失败）。不传参数时它们会打印用法。
node -e "import('./tools/theme-tokens.mjs').then(m=>console.log(m.readThemeTokens(m.USED_TOKENS)))"
```

`cross-validate.mjs` 是最强的正确性证据：它与插件共享的**只有输入文件**，解析、过滤、
聚合全部各写一遍。任何口径漂移都会让数字对不上。

`host.routes.test.mjs` 补的是另一类盲区：之前所有测试都只验证 `lib/**` 与渲染，
**没有一条**检查 host 实际下发的 JSON 形状，于是「`/today` 少一个 `diagnostics` 字段」
和「`allTime` 无视过滤开关」两个真实缺陷都溜了过去。这个文件用 mock 上下文真跑
`apply()`、抓取注册的 route 并调用 handler。

`tools/visual-check.mjs` 产出 `tools/out/visual-check.html`（浅色）与
`visual-check.dark.html`（深色）。它把**真实组件**装进**真实 React 18**（浏览器里跑，
effect / fetch 全真）渲染。截图：

```bash
# Windows 自带 Edge 即可，不需要装 puppeteer
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=6000 \
  --window-size=960,2400 --screenshot=tools/out/light.png \
  "file:///$(pwd)/tools/out/visual-check.html"
```

这是**看得见的一次验证**，但注意它的边界：宿主外壳（侧栏、设置面板外框、composer
布局）是模拟的，不是真实 DSH 页面——驱动真实页面要 launch token，那是越权且脆弱的。

`tools/rehearse.mjs` 会**真的写入** `$DSH_HOME/token-usage/daily.json`。这是安全的：
水位线保证插件随后激活时只补充新事件，不会重复计数（已实测幂等）。它也让插件激活后
立刻就有历史数据可看。

### 迭代时的热更新行为

| 改动 | 生效方式 |
|---|---|
| `client.js` | **约 500ms 内热更新**（`dsh-client-hmr` 轮询文件元数据），无需重启、无需构建 |
| `cordis.patch.yml` / `package.json` | 热重载（HMR 监视这两个文件） |
| `index.js` / `lib/**` | **禁用→重新启用该 bundle 即可**，无需重启 DSH |

⚠️ 最后一条**已实测修正**：早先这里写的是「需要重启 DSH」，理由是「加载器按插件身份
缓存模块」。实测不成立——用 `plugin_manager set_bundle(enabled:false→true)` 重新启用后，
改动过的 `index.js` 会**真的重新导入**：注入一个 `hmrProbe` 字段，重启用后
`/dsh-token-usage/today` 立刻返回了它；还原文件后重启用，字段消失。

仍然成立的部分：**改完不重新启用就不会生效**（模块在激活期导入一次）。所以迭代 host 半
的最短闭环是「改文件 → 禁用 → 启用 → 打端点」，不用杀进程。

## 与其他实现的区别

profile 里 `dsh-our-free-model` 内部已有一个 `token-ledger`（写
`$DSH_HOME/channel-pack/token-ledger.json`）。本插件**不是**它的替代品，口径也不同：

| | token-ledger（our-free-model） | 本插件 |
|---|---|---|
| 覆盖范围 | 仅它自己的 13 个适配器 | **所有** provider（读日志，与路由无关） |
| 历史 | 无（装上才开始） | **可回填**（本机最早到 2026-08-25） |
| 日界 | UTC+8（对齐渠道额度结算） | **本机本地时区**（对齐用户作息直觉） |
| 界面 | 它自己的看板页 | 独立设置页 + 状态条 |

两者互不干扰，可以并存。

## 验证状态（如实说明）

已完成（全部通过）：

- ✅ 纯逻辑单测 **23 项**（日界、周/月归属、合计口径、钳制、水位线去重、fork 前缀、保留期，
  以及 `kind` 只下发枚举值、累计与区间合计同口径两条回归）
- ✅ 与独立实现交叉校验真实日志：全量合计与**逐日**读数完全一致，0 处不符（2.97B tokens / 22 天）
- ✅ 存储端到端：回填 → 落盘 → 重新打开读数不变；重复回填幂等；两实例并存不互相抹掉
- ✅ client 半：`id` 等于包名、**五个 slot 均注册**（设置页 / 里程表 / 侧栏图标 / 主面板 / 桌宠）、
  组件空态与有数据态均渲染成功、样式**只**引用 `--dsw-alias-*` 主题 token
- ✅ **侧栏图标 id 与 `main` 的 key 一致**（否则点了图标打不开面板）
- ✅ **方块换算**：单测 14 项（刚好整除、跨页、当前块归属、进度、异常输入）
  + **跨端一致性**：主面板 11 个用例的三态序列与 `lib/blocks.js` 逐字段一致，
  桌宠的**充能比例**与**池内块数**也与 `lib/blocks.js` 一致
- ✅ 里程表**可见文案**逐条断言（累计/今日/速度/昨日、千分位不缩写、占比），
  以及速率的两次采样与指数平滑（5.0K/s → 平滑后 4.0K/s，而非裸瞬时 2.0K/s）
- ✅ **上升曲线几何**：递增数据画出左低右高、坐标全在画布内、最高点归一化到顶部；
  恒定值退化为水平线且**不除零**；单点/空数组/非数组均不崩
- ✅ **host 路由契约 53 项**（`test/host.routes.test.mjs`）：四条路由的 JSON 形状、
  `/today` 必须带 `diagnostics` / `run` / `current` / `prefs`、
  `allTime` 与区间合计同口径、`groupBy=kind` 只给枚举值、
  `/prefs` 的 PUT 校验（拒绝非法 JSON / 非对象、钳制错类型）、
  `modelNorm` / `vendor` 归并后**合计与按天一致**（不丢不重）、
  `providerModel` 的 (provider, model) 不重复（回归）
- ✅ **模型归并 9 项**（`test/models.test.mjs`）：去前缀/去 `-free`、**代际不合并**、
  认不出归 unknown、别名表可覆盖、归并后总量守恒
- ✅ **消耗分布**（`test/distribution.test.mjs`）：形状守卫（防维度串档）、
  当前项高亮（原始名 → 归并行靠 `variants` 匹配）
- ✅ **运行时开关 6 项**（`test/prefs.test.mjs`）：缺省值、写后读回、原子写、
  脏输入钳制、损坏文件回默认、内存降级
- ✅ **桌宠可见文案**（`test/odometer.text.mjs`）：累计/今日/占比/速度/昨日/工作区 chip
  逐条断言，并断言**速度不是「累计变化率」**（那在空闲时恒为 0，会显示「—」）
- ✅ **实时生效**：bundle 启用后四条路由返回真实数据，实时捕获持续入账
  （本机累计 2,971,781,312 tokens / 12,693 次调用 / 89 个会话）
- ✅ **开关真能改**：实测 `PUT /prefs {"pet":false}` → 再 GET 读回 `pet:false`，
  改回 `true` 也生效
- ✅ **视觉确认（浅色 + 深色）**：用 `tools/visual-check.mjs` 把**真实组件**放进**真实浏览器**
  （Edge headless）渲染并截图，见 `tools/out/light.png` / `dark.png`。已亲眼确认：
  方块墙排成 10 列 × 10 行、顶部总量与「已获得 297 块 · 第 3 页」一致、图例三态可辨、
  诊断区显示真实存储路径（不再是「仅内存」）、设置页表格与卡片对齐、
  主题 token 在深浅两套下都正确跟随、桌宠在右下角正常渲染。
- ✅ **工作区维度**：真实 API 返回 8 个工作区、分布与独立试算一致；
  视觉确认里横条长度比例、Workspace 标题、当前工作区高亮全部正确。
- ✅ **里程碑刻度**：每行一道竖线、首末行标量级，位置与量级均已核对
  （`2.01B` / `2.91B` 对应 pageStart=200 的首末行）。

## ⚠️ 四次「验证器骗过了自己」

这个插件的返工史里，**最贵的错误都不是产品 bug，而是验证器的 bug**。四次都是
同一类问题：验证器造了一个比现实**好看**的世界，然后拿它当证据。

### ① 样式从未被注入

**症状**（用户报的）：方块墙挤在页面最下面、桌宠只剩一行裸文本、里程表数字粘成
`2,998,037,680tokens`。

**根因**：`client.js` 里注入样式写的是

```js
const styles = ctx.get('styles')            // ← 永远是 undefined
if (styles !== undefined && styles.insert) ctx.effect(() => styles.insert(CSS), …)
```

`styles` **不是一个 Cordis 服务**。查遍 web profile 的所有包，没有任何地方
`provide('styles')`——它是动态插件（`evaluateClientHalf`）的**函数参数**，而本插件走的是
`__ModuleLoader__.load({ id, factory })` 的 bundle 形式，那条路径上没有这个参数。
于是 11KB CSS 一行都没进页面：

| 失效的规则 | 界面表现 |
|---|---|
| `.dsh-tu-wall-grid { display: grid }` | 30 格竖排成一列 → 挤占页面最下方 |
| `#dsh-tu-pet { position: fixed }` | 桌宠退回文档流 → 只剩裸文本 |
| `.dsh-tu-odo-item { white-space: nowrap }` | 「…680tokens」粘在一起 |

**为什么测试没抓到**（两层都失效了）：

1. `test/client.smoke.mjs` 的 mock ctx **伪造了** `styles` 服务，于是 `insert` 被调用、
   断言「注册了样式」通过——测的是「有没有调用」，不是「CSS 有没有进 DOM」；
2. `tools/visual-check.mjs` 为了拿 CSS 字符串，同样伪造了 `styles`，把 CSS 直接内联进
   生成的 HTML——**验证器替被测插件把样式注了进去**，截图当然完美。

两者都绕过了它们本该验证的那条路径。这是「验证器自己作弊」的典型案例。

**修复与加固**：

- 插件自己建 `<style data-plugin="dsh-token-usage">` 挂到 `document.head`，
  `ctx.effect` 负责卸载移除（与 `dsh-theme-tarkov` 桌宠同款，那个是 profile 里
  唯一实测能拖的桌宠）；
- `client.smoke` 改为断言**真实 DOM**：head 里必须有本包 style、且含关键选择器；
  并把 mock 里的 `styles` 删掉（如实返回 undefined）；
- `visual-check` 不再伪造 `styles`，改为从 `document.head` 取 CSS，取不到就**硬失败**；
  并在页面里注入一段**自检横幅**，用 `getComputedStyle` 断言
  `display:grid` / `position:fixed` 真的生效（不是「有没有调用」）；
- 回归验证：把修复撤掉后，`client.smoke` 的样式断言 **7 项全红**。

### ② 视觉验证用了手写的假主题值

**症状**：用户看真实页面时，桌宠的方块是**近黑色**、背景是一块偏蓝的灰；我给的
截图里却是**蓝色**方块、暖白卡片 —— 完全不是一回事。

**根因**：`tools/visual-check.mjs` 把主题 token 的值**手写**在文件里：

```js
--dsw-alias-brand-primary: #247bbf   // ← 我编的蓝
```

真实浅色主题里它是 `--dsw-static-neutral-bluish-1000` = `rgb(15,17,21)`，**近黑**。

**修复**：`tools/theme-tokens.mjs` 直接解析宿主的
`@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css`（`body` 块 = 浅色，
`body[data-ds-dark-theme]` = 深色），解析 alias → static 两层引用，拿到**真实取值**。
`visual-check` 与 `client.smoke` 的 token 清单都改用它。

⚠️ 同一类错误在 `client.smoke` 里也有过：主题 token 清单是手写的，于是新加的
`label-tertiary` 没进清单 → 测试红了 → 说明「手写清单」本身就是个会漂移的东西。
现在清单来自宿主真实 CSS，不会漂移。

### ③ 假数据比现实好看

**症状**：截图里工作区显示「HD222 游戏」「大发鱼」，真实页面显示 `HD222game`、
`dafeiyu`。

**根因**：宿主把 workspace 存成 `path: "F:\dsh-work", title: "dsh-work"`
（见 `$DSH_HOME/storages/workspace.json`）—— **title 就是 basename**。我却在
visual-check 里编了「更好看」的中文标题，于是掩盖了「标题与路径无区别」这个事实。

**修复**：假数据一律用**真实值**（从宿主存储里读出来的形态）。编造更漂亮的
数据不只是不诚实 —— 它会**掩盖产品问题**。

### ④ 落单反引号让整个文件无法加载

**症状**：反复出现「改一处 → 报 `SyntaxError: Unexpected identifier` → 找是哪行
→ 换成普通引号」。本插件在 `client.js` 上踩了 4 次、`visual-check.mjs` 上 3 次。

**根因**：这两个文件里有大段 CSS / HTML 的**模板字符串**。往注释里写一个
Markdown 风格的行内代码（`xxx`）看着无害，却会让模板字符串**提前闭合**，
整个文件语法错误 → **该文件整个不可加载**。

**修复**：`tools/check-stray-backticks.mjs` 静态检查「落单反引号」。

⚠️ 检查器必须放在**独立文件**里：若与被检查的文件同处一个模块，那它自己还没
跑到，被检查的文件就已经语法错误无法加载了——检查器形同虚设（实测：内嵌版本
在注入落单反引号时先报 SyntaxError，检查根本没跑）。现在 `client.smoke` 会
自动检查 `client.js` / `index.js` / `visual-check.mjs` 三个文件。

⚠️ 写这个检查器时自己也踩了同一个坑：块注释里写了「跳过单引号/双引号字符串」，
其中的「星号斜杠」序列提前闭合了注释，把工具自己写崩了。

## 顺带修掉的视觉问题

| 问题 | 修法 |
|---|---|
| 卡片宽度参差（445/445/218/218/445/445） | `flex` 改 `grid`，列数按卡片数注入（6 张 → 3 列 × 2 行，每行都满） |
| 6 张卡排成「5 + 1」，末张拉满整行 | 同上，`columnsFor()` 选能整除的列数 |
| 今日占比 1.1% 时填充条宽度 0.5px，渲染成「空槽」 | 填充条 `min-width: 3px` |
| 桌宠阴影单薄，浮不起来 | 改双层阴影（近处收紧 + 远处拉开） |
| 97 个纯黑方块连成黑墙 | 改灰阶：已填=浅灰，正在填=品牌色（全场唯一品牌色） |
| 看不出「第 3 页」是多大量级 | 每 10 格一道里程碑竖线，首末行标量级 |
| 桌宠是页面上一块突兀的蓝灰 | 背景改 `bg-layer-1` + 更深的 `border-l2` |
| 工作区横条铺满整页，「太开了」 | 整块限宽 520px，三列（名/条/数字）固定宽度对齐 |
| 桌宠工作区 chip 只剩一个圆点、没有字 | 标题加 `max-width`、chip 加 `flex-shrink: 0`（见下） |
| 设置页表格日期折成「2026-」「09-25」两行 | `table-layout: fixed` + 首列定宽 + 单元格 `nowrap` |
| 表头「缓存写」把一列撑得很宽 | 表头允许换行（`white-space: normal`），三字表头竖排两行 |
| 主面板一宽一窄：方块墙 320px、下面卡片各 445px 撑满 | 整页 `max-width: 560px` 居中，四个区块共用同一条边界 |
| 主面板所有元素平铺，分不清有几件事 | 加 `.dsh-tu-section` 分层：块间细分隔线（积累 / 总量 / 去向 / 诊断） |

### 桌宠工作区 chip 消失（flex 挤压）

用户实测截图里，桌宠标题栏是「`⠿ Token 方块墙 •`」——**圆点有、名字没有**。

根因是 flex 挤压：标题 `.dsh-tu-pet-title` 是 `flex: 0 1 auto` + `min-width: 0` +
`overflow: hidden`，chip 也是 `flex: 0 1 auto`。两者抢同一行空间时，标题先把
可用宽度吃满，chip 被压成 0 宽——只剩 `::before` 那个 4px 的小圆点可见。

修法：标题加 `max-width: 118px`（它是固定文案，优先级低），chip 加
`flex-shrink: 0`（里面的工作区名是关键信息，不该被挤掉）。

⚠️ 这类「元素存在但宽度为 0」的缺陷，**结构测试与 DOM 存在性检查都抓不到** ——
只有看图才能发现。

### 视觉确认的边界（不夸大）

上面那次截图用的是**真实组件 + 真实 CSS + 真实数据流**，但**宿主外壳是模拟的**：
侧栏、设置面板外框、composer 布局都不在验证范围内。原因是驱动真实页面需要
`dsh web` 打印的 launch token（鉴权 cookie），我没有也不应去取它。

所以仍然**没有**做过的：在真实 DSH 窗口里点开侧栏图标、拖动桌宠、切换深浅主题。
这三件事需要你在页面上确认一次。
