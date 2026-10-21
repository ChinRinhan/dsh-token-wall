# 开发笔记

踩过的坑与验证器的失效方式。给未来的自己（和接手的人）看。

这些内容不属于 README：README 讲「它是什么、怎么用」，这里讲「为什么会写成现在这样」。

---

## ⚠️ 四次「验证器骗过了自己」

这个插件的返工史里，**最贵的错误都不是产品 bug，而是验证器的 bug**。四次都是同一类问题：验证器造了一个比现实**好看**的世界，然后拿它当证据。

### ① 样式从未被注入

**症状**：方块墙挤在页面最下面、桌宠只剩一行裸文本、里程表数字粘成 `2,998,037,680tokens`。

**根因**：注入样式写的是

```js
const styles = ctx.get('styles')            // ← 永远是 undefined
if (styles !== undefined && styles.insert) ctx.effect(() => styles.insert(CSS), …)
```

`styles` **不是一个 Cordis 服务**。查遍 web profile 的所有包，没有任何地方 `provide('styles')`——它是动态插件（`evaluateClientHalf`）的**函数参数**，而本插件走的是 `__ModuleLoader__.load({ id, factory })` 的 bundle 形式，那条路径上没有这个参数。于是 11KB CSS 一行都没进页面：

| 失效的规则 | 界面表现 |
|---|---|
| `.dsh-tu-wall-grid { display: grid }` | 30 格竖排成一列 → 挤占页面最下方 |
| `#dsh-tu-pet { position: fixed }` | 桌宠退回文档流 → 只剩裸文本 |
| `.dsh-tu-odo-item { white-space: nowrap }` | 「…680tokens」粘在一起 |

**为什么测试没抓到**（两层都失效了）：

1. `test/client.smoke.mjs` 的 mock ctx **伪造了** `styles` 服务，于是 `insert` 被调用、断言「注册了样式」通过——测的是「有没有调用」，不是「CSS 有没有进 DOM」
2. `tools/visual-check.mjs` 为了拿 CSS 字符串，同样伪造了 `styles`，把 CSS 直接内联进生成的 HTML——**验证器替被测插件把样式注了进去**，截图当然完美

两者都绕过了它们本该验证的那条路径。这是「验证器自己作弊」的典型案例。

**修复与加固**：

- 插件自己建 `<style data-plugin="dsh-token-usage">` 挂到 `document.head`，`ctx.effect` 负责卸载移除
- `client.smoke` 改为断言**真实 DOM**：head 里必须有本包 style、且含关键选择器；并把 mock 里的 `styles` 删掉（如实返回 undefined）
- `visual-check` 不再伪造 `styles`，改为从 `document.head` 取 CSS，取不到就**硬失败**；并在页面里注入自检横幅，用 `getComputedStyle` 断言 `display:grid` / `position:fixed` 真的生效
- 回归验证：把修复撤掉后，`client.smoke` 的样式断言 **7 项全红**

### ② 视觉验证用了手写的假主题值

**症状**：真实页面里桌宠方块是**近黑色**、背景是偏蓝的灰；截图里却是**蓝色**方块、暖白卡片——完全不是一回事。

**根因**：`visual-check.mjs` 把主题 token 的值**手写**在文件里：

```js
--dsw-alias-brand-primary: #247bbf   // ← 编的蓝
```

真实浅色主题里它是 `--dsw-static-neutral-bluish-1000` = `rgb(15,17,21)`，**近黑**。

**修复**：`tools/theme-tokens.mjs` 直接解析宿主的 `@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css`（`body` 块 = 浅色，`body[data-ds-dark-theme]` = 深色），解析 alias → static 两层引用，拿真实取值。

⚠️ 同一类错误在 `client.smoke` 里也有过：主题 token 清单是手写的，于是新加的 `label-tertiary` 没进清单 → 测试红了 → 说明「手写清单」本身就是个会漂移的东西。现在清单来自宿主真实 CSS。

### ③ 假数据比现实好看

**症状**：截图里工作区显示「HD222 游戏」「大发鱼」，真实页面显示 `HD222game`、`dafeiyu`。

**根因**：宿主把 workspace 存成 `path: "F:\dsh-work", title: "dsh-work"` —— **title 就是 basename**。我却在 visual-check 里编了「更好看」的中文标题，掩盖了「标题与路径无区别」这个事实。

**修复**：假数据一律用**真实值**。编造更漂亮的数据不只是不诚实——它会**掩盖产品问题**。

### ④ 落单反引号让整个文件无法加载

**症状**：反复出现「改一处 → 报 `SyntaxError: Unexpected identifier` → 找是哪行 → 换成普通引号」。`client.js` 上踩了 4 次、`visual-check.mjs` 上 3 次。

**根因**：这两个文件里有大段 CSS / HTML 的**模板字符串**。往注释里写一个 Markdown 风格的行内代码（反引号包裹）看着无害，却会让模板字符串**提前闭合**，整个文件语法错误 → 该文件整个不可加载。

**修复**：`tools/check-stray-backticks.mjs` 静态检查落单反引号。

⚠️ 检查器必须放在**独立文件**里：若与被检查的文件同处一个模块，那它自己还没跑到，被检查的文件就已经语法错误无法加载了——检查器形同虚设（实测：内嵌版本在注入落单反引号时先报 SyntaxError，检查根本没跑）。

⚠️ 写这个检查器时自己也踩了同一个坑：块注释里写了「跳过单引号/双引号字符串」，其中的星号斜杠序列提前闭合了注释，把工具自己写崩了。

---

## 视觉问题清单

| 问题 | 修法 |
|---|---|
| 卡片宽度参差（445/445/218/218/445/445） | `flex` 改 `grid`，列数按卡片数注入（6 张 → 3 列 × 2 行，每行都满） |
| 6 张卡排成「5 + 1」，末张拉满整行 | 同上，`columnsFor()` 选能整除的列数 |
| 今日占比 1.1% 时填充条宽度 0.5px，渲染成空槽 | 填充条 `min-width: 3px` |
| 桌宠阴影单薄，浮不起来 | 改双层阴影（近处收紧 + 远处拉开） |
| 97 个纯黑方块连成黑墙 | 改灰阶：已填=浅灰，正在填=品牌色（全场唯一品牌色） |
| 看不出「第 3 页」是多大量级 | 每 10 格一道里程碑竖线，首末行标量级 |
| 桌宠是页面上一块突兀的蓝灰 | 背景改 `bg-layer-1` + 更深的 `border-l2` |
| 工作区横条铺满整页 | 整块限宽 520px，三列（名/条/数字）固定宽度对齐 |
| 设置页表格日期折成「2026-」「09-25」两行 | `table-layout: fixed` + 首列定宽 + 单元格 `nowrap` |
| 表头「缓存写」把一列撑得很宽 | 表头允许换行，三字表头竖排两行 |
| 主面板一宽一窄：方块墙 320px、卡片各 445px 撑满 | 整页 `max-width: 560px` 居中，所有区块共用同一条边界 |
| 主面板所有元素平铺，分不清有几件事 | 加 `.dsh-tu-section` 分层：块间细分隔线 |

### 桌宠工作区 chip 消失（flex 挤压）

症状：桌宠标题栏是「`⠿ Token 方块墙 •`」——**圆点有、名字没有**。

根因是 flex 挤压：标题 `.dsh-tu-pet-title` 是 `flex: 0 1 auto` + `min-width: 0` + `overflow: hidden`，chip 也是 `flex: 0 1 auto`。两者抢同一行空间时，标题先把可用宽度吃满，chip 被压成 0 宽——只剩 `::before` 那个 4px 的小圆点可见。

修法：标题加 `max-width: 118px`（它是固定文案，优先级低），chip 加 `flex-shrink: 0`（里面的工作区名是关键信息）。

⚠️ 这类「元素存在但宽度为 0」的缺陷，**结构测试与 DOM 存在性检查都抓不到**——只有看图才能发现。

### 副标题把数字挤出可视区

「按模型/厂商」档每行多一列副标题（`4 个变体` / `3 个模型`）。早先四列都是**固定宽度**：`132 + 240 + 86 + 46 = 504`，加 3 个 gap(30) = **534px**，已经超过容器 520px；再加一列副标题（5 列 4 gap）直接溢出 **70px+**。

两处修法：

1. **条形改成弹性**（`flex: 1 1 auto`），固定列之和（328px）永远小于容器
2. **副标题给固定宽度 62px**（而不是 `auto`）——`auto` 会随文案长短变化，不同维度下条的左边缘会跳

⚠️ 连带问题：副标题缺失时若返回 `null`，那一行就**少一列**，条会多吃 62px+gap——实测同一张图里第一行条形是 `327→519`、其余行 `327→589`。现在副标题**总是渲染**（没有内容就渲染空串）。

修完实测：

```
溢出        = 0px（三档 + 窄屏 640/520/420 全部为 0）
条形左边缘  = 327（所有行一致）
条形右边缘  = 519（所有行一致）
数值左边缘  = 597（所有行一致）
```

⚠️ `test/distribution.test.mjs` 的列宽数字是**从 `client.js` 的 CSS 里正则读出来的**，不是硬编码。硬编码会让测试与实际样式漂移，变成「测试永远绿但界面仍然溢出」。已验证：把样式改回旧的固定宽度后，测试有 **4 处变红**。

### 维度串档

切档时 `useJson` 换了 URL，但**新数据回来之前 `rows` 还是上一档的**。若不挡住，切到「模型」的那一帧会拿 workspace 的行按 model 渲染——名字全空、数字还是工作区的（实测前 5 行名称为空、数值 842M）。

现在 `DistributionBars` 有**形状守卫**：只渲染「带当前维度判别字段」的行（workspace 档要 `r.workspace`、model 档要 `r.model`、vendor 档要 `r.vendor`）。

### 桌宠宽度与测试替身漂移

桌宠宽度写在 CSS 里，但 `petClamp()` 用的是测试替身的 `offsetWidth`。两处一旦漂移，位置钳制算出来的边界就是错的——而这类错误只在真实窗口里表现为「桌宠被挤到屏幕外」，单测完全看不出来。

现在 `client.smoke` 断言 CSS 宽度必须等于测试替身宽度。

---

## 其他踩过的坑

### `&amp;` 让 URL 判断失效

用 `includes('groupBy=workspace')` 判断请求时，HTML 里的 `&` 可能被写成 `&amp;`，判定落空 → 横条全空。修法：判定前先 `decodeURIComponent`。

### Node 侧常量没内联到浏览器脚本

`visual-check.mjs` 生成的 HTML 里，浏览器脚本看不到 Node 作用域。必须用 `JSON.stringify` 显式内联。

### 模板字符串里反斜杠被二次转义

`F:\\HD222game` 在模板字符串里被转成 `F:HD222game`，与数据里的 `F:\HD222game` 对不上，标题映射永远失配。修法：在 Node 端定义好字符串，再用 `JSON.stringify` 内联。

### 里程碑标签全部叠在左边缘

标签位置用了 `cell.index % COLS`，而里程碑位置天然满足 `index % 10 === 0`，于是全部算出 0 → 全叠在 `left: 0`。后来又发现标签塞进 26px 的方块里会被截断。

最终方案：标签放**独立的绝对定位层**（网格的直接子元素），`left: 2px; width: 22px`，竖线在 `left: 26px`，只在首行和末行显示。

### 网格 children 变成两个数组

加里程碑层后，网格的孩子是 `[方块数组, 里程碑数组]`，而原来只取 `children` 的测试只拿到第一个数组。修法：`flatMap` 展平后按 className 过滤。

### `main` / `odometer` 注册时丢了 ownerProps

早先写的是 `h(Comp, null)`，props 被整个丢掉，于是拿不到工作区标题与当前 cwd。修法：透传 `ownerProps`。

### 峰值速率永远是 `—`

速度原本用「累计值的相邻采样变化率」，而累计值只在有新调用时才变——空闲时恒为 0，99% 的时间显示「—」，等于没有这个指标。

改成**本次运行的总消耗 ÷ 已运行时长**（host 在 `/today` 的 `run` 字段里给）：用过就有数，不用时是稳定均值。分子只算本次运行内入账的 token，不含历史回填——否则会算出一个巨大且误导的数。

### 动效类名被整个覆盖

早先桌宠用 `el.cell.className = \`dsh-tu-block is-${state}\`` **整个覆盖**，于是 `is-new` 从来没生效过（只有主面板的 React 渲染有）。改成显式 `classList.add`。

---

## 迭代时的热更新行为

| 改动 | 生效方式 |
|---|---|
| `client.js` | 约 500ms 内热更新（`dsh-client-hmr` 轮询文件元数据），无需重启、无需构建 |
| `cordis.patch.yml` / `package.json` | 热重载 |
| `index.js` / `lib/**` | 禁用→重新启用该 bundle 即可，无需重启 DSH |

⚠️ 最后一条**已实测修正**：早先这里写的是「需要重启 DSH」，理由是「加载器按插件身份缓存模块」。实测不成立——用 `plugin_manager set_bundle(enabled:false→true)` 重新启用后，改动过的 `index.js` 会真的重新导入：注入一个 `hmrProbe` 字段，重启用后 `/dsh-token-usage/today` 立刻返回了它；还原文件后重启用，字段消失。

仍然成立的部分：**改完不重新启用就不会生效**（模块在激活期导入一次）。所以迭代 host 半的最短闭环是「改文件 → 禁用 → 启用 → 打端点」，不用杀进程。

---

## 视觉确认的边界（不夸大）

`tools/visual-check.mjs` 用的是**真实组件 + 真实 CSS + 真实数据流**，但**宿主外壳是模拟的**：侧栏、设置面板外框、composer 布局都不在验证范围内。

原因是驱动真实页面需要 `dsh web` 打印的 launch token（鉴权 cookie），没有也不该去取。

所以仍然**没有**自动验证过的：在真实 DSH 窗口里点开侧栏图标、拖动桌宠、切换深浅主题。这三件事需要人在页面上确认。

---

## 与其他实现的关系

profile 里 `dsh-our-free-model` 内部已有一个 `token-ledger`（写 `$DSH_HOME/channel-pack/token-ledger.json`）。本插件**不是**它的替代品，口径也不同：

| | token-ledger（our-free-model） | 本插件 |
|---|---|---|
| 覆盖范围 | 仅它自己的 13 个适配器 | **所有** provider（读日志，与路由无关） |
| 历史 | 无（装上才开始） | **可回填** |
| 日界 | UTC+8（对齐渠道额度结算） | **本机本地时区**（对齐用户作息直觉） |
| 界面 | 它自己的看板页 | 独立设置页 + 方块墙 + 桌宠 |

两者互不干扰，可以并存。
