# CHANGELOG

## 0.1.1 — 2026-10-23

这一版没有新功能。它修的是**「数字错了但看不出来」**这一类问题——为公开发布做的加固。

一句话概括：**以前认不出宿主接口时会安静地显示 0，现在它会明说。**

---

### 1. 宿主接口适配（新增 `lib/adapter.js`）

`ctx.sessionPersistence` 在不同 DSH 版本里换过形状。回填原先写死了一代接口，三处不匹配，而且**三处全部静默失败**：

| 期望（旧代码） | 实际（较新的 DSH） | 后果 |
|---|---|---|
| `list()` → `{header, revision}[]` | `SessionHeader[]`（无包裹） | `snapshot.header.id` 是 `undefined` → 每个会话都被跳过 |
| `open(id, 'read', {signal})` | 不存在，只有 `load(id)` / `inspect(id)` + `readFrom(id, seq)` | 抛错被逐个 catch，全记 `failed` |
| `handle.inheritedEventCount` | 不存在，只有 `header.seedLength` / `session.firstLiveSeq` / `session/end-seed` | `num(undefined)=0` → fork 继承前缀被重复计入 |

用真实 API 形状跑生产代码：

```
较新形状   → sessions=0  entries=0  failed=0   ← 一条 warn 都没有
旧形状     → sessions=1  entries=2  failed=0
```

`sessions: 0` 在界面上读起来是「你本来就没有历史会话」，而不是「插件坏了」。这是最坏的失败形态，所以：

- 新增 `probePersistence()`：先探测，再按实际存在的成员名分支
- 探测结果进 `diagnostics.persistence`，设置页诊断区直接显示 `宿主接口: list=… read=…`
- 认不出来 → 落 `degraded`，以红色「回填降级」显示原因；**不再假装成功**
- 继承前缀按可信度三级回退：`header.seedLength` → `handle.inheritedEventCount` → 日志里最后一个 `session/end-seed` 的 `seq+1`；实时路径同理退到 `session.firstLiveSeq`

### 2. 统计口径统一（`/today` 与 `/summary`）

`/today` 原先直接读 `config.*`，**完全不看查询参数**。于是设置页取消勾选「含子会话」之后：区间合计变小、而方块墙/桌宠读的累计纹丝不动。

真机量出的偏差：**297,717,133 tokens**（同一屏两个数差 2.98 亿）。

修法：

- 两个端点共用 `wantsSub()` / `wantsAux()` 一套取值口径
- `/today` 接受 `includeSub` / `includeAux`，并把**本次实际用的口径**回显进 `config`
- 这两个口径从组件 `useState` 移到 `prefs.json`（`includeSub` / `includeAux`），离开设置页不再失效
- 方块墙、桌宠、横幅的轮询都带上当前口径 → 四处读数永远同源

### 3. 保留期同时淘汰内存（`lib/store.js`）

`pruneDays` 原先只作用于写出的文档，内存表 `this.days` 永不过期。后果是「累计」（读内存）比盘上大，**重启后数字下跌**——延迟到保留期到期那天才发作，最难查。

修法：写盘时同步剪内存表。⚠️ 顺序有陷阱——必须在 `this.written = cloneDays(this.days)` **之前**剪，否则被淘汰的天会在下次 flush 被当成「全新增量」重新写回盘，保留期等于没做。这条已写成测试。

### 4. `/summary` 回显字段语义修正

`config.includeSubagents` 在两个端点里含义不同（一个报部署期 config，一个报实际口径），真机实测同一个请求下是 `true` vs `false`。已统一为「本次响应用的实际口径」。

---

### 改动清单

```
新增  lib/adapter.js                     探测/列举/读取/继承前缀，两代接口都吃
新增  test/adapter.test.mjs              13 条：两套真实形状对照 + degraded 反向断言
新增  test/store.retention.test.mjs       4 条：内存与盘同时淘汰、淘汰后不复活
新增  test/host.today.filter.test.mjs     3 条：预置数据证明两端点口径一致
改    lib/collect.js                     backfill 走 adapter；实时路径用 liveSeedPrefixOf
改    index.js                           wantsSub/wantsAux；diagnostics.persistence；降级 warn
改    lib/store.js                       flush 里 prune 内存表；删死字段 writtenMarks
改    lib/prefs.js                       DEFAULT_PREFS 增 includeSub / includeAux
改    client.js                          诊断区显示宿主接口与降级；勾选框改存 prefs；轮询带口径
改    test/cross-validate.mjs            不再硬编码 inheritedEventCount: 0；A 侧 adapter、B 侧独立扫描
改    README / docs/DESIGN / docs/NOTES  同步口径、接口兼容性表、第五例验证器失效
```

---

### 验证

**自动化**（`npm test`，13 个测试文件全绿）：

- 两代接口形状对同一批事件必须给出**相同读数**
- 接口认不出来 → `degraded` 必须非空（反向断言，防止又回到静默）
- `keepDays <= 0` 不淘汰；淘汰后旧日键不复活；内存累计 == 盘上累计
- 两个端点在两种口径下 `allTime` 与回显字段都一致

**真机数据**（`~/.dsh/sessions`，120 个会话）：

- `cross-validate`：393,800,933 tokens，13 天 **0 处不一致**
- `store.e2e`：14,169 笔 / 3,589,191,517 tokens，重启一致、幂等、并发不互抹
- 回填实时读数：`sessions=120 / failed=0 / withUsage=14169 / skippedByWatermark=14169`
  （14179 条可入账事件里有 10 条没上报 `usage`——「没测到 ≠ 用了 0」在这份数据上可见）

**反向验证**（撤掉修复确认测试会红）：

| 撤掉什么 | 变红条数 |
|---|---|
| `store.js` 的内存淘汰 | 3 |
| `/today` 的口径参数 | 2 |
| `config` 回显字段修正 | 1 |

---

### 升级注意

- `client.js` 走 HMR 自动生效；**`index.js` / `lib/**` 需要「禁用 → 重新启用」bundle**，否则跑的还是老逻辑
- 生效后设置页诊断区应多出一行 `宿主接口: list=… read=…`
- 两个新的 prefs 键（`includeSub` / `includeAux`）默认 `true`，与旧行为一致，无需迁移
- `keepDays` 语义没变，但从这一版起它**同时作用于内存与盘**（以前只作用于盘）

### 未做（有意取舍）

- **落盘改追加式日志**：现在一次 `flush()` 是 2~3ms（400 天满载约 37ms）。改它要动读/写/合并/迁移四条路径，等数据量真的到了再说，顺手能把「多进程后覆盖」一起解决
- **`/prefs` 无鉴权、`locale/*.json` 与内联字典双源、方块墙的 `title` 落在 `aria-hidden` 子树里**等观感/加固项：不影响账对不对，留着
- **同一屏“速度”两个口径**（横幅是客户端 EMA、桌宠是本次运行均值）：这是设计而非缺陷，要改的是**文案**（「瞬时」/「本次均值」），不是逻辑
