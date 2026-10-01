# dsh-composer-live 架构深读

> **TL;DR (English).** The DSH 0.1.5 composer is a Lexical contenteditable editor. This plugin makes the editor's real text invisible (`-webkit-text-fill-color: transparent`, keeping `color` so the caret still works) and paints a rendering overlay whose every character is positioned at the editor's own per-character Range-rect coordinates. The overlay never does its own layout, so caret misalignment is impossible by construction (measured ≤ 0.02 px, 0.00 per keystroke frame). The plugin injects zero official services: it reads the editor DOM into a "projection text" (chips → U+FFFC, `<br>`/paragraph → newline), and edits the draft exclusively through Lexical-native synthetic `beforeinput` events. This document walks through each layer, the pitfalls that shaped it, and the test system that guards it.

本文面向想理解、修改或给本插件提交 PR 的人。全部结论来自对 dsh 0.1.5 客户端源码与真实 DOM 的实测（Chromium + Lexical 0.49）。

---

## 目录

1. [总体架构](#1-总体架构)
2. [字符锚定渲染（v0.2 根治架构）](#2-字符锚定渲染v02-根治架构)
3. [透明化与层叠](#3-透明化与层叠)
4. [投影文本与锚表](#4-投影文本与锚表)
5. [Lexical 插入与删除通道](#5-lexical-插入与删除通道)
6. [度量与对齐的细节陷阱](#6-度量与对齐的细节陷阱)
7. [DOM 锚点策略](#7-dom-锚点策略)
8. [等宽字体体系](#8-等宽字体体系)
9. [测试体系](#9-测试体系)

---

## 1. 总体架构

插件分两半。host 半（`index.js`）是无操作 loader entry；全部功能在浏览器半（`client.js`），由 DSH 的 dsh-client-modules 按 `package.json` 的 `dsh.client` 声明加载。

浏览器半的组成：

```
┌─ 官方输入卡 [data-composer-card]
│   ┌─ 官方 Lexical 编辑器 [data-composer-input]（contenteditable）
│   │     真实文字：-webkit-text-fill-color:transparent（透明但仍在排版）
│   │     position:relative; z-index:1（caret/选区盖在渲染层之上）
│   ├─ 渲染层 .dsh-cl-live（自建，pointer-events:none，z-index:0）
│   │     逐字符定位在编辑器文字的真实坐标上
│   └─ 格式工具栏（sticky，挂在滚动容器内）
│
├─ 键盘捕获层：[data-composer-card] capture 阶段，先于官方 Lexical keymap
└─ 数据源：直接读编辑器 DOM → 投影文本（零服务注入）
```

四条设计原则：

- **渲染层永不自己排版**——一切坐标来自编辑器的真实测量。
- **零服务注入**（`inject: []`）——不依赖任何官方 client 服务，官方 client API 重构免疫。
- **草稿编辑只走 Lexical 原生通道**——合成 `beforeinput` 事件，保撤销栈，绝不直接改 DOM。
- **降级优先**——任何测不到、算不出、复刻不了的场景（含 @ 胶囊的段落、锚表漏收、渲染抛错）自动回退官方原样显示，宁可没有效果也不能错位。

## 2. 字符锚定渲染（v0.2 根治架构）

### 为什么推翻 v0.1

v0.1 的渲染层自己排版（按行建 div、复制度量、做对齐偏移），与编辑器是**两套排版引擎**。两套引擎各自计算，靠「复制度量 + 偏移补偿」开环逼近——字体、字重、断行、等宽打点时序，任何一个维度变化都是新的误差源，对齐修复做了七轮仍不能穷尽（历史版本里首行偏移、击键抖动、选中重影、行内格式漂移全是它的产物）。

### v0.2 的做法

渲染层不再排版，只做一件事：**把编辑器里每个字符的真实坐标量出来，渲染字符画到同一坐标上**。

渲染管线（一次渲染帧内）：

1. **锚表**（buildAnchors）——深度遍历编辑器根，产出文本/br/chip/段边界的序列（见 §4）。
2. **等宽打点**——先于测量：需要等宽的行先把 class 打到编辑器文本 span 与渲染行上，让布局先定型（布局定型后再打点，测量值就是旧的）。
3. **块级背景聚合**——代码块/引用段整块一个矩形（容器内容宽、首行字符顶到末行字符底，垂直无缝、右缘齐平）；语言标签 CSS `right` 定位到围栏行右侧。
4. **逐字符测量**（measureAnchorChars）——对每个文本锚按 Range 取每个字符的 rect。
5. **合并定位段**——按「同样式 + 同视觉行 + 横向连续」合并成一个绝对定位段（span 数量从每字符一个压到每段一个）。
6. **输出**——绝对定位渲染层，`pointer-events:none`，点击穿透。

因为只剩编辑器一套排版引擎，**漂移/抖动/错位在物理上不可能发生**：任何度量维度怎么变，渲染坐标都是跟着编辑器量的。实测：行内格式/代码块/块后行/软换行全部场景偏差 ≤ 0.02px；真键盘连续打字 358 帧逐帧 delta = 0.00。

## 3. 透明化与层叠

### 透明化的正确手法

```css
[data-composer-input] {
  -webkit-text-fill-color: transparent;  /* 只隐藏「绘制」 */
  /* color 属性保留原值 */
}
```

关键是 `-webkit-text-fill-color` 只影响文字绘制，`color` 属性保留——于是**免费获得**：caret 颜色正常（跟随 color）、官方 placeholder 的 `::after` 正常、chip 等官方装饰用 `currentColor` 自动恢复显示。

### 层叠：编辑器提上来，不是渲染层压下去

问题：overlay（定位元素，z-index:0）天然画在非定位的编辑器内容之上；编辑器内容含 caret 与选区高亮——被 overlay 盖住就看不见了。

- ✅ **正解**：编辑器 `position:relative; z-index:1`。caret/选区是编辑器内容的一部分，随层自然盖在 overlay 之上；编辑器的透明文字不遮挡 overlay 的渲染文字（透明的东西画不出遮挡）。
- ❌ **反例**（v0.1 踩过）：把 overlay 压 `z-index:-1`。caret 确实露出来了，但负 z 让 overlay 掉到输入框**背景**之下——渲染文字整体不可见，选中才能看到轮廓。

### caret 必须

显式设 `caret-color`。透明化后 `caret-color:auto` 在部分 Chromium 版本会跟随 text-fill-color 把光标也画成透明。

**caret 无 DOM 无 API 可查**——验证只能像素级：连拍多张截图覆盖闪烁周期，在 caret 坐标扫指定色竖线。注意截图坐标 = CSS 坐标 × devicePixelRatio，不换算会 0 命中误判。

### 选区的双影与无色

Chromium 选中时用 `::selection` 反色重绘文字——透明文字被重绘成白字，与 overlay 渲染文字成**双影**。修法是 `::selection { color: transparent }`；但 ::selection 规则一旦匹配，**未声明的属性取初始值**——只写 color 会把浏览器默认高亮一并洗掉（看起来「选中无色」），必须同时显式声明 `background`（品牌蓝半透明，明暗两套走 CSS 变量）。

## 4. 投影文本与锚表

插件与官方的一切数据交互都走「投影文本」——直接读编辑器 DOM 产出的纯文本，与官方 detectText 同构：

- 文本节点 → 原文
- `<br>` / 段落边界 → `\n`
- @ 胶囊（`span[data-composer-chip]`）→ U+FFFC（对象替代符）

### 必须知道的 DOM 形态（dsh 0.1.5 实测）

- 实时输入的多行草稿是**单个 `<p>` + `<br>`（Lexical LineBreakNode）分行**，文本在 `<span data-lexical-text>` 里。Enter 是发送、Shift+Enter 才换行（插 br）。
- `setDraft`（程序化灌入：草稿恢复、输入历史回填）才产生**多个 `<p>`**。两种形态都兼容。
- **大段粘贴是第三种形态**：官方 paste 管线的 insertText 不把 `\n` 转成换行元素——大段文本存成「**单文本节点内含字面 `\n`**」。渲染侧的行切分必须**同时认** br/段落锚和文本内的字面 `\n`，且两者共享同一行号推进逻辑；只认 br 会让全部字符记到第 0 行、charAt 越界取空串、渲染一片空白（v0.2.3 修的就是这个）。
- 段落**尾部空行**的 br 带 `data-lexical-managed-linebreak` 属性（行尾占位不切行），投影/锚表必须跳过，否则多渲染一行。
- @ 引用是 `span[data-composer-chip][contenteditable=false]` 装饰节点（React portal）；热词是 `span[data-composer-text-ref]` 文本装饰（其文本参与投影，正常渲染）。

### 锚表

buildAnchors 产出 `{kind:'text', node, len} / {kind:'chip', …} / {kind:'break'} / {kind:'para'}` 序列。光标/选区（DOM Selection）与投影 offset 的互查、选区包裹、工具栏状态高亮都基于它。**含真 chip 的段落整段降级**为官方原样显示（恢复 `currentColor`、overlay 空占位）——chip 宽度无法复刻，零错位优先。

## 5. Lexical 插入与删除通道

改动草稿（续项、围栏补全、缩进、删除标记……）不能直接改 DOM——Lexical 管理着内部状态。五条实测结论（Chromium + Lexical 0.49）：

| # | 通道 | 结果 |
| --- | --- | --- |
| 1 | keydown 处理器**内**执行编辑类 `execCommand` | **静默失败**（返回 true 零效果）——必须 `setTimeout(0)` 延后 |
| 2 | `execCommand("insertText")`，文本含 `\n` | **静默失败** |
| 3 | 合成 `paste` 事件复用官方 PASTE_COMMAND | 官方 handler 走 `insertText`，把 `\n` 当普通字符插进同一文本节点——**不拆行** |
| 4 | 合成 **`beforeinput` 序列**：`insertText`（带 data）+ `insertParagraph` | ✅ **唯一全通的多行通道**（Lexical 异步 commit，保撤销栈）；单行文本可走延后的 `execCommand("insertText")` |
| 5 | `execCommand("delete")` | 无 user activation 时**静默 no-op**（CDP/自动化环境拿不到手势）——先选区再合成 `beforeinput` `deleteContentBackward`（Lexical 不校验激活） |

两条铁律：

- 一切编辑操作延后到事件处理完（`setTimeout(0)`）。
- **有选区的整块替换**（如跨行缩进）必须走三步链：合成删除选区 → 等 commit → 插入新块 → 恢复选区。直接在选区上跑 beforeinput 插入序列会与 Lexical 内部 selection 状态不同步（实测首段丢失）。

键盘拦截本身挂 `[data-composer-card]` 的 **capture** 阶段，先于官方 Lexical keymap；官方候选菜单开着（`[data-trigger-menu]` / `[role=listbox]`）或输入框 `data-phase ≠ plain` 时一律让行。

## 6. 度量与对齐的细节陷阱

字符锚定架构消灭了对齐类问题，但测量与绘制本身还有几个物理陷阱（全部由 E2E 矩阵定位，v0.2.4 修）：

- **half-leading**：绝对定位段内字符随段自身行盒排版，字形顶 = 段 top +（行高 − 字形高）/ 2（行高 27 / 字形 21 → 3px）。段定位必须用「行盒顶」而非测出的「字形盒顶」，否则渲染文字整体下移恒定 3px。段内其余字符相对排布与编辑器同构（同字体同行高同基线），首字符对齐即全段对齐。
- **`innerHTML` 的 `\r` 规范化**：HTML 解析把字面 `\r`（含 `\r\n`）规范化成 `\n`——段 text 里的 `\r` 凭空变真换行（pre-wrap 断行）＝ CRLF 粘贴「多余空白」的来源。修法：段 text 直接剔 `\r`（视觉零宽），`escapeHtml` 保留 `&#13;` 实体通道（字符引用不参与规范化）。
- **胶囊 padding 四向补偿**：行内代码胶囊 `padding:1px 5px` 若只横向负 margin，绝对定位段的内容会下移 padding-top（恒 +1px）。必须 `margin:-1px -5px` 四向补偿。
- **标记字符占位 + 伪粗**：渲染版若删掉 `**`、`` ` `` 标记字符再上 `font-weight:700`，字符 advance 变化会让渲染行比透明文字短——光标按透明文字布局画就漂移。修法：标记字符保留占位只淡化（`.dsh-cl-mk`），粗体/标题一律 `-webkit-text-stroke` 伪粗（paint-only 不改 advance）。注意正则防重入：标记替换的产物含 `<`，后续规则的内容组要排除它防二次嵌套。
- **首行偏移用增量算法**：测量差直接赋值会在两个值间振荡（测量值已含当前偏移的效果）；「测量差 + 当前偏移 = 绝对目标」一步收敛。

## 7. DOM 锚点策略

dsh 0.1.5 前端是 CSS Modules——类名全带随机 hash（每次构建变化），**类名不可用**。插件全部用语义 `data-` 属性与结构特征锚定：

| 锚点 | 含义 |
| --- | --- |
| `[data-composer-card]` | 输入卡容器（键盘捕获挂点） |
| `[data-composer-input]` | Lexical 编辑器根（contenteditable） |
| `span[data-composer-chip]` | @ 引用胶囊（装饰节点，段落降级判据） |
| `span[data-composer-text-ref]` | 热词文本装饰（参与投影） |
| `[data-trigger-menu]` / `[role=listbox]` | 官方候选菜单（让行判据） |
| `data-lexical-managed-linebreak` | Lexical 尾部空行占位 br（跳过） |

同理，对官方**布局**的适配也用几何法而非类名：图片附件在场时的工具栏让位靠「检测编辑器外的 img → 向上找全宽祖先取底边」，官方 DOM 怎么改都不失效。

顺带兜底的两个官方定位问题（均为几何法）：图片附件在场时候选菜单悬空（官方菜单 absolute + `bottom:4px` 锚定不感知附件栏——bottom 锚定下 margin 零位移、top 与 bottom 同设会拉伸，只有 `transform: translateY` 与官方零冲突且天然幂等收敛）；工具栏盖附件缩略图（根治 = 工具栏挂进滚动容器 + `position:sticky; top:0`，附件栏在滚动容器外，sticky 天然让位）。

## 8. 等宽字体体系

语义（v0.2.4 定稿）：草稿含**已闭合**代码块 → 编辑器整框 + 渲染全段同步切等宽合成栈（同源变量）。为什么整框不逐行：大段粘贴是单文本锚跨全部行，DOM 按行换字体物理不可行；且打点循环的行号推进要同时认字面 `\n`，逐行方案的行号全落 0（E2E 实测字符 advance 两侧差 1.69px/字符累积）。

合成栈（buildCodeFont）：代码字体栈**剔除含中文字形的字体**（CJK 关键词清单，含 "nf cn" 这类自带 1.2em 中文字形的变体）与**通用字族关键字**（`monospace` 等——Chromium 视其为软终点会拦截后续回退）后，拼上从哨兵元素（body 继承链）读出的界面栈。效果：拉丁字符走等宽、中文恒走界面栈——两侧换行点/字宽永远一致，因为中文的 advance 在哪个栈里都由界面字体决定。

两套语义并存是刻意的：**渲染判定**用「已闭合」（打 ``` 的瞬间界面不变，补全封闭才出块——避免半成品视觉）；**编辑判定**（Tab 缩进、粘贴包围栏）用「含未闭合」的编辑上下文。

## 9. 测试体系

### 单测（test-live.cjs，188 项）

纯函数层：行渲染、围栏状态机、语法高亮、字体栈合成、键盘判定、粘贴判定、chip 投影、锚表逻辑。无浏览器依赖，毫秒级跑完。

### E2E（e2e/，53 场景 × 10 不变量）

单测测不了坐标、行距、视觉位置——E2E 在真实浏览器里测。设计思想：**复刻真实输入形态 + 独立投影交叉验证 + 只测真实视觉位置**。

- **六种注入通道**对应六种真实 DOM 形态：字面 `\n` / 字面 `\r\n` / 逐行 br / insertParagraph / 合成 paste / 刷新恢复多 p（setDraft 路径）。
- **独立投影**（inpage.js 自带一份与插件独立的投影实现）与插件投影交叉验证——两边算的不一样就是 bug。
- **十条不变量**（INV）中的核心三条：
  - INV-3：渲染段内字符**真实 rect** vs 编辑器字符 rect 逐字符对比 ≤ 0.5px。教训：v0.2.0 时代「实测 ≤ 0.02px」的口径是「段定位值 vs 测量值」——定义上恒等的回读，测不出系统性偏差；3px 的整体偏移就是这么漏掉的。**验证口径必须测真实视觉位置，定位值回读是恒等式**。
  - INV-6：行距均匀性（多余空白探测器，软换行感知公式）。
  - INV-7：caret 几何采样（collapsed selection 的 rect vs 字符位置；软折行点会产两个等价 rect，判定须全候选任一匹配）。
- 运行纪律：只动草稿**绝不发送**；测完自动清空；cookie 是鉴权凭据不进 git。

E2E 的价值有实证：v0.2.4 的五处真 bug 全部由测试矩阵定位，此前 25/44 场景失败而「肉眼看着没问题」。
