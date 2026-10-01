// e2e/scenarios.mjs — E2E 场景矩阵（纯数据 + 文本生成器，Node 侧生成、注入器注入）。
//
// 维度：文本形态（LF/CRLF/空行/超长行/特殊字符）× Markdown 密度 × 长度梯度
//       × 注入通道（六种，复刻真实用户输入形态）× 注入后编辑操作。
// 每条场景跑全部十条不变量；focus 字段仅用于失败分诊标注，不裁剪检查项。
//
// 注入通道见 inpage.js inject 注释：
//   bi-text（单次 insertText，含 \n 或 \r\n 由文本决定——官方 paste 的形态复刻）
//   bi-lines（逐行 + insertParagraph）/ bi-linebreak（逐行 + insertLineBreak）
//   paste-plain / paste-html（合成 ClipboardEvent）/ refresh（注入后整页刷新=草稿恢复多 p）

// ---------- 文本生成器 ----------
const PLAIN_PATTERNS = [
	(i) => `第${i}行：检查输入框渲染对齐，字符锚定架构验证，中文长行内容。`,
	(i) => `line ${i}: const value${i} = compute(${i}); // trailing comment here`,
	(i) => `Mixed 中英 line ${i} with punctuation，标点、逗号与符号！`,
	(i) => `    indented line ${i} with four leading spaces`,
	(i) => `special symbols @#$%^&*()_${i} <> & " ' plus 空格`,
];

function plainLines(n, eol = "\n") {
	return Array.from({ length: n }, (_, i) => PLAIN_PATTERNS[i % PLAIN_PATTERNS.length](i)).join(eol);
}

/** 空行密集：每 2 行内容夹 1 个空行（空行也是行——行距探测器的主靶） */
function blankDense(n, eol = "\n") {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push(PLAIN_PATTERNS[i % PLAIN_PATTERNS.length](i));
		if (i % 2 === 1) out.push("");
	}
	return out.join(eol);
}

/** 行内格式密集：粗体/斜体/行内码/删除线/链接交替 */
function inlineDense(n, eol = "\n") {
	const pats = [
		(i) => `**加粗第${i}段**，后面跟普通文字 normal text after bold.`,
		(i) => `*斜体 line ${i}* with normal tail 而且 *多处 italic* 嵌入。`,
		(i) => `行内代码 \`code_value_${i}\` 之后 normal，再一段 \`second()\` 结束。`,
		(i) => `~~删除线 ${i}~~ kept as placeholder text with strikethrough marks.`,
		(i) => `链接 [文档 ${i}](https://example.com/doc/${i}) 和 [另一篇](https://example.com/other) 混排。`,
		(i) => `混合 **bold** 与 \`code\` 与 *italic* 同一行第 ${i} 组。`,
	];
	return Array.from({ length: n }, (_, i) => pats[i % pats.length](i)).join(eol);
}

/** 块级 markdown 混合：标题/列表/引用/有序/段落循环 */
function mdDoc(cycles) {
	const out = [];
	for (let i = 0; i < cycles; i++) {
		out.push(`# 标题 第${i}节`);
		out.push(`- 无序列表项 A（含 **加粗**）`);
		out.push(`- 无序列表项 B（含 \`行内码\`）`);
		out.push(`> 引用第${i}段：引用内容比较长一点，为了覆盖引用背景的整块渲染。`);
		out.push(`> 引用续行 ${i}，同一段引用的第二行。`);
		out.push(`${i + 1}. 有序列表第一项`);
		out.push(`${i + 1}. 有序列表第二项`);
		out.push(`普通段落 ${i}，含 **加粗**、\`code\` 与 [链接](https://example.com/x/${i})，行尾。`);
	}
	return out.join("\n");
}

/** 闭合代码块（可含块内空行/缩进） */
function fenceDoc(inner, lang = "js", withBlank = false, eol = "\n") {
	const lines = [
		"前导段落，代码块之前。",
		"```" + lang,
	];
	for (const l of inner) { lines.push(l); if (withBlank) lines.push(""); }
	lines.push("```");
	lines.push("后导段落，代码块之后。");
	return lines.join(eol);
}

/** 超长行素材 */
const CJK_300 = "字符锚定渲染验证".repeat(43); // 301 字无空格中文
const LONG_URL = "https://example.com/" + "path".repeat(60) + "/end?query=" + "abc".repeat(30) + "#frag";
const MIXED_LONG = ("Mixed中英" + "English words ".repeat(8) + "中文词语").repeat(12);

// ---------- 场景矩阵 ----------
export const SCENARIOS = [
	// ===== A 基础形态 =====
	{ name: "A1-lf-plain-60", group: "A", channel: "bi-text", text: () => plainLines(60, "\n"), focus: "基准" },
	{ name: "A2-crlf-plain-60", group: "A", channel: "bi-text", text: () => plainLines(60, "\r\n"), focus: "CRLF 头号嫌疑" },
	{ name: "A3-crlf-blank-dense", group: "A", channel: "bi-text", text: () => blankDense(24, "\r\n"), focus: "CRLF+空行" },
	{ name: "A4-lf-blank-dense", group: "A", channel: "bi-text", text: () => blankDense(24, "\n"), focus: "LF 空行对照" },
	{ name: "A5-bi-lines-60", group: "A", channel: "bi-lines", text: () => plainLines(60, "\n"), focus: "br 形态" },
	{ name: "A6-bi-linebreak-60", group: "A", channel: "bi-linebreak", text: () => plainLines(60, "\n"), focus: "linebreak 实测" },
	{ name: "A7-refresh-crlf", group: "A", channel: "bi-text", refresh: true, text: () => plainLines(40, "\r\n"), focus: "刷新恢复多 p" },
	{ name: "A8-refresh-lf", group: "A", channel: "bi-text", refresh: true, text: () => plainLines(40, "\n"), focus: "刷新恢复多 p" },

	// ===== B 换行混合（同一文档两种换行共存） =====
	{
		name: "B1-br-then-literal", group: "B", focus: "br+字面\\n 共存",
		steps: [
			{ channel: "bi-lines", text: () => plainLines(3, "\n") },
			{ channel: "bi-text", text: () => "\n" + plainLines(30, "\n") + "\n" },
			{ channel: "bi-lines", text: () => plainLines(3, "\n") },
		],
	},
	{
		name: "B2-mid-insert", group: "B", focus: "中部插入字面\\n",
		channel: "bi-text", text: () => plainLines(30, "\n"),
		ops: [
			{ type: "caret", off: null }, // null = 投影中部（inject 后由 op 内解析，这里用比例）
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "pasteLiteral", text: "中部插入第一行\n中部插入第二行\n中部插入第三行\n" },
		],
	},
	{
		name: "B3-alternating", group: "B", focus: "交替注入",
		steps: [
			{ channel: "bi-text", text: () => plainLines(5, "\n") + "\n" },
			{ channel: "bi-lines", text: () => plainLines(5, "\n") },
			{ channel: "bi-text", text: () => plainLines(5, "\r\n") + "\r\n" },
			{ channel: "bi-lines", text: () => plainLines(5, "\n") },
			{ channel: "bi-text", text: () => plainLines(5, "\n") },
		],
	},
	{
		name: "B4-insert-line-start", group: "B", focus: "行首插入",
		channel: "bi-text", text: () => plainLines(20, "\n"),
		ops: [
			{ type: "caretRatio", ratio: 0.35 },
			{ type: "pasteLiteral", text: "行首插入的新行甲\n行首插入的新行乙\n" },
		],
	},

	// ===== C Markdown 密集 =====
	{ name: "C1-inline-dense-40", group: "C", channel: "bi-text", text: () => inlineDense(40, "\n"), focus: "行内格式" },
	{ name: "C2-blocks-mixed", group: "C", channel: "bi-text", text: () => mdDoc(6), focus: "块级混合" },
	{
		name: "C3-unclosed-fence", group: "C", channel: "bi-text", focus: "未闭合围栏",
		text: () => plainLines(14, "\n") + "\n```js\nconst a = 1;\nconst b = 2;\n" + plainLines(5, "\n").replace(/^[^\n]*/, "围栏之后的普通行"),
	},
	{ name: "C4-fence-blank-inside", group: "C", channel: "bi-text", focus: "块内空行", text: () => fenceDoc(["const x = 1;", "function f() {", "  return x + 1;", "}"], "js", true) },
	{ name: "C5-fence-indented", group: "C", channel: "bi-text", focus: "块内缩进", text: () => fenceDoc(["  indented code a = 1;", "    deeper indent", "  back to two"], "python") },
	{ name: "C6-list-30", group: "C", channel: "bi-text", focus: "长列表", text: () => Array.from({ length: 30 }, (_, i) => `${i + 1}. 有序列表第${i + 1}项，内容含 **加粗**`).join("\n") },
	{ name: "C7-quote-20", group: "C", channel: "bi-text", focus: "长引用", text: () => Array.from({ length: 20 }, (_, i) => `> 引用行 ${i}：内容持续以引用形态渲染，覆盖整块背景。`).join("\n") },
	{
		name: "C8-wrapped-bold", group: "C", channel: "bi-text", focus: "软换行+格式",
		text: () => "开头普通文字，" + "**" + "这是很长的一段加粗内容".repeat(8) + "**" + "，结尾普通文字。\n第二行 " + "`" + "inline_code_long".repeat(6) + "`" + " 结束。",
	},
	{ name: "C9-crlf-markdown", group: "C", channel: "bi-text", text: () => mdDoc(5).replace(/\n/g, "\r\n"), focus: "CRLF+格式" },
	{ name: "C10-refresh-crlf-md", group: "C", channel: "bi-text", refresh: true, text: () => mdDoc(5).replace(/\n/g, "\r\n"), focus: "刷新+CRLF+格式" },
	{ name: "C11-crlf-fence", group: "C", channel: "bi-text", text: () => fenceDoc(["const x = 1;", "function f() {", "  return x + 1;", "}"], "js", true).replace(/\n/g, "\r\n"), focus: "CRLF+代码块（段剔 \\r 后背景）" },

	// ===== D 超长行（软换行） =====
	{ name: "D1-cjk-300", group: "D", channel: "bi-text", text: () => `前置说明行\n${CJK_300}\n后置说明行`, focus: "中文折行" },
	{ name: "D2-long-url", group: "D", channel: "bi-text", text: () => `链接地址如下：\n${LONG_URL}\n以上是地址。`, focus: "URL 折行" },
	{ name: "D3-mixed-long", group: "D", channel: "bi-text", text: () => `${MIXED_LONG}\n普通行`, focus: "中英混排折行" },

	// ===== E 特殊字符 =====
	{ name: "E1-emoji", group: "E", channel: "bi-text", text: () => plainLines(3, "\n") + "\n🎉🚀✅ emoji 行 😀😄 与 👨‍👩‍👧‍👦 组合家庭\n图表 ✨⭐️🔥 结束行\n" + plainLines(3, "\n"), focus: "emoji/组合" },
	{ name: "E2-tabs", group: "E", channel: "bi-text", text: () => "col1\tcol2\tcol3\na\tb\tc\n制表\t符\t行", focus: "制表符" },
	{ name: "E3-trail-spaces", group: "E", channel: "bi-text", text: () => "行尾三个空格   \n下一行文字\n双空格行尾  \n尾行无空格", focus: "行尾空格" },
	{ name: "E4-cr-only", group: "E", channel: "bi-text", text: () => plainLines(6, "\r"), focus: "孤立 \\r 观测" },

	// ===== F 注入后编辑 =====
	{
		name: "F1-type-mid", group: "F", focus: "中部打字",
		channel: "bi-text", text: () => plainLines(40, "\n"),
		ops: [{ type: "caretRatio", ratio: 0.5 }, { type: "type", text: "新插入XY" }, { type: "type", text: "Z" }],
	},
	{
		name: "F2-backspace-mid", group: "F", focus: "中部删字",
		channel: "bi-text", text: () => plainLines(40, "\n"),
		ops: [{ type: "caretRatio", ratio: 0.5 }, { type: "backspace" }, { type: "backspace" }, { type: "backspace" }, { type: "backspace" }, { type: "backspace" }],
	},
	{
		name: "F3-delete-line", group: "F", focus: "删整行",
		channel: "bi-text", text: () => plainLines(20, "\n"),
		ops: [{ type: "caretRatio", ratio: 0.45 }, { type: "selectLine" }, { type: "backspace" }],
	},
	{
		name: "F4-caret-dense", group: "F", focus: "密集光标采样",
		channel: "bi-text", text: () => inlineDense(12, "\n"),
		ops: [{ type: "caretSweep", n: 16 }],
	},
	{
		name: "F5-append-tail", group: "F", focus: "末尾续打",
		channel: "bi-text", text: () => plainLines(20, "\n"),
		ops: [{ type: "caret", off: null }, { type: "type", text: "续写内容甲" }, { type: "type", text: "乙丙丁" }, { type: "type", text: " continue tail" }],
	},
	{
		name: "F6-insert-head", group: "F", focus: "首行插入",
		channel: "bi-text", text: () => plainLines(30, "\n"),
		ops: [{ type: "caret", off: 0 }, { type: "type", text: "头部新行一\n头部新行二\n" }],
	},

	// ===== G 粘贴通道 =====
	{ name: "G1-paste-html", group: "G", channel: "paste-html", focus: "富文本 DOM", text: () => "", html: "<b>加粗行</b><div>div 行内容</div><div>第二 div</div><strong>strong 行</strong>" },
	{ name: "G2-paste-plain-long", group: "G", channel: "paste-plain", focus: "吞\\n 单行路径", text: () => plainLines(12, "\n") },
	{ name: "G3-paste-code-10", group: "G", channel: "paste-plain", focus: "包围栏", text: () => Array.from({ length: 10 }, (_, i) => `function f${i}() { return ${i}; }`).join("\n") },

	// ===== Q 续项键盘交互（keydown 捕获层：续项→两次 Shift+Enter 退出）=====
	{
		name: "Q1-quote-continue", group: "Q", focus: "引用续项→空项退出",
		channel: "bi-text", text: () => "> 引用一",
		ops: [
			{ type: "caret", off: null },
			{ type: "enter", shift: true },
			{ type: "expectSrc", expect: "> 引用一\n> " },
			{ type: "enter", shift: true },
			{ type: "expectSrc", expect: "> 引用一\n" },
		],
	},
	{
		name: "Q2-list-continue", group: "Q", focus: "列表续项回归",
		channel: "bi-text", text: () => "1. 第一",
		ops: [
			{ type: "caret", off: null },
			{ type: "enter", shift: true },
			{ type: "expectSrc", expect: "1. 第一\n2. " },
			{ type: "enter", shift: true },
			{ type: "expectSrc", expect: "1. 第一\n" },
		],
	},
	{
		name: "Q3-quote-multi", group: "Q", focus: "引用多行续项渲染",
		channel: "bi-text", text: () => "> 引用一\n> 引用二\n> 引用三",
	},
	{
		name: "Q4-tab-indent", group: "Q", focus: "Tab 嵌套列表 / Shift+Tab 反缩进",
		channel: "bi-text", text: () => "- 第一项",
		ops: [
			{ type: "caret", off: null },
			{ type: "enter", shift: true },
			{ type: "expectSrc", expect: "- 第一项\n- " },
			{ type: "tab" },
			{ type: "expectSrc", expect: "- 第一项\n  - " },
			{ type: "type", text: "子项A" },
			{ type: "expectSrc", expect: "- 第一项\n  - 子项A" },
			{ type: "tab", shift: true },
			{ type: "expectSrc", expect: "- 第一项\n- 子项A" },
		],
	},
	{
		name: "Q5-tab-plain", group: "Q", focus: "普通行 Tab 插空格不跳焦点",
		channel: "bi-text", text: () => "普通文字",
		ops: [
			{ type: "caret", off: null },
			{ type: "tab" },
			{ type: "expectSrc", expect: "普通文字  " },
			{ type: "caret", off: 0 },
			{ type: "tab" },
			{ type: "expectSrc", expect: "  普通文字  " },
			{ type: "tab", shift: true },
			{ type: "expectSrc", expect: "普通文字  " },
		],
	},

	{
		name: "Q6-ctrlb-wrap", group: "Q", focus: "Ctrl+B/I 包裹",
		channel: "bi-text", text: () => "普通文字",
		ops: [
			{ type: "selectRange", from: 0, to: 4 },
			{ type: "key", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "**普通文字**" },
			{ type: "caret", off: 8 },
			{ type: "type", text: "尾部" },
			{ type: "selectRange", from: 8, to: 10 },
			{ type: "key", key: "i", ctrl: true },
			{ type: "expectSrc", expect: "**普通文字***尾部*" },
		],
	},
	{
		name: "Q7-table-sep", group: "Q", focus: "表格首行自动补分隔行",
		channel: "bi-text", text: () => "|列A|列B|",
		ops: [
			{ type: "caret", off: null },
			{ type: "enter", shift: true },
			{ type: "expectSrc", expect: "|列A|列B|\n|---|---|\n" },
			{ type: "expectClass", selector: ".dsh-cl-tmark" },
		],
	},
	{
		name: "Q8-task-list", group: "Q", focus: "任务列表勾选样式",
		channel: "bi-text", text: () => "- [ ] 待办甲\n- [x] 已办乙",
		ops: [
			{ type: "expectClass", selector: ".dsh-cl-task" },
			{ type: "expectClass", selector: ".dsh-cl-task-done" },
		],
	},
	{
		name: "Q9-block-indent", group: "Q", focus: "选区跨行批量缩进",
		channel: "bi-text", text: () => "第一项\n第二项\n第三项",
		ops: [
			{ type: "selectRange", from: 0, to: 11 },
			{ type: "tab" },
			{ type: "expectSrc", expect: "  第一项\n  第二项\n  第三项" },
			{ type: "tab" },
			{ type: "expectSrc", expect: "    第一项\n    第二项\n    第三项" },
			{ type: "tab", shift: true },
			{ type: "expectSrc", expect: "  第一项\n  第二项\n  第三项" },
			{ type: "tab", shift: true },
			{ type: "expectSrc", expect: "第一项\n第二项\n第三项" },
		],
	},

	// ===== H 长度梯度 =====
	{ name: "H1-len-20", group: "H", channel: "bi-text", text: () => plainLines(20, "\n"), focus: "梯度" },
	{ name: "H2-len-60", group: "H", channel: "bi-text", text: () => plainLines(60, "\n"), focus: "梯度" },
	{ name: "H3-len-200", group: "H", channel: "bi-text", text: () => plainLines(200, "\n"), focus: "性能/稳定窗" },
	{ name: "H4-crlf-200", group: "H", channel: "bi-text", text: () => plainLines(200, "\r\n"), focus: "CRLF 大文本" },
	{ name: "H5-refresh-crlf-200", group: "H", channel: "bi-text", refresh: true, text: () => plainLines(120, "\r\n"), focus: "刷新+CRLF 大文本" },

	// ===== R 附件/撤销/全选/视口/滚动（2026-10-01 扩充：真实用户场景的覆盖缺口） =====
	// v0.2.6-0.2.8 的三个附件 bug（菜单悬空/工具栏盖图/滚动透明）都出自附件场景，
	// 此前矩阵却没有附件场景——R1-R3 补上；R4-R5 补撤销重做；R6-R8 补视口与滚动；
	// R9 空文档基线。attachImage/detachImages/toolbarClear/scrollToolbar/menuNearInput
	// 见 inpage.js op 注释。
	{
		name: "R1-image-attach-basic", group: "R", focus: "附件在场打字渲染+工具栏让位",
		channel: "bi-text", text: () => plainLines(8, "\n"),
		ops: [
			{ type: "attachImage" },
			{ type: "toolbarClear" },
			{ type: "caret", off: null },
			{ type: "type", text: "附件下方继续打字" },
			{ type: "detachImages" },
			{ type: "toolbarClear" },
		],
	},
	{
		name: "R2-image-attach-long", group: "R", focus: "附件+长文本滚动",
		channel: "bi-text", text: () => plainLines(60, "\n"),
		ops: [
			{ type: "attachImage" },
			{ type: "toolbarClear" },
			{ type: "detachImages" },
		],
	},
	{
		name: "R3-attach-menu", group: "R", focus: "附件在场 @ 候选菜单贴输入框（v0.2.6 回归）",
		channel: "bi-text", text: () => plainLines(3, "\n"),
		ops: [
			{ type: "attachImage" },
			{ type: "caret", off: null },
			{ type: "menuNearInput", text: "@" },
			{ type: "detachImages" },
		],
	},
	{
		name: "R4-selectall-replace-undo", group: "R", focus: "全选替换+Ctrl+Z 撤销恢复",
		channel: "bi-text", text: () => plainLines(20, "\n"),
		ops: [
			{ type: "key", key: "a", ctrl: true },
			{ type: "type", text: "全部替换后的新内容" },
			{ type: "expectSrc", expect: "全部替换后的新内容" },
			{ type: "key", key: "z", ctrl: true },
			{ type: "expectSrc", expect: plainLines(20, "\n") },
		],
	},
	{
		name: "R5-undo-redo", group: "R", focus: "Ctrl+Z 撤销 + Ctrl+Y 重做",
		channel: "bi-text", text: () => plainLines(10, "\n"),
		ops: [
			{ type: "key", key: "a", ctrl: true },
			{ type: "type", text: "替换后" },
			{ type: "key", key: "z", ctrl: true },
			{ type: "key", key: "y", ctrl: true },
			{ type: "expectSrc", expect: "替换后" },
		],
	},
	{
		name: "R6-narrow-softwrap", group: "R", focus: "窄视口软折行重排",
		channel: "bi-text", viewport: { width: 760, height: 720 },
		text: () => `前置说明\n${CJK_300}\n${MIXED_LONG}\n后置说明`,
	},
	{
		name: "R7-resize-after", group: "R", focus: "注入后改视口（resize 重渲染路径）",
		channel: "bi-text", resizeAfter: { width: 860, height: 700 },
		text: () => plainLines(60, "\n"),
	},
	{
		name: "R8-scroll-toolbar-sticky", group: "R", focus: "长文滚动工具栏钉视口顶（v0.2.8 回归）",
		channel: "bi-text", text: () => plainLines(200, "\n"),
		ops: [{ type: "scrollToolbar", amount: 900 }, { type: "toolbarClear" }],
	},
	{
		name: "R9-empty-state", group: "R", focus: "空文档基线（透明化关闭态）",
		channel: "bi-text", text: () => "",
	},
];
