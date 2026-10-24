# 手工验收清单

自动化测试（`npm test`）覆盖不到三类东西：**命令式 DOM 的真实布局**、**宿主契约的
真实形状**、**降级路径在真实数据下的表现**。这份清单只列那三类。

改动涉及桌宠与 `/today?session=` 时，逐条走一遍。

---

## 0. 准备：把本地开发副本接进 profile

```bash
# 1) 备份现有依赖声明
cd ~/.dsh/profiles/<profile>
cp package.json package.json.bak

# 2) 把 dsh-token-wall 指向本地 clone（profile 里已有 link: 先例）
#    "dsh-token-wall": "link:F:/path/to/dsh-token-wall"
# 3) 安装
pnpm install
```

⚠️ 装完确认 `node_modules/dsh-token-wall` 是指向 clone 的链接，而不是旧副本：

```bash
ls -l ~/.dsh/profiles/<profile>/node_modules/dsh-token-wall
```

**Host 半**（`index.js` / `lib/**`）改动需要让 bundle 重新加载（禁用→启用，或重启）。
**Client 半**（`client.js`）走 client HMR，约 500ms 后自动生效，不用重启。

---

## 1. 会话桥未挂载 → 必须显示 `—`，不能显示 0

**为什么重要**：这是本功能最可能的静默失效。桥接在 `GatedOdometer` 里时，
`statusBar` 默认 false → 桥永不渲染 → sessionId 永不推送 → 读数永远为空，
**而且不报任何错**。

**步骤**

1. 打开设置页（或方块墙面板）——此时 `conversation.input.dock` 不在树上。
2. 看桌宠。

**期望**

- 大数字显示 `—`（不是 `0`、不是 `0 tok`）。
- 附加读数行里的「上下文」与「缓存」显示 `—`。
- **进度条与池仍然照常**——它们来自本地日聚合，与会话无关。这是把「会话读数」
  与「积累读数」拆开之后的主要收益：会话数据缺失时，桌宠仍有一半可用。

**反向确认**：回到对话页，约 1 秒内大数字应变成真实数字。

---

## 2. 重启后读旧会话 → 必须能出数（走 `observeSession`）

**为什么重要**：`ctx.sessions.get(id)` 只返回**活**会话。重启后继续旧会话时它返回
`undefined`，必须靠 `sessionQuery.observeSession` 从磁盘折投影。这条路径只在冷会话
时走到，单测用 mock 覆盖，真实环境必须手工验。

**步骤**

1. 记下一个**旧会话**的用量（先在对话里看一次，或看 `daily.json`）。
2. 重启 DSH（host 会重启，活会话表清空）。
3. 打开那个旧会话。
4. 看桌宠。

**期望**

- 大数字在 1~2 秒内显示该会话的真实用量，**不是 `—`、不是 0**。
- 附加读数行里的「上下文」也应有值（若该会话发生过请求）。
- **「本轮 / 上一轮」也应当立刻有值**——冷读会把同一份日志顺手折一遍播种逐轮
  状态（见 `seedTurnsFromEvents`）。若这两项是空的，说明播种没生效。
- 首次可能有一拍延迟（要解日志），之后稳定。

**若显示 `—`**：查 `projectedUnavailable` 字段说明原因：

```bash
curl "http://127.0.0.1:<port>/dsh-token-usage/today?session=<会话id>" | jq .session
```

- `no-session-query` → 组合里没有 `sessionQuery` 服务。
- `query-failed: …` → 读盘失败，看 reason 里的原始错误。
- `no-token-usage` → 该会话日志里没有 `assistant/message` 的 usage。

---

## 3. 桌宠仍可拖动（`document.body` 挂载没被破坏）

**为什么重要**：桌宠当年从 slot 撤下来，是因为 `position:fixed` 会被带 `transform`
的祖先劫持成相对定位——表现为「只能在左边窄条里滑」。任何 DOM 结构调整都可能
重新引入它。

**步骤**

1. 按住桌宠**标题栏**拖动到屏幕左上、再拖到右下。
2. 折叠后再拖。
3. 窗口缩放一次。

**期望**

- 拖动跟手，指针移出窗口也继续跟。
- 松手后位置写入 `localStorage`（`dsh.tokenUsage.pet.pos`），刷新页面后回到原位。
- 拖到屏幕边缘被钳制在视口内，不会消失。
- 折叠态也能拖。

---

## 4. 本轮实时在涨（harness 做不到的那一项）

**为什么重要**：这是相对 harness 自带「本轮用量」的核心改进。harness 只在轮次
**结束后**才显示，所以必须手工确认我们**在流式过程中**就在涨。

**步骤**

1. 发一个会跑多步的请求（例如让它读几个文件）。
2. 在它还在跑的时候盯着桌宠的「本轮」读数。

**期望**

- 本轮读数在**轮次结束前**就逐步变大。
- 轮次结束后它停住；再发下一轮时从 0 重新涨（上一轮的值让位给「本会话」的累计）。

---

## 5. 上下文读数与 harness 自己的 context meter 大致一致

**为什么重要**：两处都在表达「上下文占了多少」。口径若不同（比如我们用了
`pressureTokens` 而 harness 用 `projectedTokens`），用户会看到两个矛盾的百分比。

**步骤**

1. 打开一个上下文占用较高的会话。
2. 对比桌宠附加读数行里的「上下文 NN%」与输入框附近 harness 的 context meter。

**期望**

- 两者**接近**（允许 1~2% 的取整差异）。
- 占用高（≥ 85%）时，那一格**数字**转红；≥ 60% 转黄。
- 折叠态此时应切换成显示百分比（而不是本会话量）。

⚠️ **注意别验错对象**：进度条表达的是「当前 10M 方块填了多少」，**不是**上下文。
它只在该块 ≥ 90% 时才开始呼吸，与上下文占用无关。

---

## 6. 会话切换不串台

**步骤**

1. 会话 A 里跑一轮，记下桌宠的本会话量。
2. 切到会话 B（不同工作区更好）。
3. 看桌宠。

**期望**

- 大数字切换到 B 的值（1~2 秒内），不残留 A 的数字。
- 工作区 chip 也应跟着变。

---

## 7. 无子会话/辅助调用的口径一致（回归）

**步骤**

1. 设置页关掉「含子会话」。
2. 分别看：方块墙累计、桌宠池、工作区分布。

**期望**

- 三者**同时**变小（工作区分布过去不跟随，是个已修的 bug）。
- 若只有区间合计变了而其他没变，说明口径又分叉了。

---

## 自动化覆盖了什么（不用手工重复）

| 项目 | 覆盖它的测试 |
|---|---|
| 逐轮折叠语义（重试累加 / 同步骤替换 / reasoning 不进总量 / 缺边界容错） | `test/turn-fold.test.mjs` |
| 三级降级、租约按 `[Symbol.dispose]` 释放、冷读播种、多会话不串台 | `test/host.session.test.mjs` |
| 进度条 == `blockWall().progress`，且**上下文百分比不影响它** | `test/blocks-cross.test.mjs` |
| 无会话数据必须显示 `—`（且进度条与池照常） | `test/odometer.text.mjs` |
| 附加读数（上下文 / 缓存 / 今日）、上一轮 tooltip | `test/odometer.text.mjs` |
| 桥独立注册、不受 prefs 控制、渲染 null | `test/client.smoke.mjs` |
| 折叠结果与宿主投影一致（真实日志） | `tools/cross-validate-turns.mjs` |
| 桌宠结构顺序与折叠态 CSS | `tools/pet-tree.mjs` |
