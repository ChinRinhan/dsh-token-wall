/**
 * **Client 半**：设置页 + 输入框下方的一行今日合计。
 *
 * ## 为什么是手写的 ModuleLoader bundle
 *
 * 官方模板与 `dsh-our-free-model` 都证明：这个格式**不需要构建步骤**，`client.js`
 * 直接手写即可。宿主只要求产物是 `window.__ModuleLoader__.load({ id, factory })`
 * 包装，且 `id` **必须等于包名**（模块表按包名索引）。
 *
 * ## 两条硬约束（来自官方 practices.md）
 *
 * 1. **绝不 `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 Harness
 *    Client 包**——它们随时会变，而手写 JS 没有类型检查，组件抛错会直接把 slot
 *    条目打空（控制台 `slot entry crashed in '<slot>'`）。因此控件全部自己写。
 * 2. **只用主题 token 上色**（`--dsw-alias-*`），这样浅色/深色跟随宿主；字面量
 *    颜色只用于插画。
 *
 * ## 数据桥
 *
 * 走 host 半注册的只读 HTTP 路由（`fetch`）而不是 RPC——这是本 profile 里
 * `dsh-theme-tarkov` 已验证可用的做法，少一层契约耦合。状态条只拉 `/today`
 * 这个轻量端点，避免每次轮询都下发整张聚合表。
 */

window.__ModuleLoader__.load({
  // 必须等于 package.json 的 name：模块表按包名索引，浏览器按包名来取 bundle，
  // 注册成别的名字 → 这一行永远解析不到 → 宿主再重试一次同一脚本 → 触发
  // duplicate factory registration → 整次 Web boot 判失败（一开 App 就弹错）。
  //
  // 浏览器 bundle 读不到 package.json，所以这里只能是字面量；防漂移靠
  // `npm run check` 里的 tools/check-boot-identity.mjs，它会在提交/发布前
  // 比对这一行与包名，不一致直接失败。
  id: 'dsh-token-wall',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PKG_NAME = 'dsh-token-usage'
    const ROUTE_PREFIX = '/dsh-token-usage'
    const NS = 'dsh-token-usage'
    /**
     * 方块墙主面板的 id。**必须同时用于 `sidebar.panellist` 的 `id` 与 `main`
     * 的 `key`**——侧栏按下这个 id 去 `main` 里取同名条目渲染。
     */
    const WALL_PANEL_ID = 'dsh-token-usage-wall'

    /** 界面文案。走 locale 服务注册，缺服务时直接用中文兜底。 */
    const DICT_ZH = {
      nav: 'Token 用量',
      title: 'Token 用量',
      subtitle: '按本机时区统计每次模型调用的 token 消耗，数据来自会话日志。',
      today: '今日',
      range: '区间',
      allTime: '累计',
      requests: '调用',
      input: '输入',
      cacheRead: '缓存读',
      cacheWrite: '缓存写',
      output: '输出',
      reasoning: '思考',
      total: '合计',
      granularity: '粒度',
      groupBy: '维度',
      day: '按天',
      week: '按周',
      month: '按月',
      provider: '按渠道',
      model: '按模型',
      providerModel: '渠道 / 模型',
      kind: '按类型',
      from: '起始',
      to: '结束',
      refresh: '刷新',
      loading: '加载中…',
      loadFailed: '读取失败',
      noData: '区间内没有数据',
      includeSub: '含子会话',
      includeAux: '含辅助调用（压缩等）',
      diagnostics: '诊断',
      sessionsTracked: '已跟踪会话',
      liveEntries: '实时入账',
      backfill: '历史回填',
      storePath: '存储位置',
      memoryOnly: '仅内存（未找到 DSH home）',
      notBackfilled: '尚未回填',
      backfillDegraded: '回填降级',
      backfillDegradedHint: '读数可能偏低：宿主接口与插件预期不一致',
      hostApi: '宿主接口',
      hostApiMissing: '不可用',
      rangePreset7: '近 7 天',
      rangePreset30: '近 30 天',
      rangePreset90: '近 90 天',
      statusBarLabel: '今日',
      allTimeShort: '累计',
      rate: '速度',
      yesterday: '昨日',
      tokens: 'tokens',
      // ── 方块墙 ──
      wallTitle: 'Token 方块墙',
      wallSubtitle: '每 10M tokens 填满一个方块。累计只增不减，所以按 100 块一页分页。',
      wallHave: '已获得',
      wallBlockUnit: '块',
      wallFilling: '正在填',
      wallEmpty: '空白',
      wallNext: '下一块',
      wallPage: '第',
      scopeAll: '累计',
      scopeToday: '今日',
      petHint: '拖动标题栏可移动',
      petCollapse: '折叠',
      petExpand: '展开',
      // ── 会话读数（桌宠）──
      sessionLabel: '本会话',
      turnLabel: '本轮',
      prevTurnLabel: '上一轮',
      contextLabel: '上下文',
      contextUnavailable: '上下文占用暂不可用',
      contextCollapsedHint: '上下文接近上限，快会被压缩',
      cacheHitLabel: '缓存',
      cacheUnavailable: '缓存命中率暂不可用',
      navWall: 'Token 方块墙',
      kindChat: '对话调用',
      kindAux: '辅助调用（压缩等）',
      wallPerBlock: '/ 块',
      unnamedProvider: '(未标注渠道)',
      unnamedModel: '(未标注模型)',
      sessionsWord: '个会话',
      wsTitle: '工作区消耗',
      wsGroupBy: '工作区',
      wsHint: '按工作区（会话所在目录）统计的分布',
      distModelTitle: '模型消耗',
      distModelHint: '同一模型的多个渠道/版本变体已合并',
      distVendorTitle: '厂商消耗',
      distVendorHint: '按模型研发商归并',
      distVariants: (n) => `${n} 个变体`,
      distModels: (n) => `${n} 个模型`,
      distTabWorkspace: '工作区',
      distTabModel: '模型',
      distTabVendor: '厂商',
      wsCurrent: '当前工作区',
      wsUnnamed: '(未标注工作区)',
      wsOthers: '其他',
      wsEmpty: '还没有工作区数据',
      wsScopeAll: '累计',
      wsScopeToday: '今日',
      entriesWord: '笔入账',
      withUsageWord: '笔带用量',
      // 运行时开关（设置页用）
      modsTitle: '显示哪些模块',
      modsStatusBar: '输入框上方横幅',
      modsPet: '桌面悬浮面板（桌宠）',
      modsWallPanel: '侧栏「Token 方块墙」面板',
      modsHint: '改动立即生效，不用重启',
    }
    const DICT_EN = {
      nav: 'Token Usage',
      title: 'Token Usage',
      subtitle: 'Token spend per model call, bucketed in your local timezone from the session log.',
      today: 'Today',
      range: 'Range',
      allTime: 'All time',
      requests: 'Calls',
      input: 'Input',
      cacheRead: 'Cache read',
      cacheWrite: 'Cache write',
      output: 'Output',
      reasoning: 'Reasoning',
      total: 'Total',
      granularity: 'Granularity',
      groupBy: 'Group by',
      day: 'Day',
      week: 'Week',
      month: 'Month',
      provider: 'Provider',
      model: 'Model',
      providerModel: 'Provider / model',
      kind: 'By kind',
      from: 'From',
      to: 'To',
      refresh: 'Refresh',
      loading: 'Loading…',
      loadFailed: 'Failed to load',
      noData: 'No data in range',
      includeSub: 'Include sub-sessions',
      includeAux: 'Include auxiliary calls (compaction etc.)',
      diagnostics: 'Diagnostics',
      sessionsTracked: 'Sessions tracked',
      liveEntries: 'Live entries',
      backfill: 'Backfill',
      storePath: 'Store',
      memoryOnly: 'Memory only (DSH home not found)',
      notBackfilled: 'Not yet backfilled',
      backfillDegraded: 'Backfill degraded',
      backfillDegradedHint: 'Numbers may be low: host API does not match what the plugin expects',
      hostApi: 'Host API',
      hostApiMissing: 'unavailable',
      rangePreset7: 'Last 7 days',
      rangePreset30: 'Last 30 days',
      rangePreset90: 'Last 90 days',
      statusBarLabel: 'Today',
      allTimeShort: 'All time',
      rate: 'Rate',
      yesterday: 'Yesterday',
      tokens: 'tokens',
      // ── Block wall ──
      wallTitle: 'Token Block Wall',
      wallSubtitle: 'Every 10M tokens fills one block. The total only grows, so the wall is paged at 100 blocks.',
      wallHave: 'Earned',
      wallBlockUnit: 'blocks',
      wallFilling: 'Filling',
      wallEmpty: 'Empty',
      wallNext: 'Next block',
      wallPage: 'page',
      scopeAll: 'All time',
      scopeToday: 'Today',
      petHint: 'Drag the title bar to move',
      petCollapse: 'Collapse',
      petExpand: 'Expand',
      // ── Session readouts (pet) ──
      sessionLabel: 'This session',
      turnLabel: 'This turn',
      prevTurnLabel: 'previous turn',
      contextLabel: 'Context',
      contextUnavailable: 'Context usage unavailable',
      contextCollapsedHint: 'Context nearly full — compaction is close',
      cacheHitLabel: 'cache',
      cacheUnavailable: 'Cache hit rate unavailable',
      navWall: 'Token Block Wall',
      kindChat: 'Chat calls',
      kindAux: 'Auxiliary calls (compaction etc.)',
      wallPerBlock: 'per block',
      unnamedProvider: '(unnamed provider)',
      unnamedModel: '(unnamed model)',
      sessionsWord: 'sessions',
      wsTitle: 'Workspace spend',
      wsGroupBy: 'Workspace',
      wsHint: 'Distribution by workspace (a session\u2019s directory)',
      distModelTitle: 'Model spend',
      distModelHint: 'Variants from different providers are merged',
      distVendorTitle: 'Vendor spend',
      distVendorHint: 'Grouped by model vendor',
      distVariants: (n) => `${n} variants`,
      distModels: (n) => `${n} models`,
      distTabWorkspace: 'Workspace',
      distTabModel: 'Model',
      distTabVendor: 'Vendor',
      wsCurrent: 'current workspace',
      wsUnnamed: '(unnamed workspace)',
      wsOthers: 'others',
      wsEmpty: 'No workspace data yet',
      wsScopeAll: 'All time',
      wsScopeToday: 'Today',
      entriesWord: 'entries',
      withUsageWord: 'with usage',
      // Runtime toggles (settings page)
      modsTitle: 'Visible modules',
      modsStatusBar: 'Banner above the composer',
      modsPet: 'Floating panel (desktop pet)',
      modsWallPanel: 'Sidebar "Token Block Wall" panel',
      modsHint: 'Changes apply immediately, no restart',
    }

    /** 本地时区的日键（与 host 半 `localDayKey` 同口径）。 */
    function localDayKey(ts) {
      const d = new Date(ts)
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${m}-${day}`
    }

    /** 日键加减天数。 */
    function shiftDayKey(key, delta) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
      if (m === null) return key
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      d.setDate(d.getDate() + delta)
      return localDayKey(d.getTime())
    }

    /** 紧凑数字：1234567 → 1.23M。用于状态条与卡片大字。 */
    function compact(n) {
      const v = Number(n) || 0
      const abs = Math.abs(v)
      if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`
      if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`
      if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`
      return String(Math.trunc(v))
    }

    /**
     * 有限数，否则 `undefined`。
     *
     * ## 为什么需要它
     *
     * `compact()` 里的 `Number(n) || 0` 会把 `NaN` 吃成 `0`——对一般读数这是
     * 无害兜底，但对**会话用量**是灾难：宿主投影一旦改名或换形状（例如
     * `uncachedInputTokens` 变成别的拼写），`NaN` 会被渲染成 `0`，用户看到
     * 「本会话 0」而不是「读不到」。
     *
     * DESIGN 反复强调过：「读不到」与「花了 0」是两件完全不同的事。所以凡是
     * 进入会话读数的数字，都先过这一层——拿不到就是 `undefined`，由调用方画 `—`。
     */
    function finiteOrUndefined(value) {
      const n = Number(value)
      return Number.isFinite(n) ? n : undefined
    }

    /**
     * 宿主 `tokenUsage` 投影的四桶求和；任一桶不是有限数就返回 `undefined`。
     *
     * ⚠️ 四个桶是**必填**的（宿主的 `wireSchema` 要求全部存在）。少一个就说明
     * 契约变了，此时宁可显示 `—` 也不能把剩下三个加起来冒充总额。
     *
     * ⚠️ 这里的算术与 `lib/turns.js` 的 `totalOf` 是同一份口径的第两份实现
     * （客户端 bundle 不能 import lib）。`test/blocks-cross.test.mjs` 的同款思路
     * 在 `distribution.test.mjs` 里有交叉断言——改这里要一起改。
     */
    const PROJECTION_BUCKETS = [
      'uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    ]
    function sumProjectionBuckets(usage) {
      if (usage === null || typeof usage !== 'object') return undefined
      let total = 0
      for (const key of PROJECTION_BUCKETS) {
        const n = finiteOrUndefined(usage[key])
        if (n === undefined) return undefined
        total += n
      }
      return total
    }

    /** 带千分位的整数：用于表格单元格。 */
    function grouped(n) {
      return String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * `kind` 枚举 → 本地化文案。
     *
     * host 半的 `/summary` 在 `groupBy=kind` 时只下发枚举值（`chat` / `aux`），
     * 文案在展示层决定——这样切换语言时不用让 host 重启，也不会出现「英文界面
     * 里冒出中文分组名」。
     */
    function kindLabel(t, kind) {
      return kind === 'aux' ? t('kindAux') : t('kindChat')
    }

    /**
     * 路径的末级目录名：`D:\projects\alpha` → `alpha`。反斜杠与正斜杠都处理
     * （Windows 路径在日志里两种形态都出现过）。取不到末级时原样返回。
     */
    function basenameOf(cwd) {
      const m = /([^\\/]+)$/.exec(String(cwd ?? ''))
      return m !== null ? m[1] : String(cwd ?? '')
    }

    /** 极简样式（全部走主题 token，浅色/深色自动跟随）。 */
    const CSS = `
/* 主面板容器。
   ⚠️ 必须限宽并**居中**：早先它是满宽，于是「方块墙」那部分是窄的（320px），
   而下面是满宽的两张卡片（各 445px）——一宽一窄没有共同对齐线，看着散。
   现在整页统一 560px 居中，所有区块共用同一条左右边界。 */
.dsh-tu-root {
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.6;
  max-width: 560px; margin: 0 auto;
}
/* 分区块：每块有自己的上下留白，块之间用细分隔线分层——
   早先所有元素平铺，读者分不清「方块墙 / 工作区 / 汇总」是三件事还是一件事。 */
.dsh-tu-section { margin: 0 0 20px; }
.dsh-tu-section + .dsh-tu-section {
  padding-top: 18px; border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsh-tu-h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
.dsh-tu-sub { color: var(--dsw-alias-label-secondary); margin: 0 0 16px; }
/* 卡片网格。
   ⚠️ 早先用 flex: 1 1 150px，实测 6 张卡在同一行里会排成
   445 / 445 / 218 / 218 / 445 / 445 这种参差宽度——flex-grow 只按剩余空间
   分配，末行不满时会留下难看的空档。

   改用 grid，但**列数由卡片数量决定**（由 totalsCards 注入 --dsh-tu-cols）：
   纯 auto-fit 会把 6 张排成「5 + 1」，最后那张拉满整行，比参差更难看。
   按数量等分（6 张 → 3 列 2 行）每张宽度一致，视觉上是一条整齐的带子。 */
.dsh-tu-cards {
  display: grid; gap: 10px; margin-bottom: 16px;
  grid-template-columns: repeat(var(--dsh-tu-cols, 2), minmax(0, 1fr));
}
/* 窄屏：最多两列，再窄就一列。 */
@media (max-width: 720px) {
  .dsh-tu-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 420px) {
  .dsh-tu-cards { grid-template-columns: minmax(0, 1fr); }
}
.dsh-tu-card {
  padding: 10px 12px; min-width: 0;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.dsh-tu-card-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-tu-card-value { font-size: 20px; font-weight: 600; margin-top: 2px; }
.dsh-tu-card-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 2px; }
/* 工具栏：同一行里「分段控件 / 快捷区间 / 日期 / 刷新」是一组相关操作，
   用 row-gap 比纯 gap 更紧凑；align-items:center 让高矮不一的控件
   （按钮 26px、日期输入 24px、分段控件 24px）基线对齐。 */
.dsh-tu-toolbar {
  display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin-bottom: 10px;
}
.dsh-tu-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; overflow: hidden; }
.dsh-tu-seg button {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
}
/* 选中态：用主题 token 的层次差 + 品牌色下划线做强调。
   ⚠️ 刻意**不**做「品牌底色 + 白字」的反色处理：主题 token 里没有「品牌前景色」
   这一项，硬写 #fff 会违反「只用主题 token 上色」的约束（浅色/深色下都可能失配）。 */
.dsh-tu-seg button[data-active="true"] {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary);
}
.dsh-tu-seg button:hover[data-active="false"] { color: var(--dsw-alias-label-primary); }
.dsh-tu-input {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  padding: 4px 8px; font-size: 12px; font-family: inherit;
}
.dsh-tu-btn {
  appearance: none; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.dsh-tu-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dsh-tu-check {
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer;
}
.dsh-tu-check input { accent-color: var(--dsw-alias-brand-primary); }
/* 运行时开关区（设置页顶部）。三个开关竖排，各占一行——横排会挤在一行里
   读不出哪个开关对应哪个模块。 */
.dsh-tu-mods {
  display: flex; flex-direction: column; gap: 7px; align-items: flex-start;
  margin: 0 0 18px; padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-tu-mods-title {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary);
  margin-bottom: 2px;
}
/* 聚合结果表。
   ⚠️ 列宽必须**固定**：width: 100% 的表会把「其他列」挤到最小，于是日期
   折成「2026-」「09-25」两行、表头「缓存写」被撑成一整行宽——看起来「很粗」，
   也不好比数。改成 table-layout: fixed + 每列显式宽度后，日期不折行、
   表头紧凑，数字列也成列。 */
.dsh-tu-table {
  width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px;
}
.dsh-tu-table th, .dsh-tu-table td {
  text-align: right; padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  /* 数字不折行：nowrap + 溢出省略。 */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 第一列（日期 / 维度名）左对齐，且给足宽度让日期不折行。 */
.dsh-tu-table th:first-child, .dsh-tu-table td:first-child {
  text-align: left; width: 96px;
}
.dsh-tu-table th { color: var(--dsw-alias-label-secondary); font-weight: 500; }
/* 表头允许换行（「缓存写」这类三字表头竖排两行比撑宽一列更好看）。 */
.dsh-tu-table th { white-space: normal; line-height: 1.25; }
.dsh-tu-table tfoot td { font-weight: 600; border-bottom: 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-tu-empty { color: var(--dsw-alias-label-secondary); padding: 16px 0; }
.dsh-tu-err { color: var(--dsw-alias-state-error-primary); }
.dsh-tu-diag { margin-top: 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-tu-diag code { color: var(--dsw-alias-label-primary); }
/* ── 累计里程表（输入框上方常驻）─────────────────────────────────────
   克制风格：无粒子/火焰，靠「上升曲线 + 递增数字 + 填充条」三件事传达在涨。

   两条硬要点：
   1. tabular-nums —— 否则每次进位整行宽度都会跳；
   2. **按信息单元分组**，不做「一堆 span 加 flex-wrap」——那样换行时会出现
      孤立的「·」，并把数字和单位拆开（曾出现「623,892,036tokens」挤在一起）。 */
.dsh-tu-odo {
  display: flex; flex-direction: column; gap: 4px;
  width: 100%; box-sizing: border-box;
  padding: 6px 10px 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
}
/* 主行允许换行：窄宽度时让数字落到曲线下方，而不是被挤压或溢出。
   （累计数字有 11 个字符，如 623,892,036，比曲线本身还宽。） */
.dsh-tu-odo-top { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; min-width: 0; }
.dsh-tu-odo-bottom {
  display: flex; align-items: center; flex-wrap: wrap; gap: 3px 14px; min-width: 0;
}
/* 上升曲线：本次窗口内累计量的走势，左低右高即「越花越多」。 */
.dsh-tu-spark { flex: 0 0 auto; display: block; }
.dsh-tu-spark-line {
  fill: none; stroke: var(--dsw-alias-brand-primary);
  stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round;
}
.dsh-tu-spark-area { fill: var(--dsw-alias-brand-primary); fill-opacity: 0.14; stroke: none; }
.dsh-tu-odo-hero { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.dsh-tu-odo-value {
  font-size: 16px; font-weight: 600; letter-spacing: 0.2px;
  color: var(--dsw-alias-label-primary);
  transition: color 180ms ease-out;
}
/* 刚涨过：一次很轻的高亮，只提示「它动了」，不做闪烁。 */
.dsh-tu-odo-value.is-bump { color: var(--dsw-alias-brand-primary); }
.dsh-tu-odo-unit { color: var(--dsw-alias-label-secondary); }
/* 每个信息单元各自成组，换行只发生在单元之间。 */
.dsh-tu-odo-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.dsh-tu-odo-item b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsh-tu-odo-dim { color: var(--dsw-alias-label-secondary); opacity: 0.8; }
/* 当前工作区 chip：里程表里的「这是哪个项目」上下文。
   一个小圆点 + 名字，刻意做得比读数轻——它是上下文，不是读数。 */
.dsh-tu-odo-ws { color: var(--dsw-alias-label-secondary); max-width: 180px; }
.dsh-tu-odo-ws > span:last-child {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-tu-odo-ws-dot {
  flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}
/* 今日占比：一条细填充条，随今天的使用增长。
   ⚠️ 填充条给 min-width：占比很小时（清晨刚开工，1.1%）宽度只有 0.5px，
   浏览器会把它渲染成「不存在」——用户看到的是空槽，会以为条坏了。给 3px 下限，
   让「有了一点点」这件事在视觉上成立。 */
.dsh-tu-odo-bar {
  display: inline-block; width: 44px; height: 4px; border-radius: 2px;
  background: var(--dsw-alias-bg-layer-2); overflow: hidden; vertical-align: middle;
}
.dsh-tu-odo-bar-fill {
  display: block; height: 100%; border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
  min-width: 3px;
  transition: width 400ms ease-out;
}

/* ── 方块墙 ──────────────────────────────────────────────────────────
   每 10M tokens 一个方块。已填 / 正在填 / 空白三态，用颜色与透明度区分，
   不引入额外色板——全部走主题 token。 */
.dsh-tu-wall-head {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px;
  margin-bottom: 8px;
}
.dsh-tu-wall-total {
  font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
}
.dsh-tu-wall-count { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-tu-wall-count b { color: var(--dsw-alias-label-primary); font-weight: 600; }
/* 方块墙网格：10 列 × 10 行 = 100 格 = 10 亿 tokens。
   行之间用 8px 间隙、列之间 5px —— 行距更大，于是「每 10 格一个里程碑」
   的分隔线在视觉上成立（10 列正好一行）。
   ⚠️ 顶部留 14px：里程碑的量级标签在方块内部绝对定位到方块**上方**，
   没有这块空间它会被上一行挡住。 */
.dsh-tu-wall-grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 5px;
  row-gap: 8px;
  position: relative;
  padding-top: 14px;
  /* 10 列 × 26px + 间隙 ≈ 305px；给一个上限免得在宽面板里被拉成巨块。
     max-width 而不是固定宽度：窄屏时跟着缩，不溢出。 */
  max-width: 320px;
}
.dsh-tu-block {
  aspect-ratio: 1 / 1; border-radius: 3px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  position: relative; overflow: hidden;
}
/* 已填满。
   ⚠️ 刻意**不用** brand-primary 实心：真实浅色主题里 brand-primary 是近黑
   rgb(15,17,21)，97 个纯黑方块连成一片黑墙，压抑且没有层次。
   改用「浅灰实心 + 深色描边」：一眼还是「实心 = 已获得」，但整体是灰阶的，
   黑色留给**正在填**的那一块（视线自然落在最新进度上）。 */
.dsh-tu-block.is-filled {
  background: var(--dsw-alias-label-tertiary);
  border-color: var(--dsw-alias-label-tertiary);
  opacity: 0.55;
}
/* 正在填：用品牌色 + 一条从左到右的填充表示进度——全场唯一的品牌色，
   所以「进度条在哪」不需要找。 */
.dsh-tu-block.is-partial {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-tu-block-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: var(--dsw-alias-brand-primary);
  transition: width 400ms ease-out;
}
/* 里程碑刻度：每 10 格（= 1 亿 tokens）画一道竖线 + 标出量级。
   之前 100 个方块没有任何量级提示，看不出「第 3 页」到底是多大量级。

   ⚠️ 竖线画在**每行开头**（行首方块的左侧），因此网格要留出左边距；
   量级标签放在竖线**左边**（网格的 padding 区），而不是塞进方块里——
   方块只有 26px，装不下 "2.01B" 这样的文字（实测被截断成 "2.01"）。 */
.dsh-tu-wall-grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 5px;
  row-gap: 8px;
  position: relative;
  /* 左边距：给里程碑竖线 + 量级标签留位置。 */
  padding-left: 34px;
  /* 顶部：标签在竖线左侧，与首行对齐即可，不需要顶部空间。 */
  padding-top: 2px;
  /* 10 列 × 26px + 间隙 ≈ 305px；给一个上限免得在宽面板里被拉成巨块。
     max-width 而不是固定宽度：窄屏时跟着缩，不溢出。 */
  max-width: 354px;
}
.dsh-tu-milestone {
  /* 竖线与标签都在**网格层**（都是网格的直接子元素），用同一套百分比定位，
     所以两者必然对齐——不会因为「一个在方块内、一个在网格内」而错位。 */
  position: absolute; left: 26px; width: 1px;
  height: calc(100% / 10 - 8px);
  background: var(--dsw-alias-label-tertiary);
  opacity: 0.55;
  pointer-events: none;
}
.dsh-tu-milestone-label {
  position: absolute; left: 2px; width: 22px; text-align: right;
  font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary);
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
/* 刚获得一块：一次很轻的放大脉冲，提示「赚到了」。 */
.dsh-tu-block.is-new { animation: dsh-tu-pop 420ms ease-out; }
@keyframes dsh-tu-pop {
  0% { transform: scale(1); }
  35% { transform: scale(1.22); }
  100% { transform: scale(1); }
}
.dsh-tu-wall-foot {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 14px;
  margin-top: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary);
}
.dsh-tu-legend { display: inline-flex; align-items: center; gap: 5px; }
.dsh-tu-legend-swatch {
  width: 10px; height: 10px; border-radius: 2px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
}
.dsh-tu-legend-swatch.is-filled { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsh-tu-legend-swatch.is-partial { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary); }
.dsh-tu-wall-next { color: var(--dsw-alias-label-primary); font-weight: 600; }

/* ── 工作区消耗横条 ─────────────────────────────────────────────────
   方块墙表达「越花越多」，横条表达「钱花在哪」——两件事互补，所以放在同一页。

   实现刻意用 CSS 宽度百分比而不是 SVG：一个是这本来就是一维占比（不需要坐标变换），
   另一个是前端约束下 SVG 手写易错、收益为零。每行 = 工作区名 + 条 + 数字。

   ⚠️ **整个区块限宽**（max-width）：早先它铺满面板宽度，于是横条被拉成
   一条横贯屏幕的细线，右边的数字孤零零飘在几百像素外——「太开了」，很难一眼
   对齐比较。现在整块固定在 520px，条、数字、占比三列都在视线内。 */
/* 消耗分布。
   ⚠️ 列宽分配的关键约束：**条必须弹性，其余固定**。
   早先条也是固定 240px，于是四列固定宽度之和（132+240+86+46=504）
   加 3 个 gap(30) = 534px，已经超过容器 520px；「按模型/厂商」再加一列
   副标题（5 列 4 gap）直接溢出 70px+ —— 后面的数值与占比被挤出去。
   现在条吃剩余空间，固定列之和永远小于容器，副标题也给了固定宽度
   以保证各行条的左边缘仍然对齐。 */
.dsh-tu-ws { margin-top: 18px; max-width: 520px; }
.dsh-tu-ws-title {
  font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary);
  margin-bottom: 8px;
}
.dsh-tu-ws-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
/* 名称：固定宽度列，让所有条的左边缘对齐（否则长短不一很难比）。
   超出省略——完整路径在 title 属性里，hover 可见。 */
.dsh-tu-ws-name {
  flex: 0 0 118px; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 条：**弹性**，吃剩余空间。min-width 保证极窄时仍可见。 */
.dsh-tu-ws-track {
  flex: 1 1 auto; min-width: 40px; height: 8px; border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2); overflow: hidden;
}
.dsh-tu-ws-bar {
  display: block; height: 100%; border-radius: 4px;
  background: var(--dsw-alias-brand-primary);
  min-width: 2px;
  transition: width 400ms ease-out;
}
/* 当前项用品牌色高亮，其余用低透明度——一眼看出「我在哪一行」。 */
.dsh-tu-ws-row.is-current .dsh-tu-ws-bar { background: var(--dsw-alias-brand-primary); }
.dsh-tu-ws-row:not(.is-current) .dsh-tu-ws-bar { opacity: 0.55; }
.dsh-tu-ws-value {
  flex: 0 0 72px; text-align: right; font-size: 11px;
  color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums;
}
/* 消耗分布的维度切换（工作区 / 模型 / 厂商）。 */
.dsh-tu-dist-tabs { margin-bottom: 10px; }
/* 副标题（「4 个变体」/「3 个模型」）：解释这个数字背后合并了什么。
   ⚠️ 用**固定宽度**而不是 auto：auto 会随文案长短变化（「4 个变体」与
   「3 个模型」宽度不同），于是不同维度下条的左边缘位置会跳。
   固定 62px 后，最长文案（「12 个变体」）也能放下且不换行。 */
.dsh-tu-ws-sub {
  flex: 0 0 62px; text-align: right; font-size: 10px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-tu-ws-share {
  flex: 0 0 44px; text-align: right; font-size: 11px;
  color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
}
/* 窄屏：容器放开，固定列再收一点，条继续弹性。 */
@media (max-width: 640px) {
  .dsh-tu-ws { max-width: none; }
  .dsh-tu-ws-name { flex-basis: 88px; }
  .dsh-tu-ws-sub { flex-basis: 54px; }
  .dsh-tu-ws-value { flex-basis: 64px; }
}
/* 面板与桌宠共用的分段选择器（累计 / 今日）。 */
.dsh-tu-seg2 { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; overflow: hidden; }
.dsh-tu-seg2 button {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  padding: 3px 9px; font-size: 11px; cursor: pointer; font-family: inherit;
}
.dsh-tu-seg2 button[data-active="true"] {
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary);
}

/* ── 桌宠（可拖动小部件，命令式 DOM 挂在 document.body 上）────────────
   不走 slot：宿主 React 树里带 transform 的祖先会把 position:fixed 劫持成
   相对定位（这正是「卡在左边拖不动」的根因）。挂在 body 上就没有这个问题。 */
#dsh-tu-pet {
  position: fixed; left: 0; top: 0; z-index: 2147483000;
  /* 宽度：改成「单充能块 + 池」后内容少了很多，**收窄**到 196px。
     早先 268px 是为了装 30 格网格 + 一整行仪表——现在网格没了，268 太空。 */
  width: 196px; box-sizing: border-box;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  /* ⚠️ 背景**不用** bg-overlay：真实浅色主题里它是 rgb(233,236,242)——一块
     偏蓝的灰，浮在暖白页面上很突兀（用户实测截图就是这个问题）。
     改用 bg-layer-1（白）+ 更深的 border-l2，桌宠就与页面同底色、只靠阴影
     浮起来。深色主题下 bg-layer-1 是 rgb(35,35,36)，同样贴合。 */
  background: var(--dsw-alias-bg-layer-1);
  /* 双层阴影：近处一层收紧轮廓、远处一层拉开高度，比单层大阴影更像「浮起来」。 */
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.10), 0 10px 32px rgba(0, 0, 0, 0.20);
  /* 拖动时不要触发文字选中（否则会选到背后的页面文本）。 */
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
  user-select: none; -webkit-user-select: none;
  overflow: hidden;
}
/* 标题栏 = 抓取把手。 */
#dsh-tu-pet .dsh-tu-pet-head {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: grab; touch-action: none;
}
#dsh-tu-pet.is-dragging .dsh-tu-pet-head { cursor: grabbing; }
#dsh-tu-pet .dsh-tu-pet-grip {
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1;
  letter-spacing: -1px; opacity: 0.7;
}
#dsh-tu-pet .dsh-tu-pet-title {
  /* ⚠️ 标题必须**限宽**（max-width），否则它会 flex 撑满，把后面的工作区 chip
     压成 0 宽——chip 的文字消失、只剩 ::before 那个小圆点（用户实测截图正是
     这个现象：圆点有、名字没有）。给标题一个上限，chip 才有位置。 */
  flex: 0 1 auto; min-width: 0; max-width: 118px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
/* 工作区 chip：跟在标题后的小圆点 + 名字。它回答「这份用量属于谁」。
   拿不到 cwd 时整块 hidden（不占位、不留空白）。
   ⚠️ flex-shrink: 0 —— chip 里的工作区名是**关键信息**，不该被标题挤掉；
   真放不下时让标题先省略（标题「Token 方块墙」是固定文案，优先级更低）。 */
#dsh-tu-pet .dsh-tu-pet-ws {
  flex: 0 0 auto; min-width: 0; display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#dsh-tu-pet .dsh-tu-pet-ws::before {
  content: ''; flex: 0 0 auto; width: 4px; height: 4px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}
#dsh-tu-pet .dsh-tu-pet-btn {
  appearance: none; border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  width: 18px; height: 18px; line-height: 1; border-radius: 4px;
  font-size: 13px; font-family: inherit; padding: 0;
  margin-left: auto;
}
#dsh-tu-pet .dsh-tu-pet-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
#dsh-tu-pet .dsh-tu-pet-body-space { display: contents; }
#dsh-tu-pet .dsh-tu-pet-total {
  display: flex; align-items: baseline; gap: 5px;
  padding: 7px 10px 1px; white-space: nowrap; overflow: hidden;
}
/* 「累计」标签：比数字弱一档，让数字仍是主角。 */
#dsh-tu-pet .dsh-tu-pet-total-label {
  font-size: 10px; font-weight: 400; color: var(--dsw-alias-label-tertiary);
}
#dsh-tu-pet .dsh-tu-pet-total-value {
  font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis;
}
/* ── 桌宠动效 ────────────────────────────────────────────────────────
   桌宠之前是「半成品」：只有一个方块阵列，没有任何动效。
   现在给它三样**克制**的动效——动效的作用是「让它活着」，不是「让它抢戏」：

   1. **呼吸**（is-live）：「正在填」的那块轻微脉动。它是进度指示器，常驻脉动
      让面板有生气；只有一块在动，不会喧宾夺主。
/* ── 进度条 + 池 ─────────────────────────────────────────────────────
   「越攒越多」只用一块的面积来表达：
   - **进度条**：它在 PR2 会换成「上下文占用」（有真实分母，快满会被压缩）；
     PR1 仍是 10M 充能比例。为了能替换，它被写成**通用 meter**：
     .dsh-tu-pet-meter 只负责尺寸与摆放，语义由 data-kind 决定。
   - **池**：已经攒下的整块数（**全时累计**，不随 scope 变）。
   「充能 → 满 → 推进池里」这个动作本身就是最直观的积累。 */
#dsh-tu-pet .dsh-tu-pet-charge {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 10px 6px;
}
#dsh-tu-pet .dsh-tu-pet-charge-block {
  /* 进度条是视觉主体，做得比附带读数显眼：高度 26px + 圆角，看得出「在填」。 */
  position: relative; flex: 1 1 auto; height: 26px; border-radius: 5px;
  box-sizing: border-box; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
/* 填充：一条从左到右的生长条。 */
#dsh-tu-pet .dsh-tu-pet-charge-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: var(--dsw-alias-brand-primary);
  transition: width 400ms ease-out;
}
/* 快满了（>= 90%）：轻微呼吸，提示「马上要满」。
   PR1 它是「快攒到一块」；PR2 换成上下文占用后，它变成「快被压缩」——
   同一个机制，后者才是真有后果的告警。 */
#dsh-tu-pet .dsh-tu-pet-charge-block.is-almost {
  border-color: var(--dsw-alias-brand-primary);
  animation: dsh-tu-breathe 1.4s ease-in-out infinite;
}
/* 严重度着色：只给**上下文读数**用，不给进度条用。
   ⚠️ 进度条表达的是「积累进度」（还差多少攒满一块），不是告警——把它染红会让
   用户以为「块要炸了」。真正有后果的是上下文占用，所以颜色只出现在附加读数里。
   ⚠️ 只用主题 token（--dsw-alias-state-*），写死颜色在深色主题里会刺眼。 */
#dsh-tu-pet .dsh-tu-pet-meta-value.is-warn { color: var(--dsw-alias-state-warn-primary); }
#dsh-tu-pet .dsh-tu-pet-meta-value.is-danger { color: var(--dsw-alias-state-error-primary); }
#dsh-tu-pet .dsh-tu-pet-charge-pct {
  flex: 0 0 auto; min-width: 34px; text-align: right;
  font-size: 10px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
/* 池：已攒下的整块数。 */
#dsh-tu-pet .dsh-tu-pet-pool {
  display: flex; align-items: center; gap: 6px;
  padding: 0 10px 8px; font-size: 11px;
}
#dsh-tu-pet .dsh-tu-pet-pool-icon {
  flex: 0 0 auto; width: 11px; height: 11px; border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
}
#dsh-tu-pet .dsh-tu-pet-pool-label {
  color: var(--dsw-alias-label-secondary); font-weight: 600;
  font-variant-numeric: tabular-nums;
}
/* 池那一行的后缀（本轮用量）：比池本身弱一档——它和「本会话」是同一个数在涨，
   不该和「攒下的块数」争夺注意力。 */
#dsh-tu-pet .dsh-tu-pet-stat-dim {
  color: var(--dsw-alias-label-tertiary);
  font-size: 10px; font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 攒到新的一块：池弹一下。 */
#dsh-tu-pet .dsh-tu-pet-pool.is-new { animation: dsh-tu-pool-pop 600ms ease-out; }
/* 附加读数行：缓存命中率 / 今日量。比主读数弱一档——它们是补充，不是主角。 */
#dsh-tu-pet .dsh-tu-pet-meta {
  display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap;
  padding: 0 10px 8px; font-size: 10px;
  color: var(--dsw-alias-label-tertiary);
}
#dsh-tu-pet .dsh-tu-pet-meta-item {
  display: inline-flex; align-items: baseline; gap: 3px; white-space: nowrap;
}
#dsh-tu-pet .dsh-tu-pet-meta-value {
  color: var(--dsw-alias-label-secondary); font-weight: 600;
  font-variant-numeric: tabular-nums;
}
@keyframes dsh-tu-pool-pop {
  0% { transform: scale(1); }
  30% { transform: scale(1.12); }
  100% { transform: scale(1); }
}
@keyframes dsh-tu-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
@media (prefers-reduced-motion: reduce) {
  #dsh-tu-pet .dsh-tu-pet-charge-block.is-almost,
  #dsh-tu-pet .dsh-tu-pet-pool.is-new { animation: none; }
}
/* 折叠态：只留标题栏 + 大数字 + 池。
   ⚠️ 池在折叠态**保留**：它是桌面常驻形态里唯一「只增不减」的成就读数。
   附加读数行（缓存/今日）折叠时隐藏——折叠态要的是「一眼看到有没有事」。 */
#dsh-tu-pet.is-collapsed .dsh-tu-pet-charge,
#dsh-tu-pet.is-collapsed .dsh-tu-pet-meta { display: none; }
#dsh-tu-pet.is-collapsed .dsh-tu-pet-total { padding: 7px 10px 0; }
#dsh-tu-pet.is-collapsed .dsh-tu-pet-pool { padding: 2px 10px 8px; }
/* 窄屏隐藏桌宠：拖拽手势会与页面滚动打架（与 tarkov 桌宠同一取舍）。 */
@media (max-width: 768px) {
  #dsh-tu-pet { display: none !important; }
}
`

    /**
     * 从 slot 的 standardProps 里拿「Workspace 标题映射」与「当前 cwd」。
     *
     * ## ⚠️ 这两个 facts 来自宿主 **props**，不是 context，也不是服务
     *
     * 宿主的 slot 渲染层会把一组 standard props（`useWorkspaces` / `useSessions` /
     * `sessionId` / …）作为**组件 props**传进来（见 dsh-client-runtime 的
     * session-scope standard-props bundle）。所以这里只能从 props 读——
     * 用 `React.useContext` 或 `ctx.get('workspaces')` 都拿不到。
     *
     * ## 为什么是个「尽力而为」的工具函数而不是 hook
     *
     * `BlockPanel` 注册在 `main`（root scope），它的 standardProps 里**没有**
     * `useWorkspaces` / `useSessions`（那是 session-scope 才有的）。所以主面板
     * 注定拿不到当前 cwd —— 不是 bug，是 scope 决定的。
     *
     * 因此这里的策略是：**拿得到就用，拿不到就降级**，而且降级路径是一等公民：
     * 标题退回 cwd 的 basename，高亮整行关掉。功能主体（分布横条）不依赖它们。
     *
     * @param props slot 组件的 props。
     * @returns `{ wsTitles: Map, currentCwd: string|undefined }`
     */
    function pickWorkspaceFacts(props) {
      const wsTitles = new Map()
      let currentCwd
      const p = props && typeof props === 'object' ? props : {}
      try {
        // 标题映射：useWorkspaces 是 selector hook，回调里取整个快照再读 items。
        if (typeof p.useWorkspaces === 'function') {
          const snap = p.useWorkspaces((s) => s)
          const items = snap?.items
          if (Array.isArray(items)) {
            for (const w of items) {
              if (typeof w?.path === 'string' && w.path !== ''
                && typeof w.title === 'string' && w.title !== '') {
                wsTitles.set(w.path, w.title)
                // 同时存一份规范化键：host 的 cwd 与宿主的 path 分隔符可能不同
                // （Windows 的 fs.realpath 会把 / 换成 \）。原样存 + 规范化存，
                // 两级查找都能命中。
                wsTitles.set(normalizePathKey(w.path), w.title)
              }
            }
          }
        }
      } catch {
        // 快照形状不符 / 服务未就绪：保持空映射。
      }
      try {
        if (typeof p.useSessions === 'function') {
          // ⚠️ 当前会话的 cwd：`useSessions` 的快照里同时有 `current`（当前会话
          // id）与 `byId`（按 id 索引的会话摘要），两者在**同一个快照**里，
          // 一次读取即可拿到。
          //
          // 这比「用 props.sessionId」更通用：`main` 是 root scope，拿不到
          // sessionId，但能拿到 `current` —— 所以主面板也能高亮当前工作区。
          const v = p.useSessions((s) => {
            const id = s?.current
            return id === undefined ? undefined : s?.byId?.[id]?.cwd
          })
          if (typeof v === 'string' && v !== '') currentCwd = v
        }
      } catch {
        // 同上：降级为「不高亮」。
      }
      return { wsTitles, currentCwd }
    }

    /**
     * 查 Workspace 标题：先按原样查，再按规范化路径查。
     *
     * 两级查找是为了兼容「host 的 cwd」与「宿主的 workspace path」在分隔符 /
     * 尾部斜杠 / 大小写上的差异（见 normalizePathKey）。
     */
    function lookupWorkspaceTitle(wsTitles, cwd) {
      if (!(wsTitles instanceof Map)) return undefined
      const direct = wsTitles.get(cwd)
      if (typeof direct === 'string' && direct !== '') return direct
      return wsTitles.get(normalizePathKey(cwd))
    }

    /**
     * 路径规范化：用来比较「host 的 cwd」与「宿主的 workspace path」。
     *
     * 两者的来源不同（一个是会话 header，一个是 Workspace 注册），分隔符与
     * 尾部斜杠都可能不一致。统一成「正斜杠 + 无尾部斜杠 + 小写」再比。
     */
    function normalizePathKey(p) {
      return String(p ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
    }

    /** 轻量数据钩子：拉一个端点 + 可选轮询。 */
    function useJson(path, { pollMs = 0 } = {}) {
      const [state, setState] = React.useState({ status: 'loading', data: undefined, error: undefined })
      const [nonce, setNonce] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const load = () => {
          fetch(path, { signal: controller?.signal, cache: 'no-store' })
            .then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`)
              return r.json()
            })
            .then((data) => {
              if (!alive) return
              setState({ status: 'ready', data, error: undefined })
            })
            .catch((error) => {
              if (!alive || error?.name === 'AbortError') return
              // 保留上一次的数据：轮询偶发失败不该让页面闪成空白。
              setState((prev) => ({ status: 'error', data: prev.data, error: String(error?.message ?? error) }))
            })
        }
        load()
        if (pollMs > 0) {
          const timer = setInterval(load, pollMs)
          return () => {
            alive = false
            clearInterval(timer)
            controller?.abort()
          }
        }
        return () => {
          alive = false
          controller?.abort()
        }
      }, [path, pollMs, nonce])
      return { ...state, reload: () => setNonce((n) => n + 1) }
    }

    /**
     * 选列数：让最后一行不留孤零零的单张卡。
     *
     * 6 张卡：2 列 → 3 行整齐；3 列 → 2 行整齐。取能整除的数量里最大的那个
     * （不超过 3 列），这样每行都满、宽度一致。数量不是好数字时退回 2 列。
     */
    function columnsFor(count) {
      for (const cols of [3, 2]) {
        if (count % cols === 0) return cols
      }
      return 2
    }

    /** 一个合计块的呈现（卡片 + 表格共用同一份字段定义，避免两处漂移）。 */
    function totalsCards(t, totals) {
      const items = [
        { label: t('total'), value: compact(totals?.totalTokens), meta: `${grouped(totals?.totalTokens)} ${t('tokens')}` },
        { label: t('requests'), value: grouped(totals?.requests), meta: '' },
        { label: t('input'), value: compact(totals?.inputTokens), meta: grouped(totals?.inputTokens) },
        { label: t('output'), value: compact(totals?.outputTokens), meta: grouped(totals?.outputTokens) },
        { label: t('cacheRead'), value: compact(totals?.cacheReadTokens), meta: grouped(totals?.cacheReadTokens) },
        { label: t('reasoning'), value: compact(totals?.reasoningTokens), meta: grouped(totals?.reasoningTokens) },
      ]
      return h(
        'div',
        {
          className: 'dsh-tu-cards',
          style: { '--dsh-tu-cols': columnsFor(items.length) },
        },
        items.map((item) =>
          h(
            'div',
            { className: 'dsh-tu-card', key: item.label },
            h('div', { className: 'dsh-tu-card-label' }, item.label),
            h('div', { className: 'dsh-tu-card-value' }, item.value),
            item.meta === '' ? null : h('div', { className: 'dsh-tu-card-meta' }, item.meta),
          ),
        ),
      )
    }

    /** 分段选择器。 */
    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        { className: 'dsh-tu-seg' },
        options.map((opt) =>
          h(
            'button',
            {
              key: opt.value,
              type: 'button',
              'data-active': String(opt.value === value),
              'aria-pressed': opt.value === value,
              onClick: () => onChange(opt.value),
            },
            opt.label,
          ),
        ),
      )
    }

    /** 聚合结果表。 */
    function ResultTable({ t, rows, groupBy, totals }) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return h('div', { className: 'dsh-tu-empty' }, t('noData'))
      }
      const firstCol = groupBy === 'workspace'
        || groupBy === 'provider' || groupBy === 'model' || groupBy === 'providerModel'
        ? t('groupBy')
        : t('day')
      // `kind` / `workspace` 分组时 host 只给枚举/原始值，文案在这里本地化。
      const labelOf = (row) => {
        if (groupBy === 'kind') return kindLabel(t, row.kind ?? row.key)
        if (groupBy === 'workspace') {
          const cwd = String(row.workspace ?? '')
          if (cwd === '') return t('wsUnnamed')
          // basename 展示（完整路径在 <td title> 里）。host 不发 Workspace 标题，
          // 因为它不知道用户起过什么名字；主面板那边能从 props 拿到标题，
          // 表格这里就不重复那份逻辑了——表格的读者关心的是路径本身。
          return basenameOf(cwd)
        }
        return row.label || row.key || '—'
      }
      const cell = (v) => h('td', null, grouped(v))
      return h(
        'table',
        { className: 'dsh-tu-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, firstCol),
            h('th', null, t('requests')),
            h('th', null, t('input')),
            h('th', null, t('cacheRead')),
            h('th', null, t('cacheWrite')),
            h('th', null, t('output')),
            h('th', null, t('reasoning')),
            h('th', null, t('total')),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((row) =>
            h(
              'tr',
              { key: row.key },
              h('td', null, labelOf(row)),
              cell(row.totals?.requests),
              cell(row.totals?.inputTokens),
              cell(row.totals?.cacheReadTokens),
              cell(row.totals?.cacheWriteTokens),
              cell(row.totals?.outputTokens),
              cell(row.totals?.reasoningTokens),
              h('td', null, h('b', null, grouped(row.totals?.totalTokens))),
            ),
          ),
        ),
        h(
          'tfoot',
          null,
          h(
            'tr',
            null,
            h('td', null, t('total')),
            cell(totals?.requests),
            cell(totals?.inputTokens),
            cell(totals?.cacheReadTokens),
            cell(totals?.cacheWriteTokens),
            cell(totals?.outputTokens),
            cell(totals?.reasoningTokens),
            h('td', null, h('b', null, grouped(totals?.totalTokens))),
          ),
        ),
      )
    }

    /**
     * 诊断区：把「回填了多少、存储在哪、宿主接口长什么样」如实摆出来，
     * 便于判断数字可不可信。
     *
     * ⚠️ `degraded` 必须显示在**肉眼可见的位置**（红色错误行）。它是「回填
     * 认不出宿主接口」的唯一信号——曾经这种情况是静默的：`sessions: 0`
     * 看起来就像「你本来就没有历史会话」，用户根本不会怀疑数字少了。
     */
    function Diagnostics({ t, diag, config }) {
      const backfill = diag?.backfill
      const degraded = typeof backfill?.degraded === 'string' && backfill.degraded !== ''
        ? backfill.degraded
        : undefined
      const backfillText = backfill === undefined
        ? t('notBackfilled')
        : `${backfill.sessions} ${t('sessionsWord')} / ${backfill.entries} ${t('entriesWord')} / ${backfill.withUsage} ${t('withUsageWord')}`
      const storePath = diag?.store?.kind === 'file' ? diag.store.path : t('memoryOnly')
      // 宿主接口实际走的那条路：接口换代时这是第一现场。
      const iface = diag?.persistence
      const ifaceText = iface === undefined
        ? t('hostApiMissing')
        : `list=${iface.listKind} · read=${iface.readKind}`
      return h(
        'div',
        { className: 'dsh-tu-diag' },
        h('div', null, `${t('sessionsTracked')}: ${grouped(diag?.sessionsTracked)}`),
        h('div', null, `${t('liveEntries')}: ${grouped(diag?.liveEntries)}`),
        h('div', null, `${t('backfill')}: ${backfillText}`),
        h('div', null, `${t('hostApi')}: `, h('code', null, ifaceText)),
        h('div', null, `${t('storePath')}: `, h('code', null, String(storePath))),
        h('div', null, `keepDays: ${config?.keepDays ?? '—'} · refresh: ${config?.statusBarRefreshMs ?? '—'}ms`),
        degraded === undefined
          ? null
          : h('div', { className: 'dsh-tu-err' },
            `${t('backfillDegraded')} — ${t('backfillDegradedHint')}: ${degraded}`),
        diag?.backfillError === undefined
          ? null
          : h('div', { className: 'dsh-tu-err' }, `backfill error: ${diag.backfillError}`),
      )
    }

    /** 设置页主体。 */
    function SettingsPage(props) {
      const t = props.t
      const [groupBy, setGroupBy] = React.useState('day')
      const todayKey = localDayKey(Date.now())
      const [from, setFrom] = React.useState(shiftDayKey(todayKey, -29))
      const [to, setTo] = React.useState(todayKey)

      // 运行时开关（横幅 / 桌宠 / 主面板 / 统计口径）。
      const prefs = usePrefs()
      // ⚠️ 统计口径**不再是**组件 state：它必须持久化，并与 `/today` 共用同一份
      // 值。早先这里是 `useState(true)`，于是离开设置页就回默认，而且方块墙
      // 读的 `/today` 压根不看它——两处口径必然打架。
      const includeSub = prefs.includeSub !== false
      const includeAux = prefs.includeAux !== false
      const [savingPrefs, setSavingPrefs] = React.useState(false)
      /**
       * 改开关：先本地生效（立刻响应），再 PUT 到 host 存盘。
       *
       * ⚠️ 先本地生效是有意的：PUT 是网络往返，等它回来会让点击「感觉没反应」。
       * host 存盘失败时 host 会返回原值，下一次 /today 轮询会把它纠正回来。
       */
      const setPref = (key) => {
        const next = { ...prefs, [key]: !prefs[key] }
        prefsStore.set(next)
        setSavingPrefs(true)
        fetch(`${ROUTE_PREFIX}/prefs`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [key]: next[key] }),
        })
          .then((r) => (r.ok ? r.json() : undefined))
          .then((body) => {
            if (body?.ok === true && body.prefs !== undefined) {
              prefsStore.set(body.prefs)
            }
          })
          .catch(() => {})
          .finally(() => setSavingPrefs(false))
      }

      const query = `?groupBy=${encodeURIComponent(groupBy)}&from=${from}&to=${to}`
        + `&includeSub=${includeSub ? '1' : '0'}&includeAux=${includeAux ? '1' : '0'}`
      const { status, data, error, reload } = useJson(`${ROUTE_PREFIX}/summary${query}`, { pollMs: 15000 })

      const groupOptions = [
        { value: 'day', label: t('day') },
        { value: 'week', label: t('week') },
        { value: 'month', label: t('month') },
        { value: 'workspace', label: t('wsGroupBy') },
        { value: 'provider', label: t('provider') },
        { value: 'model', label: t('model') },
        { value: 'providerModel', label: t('providerModel') },
        { value: 'kind', label: t('kind') },
      ]
      const preset = (days) => () => {
        const now = localDayKey(Date.now())
        setFrom(shiftDayKey(now, -(days - 1)))
        setTo(now)
      }

      const totals = data?.totals
      const today = data?.today?.totals
      const allTime = data?.allTime

      return h(
        'div',
        { className: 'dsh-tu-root' },
        h('h1', { className: 'dsh-tu-h1' }, t('title')),
        h('p', { className: 'dsh-tu-sub' }, t('subtitle')),

        // 运行时开关。放在最前面——用户最想改的就是「显示哪些」。
        h('div', { className: 'dsh-tu-mods' },
          h('div', { className: 'dsh-tu-mods-title' },
            t('modsTitle'),
            h('span', { className: 'dsh-tu-wall-count' }, ` · ${t('modsHint')}`),
          ),
          h('label', { className: 'dsh-tu-check' },
            h('input', {
              type: 'checkbox', checked: prefs.pet !== false,
              onChange: () => setPref('pet'),
            }),
            h('span', null, t('modsPet')),
          ),
          h('label', { className: 'dsh-tu-check' },
            h('input', {
              type: 'checkbox', checked: prefs.wallPanel !== false,
              onChange: () => setPref('wallPanel'),
            }),
            h('span', null, t('modsWallPanel')),
          ),
          h('label', { className: 'dsh-tu-check' },
            h('input', {
              type: 'checkbox', checked: prefs.statusBar !== false,
              onChange: () => setPref('statusBar'),
            }),
            h('span', null, t('modsStatusBar')),
          ),
          savingPrefs ? h('span', { className: 'dsh-tu-wall-count' }, '…') : null,
        ),

        // 今日 + 累计：用户最常看的两块。
        h('div', { className: 'dsh-tu-cards' },
          h('div', { className: 'dsh-tu-card' },
            h('div', { className: 'dsh-tu-card-label' }, `${t('today')} · ${data?.today?.day ?? todayKey}`),
            h('div', { className: 'dsh-tu-card-value' }, compact(today?.totalTokens)),
            h('div', { className: 'dsh-tu-card-meta' },
              `${grouped(today?.requests)} ${t('requests')} · ${grouped(today?.totalTokens)} ${t('tokens')}`),
          ),
          h('div', { className: 'dsh-tu-card' },
            h('div', { className: 'dsh-tu-card-label' }, t('allTime')),
            h('div', { className: 'dsh-tu-card-value' }, compact(allTime?.totalTokens)),
            h('div', { className: 'dsh-tu-card-meta' },
              `${grouped(allTime?.requests)} ${t('requests')}`),
          ),
        ),

        h('div', { className: 'dsh-tu-toolbar' },
          h(Segmented, { value: groupBy, options: groupOptions, onChange: setGroupBy }),
          h('button', { className: 'dsh-tu-btn', type: 'button', onClick: preset(7) }, t('rangePreset7')),
          h('button', { className: 'dsh-tu-btn', type: 'button', onClick: preset(30) }, t('rangePreset30')),
          h('button', { className: 'dsh-tu-btn', type: 'button', onClick: preset(90) }, t('rangePreset90')),
          h('input', {
            className: 'dsh-tu-input', type: 'date', value: from,
            'aria-label': t('from'), onChange: (e) => setFrom(e.target.value),
          }),
          h('span', null, '–'),
          h('input', {
            className: 'dsh-tu-input', type: 'date', value: to,
            'aria-label': t('to'), onChange: (e) => setTo(e.target.value),
          }),
          h('button', { className: 'dsh-tu-btn', type: 'button', onClick: reload }, t('refresh')),
          h('span', { className: 'dsh-tu-card-meta' }, status === 'loading' ? t('loading') : ''),
        ),

        // 两个过滤开关：分别对应 scope（谁发起的）与 kind（是不是辅助调用），
        // 两维正交，所以各给一个开关。
        //
        // ⚠️ 走 `setPref`（存 prefs.json）而不是组件 state：这两个口径会影响
        // 方块墙、桌宠、横幅的累计读数，必须是全局且持久的。
        h('div', { className: 'dsh-tu-toolbar' },
          h('label', { className: 'dsh-tu-check' },
            h('input', {
              type: 'checkbox', checked: includeSub,
              onChange: () => setPref('includeSub'),
            }),
            h('span', null, t('includeSub')),
          ),
          h('label', { className: 'dsh-tu-check' },
            h('input', {
              type: 'checkbox', checked: includeAux,
              onChange: () => setPref('includeAux'),
            }),
            h('span', null, t('includeAux')),
          ),
        ),

        // 区间合计（比今日/累计更贴近「汇总一段时间」这个诉求）。
        totalsCards(t, totals),
        error === undefined ? null : h('div', { className: 'dsh-tu-err' }, `${t('loadFailed')}: ${error}`),
        h(ResultTable, { t, rows: data?.rows, groupBy, totals }),
        h(Diagnostics, { t, diag: data?.diagnostics, config: data?.config }),
      )
    }

    /**
     * 输入框上方的**累计里程表**。
     *
     * ## 设计意图
     *
     * 要传达的是「token 越花越多」。**纯数字传达不了这个**——数字再怎么涨，
     * 一眼看上去仍是静态文本。所以这里用三件互相印证的东西：
     *
     * 1. **上升曲线**：本窗口内累计量的走势，左低右高本身就是「在涨」的形状；
     * 2. **递增数字**：带千分位、不缩写，每位都在走；
     * 3. **今日填充条**：今天占累计的比例，随使用变长。
     *
     * ## 克制风格的实现
     *
     * - 不加粒子/火焰，只让「曲线 + 数字 + 条」的变化成为动感来源。
     * - 数字用**等宽数字**（`font-variant-numeric: tabular-nums`）：否则每次进位
     *   整行宽度会跳动，看着很毛躁。这是「克制」里最要紧的一条。
     * - 增速用**指数滑动平均**平滑，避免 1 秒轮询下数字乱跳（真实的 token 消耗
     *   本来就是一阵一阵的，原始瞬时值会闪得很吵）。
     * - 刚涨过时给数字一个很轻的高亮（180ms 渐隐），提示「它动了」。
     *
     * ## 曲线数据从哪来
     *
     * **纯客户端采样**：每次轮询把累计值压进一个定长环形缓冲，画成折线。
     * 因此它反映的是「打开页面之后」的走势，不是历史——不需要 host 支持，
     * 也不会在刷新页面时画出一条假的斜线（缓冲从零重新累积）。
     */
    function Odometer(props) {
      const t = locale.t
      // 轮询间隔由 host 配置决定；默认 1 秒（用户选的实时档）。
      const [pollMs, setPollMs] = React.useState(1000)
      // 统计口径与设置页 / 方块墙共用（见 todayQuery 的说明）。
      const prefs = usePrefs()
      const { data } = useJson(`${ROUTE_PREFIX}/today${todayQuery(prefs)}`, { pollMs })
      const reported = Number(data?.config?.statusBarRefreshMs)
      React.useEffect(() => {
        if (Number.isFinite(reported) && reported >= 1000 && reported !== pollMs) setPollMs(reported)
      }, [reported, pollMs])

      // 当前工作区（只用于展示 chip）。拿不到就整个 chip 不渲染——
      // 里程表是「克制风格」的代表，多一行噪声比少一行信息更糟。
      const { wsTitles, currentCwd } = pickWorkspaceFacts(props)

      const allTime = Number(data?.allTime?.totalTokens) || 0
      const todayTotal = Number(data?.totals?.totalTokens) || 0

      // ── 速率 + 曲线：都从累计值的相邻采样推导 ──
      const rateRef = React.useRef({ lastTotal: undefined, lastAt: undefined, ema: 0, primed: false })
      const [rate, setRate] = React.useState(0)
      const [bump, setBump] = React.useState(0)
      const prevTotalRef = React.useRef(0)
      // 曲线采样点（累计值）。定长：1 秒一个点、保留 40 个 ≈ 最近 40 秒。
      const SPARK_POINTS = 40
      const [spark, setSpark] = React.useState([])

      React.useEffect(() => {
        if (data?.ok !== true) return
        const now = Date.now()
        const r = rateRef.current
        if (r.lastTotal !== undefined && r.lastAt !== undefined) {
          const dt = (now - r.lastAt) / 1000
          const dTokens = allTime - r.lastTotal
          // 只在时间推进且总量未回退时更新（回退 = 换日/数据重建，不当作负消耗）。
          if (dt > 0.2 && dTokens >= 0) {
            const instant = dTokens / dt
            // 指数滑动平均：新样本权重 0.35，兼顾灵敏与平稳。
            r.ema = r.primed ? r.ema * 0.65 + instant * 0.35 : instant
            r.primed = true
            setRate(r.ema)
          }
        }
        r.lastTotal = allTime
        r.lastAt = now
        if (allTime > prevTotalRef.current) {
          prevTotalRef.current = allTime
          setBump((n) => n + 1)
        }
        // 曲线：追加采样点，只保留最近 SPARK_POINTS 个。
        setSpark((prev) => {
          const next = prev.length > 0 && prev[prev.length - 1] === allTime
            ? prev.slice()
            : prev.concat(allTime)
          return next.length > SPARK_POINTS ? next.slice(next.length - SPARK_POINTS) : next
        })
      }, [allTime, data])

      // 数字刚变化时的高亮：短暂加一个 class，靠 key 变化重新触发 CSS 动画。
      const [flash, setFlash] = React.useState(false)
      React.useEffect(() => {
        if (bump === 0) return
        setFlash(true)
        const timer = setTimeout(() => setFlash(false), 220)
        return () => clearTimeout(timer)
      }, [bump])

      if (data?.ok !== true) return null
      if (data.config?.statusBarEnabled === false) return null

      const todayShare = allTime > 0 ? (todayTotal / allTime) * 100 : 0
      const yesterday = Number(data?.yesterday?.totals?.totalTokens) || 0

      /** 一个信息单元：标签 + 值（+ 可选后缀），整体 `white-space: nowrap` 不可断行。 */
      const item = (key, label, value, suffix, dim) => h(
        'span',
        { className: 'dsh-tu-odo-item', key },
        h('span', null, label),
        h('b', null, value),
        suffix === undefined ? null : h('span', { className: dim ? 'dsh-tu-odo-dim' : undefined }, suffix),
      )

      return h(
        'div',
        { className: 'dsh-tu-odo', title: `${grouped(allTime)} ${t('tokens')}` },
        // ① 主行：上升曲线 + 累计数字（主角）。
        h(
          'div',
          { className: 'dsh-tu-odo-top' },
          h(Sparkline, { points: spark }),
          h(
            'div',
            { className: 'dsh-tu-odo-hero' },
            h('span', null, t('allTimeShort')),
            h(
              'span',
              { className: `dsh-tu-odo-value${flash ? ' is-bump' : ''}` },
              formatOdometer(allTime),
            ),
            h('span', { className: 'dsh-tu-odo-unit' }, t('tokens')),
          ),
        ),
        // ② 次行：今日（含占比条）· 速度 · 昨日参照。
        //    每个信息单元各自成组，换行只发生在单元之间——不会出现孤立的「·」，
        //    也不会把数字和单位拆开（之前 `623,892,036tokens` 挤在一起就是这么来的）。
        h(
          'div',
          { className: 'dsh-tu-odo-bottom' },
          h(
            'span',
            { className: 'dsh-tu-odo-item', key: 'today' },
            h('span', null, t('statusBarLabel')),
            h('b', null, compact(todayTotal)),
            h('span', { className: 'dsh-tu-odo-dim' }, `${todayShare.toFixed(1)}%`),
            h(
              'span',
              { className: 'dsh-tu-odo-bar', 'aria-hidden': true },
              h('span', {
                className: 'dsh-tu-odo-bar-fill',
                style: { width: `${Math.max(0, Math.min(100, todayShare))}%` },
              }),
            ),
          ),
          item('rate', t('rate'), rate >= 1 ? `${compact(Math.round(rate))}/s` : '—'),
          // 昨日全天作为参照。
          //
          // ⚠️ 刻意**不**显示「今日 vs 昨日」的百分比：今天是**进行中**的，
          // 拿部分天去比昨天的一整天，早上必然大幅负值、下午又虚高，是误导而非
          // 信息。存储只到「日」粒度，做不到「昨日同一时刻」的对齐比较，
          // 所以只把昨日全天原样摆出来当参照，不做减法。
          yesterday > 0 ? item('yesterday', t('yesterday'), compact(yesterday), undefined, true) : null,
          // 当前工作区。放在最后：它是「这一行的上下文」，不是读数本身。
          // 放在最前面会让「累计」这个主角往后挪，破坏主行/次行的层次。
          currentCwd === undefined
            ? null
            : h(
              'span',
              { className: 'dsh-tu-odo-item dsh-tu-odo-ws', key: 'workspace', title: currentCwd },
              h('span', { className: 'dsh-tu-odo-ws-dot', 'aria-hidden': true }),
              h('span', null, lookupWorkspaceTitle(wsTitles, currentCwd) ?? basenameOf(currentCwd)),
            ),
        ),
      )
    }

    /**
     * 从**原始模型名**推出厂商键（只用于「高亮当前项」，不用于聚合）。
     *
     * ⚠️ 为什么客户端还要自己推一遍：host 的 `current.model` 是**原始名**
     * （如 `workbuddy/deepseek-v4.1-flash`），而厂商维度的行是归并后的
     * vendor 键。要知道「当前模型属于哪个厂商」，就得在客户端按同一套规则
     * 推一次。
     *
     * 这里只实现**厂商前缀识别**这一条（不实现完整归一化）——因为只需要
     * vendor 键，不需要规范模型名。规则与 `lib/models.js` 的
     * `VENDOR_PATTERNS` 保持一致；两边漂移的后果只是「高亮错行」，
     * 不影响数据正确性，所以这里接受这份小重复。
     */
    function normalizeVendorOf(rawModel) {
      const name = String(rawModel ?? '').split('/').pop().toLowerCase().trim()
      if (name === '') return undefined
      if (/^deepseek[-.]/.test(name) || name === 'deepseek') return 'deepseek'
      if (/^glm[-.]/.test(name)) return 'zhipu'
      if (/^mimo[-.]/.test(name)) return 'xiaomi'
      if (/^minimax[-.]/.test(name)) return 'minimax'
      if (/^step[-.]/.test(name)) return 'stepfun'
      if (/^qwen[-.]/.test(name)) return 'qwen'
      if (/^claude[-.]/.test(name)) return 'anthropic'
      if (/^(gpt|o[134])[-.]/.test(name)) return 'openai'
      if (/^(gemini|gemma)[-.]/.test(name)) return 'google'
      if (/^(kimi|moonshot)[-.]/.test(name)) return 'moonshot'
      if (/^spark[-.]/.test(name)) return 'spark'
      return 'unknown'
    }

    /**
     * **消耗分布**：一条横条排行，支持三种维度（工作区 / 模型 / 厂商）。
     *
     * 方块墙回答「总量在涨」，这个组件回答「**涨在哪儿**」。两件事互补，
     * 所以放在同一页，不另开页面。
     *
     * ## 三个维度为什么用同一个组件
     *
     * 它们的形状完全一样：`{ 名称, 用量 }` 的排行。差别只在
     * 「名称怎么取」「哪些被合并」「当前项怎么高亮」。所以用一套渲染、
     * 三套取值逻辑（见 `pickRows`），而不是写三份几乎相同的组件。
     *
     * ## 四个有意的设计决定
     *
     * 1. **只显示前 N 行 + 折叠「其他」**。本机实测 8 个工作区、12 个模型，
     *    分布从 46% 到 0.0%。全铺开时最后几行的条形几乎不可见，却占掉整块
     *    高度。取前 6 个已能覆盖 99%+ 的量，其余合成一行。
     * 2. **当前项高亮**（`is-current`）。用户问的第一个问题通常是「我现在
     *    这个项目/模型花了多少」，高亮比排序更快回答它。
     * 3. **展示名按维度取**：工作区用 Workspace 标题（回落 basename）、
     *    模型用归一化后的名字、厂商用中文展示名。
     * 4. **条用 CSS 宽度百分比**，不引图表库（同 Sparkline 的理由）。
     *
     * @param dim        `'workspace' | 'model' | 'vendor'`
     * @param rows       对应维度的 rows（host 侧已排好序）
     * @param wsTitles   cwd → Workspace title 的映射（仅工作区维度用）
     * @param current    当前项的值（cwd / 原始模型名 / vendor），用于高亮
     */
    const DIST_MAX_ROWS = 6

    function DistributionBars({ t, dim, rows, wsTitles, current }) {
      const all = Array.isArray(rows) ? rows : []
      const titleOf = () => (dim === 'workspace' ? t('wsTitle')
        : dim === 'model' ? t('distModelTitle')
          : t('distVendorTitle'))
      const hintOf = () => (dim === 'workspace' ? t('wsHint')
        : dim === 'model' ? t('distModelHint')
          : t('distVendorHint'))

      // ⚠️ **维度守卫**：`useJson` 换 URL 时，新数据回来之前 `rows` 还是**上一档**
      // 的数据。若不挡住，切到「模型」的那一帧会拿 workspace 的行去按 model 渲染
      // ——名字全空、数字还是工作区的（实测截图里前 5 行名称为空、数值 842M）。
      //
      // 每档的行有不同的判别字段：workspace 有 `workspace`、model 有 `model`、
      // vendor 有 `vendor`。只渲染「形状匹配当前维度」的行。
      const shaped = all.filter((r) => {
        if (r === null || typeof r !== 'object') return false
        if (dim === 'workspace') return typeof r.workspace === 'string'
        if (dim === 'model') return typeof r.model === 'string'
        return typeof r.vendor === 'string' && typeof r.label === 'string'
      })

      if (shaped.length === 0) {
        // 数据还没到 / 形状不匹配：显示占位，而不是渲染错乱数据。
        return h('div', { className: 'dsh-tu-ws' },
          h('div', { className: 'dsh-tu-ws-title' }, titleOf()),
          h('div', { className: 'dsh-tu-empty' }, all.length === 0 ? t('wsEmpty') : t('loading')),
        )
      }

      // 取用量：兼容两种行格式——
      //   /summary?groupBy=* → row.totals.totalTokens
      //   /workspaces        → row.totalTokens（轻量端点，少一层包装）
      const tokensOf = (row) => Number(row?.totals?.totalTokens ?? row?.totalTokens) || 0
      const sorted = [...shaped].sort((a, b) => tokensOf(b) - tokensOf(a))
      const total = sorted.reduce((a, r) => a + tokensOf(r), 0)
      if (total <= 0) {
        return h('div', { className: 'dsh-tu-ws' },
          h('div', { className: 'dsh-tu-ws-title' }, titleOf()),
          h('div', { className: 'dsh-tu-empty' }, t('wsEmpty')),
        )
      }

      const head = sorted.slice(0, DIST_MAX_ROWS)
      const tail = sorted.slice(DIST_MAX_ROWS)
      const tailTotal = tail.reduce((a, r) => a + tokensOf(r), 0)

      /**
       * 一行 → `{ key, label, sub, isCurrent }`。
       *
       * `sub` 是可选的副标题（模型维度显示「4 个变体」、厂商维度显示
       * 「3 个模型」），让人知道这个数字背后合并了什么。
       */
      const describe = (row) => {
        if (dim === 'workspace') {
          const cwd = String(row.workspace ?? '')
          const title = cwd === '' ? undefined : lookupWorkspaceTitle(wsTitles, cwd)
          return {
            key: cwd,
            label: cwd === '' ? t('wsUnnamed') : (title ?? basenameOf(cwd)),
            title: cwd,
            sub: undefined,
            isCurrent: cwd !== '' && cwd === current,
          }
        }
        if (dim === 'model') {
          // 模型维度的「当前项」比较的是**归一化后的名字**：host 给的
          // current.model 是原始名（如 workbuddy/deepseek-v4.1-flash），
          // 而这一行是归并后的 deepseek-v4.1-flash——用 variants 判断。
          const variants = Array.isArray(row.variants) ? row.variants : []
          const isCurrent = typeof current === 'string' && current !== ''
            && (variants.includes(current) || row.model === current)
          return {
            key: String(row.key ?? row.model ?? ''),
            label: String(row.label ?? row.model ?? ''),
            title: variants.length > 0 ? variants.join('\n') : undefined,
            sub: variants.length > 1 ? t('distVariants')(variants.length) : undefined,
            isCurrent,
          }
        }
        // vendor
        const models = Array.isArray(row.models) ? row.models : []
        return {
          key: String(row.key ?? row.vendor ?? ''),
          label: String(row.label ?? row.vendor ?? ''),
          title: models.length > 0 ? models.join('\n') : undefined,
          sub: models.length > 1 ? t('distModels')(models.length) : undefined,
          isCurrent: typeof current === 'string' && current !== '' && row.vendor === current,
        }
      }

      const rowOf = (desc, value, isOthers) => {
        const share = total > 0 ? (value / total) * 100 : 0
        return h(
          'div',
          {
            className: `dsh-tu-ws-row${desc.isCurrent ? ' is-current' : ''}`,
            key: isOthers ? '__others__' : (desc.key || desc.label),
          },
          h('div', { className: 'dsh-tu-ws-name', title: desc.title }, desc.label),
          h('span', { className: 'dsh-tu-ws-track' },
            h('span', {
              className: 'dsh-tu-ws-bar',
              style: { width: `${Math.max(0, Math.min(100, share)).toFixed(2)}%` },
            }),
          ),
          // 副标题（「4 个变体」/「3 个模型」）放在数值左侧，用弱化色——
          // 它解释数字，不是数字。
          //
          // ⚠️ **没有副标题时也要渲染一个空占位**，不能返回 null。
          // 因为 flex 里少一个孩子就等于少一列，那条会多吃 62px+8gap——
          // 实测「按模型」第一行（唯一有副标题的）条形是 327→519，
          // 其余行是 327→589，同一张图里条长不一致，看着像画错了。
          h('span', { className: 'dsh-tu-ws-sub' }, desc.sub ?? ''),
          h('span', { className: 'dsh-tu-ws-value' }, compact(value)),
          h('span', { className: 'dsh-tu-ws-share' }, `${share.toFixed(1)}%`),
        )
      }

      return h(
        'div',
        { className: 'dsh-tu-ws' },
        h('div', { className: 'dsh-tu-ws-title' },
          `${titleOf()} · `,
          h('span', { className: 'dsh-tu-wall-count' }, hintOf()),
        ),
        head.map((r) => rowOf(describe(r), tokensOf(r), false)),
        tail.length > 0
          ? rowOf({ key: '', label: `${t('wsOthers')} ${tail.length}`, isCurrent: false }, tailTotal, true)
          : null,
      )
    }

    /**
     * 迷你上升曲线（sparkline）。
     *
     * 为什么手写 SVG 而不引图表库：官方明确禁止 `require` 任何 Harness Client 包
     * （它们随时会变，而手写 JS 没有类型检查）；引第三方图表库又要走
     * `dsh.client.external` 与打包流程。40 个点的折线用 SVG 二十行就够，
     * 而且**样式全部走主题 token**，浅色/深色自动跟随。
     *
     * 归一化：以窗口内的 min/max 拉伸到画布高度。窗口内数值没变化时（还没开始花）
     * 退化成一条底部水平线，而不是除零。
     */
    function Sparkline({ points }) {
      const W = 46
      const H = 16
      if (!Array.isArray(points) || points.length < 2) {
        // 采样不足：留一个等宽占位，避免主行在头两秒左右抖动。
        return h('svg', {
          className: 'dsh-tu-spark', width: W, height: H,
          viewBox: `0 0 ${W} ${H}`, 'aria-hidden': true,
        })
      }
      const min = Math.min(...points)
      const max = Math.max(...points)
      const span = max - min
      const stepX = W / (points.length - 1)
      const coords = points.map((v, i) => {
        const x = i * stepX
        // span 为 0（数值未变）时压在底部，不制造假的起伏。
        const y = span === 0 ? H - 1 : H - 1 - ((v - min) / span) * (H - 3)
        return [x, y]
      })
      const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
      const area = `${line} L${W},${H} L0,${H} Z`
      return h(
        'svg',
        {
          className: 'dsh-tu-spark',
          width: W,
          height: H,
          viewBox: `0 0 ${W} ${H}`,
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { className: 'dsh-tu-spark-area', d: area }),
        h('path', { className: 'dsh-tu-spark-line', d: line }),
      )
    }

    /**
     * 里程表数字：带千分位、**不缩写**。
     *
     * 刻意不用 `compact()`（1.23M）：里程表要的是「一位一位往上走」的实感，
     * 缩写会把低位变化吃掉，反而看不出在涨。
     */
    function formatOdometer(n) {
      return grouped(n)
    }

    // ── 方块墙 ─────────────────────────────────────────────────────────
    //
    // 逻辑与 `lib/blocks.js` 等价（客户端是手写 bundle，不能 import 那个模块）。
    // 两边的一致性由 `test/blocks.test.mjs` 交叉校验。

    /** 一个方块代表多少 token。 */
    const BLOCK_UNIT = 10 * 1e6
    /** 一页格子数（100 格 × 10M = 10 亿）。 */
    const BLOCK_PAGE_SIZE = 100

    /**
     * 把 token 总量换算成方块墙状态。
     * @returns `{ filled, progress, pageIndex, pageStart, cells }`，`cells` 恒有
     *          `BLOCK_PAGE_SIZE` 项，每项 `{ index, state, fill }`。
     */
    function blockWall(total, { unit = BLOCK_UNIT, pageSize = BLOCK_PAGE_SIZE } = {}) {
      const safeTotal = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : 0
      const u = Number.isFinite(Number(unit)) && Number(unit) > 0 ? Number(unit) : BLOCK_UNIT
      const size = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0 ? Math.floor(Number(pageSize)) : BLOCK_PAGE_SIZE
      const filled = Math.floor(safeTotal / u)
      const remainder = safeTotal - filled * u
      const progress = remainder / u
      const pageIndex = Math.floor(filled / size)
      const pageStart = pageIndex * size
      const cells = []
      for (let i = 0; i < size; i += 1) {
        const index = pageStart + i
        let state = 'empty'
        let fill = 0
        if (index < filled) { state = 'filled'; fill = 1 } else if (index === filled) { state = 'partial'; fill = progress }
        cells.push({ index, state, fill })
      }
      return { total: safeTotal, unit: u, pageSize: size, filled, remainder, progress, pageIndex, pageStart, cells }
    }

    /**
     * 方块网格。
     *
     * `newFrom` 之后的块标记为 `is-new`，触发一次很轻的放大脉冲——用于「刚赚到
     * 一块」的提示。之所以是**范围**而不是单个索引：实测单轮对话最多能花 37.8M
     * = 3.8 块，一次多块时必须让新增的那几块一起亮，而不是只亮最后一块。
     *
     * ## 里程碑刻度
     *
     * 每 10 格（= 1 亿 tokens）画一道竖线，并在最上面标出量级（1亿 / 2亿 …）。
     * 之前 100 个方块没有任何量级提示 —— 看到「第 3 页」时无从判断那到底是
     * 3 亿还是 300 亿。刻度线让「量级」成为**空间信息**而不是需要心算的数字。
     *
     * 刻度用**绝对**位置（pageStart + i），不是相对页内位置 —— 所以翻页时刻度
     * 始终标着正确的量级（3 亿那页就写 3 亿）。
     */
    function BlockGrid({ cells, newFrom, pageStart = 0, unit = BLOCK_UNIT }) {
      const COLS = 10
      const totalRows = Math.ceil(cells.length / COLS)
      return h(
        'div',
        { className: 'dsh-tu-wall-grid', 'aria-hidden': true },
        cells.map((cell, i) => {
          const isNew = newFrom !== undefined && cell.index >= newFrom && cell.state !== 'empty'
          // ⚠️ 列/行位置用**数组下标 i**（网格内位置），不是 cell.index（绝对格号）。
          // cell.index 是整张墙的绝对格号（翻页后是 200、300…），拿它算列会得到
          // 错误的布局。
          const col = i % COLS
          const row = Math.floor(i / COLS)
          const isMilestone = col === 0
          // 标签只标首行与末行：10 行都标会变成一排数字，反而看不出刻度节奏。
          const showLabel = isMilestone && (row === 0 || row === totalRows - 1)
          return h(
            'div',
            {
              key: cell.index,
              className: `dsh-tu-block is-${cell.state}${isNew ? ' is-new' : ''}`
                + (isMilestone ? ' is-milestone-start' : ''),
              // 标题给读屏软件（网格本身是 aria-hidden，但信息不该丢）。
              title: `${(pageStart + cell.index + 1) * unit} tokens`,
            },
            cell.state === 'partial'
              ? h('span', { className: 'dsh-tu-block-fill', style: { width: `${(cell.fill * 100).toFixed(2)}%` } })
              : null,
          )
        }),
        // 里程碑刻度层：竖线 + 量级标签，都是**网格的直接子元素**（同一定位基准，
        // 必然对齐）。每行一个（每行 10 格 = 100M）。
        //
        // ⚠️ 行高未知（方块高由 aspect-ratio 决定，算不出来），所以用**百分比**
        // 近似定位行：每行占 1/totalRows 的高度。误差在 1 行以内，而标签是量级
        // 锚点，差几像素不影响可读性。
        cells.map((cell, i) => ({ cell, i })).filter(({ i }) => i % COLS === 0).map(({ cell, i }) => {
          const row = Math.floor(i / COLS)
          const topPct = (row * 100) / totalRows
          // 标签只标首行与末行：10 行都标会变成一排数字，反而看不出刻度节奏。
          const isEdge = row === 0 || row === totalRows - 1
          return h(
            'span',
            { key: `ms-${cell.index}`, className: 'dsh-tu-milestone', style: { top: `${topPct}%` } },
          )
        }),
        cells.map((cell, i) => ({ cell, i })).filter(({ i }) => i % COLS === 0).map(({ cell, i }) => {
          const row = Math.floor(i / COLS)
          const topPct = (row * 100) / totalRows
          const isEdge = row === 0 || row === totalRows - 1
          return h(
            'span',
            {
              key: `msl-${cell.index}`,
              className: 'dsh-tu-milestone-label',
              style: { top: `${topPct}%` },
            },
            isEdge ? compact((pageStart + i + 1) * unit) : '',
          )
        }),
      )
    }

    /** 图例。 */
    function BlockLegend({ t, unitLabel }) {
      return h(
        'div',
        { className: 'dsh-tu-wall-foot' },
        h('span', { className: 'dsh-tu-legend' },
          h('span', { className: 'dsh-tu-legend-swatch is-filled' }),
          `${unitLabel} ${t('wallPerBlock')}`),
        h('span', { className: 'dsh-tu-legend' },
          h('span', { className: 'dsh-tu-legend-swatch is-partial' }),
          t('wallFilling')),
        h('span', { className: 'dsh-tu-legend' },
          h('span', { className: 'dsh-tu-legend-swatch' }),
          t('wallEmpty')),
      )
    }

    /**
     * 累计 / 今日 切换。
     *
     * 两个维度语义不同，必须让用户明确知道在看哪个：累计是「只增不减的历史总量」，
     * 今日是「午夜归零的当天量」。切换只影响方块墙，不影响顶部数字。
     */
    function ScopeToggle({ t, scope, onScope }) {
      return h(
        'span',
        { className: 'dsh-tu-seg2' },
        h('button', {
          type: 'button', 'data-active': String(scope === 'all'),
          'aria-pressed': scope === 'all', onClick: () => onScope('all'),
        }, t('scopeAll')),
        h('button', {
          type: 'button', 'data-active': String(scope === 'today'),
          'aria-pressed': scope === 'today', onClick: () => onScope('today'),
        }, t('scopeToday')),
      )
    }

    /** 从 `/today` 的数据里取指定 scope 的 token 总量。 */
    function tokensForScope(data, scope) {
      if (scope === 'today') return Number(data?.totals?.totalTokens) || 0
      return Number(data?.allTime?.totalTokens) || 0
    }

    /**
     * `/today` 的查询串：把**持久化的统计口径**带上。
     *
     * 方块墙、桌宠、横幅、设置页表必须看同一份口径，否则会重演「区间合计变了、
     * 累计没变」那种自相矛盾。口径本身存在 `prefs.json`，这里只负责传参。
     */
    function todayQuery(prefs) {
      const sub = prefs?.includeSub !== false ? '1' : '0'
      const aux = prefs?.includeAux !== false ? '1' : '0'
      return `?includeSub=${sub}&includeAux=${aux}`
    }

    // ── 专属主面板 ─────────────────────────────────────────────────────
    /**
     * 侧栏里的方块墙图标。
     *
     * 用 `currentColor` 上色，因此自动跟随宿主对「选中/未选中」的颜色处理——
     * 不需要自己判断 `active` 就能与其它面板图标保持一致（这是最不容易做错的
     * 做法：宿主用 CSS 控制颜色，我们只要不写死颜色）。
     *
     * 图形：3×3 的小方格，右下角一个空心——正好是「方块墙」的隐喻。
     */
    /**
     * 订阅运行时开关，返回当前开关值。
     *
     * 用 React 的 `useState` + `useEffect` 实现订阅：prefsStore 不是 React 的
     * 状态源，但它在变化时会通知订阅者，这里把通知转成一次 re-render。
     */
    function usePrefs() {
      const [prefs, setPrefs] = React.useState(prefsStore.value)
      React.useEffect(() => prefsStore.subscribe((next) => setPrefs({ ...next })), [])
      return prefs
    }

    /**
     * 侧栏图标：受 `wallPanel` 开关控制。
     *
     * 关闭时返回 `null`——宿主的 slot 渲染器会跳过 null，于是侧栏里就没有这个
     * 图标了。开关变化时组件 re-render，所以**立即生效**。
     */
    function GatedPanelIcon(props) {
      const prefs = usePrefs()
      if (prefs.wallPanel === false) return null
      return h(BlockPanelIcon, props)
    }

    /**
     * 横幅（输入框上方）：受 `statusBar` 开关控制。
     *
     * 默认关闭——它的内容已并入桌宠。打开它仍然有用：桌宠在 ≤768px 会隐藏
     * （拖拽手势与页面滚动打架），而横幅在窄屏仍在。
     */
    function GatedOdometer(props) {
      const prefs = usePrefs()
      if (prefs.statusBar === false) return null
      return h(Odometer, props)
    }

    /**
     * 方块墙主面板：受 `wallPanel` 开关控制（同 GatedPanelIcon）。
     */
    function GatedBlockPanel(props) {
      const prefs = usePrefs()
      if (prefs.wallPanel === false) return null
      return h(BlockPanel, props)
    }

    /**
     * **会话桥**：把当前会话 id 推给 `focusStore`，自己不渲染任何东西。
     *
     * ## 为什么必须有它
     *
     * 桌宠是 root scope 的命令式 DOM，拿不到 `sessionId`；host 也不知道用户在 UI
     * 里选中了哪个会话。只有 session-scope 的 slot 组件拿得到这个 prop，所以这里
     * 做一个「只写不画」的组件，把它挂进 `conversation.input.dock`。
     *
     * ## 为什么单独注册、不复用 GatedOdometer
     *
     * `GatedOdometer` 在 `prefs.statusBar === false` 时**提前 return null**。
     * 而 `statusBar` 默认就是 false —— 把桥接在那里，sessionId 永远推不进来，
     * 桌宠读数永远为空，而且**不报任何错**。所以桥是独立条目、永不受开关控制。
     *
     * ## 为什么在 render 期间写 store 是安全的
     *
     * `focusStore.set` 对同一个 id 只刷新时间戳、不通知订阅者（见其实现），
     * 所以重复 render 不会造成通知风暴；换会话时才通知一次。这里刻意不用
     * `useEffect`，因为 effect 在 commit 后才跑，而桌宠的下一次轮询可能更早——
     * 那样会有一拍读到旧会话。同步写能让两者同拍。
     */
    function SessionBridge(props) {
      const sessionId = props?.sessionId
      focusStore.set(typeof sessionId === 'string' ? sessionId : undefined)
      return null
    }

    function BlockPanelIcon({ size = 16 } = {}) {
      const s = Number(size) || 16
      const cells = []
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          const filled = !(r === 2 && c === 2)
          cells.push(h('rect', {
            key: `${r}-${c}`,
            x: c * 7 + 1,
            y: r * 7 + 1,
            width: 5.4,
            height: 5.4,
            rx: 1.2,
            fill: filled ? 'currentColor' : 'none',
            stroke: filled ? 'none' : 'currentColor',
            strokeWidth: filled ? 0 : 1.2,
          }))
        }
      }
      return h(
        'svg',
        {
          width: s, height: s, viewBox: '0 0 22 22',
          'aria-hidden': true, focusable: false,
        },
        cells,
      )
    }

    /**
     * 方块墙主面板（`sidebar.panellist` 图标 + `main` 页面）。
     *
     * 顶部是实时跟进的总消耗量，下面是方块网格，底部是区间汇总——「积累」与
     * 「明细」在同一页，不用来回切。
     */
    function BlockPanel(props) {
      const t = locale.t
      const [scope, setScope] = React.useState('all')
      // 消耗分布的维度：工作区 / 模型 / 厂商。
      // 默认工作区（保持原有行为），另两个是「同一模型多供应商」问题的答案。
      const [distDim, setDistDim] = React.useState('workspace')
      // 统计口径（含子会话 / 含辅助调用）——与设置页共用同一份 prefs。
      const prefs = usePrefs()
      const { data } = useJson(`${ROUTE_PREFIX}/today${todayQuery(prefs)}`, { pollMs: 1000 })
      const [newFrom, setNewFrom] = React.useState(undefined)

      // 分布数据：按维度拉不同的分组。
      //
      // - 工作区：用轻量的 /workspaces 端点（只回 top N）
      // - 模型 / 厂商：用 /summary（归并逻辑在 host 侧，需要 modelAliases）
      //
      // 轮询比 /today 慢（10 秒）：这是「哪花得多」的分布，不是秒级心跳。
      //
      // ⚠️ **必须带上口径参数**（`includeSub` / `includeAux`）。
      //
      // 这条曾经漏掉：host 侧修好了「/workspaces 要走运行时 prefs」，但客户端
      // 根本没把这两个参数传下来，于是端到端仍然不一致——设置页关掉「含子会话」
      // 后，累计（/today）变小、而旁边的分布纹丝不动。**修一半比不修更难发现**，
      // 因为 host 的测试全绿。所以这里复用 `todayQuery()`，让三个端点只有一处
      // 口径来源。
      const fromKey = scope === 'today' ? localDayKey(Date.now()) : '2000-01-01'
      const toKey = scope === 'today' ? localDayKey(Date.now()) : '2099-12-31'
      const distScope = todayQuery(prefs).slice(1) // 去掉前导 `?`，便于继续拼
      const distQuery = distDim === 'workspace'
        ? `${ROUTE_PREFIX}/workspaces?limit=12&from=${fromKey}&to=${toKey}&${distScope}`
        : `${ROUTE_PREFIX}/summary?groupBy=${distDim === 'model' ? 'modelNorm' : 'vendor'}`
          + `&from=${fromKey}&to=${toKey}&${distScope}`
      const { data: distData } = useJson(distQuery, { pollMs: 10000 })
      const distRows = distData?.rows

      // Workspace 标题映射 + 当前 cwd。**没有这两个也不塌**——组件会用
      // cwd 的 basename 兜底，只是不显示宿主给 Workspace 起的名字。
      // `main` 是 root scope，本来就没有 session-scope 的 props，所以这里
      // 拿不到属于正常，不能当 bug 处理（详见 pickWorkspaceFacts 的说明）。
      const { wsTitles, currentCwd } = pickWorkspaceFacts(props)

      // 当前项（用于高亮）：工作区比 cwd，模型比原始模型名，厂商比 vendor。
      // host 的 `current` 同时给了 workspace 与 model（都是**原始名**）。
      const currentModelRaw = typeof data?.current?.model === 'string' ? data.current.model : ''
      const currentVendor = distDim === 'vendor'
        ? normalizeVendorOf(currentModelRaw)
        : undefined
      const currentForDim = distDim === 'workspace'
        ? currentCwd
        : distDim === 'model' ? currentModelRaw : currentVendor

      const total = tokensForScope(data, scope)
      const wall = blockWall(total)

      // 记录上一轮的已填块数，用于「刚获得」的脉冲与错开点亮。
      const prevFilledRef = React.useRef(undefined)
      const [pending, setPending] = React.useState([])
      React.useEffect(() => {
        const prev = prevFilledRef.current
        prevFilledRef.current = wall.filled
        if (prev === undefined || wall.filled <= prev) return
        // 一次可能跨多块（实测单轮最多 3.8 块）→ 逐个点亮，而不是一次全亮。
        const added = []
        for (let i = prev; i < wall.filled; i += 1) added.push(i)
        setPending((cur) => cur.concat(added))
      }, [wall.filled])

      // 错开点亮：每 120ms 放出一块，营造「连击」感。
      React.useEffect(() => {
        if (pending.length === 0) return
        const timer = setTimeout(() => setPending((cur) => cur.slice(1)), 120)
        return () => clearTimeout(timer)
      }, [pending])

      React.useEffect(() => {
        if (pending.length === 0) { setNewFrom(undefined); return }
        setNewFrom(pending[0])
        const timer = setTimeout(() => setNewFrom(undefined), 420)
        return () => clearTimeout(timer)
      }, [pending])

      if (data?.ok !== true) {
        return h('div', { className: 'dsh-tu-root' }, h('div', { className: 'dsh-tu-empty' }, t('loading')))
      }

      const todayTotal = Number(data?.totals?.totalTokens) || 0
      const allTime = Number(data?.allTime?.totalTokens) || 0

      return h(
        'div',
        { className: 'dsh-tu-root' },
        h('h1', { className: 'dsh-tu-h1' }, t('wallTitle')),
        h('p', { className: 'dsh-tu-sub' }, t('wallSubtitle')),

        // ── 第 1 层：方块墙（「积累」） ──
        // 每层是一个 `.dsh-tu-section`：块之间用细分隔线分层。
        // 早先所有元素平铺，读者分不清「方块墙 / 工作区 / 汇总」是三件事还是一件事。
        h('div', { className: 'dsh-tu-section' },
          h('div', { className: 'dsh-tu-wall-head' },
            h('span', { className: 'dsh-tu-wall-total' }, grouped(total)),
            h('span', { className: 'dsh-tu-wall-count' }, t('tokens')),
            h('span', { className: 'dsh-tu-wall-count' },
              `${t('wallHave')} `, h('b', null, wall.filled), ` ${t('wallBlockUnit')}`),
            h('span', { className: 'dsh-tu-wall-count' }, `· ${t('wallPage')} ${wall.pageIndex + 1}`),
            h(ScopeToggle, { t, scope, onScope: setScope }),
          ),
          h(BlockGrid, { cells: wall.cells, newFrom, pageStart: wall.pageStart, unit: BLOCK_UNIT }),
          h(BlockLegend, { t, unitLabel: unitLabelOf(BLOCK_UNIT) }),
          h('div', { className: 'dsh-tu-wall-foot' },
            h('span', null, `${t('wallNext')} `,
              h('span', { className: 'dsh-tu-wall-next' },
                `${compact(wall.remainder)} / ${compact(BLOCK_UNIT)}`),
              ` (${(wall.progress * 100).toFixed(1)}%)`),
          ),
        ),

        // ── 第 2 层：两个总量的对照 ──
        h('div', { className: 'dsh-tu-section' },
          h('div', { className: 'dsh-tu-cards' },
            h('div', { className: 'dsh-tu-card' },
              h('div', { className: 'dsh-tu-card-label' }, t('allTimeShort')),
              h('div', { className: 'dsh-tu-card-value' }, compact(allTime)),
              h('div', { className: 'dsh-tu-card-meta' }, `${grouped(allTime)} ${t('tokens')}`)),
            h('div', { className: 'dsh-tu-card' },
              h('div', { className: 'dsh-tu-card-label' }, t('statusBarLabel')),
              h('div', { className: 'dsh-tu-card-value' }, compact(todayTotal)),
              h('div', { className: 'dsh-tu-card-meta' },
                `${t('wallHave')} ${Math.floor(todayTotal / BLOCK_UNIT)} ${t('wallBlockUnit')}`)),
          ),
        ),

        // ── 第 3 层：消耗分布（「去向」）──
        //
        // 三个维度用同一套横条渲染，因为形状完全一样（{ 名称, 用量 } 的排行）。
        // 「模型」与「厂商」是为「同一模型走了多个供应商」这个真实问题加的：
        // 按原始模型名分组会把 deepseek-v4.1-flash 拆成 4 行（4 个渠道）。
        h('div', { className: 'dsh-tu-section' },
          h('div', { className: 'dsh-tu-dist-tabs' },
            h(Segmented, {
              value: distDim,
              options: [
                { value: 'workspace', label: t('distTabWorkspace') },
                { value: 'model', label: t('distTabModel') },
                { value: 'vendor', label: t('distTabVendor') },
              ],
              onChange: setDistDim,
            }),
          ),
          h(DistributionBars, {
            t,
            dim: distDim,
            rows: distRows,
            wsTitles,
            current: currentForDim,
          }),
        ),

        // ── 第 4 层：诊断 ──
        h('div', { className: 'dsh-tu-section' },
          h(Diagnostics, { t, diag: data?.diagnostics, config: data?.config }),
        ),
      )
    }

    /** 单位的人类可读写法（与 lib/blocks.js 的 unitLabel 等价）。 */
    function unitLabelOf(unit) {
      const u = Number(unit) || BLOCK_UNIT
      const trim = (n) => String(Number(n.toFixed(2)))
      if (u >= 1e9) return `${trim(u / 1e9)}B`
      if (u >= 1e6) return `${trim(u / 1e6)}M`
      if (u >= 1e3) return `${trim(u / 1e3)}K`
      return String(u)
    }

    // ── 桌宠（可拖动的方块窗口）────────────────────────────────────────
    const PET_POS_KEY = 'dsh.tokenUsage.pet.pos'
    const PET_COLLAPSED_KEY = 'dsh.tokenUsage.pet.collapsed'

    function petReadPos() {
      try {
        const raw = localStorage.getItem(PET_POS_KEY)
        if (raw === null) return undefined
        const p = JSON.parse(raw)
        if (p === null || typeof p !== 'object') return undefined
        const x = Number(p.x); const y = Number(p.y)
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
      } catch { return undefined }
    }
    function petWritePos(pos) {
      try { localStorage.setItem(PET_POS_KEY, JSON.stringify(pos)) } catch { /* 存储满/禁用 */ }
    }
    function petReadCollapsed() {
      try { return localStorage.getItem(PET_COLLAPSED_KEY) === '1' } catch { return false }
    }
    function petWriteCollapsed(v) {
      try { localStorage.setItem(PET_COLLAPSED_KEY, v ? '1' : '0') } catch { /* ignore */ }
    }

    /** 默认位置：右下角（避开输入框与右侧面板）。 */
    function petDefaultPos(size) {
      const w = typeof window !== 'undefined' ? window.innerWidth : 1200
      const hgt = typeof window !== 'undefined' ? window.innerHeight : 800
      return { x: Math.max(8, w - size.w - 24), y: Math.max(8, hgt - size.h - 120) }
    }

    /** 钳制到视口内，且给底部留出输入框的空间。 */
    function petClamp(pos, size) {
      const w = typeof window !== 'undefined' ? window.innerWidth : 1200
      const hgt = typeof window !== 'undefined' ? window.innerHeight : 800
      return {
        x: Math.min(Math.max(4, pos.x), Math.max(4, w - size.w - 4)),
        y: Math.min(Math.max(4, pos.y), Math.max(4, hgt - size.h - 4)),
      }
    }

    // ── 桌宠（命令式 DOM，不走 React）────────────────────────────────
    //
    // ## 为什么彻底放弃 React 托管
    //
    // slot 内容渲染在宿主 React 树里，position:fixed 会被带 transform/filter 的
    // 祖先劫持成相对定位（CSS 规范），桌宠就被锚死在 slot 容器里——这正是
    // 「只能在左边窄条里滑」的原因。profile 里能拖的 tarkov 桌宠根本不走 slot，
    // 而是直接把 DOM 挂到 document.body。照抄。
    //
    // ## 数据流
    //
    // 轮询 /today → 把数字写进现有 DOM（querySelector 更新 textContent / style），
    // **不重建结构**。这带来两个好处：拖动状态与渲染完全解耦（不会互相打断）；
    // 填充条的 CSS transition 在两次更新之间得以保留（重建会丢动画）。

    /**
     * 创建桌宠 DOM 并启动它的轮询；返回清理函数。
     *
     * 拖动实现（与 tarkov 桌宠同款）：pointerdown 记录抓取偏移 → setPointerCapture
     * （指针移出元素仍收事件）→ pointermove 直接改 left/top → pointerup 写盘。
     */
    function createBlockPetDom({ t }) {
      const doc = document

      // ── 建骨架 ──
      const root = doc.createElement('div')
      root.id = 'dsh-tu-pet'
      root.title = t('petHint')

      // 标题栏：抓取把手 + 当前工作区 chip + 折叠按钮。
      const head = doc.createElement('div')
      head.className = 'dsh-tu-pet-head'
      const grip = doc.createElement('span')
      grip.className = 'dsh-tu-pet-grip'
      grip.textContent = '⠿'
      const title = doc.createElement('span')
      title.className = 'dsh-tu-pet-title'
      title.textContent = t('navWall')
      // 工作区 chip：**当前工作区**（你在哪个项目）。
      //
      // ⚠️ 桌宠是 root scope 的命令式 DOM，拿不到 session-scope 的 props，
      // 所以「当前会话是哪个」它自己问不出来——由 host 在 /today 的 `current`
      // 字段里告知（host 知道每个会话的 cwd）。
      const wsChip = doc.createElement('span')
      wsChip.className = 'dsh-tu-pet-ws'
      wsChip.hidden = true
      const collapseBtn = doc.createElement('button')
      collapseBtn.type = 'button'
      collapseBtn.className = 'dsh-tu-pet-btn'
      collapseBtn.setAttribute('aria-label', t('petCollapse'))
      collapseBtn.textContent = '–'
      head.append(grip, title, wsChip, collapseBtn)

      // 大数字：**本会话**用量。
      //
      // 标签必须写明口径——桌宠是独立的小面板，用户单看一个数字不知道它是
      // 「本会话」还是「全时累计」。早先这里是累计，标签写「累计」；现在主读数
      // 换成会话（这才是用户问的那个问题），全时累计改由下面的「池」承担。
      const total = doc.createElement('div')
      total.className = 'dsh-tu-pet-total'
      const totalLabel = doc.createElement('span')
      totalLabel.className = 'dsh-tu-pet-total-label'
      totalLabel.textContent = t('sessionLabel')
      const totalValue = doc.createElement('span')
      totalValue.className = 'dsh-tu-pet-total-value'
      total.append(totalLabel, totalValue)

      // ── 上下文条 + 池 ─────────────────────────────────────────────────
      //
      // ## 进度条现在的语义：**上下文占用**
      //
      // PR1 之前它是「当前这个 10M 方块填了多少」——一个任意刻度，跟任何决策
      // 都无关。现在换成 `projectedTokens / contextWindow`：这是唯一**有后果**的
      // 进度，快满就会被压缩，用户会真的据此行动。分母来自宿主的
      // `contextPressure.contextWindow`（实测 1M 与 128K 两种，绝不能写死）。
      //
      // ## 池仍然是**全时累计块数**
      //
      // 这是插件的身份读数，只增不减。**不能**让它跟随会话：一个会话通常只有
      // 0.2 块，跟随就会长期显示「0 块」，彻底失去意义。
      //
      // ```
      // ┌──────────────────────┐
      // │ 本会话 2.13M          │  ← 大数字：本会话用量
      // │ ▓▓▓▓▓▓▓░░░ 71%        │  ← 上下文占用（快满会被压缩）
      // │ ▣ 58 块 · 本轮 41K    │  ← 池（全时）+ 本轮实时
      // └──────────────────────┘
      // ```
      //
      // ⚠️ class 名沿用 `charge*`：`blocks-cross.test.mjs` 与 `client.smoke.mjs`
      // 按这些名字定位元素。改名会让两个测试静默失去覆盖，而改名本身没有收益。
      const charge = doc.createElement('div')
      charge.className = 'dsh-tu-pet-charge'
      const chargeBlock = doc.createElement('div')
      chargeBlock.className = 'dsh-tu-pet-charge-block'
      const chargeFill = doc.createElement('span')
      chargeFill.className = 'dsh-tu-pet-charge-fill'
      chargeBlock.appendChild(chargeFill)
      const chargePct = doc.createElement('span')
      chargePct.className = 'dsh-tu-pet-charge-pct'
      charge.append(chargeBlock, chargePct)

      // 池：已攒下的整块数（全时累计）+ 本轮用量。
      const pool = doc.createElement('div')
      pool.className = 'dsh-tu-pet-pool'
      const poolIcon = doc.createElement('span')
      poolIcon.className = 'dsh-tu-pet-pool-icon'
      // 池图标：一个实心小方块（与「已获得的块」同一视觉语言）。
      poolIcon.setAttribute('aria-hidden', 'true')
      const poolLabel = doc.createElement('span')
      poolLabel.className = 'dsh-tu-pet-pool-label'
      // 本轮用量：和池同一行，用弱一档的颜色——它和「本会话」是同一个数在涨，
      // 不值得单独占一行（Q13 保留四个读数，但不等于四行）。
      const turnLabel = doc.createElement('span')
      turnLabel.className = 'dsh-tu-pet-stat-dim'
      pool.append(poolIcon, poolLabel, turnLabel)

      // 附加读数行：缓存命中率 + 今日量。
      //
      // 为什么是这两个：
      // - **缓存命中率**是成本的主要驱动（实测本会话 119M 里 118.6M 是缓存读取），
      //   而它一直只藏在 harness 的详情弹窗里；
      // - **今日量**给一个「今天的节奏」参照，而它本来就在 `/today` 的响应里，
      //   不下发到桌宠是白丢。
      //
      // 两者都是「补充读数」，所以字号更小、颜色更弱（`label-tertiary`）——
      // 主读数仍然只有「本会话」和上下文条。
      const meta = doc.createElement('div')
      meta.className = 'dsh-tu-pet-meta'
      // 上下文占用：从进度条降级到这里（见渲染段说明）。它仍然是**唯一有后果**的
      // 读数——快满会被压缩——所以放在第一位，且占用高时它会变色。
      const ctxItem = doc.createElement('span')
      ctxItem.className = 'dsh-tu-pet-meta-item'
      const ctxLabel = doc.createElement('span')
      ctxLabel.textContent = t('contextLabel')
      const ctxValue = doc.createElement('span')
      ctxValue.className = 'dsh-tu-pet-meta-value'
      ctxItem.append(ctxLabel, ctxValue)
      const cacheItem = doc.createElement('span')
      cacheItem.className = 'dsh-tu-pet-meta-item'
      const cacheLabel = doc.createElement('span')
      cacheLabel.textContent = t('cacheHitLabel')
      const cacheValue = doc.createElement('span')
      cacheValue.className = 'dsh-tu-pet-meta-value'
      cacheItem.append(cacheLabel, cacheValue)
      const todayItem = doc.createElement('span')
      todayItem.className = 'dsh-tu-pet-meta-item'
      const todayLabelEl = doc.createElement('span')
      todayLabelEl.textContent = t('statusBarLabel')
      const todayValue = doc.createElement('span')
      todayValue.className = 'dsh-tu-pet-meta-value'
      todayItem.append(todayLabelEl, todayValue)
      meta.append(ctxItem, cacheItem, todayItem)

      const foot = pool

      // 组装顺序：标题栏 → 本会话大数字 → **上下文条 + 池**（视觉主体）→ 附加读数。
      root.append(head, total, charge, foot, meta)
      doc.body.appendChild(root)

      // ── 状态 ──
      // ⚠️ 已无 `scope`：桌宠不再有「累计 / 今日」切换。早先那个切换是为了让
      // 大数字在两者间选一个，而「今日」已作为冗余读数移除（见上），切换失去对象。
      let collapsed = petReadCollapsed()
      let disposed = false
      let drag = null
      let lastRenderKey = ''
      // 上一帧已填的块数：用于检测「跨过 10M 整数」并触发落块脉冲。
      let prevFilled = -1
      // 上一帧的会话读数与上下文占用：折叠态切换时要用它们重算大数字，
      // 而按钮事件里拿不到最新的 data。
      let lastSessionTokens
      let lastOccupancy

      /**
       * 折叠态自适应读数（Q7=C）。
       *
       * 折叠态是 99% 时间被看到的那一屏，它该回答「现在有没有事」：
       * - **接近压缩**（≥ 80%）→ 显示上下文百分比，这是唯一的紧急信息；
       * - 平时 → 显示本会话用量，只是参考。
       *
       * 阈值取 80% 而不是 90%：90% 是「已经危险」的告警线（`is-almost` 用那个），
       * 而折叠态需要**提前**一点把注意力引过去，用户才有时间反应。
       */
      function applyCollapsedReadout(occupancy) {
        if (occupancy !== undefined) lastOccupancy = occupancy
        const urgent = lastOccupancy !== undefined && lastOccupancy >= 0.8
        if (collapsed && urgent) {
          totalLabel.textContent = t('contextLabel')
          totalValue.textContent = `${Math.round(lastOccupancy * 100)}%`
          total.title = t('contextCollapsedHint')
        } else {
          totalLabel.textContent = t('sessionLabel')
          totalValue.textContent = lastSessionTokens === undefined ? '—' : compact(lastSessionTokens)
          total.title = ''
        }
      }

      // ── 折叠/展开 ──
      function applyCollapsed() {
        root.classList.toggle('is-collapsed', collapsed)
        collapseBtn.textContent = collapsed ? '+' : '–'
        collapseBtn.setAttribute('aria-label', collapsed ? t('petExpand') : t('petCollapse'))
        applyCollapsedReadout(lastOccupancy)
      }

      // ── 渲染（只改差异，不重建）──
      function render(data) {
        if (disposed || data?.ok !== true) return

        // 同步运行时开关（host 是权威）。设置页改了开关 → PUT → host 存盘 →
        // 这里读到新值 → 灌进共享 store → 各模块（桌宠/主面板）立刻反应。
        if (data.prefs !== undefined && typeof data.prefs === 'object') {
          prefsStore.set({
            statusBar: data.prefs.statusBar !== false,
            pet: data.prefs.pet !== false,
            wallPanel: data.prefs.wallPanel !== false,
            // 统计口径也要同步：它决定这一拍以及后面的轮询怎么问 host。
            includeSub: data.prefs.includeSub !== false,
            includeAux: data.prefs.includeAux !== false,
          })
        }

        // ── 会话读数（可选）────────────────────────────────────────────
        //
        // `data.session` 只在请求带了 `?session=` 时才出现。两个来源各司其职：
        // - `live`：我们自己增量折的逐轮状态 → 有「本轮实时在涨」；
        // - `projected`：宿主投影的整份日志 → 权威的会话总量与上下文占用。
        //
        // ⚠️ 任何一项拿不到都显示 `—`，**绝不显示 0**。「读不到」和「花了 0」
        // 是两件完全不同的事，把前者画成后者是本插件最不能接受的失效形态
        // （DESIGN.md 里反复强调过）。
        const session = data?.session
        const live = session?.live
        const projected = session?.projected
        const tokenUsage = projected?.tokenUsage
        const pressure = projected?.contextPressure

        // 本会话用量：优先宿主投影（权威、含整份日志），退到我们自己折的。
        //
        // ⚠️ 两条路都必须过 `finiteOrUndefined` / `sumProjectionBuckets`。
        // 早先写的是 `Number(live.sessionTokens) || 0`，而 `compact()` 内部还有
        // 一层 `Number(n) || 0`——宿主字段一改名，NaN 就会一路变成「0」，
        // 于是「读不到」被画成「没花过」。这是 DESIGN 明令禁止的失效形态。
        //
        // ⚠️ 退到 `live` 时还多一个条件：**必须 > 0**。
        // 因为 `live` 是「插件启动以来」的累计，只要收到过任何一条事件就会存在
        // （哪怕是 `turn/start`，此时用量是 0）。若 `projected` 恰好不可用
        // （比如服务不在组合里），直接画 `live` 的 0 会让人以为「这个会话没花钱」，
        // 而实际上我们只是不知道它的历史总量。宁可画 `—`。
        const projectedTotal = sumProjectionBuckets(tokenUsage)
        const liveTotal = live === undefined || live === null ? undefined : finiteOrUndefined(live.sessionTokens)
        const sessionTokens = projectedTotal
          ?? (liveTotal !== undefined && liveTotal > 0 ? liveTotal : undefined)

        totalValue.textContent = sessionTokens === undefined ? '—' : compact(sessionTokens)
        totalLabel.textContent = t('sessionLabel')
        lastSessionTokens = sessionTokens

        // 上下文占用：`projectedTokens` 是「下一次请求的预计占用」，比上一拍的
        // 样本更贴近即将发生的事（harness 的 contextOccupancy 也是这个优先级）。
        const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
        const windowTokens = pressure?.contextWindow
        const occupancy = Number.isFinite(usedTokens) && Number.isFinite(windowTokens) && windowTokens > 0
          ? Math.max(0, Math.min(1, usedTokens / windowTokens))
          : undefined

        // ── 进度条 = **当前这个 10M 方块的填充进度** ─────────────────────
        //
        // ⚠️ 这里曾经试过把进度条换成「上下文占用」，结论是**不对**：
        // 上下文百分比是个「状态读数」，不是「积累进度」。进度条这个形状在
        // 用户心里对应的是「还差多少攒满一块」，换成上下文会让它和池脱节
        // （池在讲块数，条在讲窗口占用，两者不是同一个量纲）。
        //
        // 所以职责分清了：
        // - **条**：块的填充进度（和池同一个量纲，`blockWall().progress`）；
        // - **上下文**：降级成下面附加读数行里的一个百分比（`上下文 49%`）。
        const totalTokens = Number(data?.allTime?.totalTokens) || 0
        const wall = blockWall(totalTokens)
        const progressPct = Math.round(wall.progress * 100)
        chargeFill.style.width = `${(wall.progress * 100).toFixed(2)}%`
        chargePct.textContent = `${progressPct}%`
        // 快攒满一块（>= 90%）：轻微呼吸，提示「马上要落块了」。
        chargeBlock.classList.toggle('is-almost', wall.progress >= 0.9)
        chargeBlock.title = `${t('wallNext')} ${compact(wall.remainder)} / ${compact(BLOCK_UNIT)}`

        // 池：**全时累计**块数（不随会话变）。
        poolLabel.textContent = `${wall.filled} ${t('wallBlockUnit')}`
        pool.title = `${wall.filled} × ${compact(BLOCK_UNIT)} = ${compact(totalTokens)}`

        // 本轮用量：和「本会话」是同一个数在涨，做成池那一行的后缀。
        //
        // 「上一轮」也在这里，但只进 tooltip 而不占一行：
        // 它的作用是给「本轮这个数算大还是算小」一个参照，是**按需**信息；
        // 常显会把这个已经住了四个读数的小面板挤爆。
        const turnTokens = live === undefined || live === null ? undefined : finiteOrUndefined(live.turnTokens)
        const prevTurnTokens = live === undefined || live === null
          ? undefined
          : finiteOrUndefined(live.previousTurnTokens)
        if (turnTokens === undefined) {
          turnLabel.textContent = ''
          turnLabel.title = ''
        } else {
          turnLabel.textContent = `· ${t('turnLabel')} ${compact(turnTokens)}`
          turnLabel.title = prevTurnTokens === undefined
            ? `${t('turnLabel')} ${compact(turnTokens)}`
            : `${t('turnLabel')} ${compact(turnTokens)} · ${t('prevTurnLabel')} ${compact(prevTurnTokens)}`
        }

        // ── 附加读数 ────────────────────────────────────────────────────
        //
        // 缓存命中率 = 缓存读取 / 计费输入（未缓存 + 缓存读 + 缓存写）。
        // 分母为 0（还没有任何输入）时显示 `—`，不算成 0%。
        //
        // ⚠️ 不能把 outputTokens 放进分母：命中率是**输入侧**的概念，
        // 混进输出会让它随回复长度漂移，失去「这家的缓存好不好用」的含义。
        //
        // ⚠️ 三个桶同样要过 `finiteOrUndefined`：字段改名时宁可画 `—`。
        const uncachedInput = finiteOrUndefined(tokenUsage?.uncachedInputTokens)
        const cacheRead = finiteOrUndefined(tokenUsage?.cacheReadTokens)
        const cacheWrite = finiteOrUndefined(tokenUsage?.cacheWriteTokens)
        const billedInput = uncachedInput === undefined || cacheRead === undefined
          || cacheWrite === undefined
          ? undefined
          : uncachedInput + cacheRead + cacheWrite
        const cacheHit = billedInput !== undefined && billedInput > 0
          ? (cacheRead / billedInput) * 100
          : undefined
        cacheValue.textContent = cacheHit === undefined ? '—' : `${cacheHit.toFixed(1)}%`
        cacheItem.title = cacheHit === undefined
          ? t('cacheUnavailable')
          : `${t('cacheHitLabel')} ${compact(cacheRead)} / ${compact(billedInput)}`

        // 今日量：`/today` 本来就下发，桌宠不下发是白丢。
        //
        // ⚠️ 这里要区分「读不到」与「真的是 0」：
        // - `totals.totalTokens` 缺失或不是有限数 → `—`（读不到）；
        // - 它是 0 → 显示 `0`（今天确实还没花）——早先写成 `> 0 ? … : '—'`，
        //   把一个合法的 0 画成了「不可用」，是反向的混淆。
        const todayTokens = finiteOrUndefined(data?.totals?.totalTokens)
        todayValue.textContent = todayTokens === undefined ? '—' : compact(todayTokens)

        // 上下文占用：**不再是进度条**，而是这里的一个百分比读数。
        //
        // 但它仍然是唯一「有后果」的读数（快满会被压缩），所以占用高时这一格
        // 会变色——颜色只在这里出现，进度条保持单色（它是积累进度，不是告警）。
        if (occupancy === undefined) {
          ctxValue.textContent = '—'
          ctxValue.classList.remove('is-warn', 'is-danger')
          ctxItem.title = t('contextUnavailable')
        } else {
          ctxValue.textContent = `${Math.round(occupancy * 100)}%`
          const danger = occupancy >= 0.85
          const warn = !danger && occupancy >= 0.6
          ctxValue.classList.toggle('is-danger', danger)
          ctxValue.classList.toggle('is-warn', warn)
          ctxItem.title = `${t('contextLabel')} ${compact(usedTokens)} / ${compact(windowTokens)}`
        }

        // 当前工作区 chip（host 告知的「当前会话是哪个」）。
        const currentCwd = typeof data?.current?.workspace === 'string' ? data.current.workspace : ''
        if (currentCwd === '') {
          wsChip.hidden = true
        } else {
          wsChip.textContent = basenameOf(currentCwd)
          wsChip.title = currentCwd
          wsChip.hidden = false
        }

        // 折叠态自适应（Q7=C）：折叠是 99% 时间被看到的那一屏，它该回答
        // 「现在有没有事」。接近压缩时那才是唯一的紧急信息，平时本会话量只是参考。
        applyCollapsedReadout(occupancy)

        // 只有内容真的变了才碰 DOM：避免无谓的样式写入打断 CSS 过渡。
        const key = [
          wall.filled,
          // 进度条现在跟 wall.progress 走（块内填充），不能只看 filled——
          // 否则同一块内从 10% 涨到 80% 时 key 不变，条不会重绘。
          wall.progress.toFixed(4),
          occupancy === undefined ? 'na' : occupancy.toFixed(4),
          sessionTokens === undefined ? 'na' : sessionTokens,
          turnTokens === undefined ? 'na' : turnTokens,
          cacheHit === undefined ? 'na' : cacheHit.toFixed(2),
          Number.isFinite(todayTokens) ? todayTokens : 'na',
          currentCwd,
          collapsed ? 1 : 0,
        ].join('|')
        if (key === lastRenderKey) return
        lastRenderKey = key

        // 落块脉冲：跨过 10M 整数时，让**池**弹一下（「又攒到一块」）。
        const crossed = prevFilled >= 0 && wall.filled > prevFilled
        if (crossed) {
          pool.classList.remove('is-new')
          // 强制 reflow 让动画能重放（同一个类连续加两次不会重跑动画）。
          void pool.offsetWidth
          pool.classList.add('is-new')
          setTimeout(() => pool.classList.remove('is-new'), 600)
        }
        prevFilled = wall.filled
      }

      // ── 轮询 ──
      // /today 给全部读数：今日/累计/当前工作区/prefs，以及**带 `?session=` 时的
      // 会话读数**（本会话、本轮、上下文占用）。一个端点就够。
      //
      // 统计口径每次轮询都从 `prefsStore` 现读：用户在设置页改完，下一拍就生效
      // （桌宠不是 React 组件，拿不到 props，只能从共享 store 取）。
      //
      // `?session=` 来自 `focusStore`（由 session-scope 的桥写入）。桥没挂载时
      // `focusStore.value` 是 undefined，此时**不带**该参数——host 就会省略整个
      // `session` 字段，桌宠显示 `—`。这正是我们要的降级：不猜、不显示 0。
      //
      // ⚠️ 陈旧 id 照用但标注：桥所在 slot 可能已不在树上（用户切到方块墙面板），
      // 那时 `focusStore.value` 仍是最后一次看到的值。它仍是我们知道的最好信息，
      // 只是可能不是用户此刻正看的那个会话。
      const todayPath = () => {
        const base = `${ROUTE_PREFIX}/today${todayQuery(prefsStore.value)}`
        const id = focusStore.value
        if (typeof id !== 'string' || id === '') return base
        return `${base}${base.includes('?') ? '&' : '?'}session=${encodeURIComponent(id)}`
      }
      const pollTimer = setInterval(() => {
        fetch(todayPath(), { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : undefined))
          .then(render)
          .catch(() => {})
      }, 1000)
      // 立即拉一次，避免首秒空白。
      fetch(todayPath(), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : undefined))
        .then(render)
        .catch(() => {})

      // ── 位置 ──
      function applyPos(pos) {
        root.style.left = `${Math.round(pos.x)}px`
        root.style.top = `${Math.round(pos.y)}px`
      }
      function currentSize() {
        return { w: root.offsetWidth, h: root.offsetHeight }
      }
      // 先挂到视口外量尺寸，再定最终位置（避免首帧闪现在 0,0）。
      root.style.left = '-9999px'
      root.style.top = '0px'
      const savedPos = petReadPos()
      applyPos(petClamp(savedPos ?? petDefaultPos(currentSize()), currentSize()))

      // ── 拖动（把手区 = 标题栏；网格与按钮不触发拖动）──
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        // 折叠态整个窗口就是把手；展开态只有标题栏是把手。
        const rect = root.getBoundingClientRect()
        drag = {
          dx: e.clientX - rect.left,
          dy: e.clientY - rect.top,
          moved: false,
          sx: e.clientX,
          sy: e.clientY,
          size: currentSize(),
        }
        root.classList.add('is-dragging')
        try { head.setPointerCapture(e.pointerId) } catch { /* 不支持捕获 */ }
      })
      head.addEventListener('pointermove', (e) => {
        if (drag === null) return
        if ((e.buttons & 1) === 0) { endDrag(e); return }
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true
        if (!drag.moved) return
        applyPos(petClamp({ x: e.clientX - drag.dx, y: e.clientY - drag.dy }, drag.size))
      })
      function endDrag(e) {
        if (drag === null) return
        try { head.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
        const moved = drag.moved
        drag = null
        root.classList.remove('is-dragging')
        if (moved) {
          const x = Number.parseFloat(root.style.left)
          const y = Number.parseFloat(root.style.top)
          if (Number.isFinite(x) && Number.isFinite(y)) petWritePos({ x, y })
        }
      }
      head.addEventListener('pointerup', endDrag)
      head.addEventListener('pointercancel', endDrag)

      // 单击折叠按钮（不与拖动冲突：按钮在 head 内，stopPropagation 隔离）。
      collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        collapsed = !collapsed
        petWriteCollapsed(collapsed)
        applyCollapsed()
        applyPos(petClamp({ x: Number.parseFloat(root.style.left), y: Number.parseFloat(root.style.top) }, currentSize()))
      })

      // 窗口缩放时重新钳制。
      const onResize = () => {
        if (disposed) return
        applyPos(petClamp({ x: Number.parseFloat(root.style.left), y: Number.parseFloat(root.style.top) }, currentSize()))
      }
      window.addEventListener('resize', onResize)

      applyCollapsed()

      // ── 卸载 ──
      return () => {
        disposed = true
        clearInterval(pollTimer)
        window.removeEventListener('resize', onResize)
        root.remove()
      }
    }


    /**
     * 运行时开关的**共享状态**。
     *
     * ## 为什么是模块级而不是 React state
     *
     * 三个模块（横幅 / 桌宠 / 主面板）由**不同的**渲染路径控制：
     * - 横幅与主面板是 slot 组件（React）；
     * - 桌宠是命令式 DOM（挂在 document.body 上，**不经过 React**）。
     *
     * 如果用 React state，桌宠就拿不到——它不是 React 树的一部分。所以这里用
     * 一个模块级的 store + 订阅机制：谁需要就订阅，改动时统一通知。
     *
     * ## 数据流
     *
     * 初次：读 host 的 `/today`（它带 `prefs` 字段）→ 灌进 store。
     * 之后：设置页改开关 → `PUT /prefs` → 成功后写进 store → 通知订阅者。
     *
     * 桌宠因此能**立即**出现/消失，不用刷新页面。
     */
    const prefsStore = {
      value: {
        statusBar: false, pet: true, wallPanel: true, includeSub: true, includeAux: true,
      },
      listeners: new Set(),
      set(next) {
        this.value = { ...this.value, ...next }
        for (const fn of this.listeners) {
          try {
            fn(this.value)
          } catch {
            // 单个订阅者出错不该影响其他订阅者。
          }
        }
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }

    /**
     * 「用户正在看哪个会话」的共享状态 —— **数据桥**。
     *
     * ## 为什么需要它
     *
     * 桌宠是 root scope 的**命令式 DOM**（挂在 `document.body` 上），它拿不到
     * session-scope 的 props，所以**问不出当前会话是哪个**。而 host 更不知道：
     * 「UI 里选中了哪个会话」是纯客户端状态。
     *
     * 唯一可靠的来源是一个 **session-scope 的 slot 组件**——它拿得到 `sessionId`
     * prop。所以那个组件只做一件事：把 id 写进这个 store。桌宠每拍轮询时读它，
     * 把 id 作为 `?session=` 传给 host，由 host 去查真实数据。
     *
     * ## 为什么只传 id，不传数字
     *
     * 数字统一由 host 出。若桥也传数字，就会出现两个来源（浏览器折的 vs host 折的），
     * 而它们迟早不一致——正是 DESIGN.md 里警告过的那类「同一件事两个读数」。
     * 传一个字符串则不可能漂移。
     *
     * ## 为什么没有订阅机制
     *
     * 一开始写了 `subscribe` / `updatedAt` / `FOCUS_STALE_MS`，想「桥一变就让桌宠
     * 立刻重绘」以及「桥卸载后标注陈旧」。实现完发现两样都没人用：桌宠是 1 秒一次的
     * 轮询，本来就会读到最新值；而「陈旧」也没有对应的 UI。留着就是一整套没有调用
     * 方的 API——比没有更糟，因为它暗示存在一套不存在的机制。于是删掉，只留 `set` 与
     * `value`。真需要即时性时再加，那时会有真正的调用方。
     *
     * ## ⚠️ 桥必须**不受开关控制**
     *
     * 早先唯一的 session-scope 挂载点是 `conversation.input.dock` 里的
     * `GatedOdometer`，它在 `prefs.statusBar === false` 时**直接返回 null**。
     * 而 `statusBar` 默认就是 false —— 把桥接在那里，sessionId 永远推不进来，
     * 桌宠读数永远是空，**而且不会报任何错**。所以桥单独注册一个自己的条目
     * （见 `SessionBridge`），永远渲染 null，只负责推数据。
     */
    const focusStore = {
      /** 当前会话 id；`undefined` = 还没收到（或桥未挂载）。 */
      value: undefined,
      set(sessionId) {
        this.value = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
      },
    }

    const locale = {
      t: (key) => DICT_ZH[key] ?? key,
      register(ctx) {
        const svc = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (svc === undefined || typeof svc.register !== 'function') return
        try {
          svc.register(NS, 'zh', DICT_ZH)
          svc.register(NS, 'en', DICT_EN)
          const translate = svc.bind(NS)
          if (typeof translate === 'function') locale.t = (key) => translate(key)
        } catch {
          // 字典注册失败不该打空页面：保持中文兜底。
        }
      },
    }

    /**
     * 把样式挂进页面，返回清理函数。
     *
     * ## 为什么不用 `ctx.get('styles')`
     *
     * 早先这里写的是：
     *
     * ```js
     * const styles = ctx.get('styles')
     * if (styles !== undefined && styles.insert) ctx.effect(() => styles.insert(CSS), …)
     * ```
     *
     * 它**从未执行过**——`styles` 并不是一个 Cordis 服务。查遍 web profile 的所有包，
     * 没有任何地方 `provide('styles')`；它是动态插件（`evaluateClientHalf`）的
     * **函数参数**，而本插件走的是 `__ModuleLoader__.load({ id, factory })` 的
     * bundle 形式，那条路径上没有这个参数。
     *
     * 于是 11KB CSS 一行都没进页面，全部样式失效，界面上表现为：
     *
     * - 方块墙的 `display:grid` 没了 → 30 格竖排成一列，挤占页面最下方；
     * - 桌宠的 `position:fixed` 没了 → 退回普通文档流，只剩一个裸文本；
     * - 里程表的 `white-space:nowrap` 分组失效 → 「2,998,037,680tokens」粘在一起。
     *
     * ## 正确做法（与 `dsh-theme-tarkov` 桌宠同款）
     *
     * 自己建 `<style>` 挂到 `document.head`，并打上 `data-plugin` 标记——这是
     * `dsh-client-modules` 的 HMR 记账约定（它按 `style[data-plugin]` 认领与清理
     * 包所拥有的样式标签）。清理函数负责移除，随 `ctx.effect` 卸载。
     */
    function insertStyles(ctx) {
      const doc = typeof document !== 'undefined' ? document : undefined
      if (doc === undefined) return
      ctx.effect(() => {
        const el = doc.createElement('style')
        el.setAttribute('data-plugin', PKG_NAME)
        el.setAttribute('data-plugin-css', PKG_NAME)
        el.textContent = CSS
        ;(doc.head ?? doc.documentElement).appendChild(el)
        return () => {
          try {
            el.remove()
          } catch {
            // 已被宿主 HMR 移除过：重复移除不该抛错。
          }
        }
      }, `${PKG_NAME}: styles`)
    }

    return {
      name: PKG_NAME,
      inject: ['slots'],
      apply(ctx) {
        insertStyles(ctx)
        locale.register(ctx)

        const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots
        if (slots === undefined || typeof slots.inject !== 'function') return

        // ① 设置页：一个独立 section（id 用自己的，避免覆盖宿主已有页）。
        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: PKG_NAME,
              order: 40,
              label: () => locale.t('nav'),
              locale: NS,
            },
            (ownerProps) => h(SettingsPage, { ...ownerProps, t: locale.t }),
          ),
        )

        // ② 累计里程表（输入框上方的横幅）。
        //
        // ⚠️ **默认不显示**：横幅与桌宠显示的是同一批读数（累计/今日/速度），
        // 两处同时显示是冗余，而且横幅在输入框上方会**把对话区往上挤**。
        // 全部内容已并入桌宠（createBlockPetDom），所以横幅默认渲染成 null。
        //
        // 但**仍然注册**：注册是一次性的，而开关是运行时可变的；注册了再按开关
        // 渲染 null，用户打开开关就能立刻看到横幅，不必重载页面。
        //
        // ⚠️ ownerProps 必须透传：这个 slot 是 session scope，props 里带
        //   `session` / `useSessions` 等，Odometer 靠它们取当前工作区。
        //   早先写死 `h(Odometer, null)` 把 props 整个丢掉了。
        slots.inject('conversation.input.dock', () => {
          const render = (ownerProps) => h(GatedOdometer, ownerProps)
          // 测试用的逃生口：暴露内部组件引用。
          //
          // 为什么需要：GatedOdometer 在开关关闭时返回 null，测试拿不到
          // Odometer 本身。而 Sparkline 是 Odometer 的**内部函数**，无法从
          // 外部引用——于是测试只能「渲染 Odometer → 从渲染树里捞 Sparkline」。
          // 把引用挂出来，测试就能直接测，不必依赖渲染路径。
          // ponytail: 测试专用出口，生产代码路径不受影响。
          render.__component = Odometer
          render.__sparkline = Sparkline
          return slots.register(
            { name: 'conversation.input.dock', id: `${PKG_NAME}-odometer`, order: 5 },
            render,
          )
        })



        // ③ 方块墙主面板：`sidebar.panellist` 是侧栏的全局面板图标，
        //    其 `id` 必须与 `main` 的 `key` 一致——侧栏按钮点击后按这个 id
        //    去 `main` 里找同名 key 的条目渲染。两者注册同一个 id 才配得上对。
        //
        //    两个槽位都由宿主的 shipped 条目声明（`inject` 会立即执行）；
        //    即便将来某个声明晚于本插件，`slots.inject` 也会在声明出现时补跑，
        //    所以这里的注册顺序不构成依赖。
        //
        // ⚠️ **始终注册**，开关在组件内部生效（渲染成 null）。因为 slot 注册是
        //    **一次性**的，而开关是运行时可变的：若在注册时判断，用户后来打开
        //    开关就必须重载页面才能看到面板。
        slots.inject('sidebar.panellist', () =>
          slots.register(
            {
              name: 'sidebar.panellist',
              id: WALL_PANEL_ID,
              order: 20,
              label: () => locale.t('navWall'),
            },
            (ownerProps) => h(GatedPanelIcon, ownerProps),
          ),
        )

        slots.inject('main', () => {
          const render = (ownerProps) => h(GatedBlockPanel, ownerProps)
          // 测试用的逃生口：见 conversation.input.dock 的同名注释。
          render.__component = BlockPanel
          return slots.register({ name: 'main', key: WALL_PANEL_ID }, render)
        })

        // ③.5 会话桥：**只写不画**，永远渲染 null。
        //
        // 它的唯一职责是把 session-scope 的 `sessionId` 推给 focusStore，让
        // root scope 的命令式桌宠知道「用户正在看哪个会话」。
        //
        // ⚠️ 三个刻意的选择：
        //   1. **用自己独立的 id**（不是复用 `-odometer`）——复用 id 会顶掉那个
        //      条目（slot 契约：同 id 即替换），横幅就再也渲染不出来了。
        //   2. **不受任何 prefs 开关控制**——`statusBar` 默认 false，接在受控组件
        //      里等于永远不推数据，而且不报错。
        //   3. **order 放最前**（-100）——保证它在同一帧里先于其他条目 render，
        //      桌宠下一次轮询就能读到本帧的会话 id。
        slots.inject('conversation.input.dock', () =>
          slots.register(
            { name: 'conversation.input.dock', id: `${PKG_NAME}-session-bridge`, order: -100 },
            (ownerProps) => h(SessionBridge, ownerProps),
          ),
        )

        // ④ 桌宠：**不走 slot**。
        //
        // ## 为什么从 shell.overlay 撤下来
        //
        // slot 内容渲染在宿主的 React 树里。实测 `position:fixed` 会被任何带
        // `transform` / `filter` 的**祖先元素**劫持成相对定位（CSS 规范如此）——
        // 桌宠因此被锚死在 slot 容器那一小块区域里，只能在左边窄条里滑动，拖不出来。
        //
        // profile 里已验证能拖的 `dsh-theme-tarkov` 桌宠根本不走 slot：它把 DOM
        // 直接挂到 `document.body` 上。本插件照抄这个做法（挂载点/拆卸/样式插入
        // 都走 `ctx.effect`，随插件生命周期卸载）。
        //
        // ⚠️ 桌宠受**运行时开关**控制（prefs.pet）。它不是 React 组件，所以
        // 不能靠 slot 卸载；这里用「订阅 prefsStore → 按开关创建/销毁 DOM」。
        // 这样用户在设置页关掉它，桌宠**立刻消失**，不用刷新页面。
        ctx.effect(() => {
          let cleanup = undefined
          const sync = (prefs) => {
            const wanted = prefs.pet !== false
            if (wanted && cleanup === undefined) {
              cleanup = createBlockPetDom({ t: locale.t })
            } else if (!wanted && cleanup !== undefined) {
              cleanup()
              cleanup = undefined
            }
          }
          sync(prefsStore.value)
          const unsubscribe = prefsStore.subscribe(sync)
          return () => {
            unsubscribe()
            if (cleanup !== undefined) cleanup()
          }
        }, `${PKG_NAME}: pet dom`)
      },
    }
  },
})