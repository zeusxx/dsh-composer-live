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

/** Markdown 标记混排行（Z 组粘贴变体：用户粘贴的真实内容常含格式标记） */
function mdLines(n) {
	const pats = [
		(i) => `## 标题 ${i} 的正文内容`,
		(i) => `这是**加粗 ${i}**与*斜体*混排的一行内容`,
		(i) => `- 列表项 ${i}：带 \`行内代码\` 的内容`,
		(i) => `> 引用行 ${i}，引用块内容`,
		(i) => `普通文本行 ${i}，含 [链接文字](https://example.com/${i})`,
		(i) => `${i}. 有序条目，任务 [ ] 待办`,
	];
	return Array.from({ length: n }, (_, i) => pats[i % pats.length](i)).join("\n");
}

/** mdLines 的 text/html 版（模拟从浏览器/Word 复制：多 <p> + <b>/<i> 富文本形态） */
function mdHtml(n) {
	const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const pats = [
		(i) => "<p>" + esc(`标题 ${i} 的正文内容`) + "</p>",
		(i) => "<p>这是<b>" + esc(`加粗 ${i}`) + "</b>与<i>斜体</i>混排的一行内容</p>",
		(i) => "<p>" + esc(`列表项 ${i}：带行内代码的内容`) + "</p>",
		(i) => "<p>" + esc(`引用行 ${i}，引用块内容`) + "</p>",
		(i) => "<p>" + esc(`普通文本行 ${i}，含链接文字`) + "</p>",
		(i) => "<p>" + esc(`${i}. 有序条目，任务待办`) + "</p>",
	];
	return Array.from({ length: n }, (_, i) => pats[i % pats.length](i)).join("");
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

// S/W/X/D/U/P 组共用的固定素材与断言生成器（2026-10-24 扩充）
const CJK30 = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥"; // 30 字单行
const CJK20 = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸"; // 20 字
const THREE_LINES = ["第一行内容甲乙丙", "第二行内容丁戊己", "第三行内容庚辛壬"].join("\n"); // 投影 26 字
const THREE_LINES_PROJ = THREE_LINES; // bi-lines(br) 与 bi-text(字面\n) 两形态投影同构，别名以示语义

/** V7 粘贴 MD 全家桶：标题/粗斜/行内码/链接/代码块/引用/有序无序列表/任务/表格 */
const MD_SUITE = [
	"# 标题一",
	"普通段落带 **粗体**、*斜体*、`行内代码` 和 [链接](https://example.com)。",
	"> 引用第一行",
	"> 引用第二行",
	"- 无序列表项 A",
	"1. 有序第一",
	"```js",
	"const x = 42;",
	"```",
	"| 列一 | 列二 |",
	"| --- | --- |",
	"- [x] 已完成任务",
].join("\n");
/** 选区包裹断言：s.slice(from,to) 前后加标记（默认 **） */
const wrapSel = (s, from, to, mark = "**") => s.slice(0, from) + mark + s.slice(from, to) + mark + s.slice(to);

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
	// G1 v0.5.0 注：富文本粘贴转 Markdown 会截胡带格式增益的 html 粘贴——本场景的
	// 目标是「官方富文本管线的 DOM 形态渲染」，改为 ops 内先按 Ctrl+Shift+V（手势
	// 窗口内走原生官方富文本解析）再 pasteClip，保持原语义；转换路径本身在 V8-V11。
	{
		name: "G1-paste-html", group: "G", channel: "bi-text", focus: "富文本 DOM（手势走原生）", text: () => "",
		ops: [
			{ type: "key", key: "v", ctrl: true, shift: true },
			{ type: "pasteClip", text: "加粗行\ndiv 行内容\n第二 div\nstrong 行", html: "<b>加粗行</b><div>div 行内容</div><div>第二 div</div><strong>strong 行</strong>" },
		],
	},
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
		name: "R3-attach-menu", group: "R", focus: "附件在场 @ 候选菜单贴输入框（v0.2.6 回归；skipOn 8124——0.1.5 的 input-trigger 无法以 trusted 事件触发，仅 020 真测；光标行首——官方 @ 触发要求前邻空白/行首，标点后不弹）",
		skipOn: ["8124"],
		channel: "bi-text", text: () => plainLines(3, "\n"),
		ops: [
			{ type: "attachImage" },
			{ type: "caret", off: 0 },
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
		name: "R8-toolbar-outside-card", group: "R", focus: "卡外工具栏位置/等宽 + 长文滚动输入区固定（v0.2.14 回归）",
		channel: "bi-text", text: () => plainLines(200, "\n"),
		ops: [{ type: "scrollToolbar", amount: 900 }, { type: "toolbarClear" }],
	},
	{
		name: "R9-empty-state", group: "R", focus: "空文档基线（透明化关闭态）",
		channel: "bi-text", text: () => "",
	},

	// ===== S/W/X/D/U/P 六组（2026-10-24 扩充：日常操作的多样性覆盖）=====
	// 背景：用户报「打一串字→选中中间一段→Ctrl+B→后面的字消失」，62 场景矩阵没抓住
	// （唯一的 Q6 恰好全选/尾部，对选区时序竞争不敏感）。扩充原则：
	//   S = 同一目标（选中一段加粗）用用户所有可能的选择/按键方式各来一遍
	//   W = 格式快捷键的位置与形态变体（行中/行尾/跨行/嵌套/撤销…）
	//   X = 真实打字通道（CDP trusted——合成 beforeinput 逐字符实测只进 1 字，不可用）
	//   D = 删除的日常变体（选中删/替换删/删词/跨行合并）
	//   U = 撤销重做链（格式化后的恢复语义）
	//   P = 刷新多 p / 粘贴通道的格式化
	// 断言核心 = expectSrc 精确内容（一个字都不能丢）。

	// ===== S 选择方式 × Ctrl+B（全部选同一段 [10,20)，期望一字不丢） =====
	{
		name: "S1-mid-select-synthkey", group: "S", focus: "程序选区+合成键（用户 bug 主靶：选区后 4 字消失）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "key", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "S2-mid-select-trustedkey", group: "S", focus: "程序选区+trusted 键",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "S3-mouse-drag-trustedkey", group: "S", focus: "真实鼠标拖选+trusted 键",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "mouseSelect", from: 10, to: 20 },
			{ type: "expectSel", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "S4-mouse-drag-synthkey", group: "S", focus: "真实鼠标拖选+合成键",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "mouseSelect", from: 10, to: 20 },
			{ type: "key", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "S5-shiftarrow-extend", group: "S", focus: "Shift+方向键扩选（trusted）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "caret", off: 10 },
			{ type: "cdpKey", key: "ArrowRight", shift: true, hold: 30 },
			{ type: "cdpKey", key: "ArrowRight", shift: true, hold: 30 },
			{ type: "cdpKey", key: "ArrowRight", shift: true, hold: 30 },
			{ type: "cdpKey", key: "ArrowRight", shift: true, hold: 30 },
			{ type: "cdpKey", key: "ArrowRight", shift: true, hold: 30 },
			{ type: "expectSel", from: 10, to: 15 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 15) },
		],
	},
	{
		name: "S6-dblclick-word", group: "S", focus: "词级选择加粗（双击语义；CDP 双击在 headless 不触发原生词选择，用 selectWord 程序化词选择覆盖插件行为）",
		channel: "bi-text", text: () => "甲乙 hello world 丙丁 tail",
		ops: [
			{ type: "caret", off: 4 },
			{ type: "selectWord" },
			{ type: "expectSel", from: 3, to: 8 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "甲乙 **hello** world 丙丁 tail" },
		],
	},
	{
		name: "S7-shiftclick-extend", group: "S", focus: "程序锚点+Shift+点击扩选",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "caret", off: 10 },
			{ type: "shiftClick", at: 16 },
			{ type: "expectSel", from: 10, to: 16 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 16) },
		],
	},
	{
		name: "S8-selectall-bold", group: "S", focus: "Ctrl+A 全选加粗",
		channel: "bi-text", text: () => CJK20,
		ops: [
			{ type: "key", key: "a", ctrl: true },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "**" + CJK20 + "**" },
		],
	},
	{
		name: "S9-select-tail", group: "S", focus: "选结尾段（A5 形态）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 20, to: 30 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 20, 30) },
		],
	},
	{
		name: "S10-select-head", group: "S", focus: "选开头段（A6 形态）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 0, to: 10 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 0, 10) },
		],
	},
	{
		name: "S11-selectline-bold", group: "S", focus: "行选择加粗（多行文本选一行）",
		channel: "bi-lines", text: () => THREE_LINES,
		ops: [
			{ type: "caretRatio", ratio: 0.05 },
			{ type: "selectLine" },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "**" + THREE_LINES.split("\n")[0] + "**" + "\n" + THREE_LINES.split("\n").slice(1).join("\n") },
		],
	},
	{
		name: "S12-para-select-bold", group: "S", focus: "段落级选择加粗（三击选段语义；CDP 三击在 headless 不触发原生段选择，用程序化选段覆盖——三击本体入 L2 手工清单）",
		channel: "bi-text", refresh: true, text: () => CJK20 + "\n第二行内容",
		ops: [
			{ type: "selectRange", from: 0, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "**" + CJK20 + "**\n第二行内容" },
		],
	},
	{
		name: "S13-stress-mid-bold", group: "S", focus: "时序压力：选中间加粗 ×12（rAF/setTimeout 竞争探测器）",
		channel: "bi-text", text: () => "",
		ops: [{ type: "stressWrap", text: CJK30, from: 10, to: 20, key: "b", mark: "**", rounds: 12 }],
	},
	{
		name: "S14-stress-linetail", group: "S", focus: "时序压力：行尾边界加粗 ×8",
		channel: "bi-text", text: () => "",
		ops: [{ type: "stressWrap", text: THREE_LINES, from: 4, to: 8, key: "b", mark: "**", rounds: 8 }],
	},
	{
		name: "S15-stress-crossline", group: "S", focus: "时序压力：跨行选区加粗 ×8",
		channel: "bi-text", text: () => "",
		ops: [{ type: "stressWrap", text: THREE_LINES, from: 4, to: 14, key: "b", mark: "**", rounds: 8 }],
	},
	{
		name: "W21-stress-italic", group: "W", focus: "时序压力：选中间斜体 ×8",
		channel: "bi-text", text: () => "",
		ops: [{ type: "stressWrap", text: CJK30, from: 10, to: 20, key: "i", mark: "*", rounds: 8 }],
	},

	// ===== W 格式快捷键形态变体 =====
	{
		name: "W1-bold-crossline-br", group: "W", focus: "跨行选区加粗（br 形态）",
		channel: "bi-lines", text: () => THREE_LINES,
		ops: [
			{ type: "selectRange", from: 4, to: 14 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(THREE_LINES_PROJ, 4, 14) },
		],
	},
	{
		name: "W2-bold-crossline-literalnl", group: "W", focus: "跨行选区加粗（字面 \\n 形态——C1 靶）",
		channel: "bi-text", text: () => THREE_LINES,
		ops: [
			{ type: "selectRange", from: 4, to: 14 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(THREE_LINES_PROJ, 4, 14) },
		],
	},
	{
		name: "W3-bold-linetail-boundary", group: "W", focus: "选区终点恰在行尾（B5 靶：丢 \\n+下 行首）",
		channel: "bi-lines", text: () => THREE_LINES,
		ops: [
			{ type: "selectRange", from: 4, to: 8 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(THREE_LINES_PROJ, 4, 8) },
		],
	},
	{
		name: "W4-bold-linetail-boundary-literal", group: "W", focus: "行尾边界（字面 \\n 形态）",
		channel: "bi-text", text: () => THREE_LINES,
		ops: [
			{ type: "selectRange", from: 4, to: 8 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(THREE_LINES_PROJ, 4, 8) },
		],
	},
	{
		name: "W5-caretstate-bold-type", group: "W", focus: "光标态 Ctrl+B 插空标记+打字",
		channel: "bi-text", text: () => CJK20,
		ops: [
			{ type: "caret", off: 10 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: CJK20.slice(0, 10) + "****" + CJK20.slice(10) },
			{ type: "type", text: "重点" },
			{ type: "expectSrc", expect: CJK20.slice(0, 10) + "**重点**" + CJK20.slice(10) },
		],
	},
	{
		name: "W6-bold-then-type-tail", group: "W", focus: "加粗后光标落段尾、续打追加（不再选中整段防误替换）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
			{ type: "type", text: "尾注" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + "**" + CJK30.slice(10, 20) + "**尾注" + CJK30.slice(20) },
		],
	},
	{
		name: "W7-two-segments", group: "W", focus: "连续两段加粗（第二段 offset 修正 +4）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 15 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 15) },
			{ type: "selectRange", from: 24, to: 29 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(wrapSel(CJK30, 10, 15), 24, 29) },
		],
	},
	{
		name: "W8-nested-bold", group: "W", focus: "已有 bold 段再选整段再包（嵌套语义=现状）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "selectRange", from: 10, to: 24 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + "****" + CJK30.slice(10, 20) + "****" + CJK30.slice(20) },
		],
	},
	{
		name: "W9-italic-mid", group: "W", focus: "Ctrl+I 选中间",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "i", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20, "*") },
		],
	},
	{
		name: "W10-code-mid", group: "W", focus: "Ctrl+E 行内码选中间",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "e", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20, "`") },
		],
	},
	{
		name: "W11-bold-then-italic", group: "W", focus: "B 后同段再 I（链式格式）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "selectRange", from: 10, to: 24 },
			{ type: "cdpKey", key: "i", ctrl: true },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + "***" + CJK30.slice(10, 20) + "***" + CJK30.slice(20) },
		],
	},
	{
		name: "W12-select-marks", group: "W", focus: "选区含 ** 标记字符加粗（字符保全）",
		channel: "bi-text", text: () => "甲乙**丙丁**戊己",
		ops: [
			{ type: "selectRange", from: 2, to: 8 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "甲乙" + "****丙丁****" + "戊己" },
		],
	},
	{
		name: "W13-select-emoji", group: "W", focus: "选区含 emoji（代理对 offset）",
		channel: "bi-text", text: () => "甲🎉乙丙🎊丁",
		ops: [
			{ type: "selectRange", from: 1, to: 7 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "甲**🎉乙丙🎊**丁" },
		],
	},
	{
		name: "W14-selectall-italic", group: "W", focus: "全选 Ctrl+I",
		channel: "bi-text", text: () => CJK20,
		ops: [
			{ type: "key", key: "a", ctrl: true },
			{ type: "cdpKey", key: "i", ctrl: true },
			{ type: "expectSrc", expect: "*" + CJK20 + "*" },
		],
	},
	{
		name: "W15-selectall-code", group: "W", focus: "全选 Ctrl+E",
		channel: "bi-text", text: () => CJK20,
		ops: [
			{ type: "key", key: "a", ctrl: true },
			{ type: "cdpKey", key: "e", ctrl: true },
			{ type: "expectSrc", expect: "`" + CJK20 + "`" },
		],
	},
	{
		name: "W16-bold-in-list", group: "W", focus: "列表行内选中加粗",
		channel: "bi-text", text: () => "- 列表项目甲乙丙丁戊己庚辛",
		ops: [
			{ type: "selectRange", from: 4, to: 8 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "- 列表" + "**项目甲乙**" + "丙丁戊己庚辛" },
			{ type: "expectClass", selector: ".dsh-cl-lmark" },
		],
	},
	{
		name: "W17-bold-in-quote", group: "W", focus: "引用行内选中加粗",
		channel: "bi-text", text: () => "> 引用内容甲乙丙丁戊己庚辛",
		ops: [
			{ type: "selectRange", from: 4, to: 8 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "> 引用" + "**内容甲乙**" + "丙丁戊己庚辛" },
			{ type: "expectClass", selector: ".dsh-cl-qmark" },
		],
	},
	{
		name: "W18-bold-undo-restore", group: "W", focus: "加粗后 Ctrl+Z 一次恢复原文",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: CJK30 },
		],
	},
	{
		name: "W19-crossline-bold-undo", group: "W", focus: "跨行加粗（两端补标记=2 条撤销）后撤销恢复原文",
		channel: "bi-lines", text: () => THREE_LINES,
		ops: [
			{ type: "selectRange", from: 4, to: 14 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(THREE_LINES_PROJ, 4, 14) },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: THREE_LINES_PROJ },
		],
	},
	{
		name: "W20-typechars-channel", group: "W", focus: "typeChars 逐字符（execCommand）+选段加粗",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "typeChars", text: CJK20 },
			{ type: "expectSrc", expect: CJK20 },
			{ type: "selectRange", from: 5, to: 12 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK20, 5, 12) },
		],
	},

	// ===== X 真实打字通道（CDP trusted insertText）=====
	{
		name: "X1-cdptype-then-bold", group: "X", focus: "trusted 逐字打字+选中间加粗（用户流主场景）",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: CJK30, chars: true, interval: 15 },
			{ type: "expectSrc", expect: CJK30 },
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "X2-type-correct-bold", group: "X", focus: "打字→Backspace 改正→选段加粗（完整日常流）",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: "一二三四五六七八九十甲乙丙丁错戊己", chars: true, interval: 10 },
			{ type: "caret", off: 15 },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "cdpType", text: "对" },
			{ type: "expectSrc", expect: "一二三四五六七八九十甲乙丙丁对戊己" },
			{ type: "selectRange", from: 10, to: 15 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "一二三四五六七八九十**甲乙丙丁对**戊己" },
		],
	},
	{
		name: "X3-type-undo-redo", group: "X", focus: "打字后撤销/重做",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: CJK20 },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: "" },
			{ type: "cdpKey", key: "y", ctrl: true },
			{ type: "expectSrc", expect: CJK20 },
		],
	},
	{
		name: "X4-type-multiline-crossline", group: "X", focus: "打字出多行+跨行选段加粗",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: THREE_LINES },
			{ type: "expectSrc", expect: THREE_LINES_PROJ },
			{ type: "selectRange", from: 4, to: 14 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(THREE_LINES_PROJ, 4, 14) },
		],
	},
	{
		name: "X5-type-selectall-replace", group: "X", focus: "打字+全选+打字替换",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: CJK20 },
			{ type: "key", key: "a", ctrl: true },
			{ type: "cdpType", text: "全部替换" },
			{ type: "expectSrc", expect: "全部替换" },
		],
	},
	{
		name: "X6-type-select-delete", group: "X", focus: "打字+选段 Backspace 删除",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: CJK30 },
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + CJK30.slice(20) },
		],
	},
	{
		name: "X7-type-select-typereplace", group: "X", focus: "打字+选段+打字替换",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: CJK30 },
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpType", text: "替换" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + "替换" + CJK30.slice(20) },
		],
	},
	{
		name: "X8-type-long-render", group: "X", focus: "trusted 打字 30 行（INV 全套）",
		channel: "bi-text", text: () => "",
		ops: [{ type: "cdpType", text: plainLines(30, "\n"), chars: true, interval: 5 }],
	},
	{
		name: "X9-type-emoji-mixed", group: "X", focus: "trusted 打字 emoji 混排+选段",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: "甲🎉乙丙🎊丁戊", chars: true, interval: 10 },
			{ type: "selectRange", from: 1, to: 7 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "甲**🎉乙丙🎊**丁戊" },
		],
	},
	{
		name: "X10-type-tab-bold", group: "X", focus: "打字+Tab 缩进+选段加粗",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "cdpType", text: "- 列表甲乙丙丁" },
			{ type: "caret", off: null },
			{ type: "enter", shift: true },
			{ type: "tab" },
			{ type: "cdpType", text: "子项内容" },
			{ type: "expectSrc", expect: "- 列表甲乙丙丁\n  - 子项内容" },
			{ type: "selectRange", from: 4, to: 8 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "- 列表**甲乙丙丁**\n  - 子项内容" },
		],
	},

	// ===== D 删除的日常变体 =====
	{
		name: "D1-select-backspace", group: "D", focus: "选中段 Backspace",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "backspace" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + CJK30.slice(20) },
		],
	},
	{
		name: "D2-select-deletekey", group: "D", focus: "选中段 Delete 前向删（trusted）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "Delete" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + CJK30.slice(20) },
		],
	},
	{
		name: "D3-select-typereplace", group: "D", focus: "选中段打字替换（execCommand）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "type", text: "替换词" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + "替换词" + CJK30.slice(20) },
		],
	},
	{
		name: "D4-ctrlbackspace-word", group: "D", focus: "光标处 Ctrl+Backspace 删词（trusted）",
		channel: "bi-text", text: () => "甲乙 hello world 丙丁",
		ops: [
			{ type: "caret", off: 14 },
			{ type: "cdpKey", key: "Backspace", ctrl: true },
			{ type: "expectSrc", expect: "甲乙 hello  丙丁" },
		],
	},
	{
		name: "D5-linestart-backspace-merge", group: "D", focus: "行首 Backspace 跨行合并（br 删除路径）",
		channel: "bi-lines", text: () => THREE_LINES,
		ops: [
			{ type: "caret", off: 9 },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectSrc", expect: THREE_LINES_PROJ.slice(0, 8) + THREE_LINES_PROJ.slice(9) },
		],
	},
	{
		name: "D6-linetail-delete-forward", group: "D", focus: "行尾 Delete 前向合并下一行",
		channel: "bi-lines", text: () => THREE_LINES,
		ops: [
			{ type: "caret", off: 8 },
			{ type: "cdpKey", key: "Delete" },
			{ type: "expectSrc", expect: THREE_LINES_PROJ.slice(0, 8) + THREE_LINES_PROJ.slice(9) },
		],
	},
	{
		name: "D7-selectall-backspace", group: "D", focus: "全选 Backspace 清空",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "key", key: "a", ctrl: true },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectSrc", expect: "" },
		],
	},
	{
		name: "D8-bold-then-delete", group: "D", focus: "加粗后选中删除（格式化+删除组合）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "selectRange", from: 12, to: 22 },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20).slice(0, 12) + wrapSel(CJK30, 10, 20).slice(22) },
		],
	},
	{
		name: "D9-select-delete-then-paste", group: "D", focus: "选中段删除后光标处粘贴",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + CJK30.slice(20) },
			{ type: "cdpType", text: "粘入" },
			{ type: "expectSrc", expect: CJK30.slice(0, 10) + "粘入" + CJK30.slice(20) },
		],
	},

	// ===== U 撤销重做链 =====
	{
		name: "U1-bold-undo", group: "U", focus: "加粗→Z→原文（W18 的 U 视角+多次操作）",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: CJK30 },
		],
	},
	{
		name: "U2-bold-undo-redo", group: "U", focus: "加粗→Z→Y→格式化文本",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "cdpKey", key: "y", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "U3-two-bold-double-undo", group: "U", focus: "两段加粗→Z×2→原文",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 0, to: 5 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "selectRange", from: 25, to: 30 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: CJK30 },
		],
	},
	{
		name: "U4-type-undo-step", group: "U", focus: "打字→Z→少一段（撤销单元粒度）",
		channel: "bi-text", text: () => "起始文本",
		ops: [
			{ type: "caret", off: null },
			{ type: "type", text: "追加甲" },
			{ type: "type", text: "追加乙" },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: "起始文本追加甲" },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: "起始文本" },
		],
	},
	{
		name: "U5-bold-type-undo-chain", group: "U", focus: "加粗+打字→Z×2 逐步回退",
		channel: "bi-text", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "caret", off: null },
			{ type: "type", text: "尾巴" },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "U6-tab-undo", group: "U", focus: "Tab 缩进→Z 恢复",
		channel: "bi-text", text: () => "- 列表项",
		ops: [
			{ type: "caret", off: null },
			{ type: "enter", shift: true },
			{ type: "tab" },
			{ type: "expectSrc", expect: "- 列表项\n  - " },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: "- 列表项\n- " },
		],
	},
	{
		name: "U7-crossline-bold-undo-verify", group: "U", focus: "跨行加粗（两端补标记=2 条撤销）→Z×2 恢复原文",
		channel: "bi-text", text: () => THREE_LINES,
		ops: [
			{ type: "selectRange", from: 4, to: 14 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(THREE_LINES_PROJ, 4, 14) },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "cdpKey", key: "z", ctrl: true },
			{ type: "expectSrc", expect: THREE_LINES_PROJ },
		],
	},

	// ===== P 刷新多 p / 粘贴通道的格式化 =====
	{
		name: "P1-refresh-select-bold", group: "P", focus: "刷新恢复多 p 后选段加粗",
		channel: "bi-text", refresh: true, text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "P2-refresh-mouseselect-bold", group: "P", focus: "刷新多 p+真实鼠标选段加粗",
		channel: "bi-text", refresh: true, text: () => CJK30,
		ops: [
			{ type: "mouseSelect", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "P3-refresh-crosspara-bold", group: "P", focus: "刷新多 p+跨段落选区加粗（tail 落在段内 offset 25=四/五之间）",
		channel: "bi-text", refresh: true, text: () => CJK20 + "\n" + CJK20,
		ops: [
			{ type: "selectRange", from: 15, to: 25 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: CJK20.slice(0, 15) + "**" + CJK20.slice(15) + "\n" + CJK20.slice(0, 4) + "**" + CJK20.slice(4) },
		],
	},
	{
		name: "P4-paste-then-bold", group: "P", focus: "粘贴通道注入+选段加粗（期望字符串化——函数 expect 经 JSON 序列化会丢失）",
		channel: "paste-plain", text: () => CJK30,
		ops: [
			{ type: "selectRange", from: 10, to: 20 },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: wrapSel(CJK30, 10, 20) },
		],
	},
	{
		name: "P5-selectall-multiline-bold", group: "P", focus: "多行全选加粗（跨行两端补标记路径；富文本内 offset 选区/格式化换算与 paste 后编辑时序另案——G1 已覆盖富文本渲染）",
		channel: "bi-text", text: () => THREE_LINES,
		ops: [
			{ type: "key", key: "a", ctrl: true },
			{ type: "cdpKey", key: "b", ctrl: true },
			{ type: "expectSrc", expect: "**" + THREE_LINES_PROJ + "**" },
		],
	},
	// ===== V 组（2026-11-08 v0.2.18）：引用行多行粘贴续前缀 + 粘贴 MD 渲染固化 =====
	// pasteClip 走真实 Ctrl+V 同事件管线（先过插件 paste handler 再落官方）。
	// 语义：第一行接光标处并入当前段落（原样），第二行起补 "> "；空行补裸 ">"；
	// 已是引用块/单行/普通行光标 → 不处理（放行官方原样插入）。
	{
		name: "V1-quote-paste-multiline", group: "V", focus: "核心：引用行粘贴 3 行续前缀",
		channel: "bi-text", text: () => "> 引用起始行",
		ops: [
			{ type: "pasteClip", text: "第一段\n第二行\n第三行" },
			{ type: "expectSrc", expect: "> 引用起始行第一段\n> 第二行\n> 第三行" },
		],
	},
	{
		name: "V2-quote-paste-already-quoted", group: "V", focus: "粘贴内容本身是引用块 → 原样（防双重前缀）",
		channel: "bi-text", text: () => "> 引用起始行",
		ops: [
			{ type: "pasteClip", text: "> 甲\n> 乙" },
			{ type: "expectSrc", expect: "> 引用起始行> 甲\n> 乙" },
		],
	},
	{
		name: "V3-plain-paste-no-quote", group: "V", focus: "普通行光标粘贴多行 → 不加前缀（不误伤回归）",
		channel: "bi-text", text: () => "普通段落",
		ops: [
			{ type: "pasteClip", text: "甲\n乙" },
			{ type: "expectSrc", expect: "普通段落甲\n乙" },
		],
	},
	{
		name: "V4-quote-paste-single-line", group: "V", focus: "单行粘贴 → 原样（接当前行后）",
		channel: "bi-text", text: () => "> 引用起始行",
		ops: [
			{ type: "pasteClip", text: "单行文本" },
			{ type: "expectSrc", expect: "> 引用起始行单行文本" },
		],
	},
	{
		name: "V5-quote-paste-blank-middle", group: "V", focus: "粘贴含空行 → 空行补裸 >（保持引用块连续）",
		channel: "bi-text", text: () => "> 引用起始行",
		ops: [
			{ type: "pasteClip", text: "上行\n\n下行" },
			{ type: "expectSrc", expect: "> 引用起始行上行\n>\n> 下行" },
		],
	},
	{
		name: "V6-quote-paste-render", group: "V", focus: "渲染层验证：粘贴后引用标记 ≥3（原行+新 2 行；第一段并入原行不新增标记）",
		channel: "bi-text", text: () => "> 引用起始行",
		ops: [
			{ type: "pasteClip", text: "第一段\n第二行\n第三行" },
			{ type: "expectSrc", expect: "> 引用起始行第一段\n> 第二行\n> 第三行" },
			{ type: "snapshotClass", selector: ".dsh-cl-qmark", min: 3 },
		],
	},
	{
		name: "V7-paste-md-suite", group: "V", focus: "功能 2 固化：粘贴 MD 全家桶全部渲染（标题/粗斜/行内码/链接/代码块/引用/列表/任务/表格）",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: MD_SUITE },
			{ type: "expectClass", selector: ".dsh-cl-heading" },
			{ type: "expectClass", selector: ".dsh-cl-strong" },
			{ type: "expectClass", selector: ".dsh-cl-em" },
			{ type: "expectClass", selector: ".dsh-cl-cd" },
			{ type: "expectClass", selector: ".dsh-cl-lk" },
			{ type: "expectClass", selector: ".dsh-cl-lang" },
			{ type: "expectClass", selector: ".dsh-cl-qbg" },
			{ type: "expectClass", selector: ".dsh-cl-lmark" },
			{ type: "expectClass", selector: ".dsh-cl-task" },
			{ type: "expectClass", selector: ".dsh-cl-tmark" },
		],
	},

	// ===== V8-V11 富文本粘贴转 Markdown（2026-11-22 任务④）=====
	{
		name: "V8-rich-convert", group: "V", focus: "text/html 粘贴→转换为 Markdown 源码（粗体/斜体/行内码/链接/列表/代码块）",
		channel: "bi-text", text: () => "",
		ops: [
			{
				type: "pasteClip", text: "粗体 与 斜体 与 x=1\n第一项\n第二项",
				html: "<p><b>粗体</b> 与 <i>斜体</i> 与 <code>x=1</code></p><ul><li>第一项</li><li>第二项</li></ul>",
			},
			{ type: "expectSrc", expect: "**粗体** 与 *斜体* 与 `x=1`\n\n- 第一项\n- 第二项" },
			{ type: "expectClass", selector: ".dsh-cl-strong" },
			{ type: "expectClass", selector: ".dsh-cl-lmark" },
		],
	},
	{
		name: "V9-rich-plain-gesture", group: "V", focus: "Ctrl+Shift+V 手势窗口内的粘贴走原生（纯文本落入，不转换）",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "key", key: "v", ctrl: true, shift: true },
			{
				type: "pasteClip", text: "粗体 与 斜体",
				html: "<p><b>粗体</b> 与 <i>斜体</i></p>",
			},
			{ type: "expectSrc", expect: "粗体 与 斜体" },
		],
	},
	{
		name: "V10-rich-no-gain", group: "V", focus: "html 与纯文本无增益（普通段落）→ 原生不转换",
		channel: "bi-text", text: () => "",
		ops: [
			{
				type: "pasteClip", text: "普通段落没有格式增益",
				html: "<p>普通段落没有格式增益</p>",
			},
			{ type: "expectSrc", expect: "普通段落没有格式增益" },
		],
	},
	{
		name: "V11-rich-word-junk", group: "V", focus: "Word 风格 HTML（MsoNormal/o:p 垃圾标签）→ 干净 Markdown",
		channel: "bi-text", text: () => "",
		ops: [
			{
				type: "pasteClip", text: "Word 标题\nWord 正文粗体部分",
				html: '<h2><span>Word 标题</span></h2><p class=MsoNormal><b>Word 正文</b>粗体部分<o:p></o:p></p>',
			},
			{ type: "expectSrc", expect: "## Word 标题\n\n**Word 正文**粗体部分" },
		],
	},

	// ===== Y 行级差量渲染（v0.4.0 新增）=====
	// 背景：渲染层从「每键全量 innerHTML 重建」改为「行容器定位 + 行级差量替换 +
	// 测量缓存 x/y 拆分验证与 dy 重定基」。五场景各钉一个新机制的靶：
	//   Y1 = 打字致折行数变化 → 下游整段 y 平移（dy 重定基 + 容器定位专项）
	//   Y2 = 行数增减交替 → 行容器槽位收缩与 DOM 序对齐
	//   Y3 = 重复行文档改一行 → 按行号索引缓存（旧文本 Map 会互相顶替全量重测）
	//   Y4 = 已闭合代码块内打字 → 背景层签名 + 等宽整框（anyCode 位）
	//   Y5 = 大文档光标全扫 → editSet 翻转只重写新旧两行
	{
		name: "Y1-shift-typing", group: "Y", focus: "行中连打致折行变化（dy 重定基+容器定位）",
		channel: "bi-text", text: () => plainLines(120, "\n"),
		ops: [
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "cdpType", text: "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Y2-row-shrink-stress", group: "Y", focus: "Enter/Backspace 交替（行容器收缩+DOM 序）",
		channel: "bi-lines", text: () => plainLines(12, "\n"),
		ops: (function () {
			const ops = [{ type: "caretRatio", ratio: 0.5 }];
			for (let i = 0; i < 10; i++) ops.push({ type: "cdpKey", key: "Enter" }, { type: "cdpKey", key: "Backspace" });
			ops.push({ type: "cdpKey", key: "Enter" }, { type: "cdpType", text: "新行内容" }, { type: "expectRows" });
			return ops;
		})(),
	},
	{
		name: "Y3-duplicate-lines", group: "Y", focus: "重复行文档改一行（按行号索引缓存）",
		channel: "bi-lines", text: () => Array.from({ length: 30 }, () => "完全相同的重复行内容，验证按行号索引。").join("\n"),
		ops: [
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "cdpType", text: "差异字符" },
			{ type: "expectRows" },
		],
	},
	{
		name: "Y4-bigdoc-codeblock", group: "Y", focus: "闭合代码块内打字（背景签名+等宽位）",
		channel: "bi-lines",
		text: () => {
			const pre = Array.from({ length: 40 }, (_, i) => "普通行 " + i + "：前置内容").join("\n");
			const code = ["```js", "function hello() {", "  const greeting = 'world';", "  return greeting;", "}", "```"].join("\n");
			const post = Array.from({ length: 40 }, (_, i) => "普通行 " + i + "：后置内容").join("\n");
			return pre + "\n" + code + "\n" + post;
		},
		ops: [
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "cdpType", text: " // 块内续写注释内容", chars: true },
			{ type: "expectClass", selector: ".dsh-cl-bg" },
			{ type: "expectRows" },
		],
	},
	{
		name: "Y5-focus-walk-bigdoc", group: "Y", focus: "50 行文档光标全扫（editSet 翻转差量）",
		channel: "bi-text", text: () => plainLines(50, "\n"),
		ops: [{ type: "caretSweep", n: 50 }, { type: "expectRows" }],
	},

	// ===== Z 粘贴后编辑组合（2026-11-20 用户报障复现：v0.4.0 行级差量疑似缺陷）=====
	// 用户三症状：①大段粘贴后换行输入格式错位；②code block 内粘贴纯文本再
	// Shift+Enter 续写格式错误；③连续粘贴大段显示错误。V 组只测「粘贴后立即
	// 渲染」，未覆盖「粘贴之后的后续编辑」——差量缓存在这两个动作的组合下
	// 才暴露。Z 组钉住组合；随后按用户要求扩成「粘贴方式×内容格式×长度」矩阵。
	{
		name: "Z1-paste-big-then-break-type", group: "Z", focus: "复现①：大段粘贴→行中换行→续打",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: plainLines(80, "\n") },
			{ type: "caretRatio", ratio: 0.4 },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "换行后新内容", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z2-paste-into-codeblock-break-type", group: "Z", focus: "复现②：块内粘贴纯文本→Shift+Enter→续打",
		channel: "bi-lines",
		text: () => "前置说明\n```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n后置说明",
		ops: [
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "pasteClip", text: "粘贴纯文本第一行\n第二行内容\n第三行尾巴" },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "块内续写", chars: true },
			{ type: "expectClass", selector: ".dsh-cl-bg" },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z3-paste-twice-big", group: "Z", focus: "复现③：连续两次大段粘贴",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: plainLines(60, "\n") },
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "pasteClip", text: plainLines(40, "\r\n") },
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "cdpType", text: "尾缀内容", chars: true },
			{ type: "expectRows" },
		],
	},

	// ===== Z 变体轰击（2026-11-20 二轮：Z1-Z3 未复现，扩大贴近用户描述的组合）=====
	{
		name: "Z4-paste-md-big-then-break", group: "Z", focus: "含 Markdown 标记的大段粘贴→换行续打",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: mdLines(48) },
			{ type: "caretRatio", ratio: 0.45 },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "续写中文内容", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z5-paste-big-into-codeblock", group: "Z", focus: "闭合块内粘贴大段（块行数暴增）→换行续打",
		channel: "bi-lines",
		text: () => "```js\nconst a = 1;\n```",
		ops: [
			{ type: "caret", off: 14 },
			{ type: "pasteClip", text: plainLines(40, "\n") },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "块内续写", chars: true },
			{ type: "expectClass", selector: ".dsh-cl-bg" },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z6-paste-backtoback", group: "Z", focus: "无间隔连续双粘（Lexical 异步 commit 窗口）",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: plainLines(50, "\n") },
			{ type: "pasteClip", text: plainLines(30, "\n") },
			{ type: "cdpType", text: "尾", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z7-paste-big-edit-linestart", group: "Z", focus: "大段粘贴→行首编辑",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: plainLines(60, "\n") },
			{ type: "caretRatio", ratio: 0.35 },
			{ type: "cdpType", text: "行首插入", chars: true },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "cdpType", text: "改", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z8-paste-crlf-break-type", group: "Z", focus: "CRLF 大段粘贴→换行续打",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: plainLines(60, "\r\n") },
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "换行内容", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z9-paste-big-esc-type", group: "Z", focus: "大段粘贴→Esc 分发→续打",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: plainLines(50, "\n") },
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "cdpKey", key: "Escape" },
			{ type: "cdpType", text: "继续打字", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z10-paste-selectall-replace", group: "Z", focus: "大段粘贴→全选→再粘贴替换",
		channel: "bi-text", text: () => "原有草稿内容\n第二行",
		ops: [
			{ type: "pasteClip", text: plainLines(40, "\n") },
			{ type: "key", key: "a", ctrl: true },
			{ type: "pasteClip", text: mdLines(20) },
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "cdpType", text: "替换后打字", chars: true },
			{ type: "expectRows" },
		],
	},

	// ===== Z 富文本粘贴（2026-11-20 三轮：真实复制带 text/html，Lexical 走多 p 富文本解析）=====
	{
		name: "Z11-pastehtml-break-type", group: "Z", focus: "富文本粘贴（text/html 多 p）→行中换行续打",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: mdLines(30), html: mdHtml(30) },
			{ type: "caretRatio", ratio: 0.4 },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "富文本后换行续打", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z12-pastehtml-big-multiedit", group: "Z", focus: "富文本大段粘贴→多轮编辑",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: mdLines(50), html: mdHtml(50) },
			{ type: "caretRatio", ratio: 0.3 },
			{ type: "cdpType", text: "前部编辑", chars: true },
			{ type: "caretRatio", ratio: 0.7 },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "后部换行续打", chars: true },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z13-paste-mixed-plain-html", group: "Z", focus: "纯文本与富文本交替粘贴→编辑",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: plainLines(30, "\n") },
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "pasteClip", text: mdLines(20), html: mdHtml(20) },
			{ type: "caretRatio", ratio: 0.4 },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "混合后打字", chars: true },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z14-pastehtml-into-codeblock", group: "Z", focus: "富文本粘贴进闭合块→Shift+Enter 续打",
		channel: "bi-lines",
		text: () => "```js\nconst a = 1;\nconst b = 2;\n```",
		ops: [
			{ type: "caretRatio", ratio: 0.5 },
			{ type: "pasteClip", text: mdLines(20), html: mdHtml(20) },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "块内续打", chars: true },
			{ type: "expectRows" },
		],
	},

	// ===== Z 用户截图定向（2026-11-20 四轮：图 4→5 = 粘贴闭合块后 Backspace 删围栏 → 错乱）=====
	// 粘贴含闭合代码块的内容后光标在文档尾——第一次 Backspace 恰好删掉闭合围栏的
	// 最后一个反引号（``` → ``）→ 块状态「闭合→未闭合」翻转（inCode/anyCode 全变）。
	{
		name: "Z15-paste-codeblock-backspace-fence", group: "Z", focus: "复现⑤：粘贴闭合块→Backspace 删围栏末字符（状态翻转）",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: "说明文字开头\n```js\nconst value = compute(42);\nfunction hello() { return 'world'; }\nconst rows = Array.from(list).map(fn);\n```\n结尾说明" },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectRows" },
		],
	},
	{
		name: "Z16-paste-codeblock-backspace-type", group: "Z", focus: "复现⑤+续打：删围栏后继续编辑",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: "```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```" },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "cdpType", text: "续打内容", chars: true },
			{ type: "cdpKey", key: "Enter", shift: true },
			{ type: "cdpType", text: "more text here", chars: true },
			{ type: "expectRows" },
		],
	},

	// Z17：用户截图实形——超长单行代码（软折十几个视觉行）+ 块状态翻转
	{
		name: "Z17-paste-longline-codeblock-backspace", group: "Z", focus: "复现⑤实形：超长单行代码块→Backspace 删围栏",
		channel: "bi-text", text: () => "",
		ops: [
			{ type: "pasteClip", text: "复制以下整段：\n```js\ncopy(JSON.stringify((function(){var ov=document.querySelector('.dsh-cl-live');if(!ov)return{err:'no-ov'};var input=document.querySelector('[data-composer-input]');return{dbg:window.__dshClDebug(),pCount:input.querySelectorAll(':scope > p').length,rows:Array.from(ov.querySelectorAll('.dsh-cl-row')).map(function(r){return{li:r.dataset.li,x:r.style.left,y:r.style.top,segs:Array.from(r.querySelectorAll('.dsh-cl-c')).map(function(s){return s.className.replace('dsh-cl-c','').trim()+'='+s.textContent}).join('|').slice(0,90)}}),bg:Array.from(ov.querySelectorAll('.dsh-cl-bglayer > *')).map(function(b){return b.className+'@'+b.style.top+'/'+b.style.height})};})(),null,1))\n```" },
			{ type: "cdpKey", key: "Backspace" },
			{ type: "expectRows" },
		],
	},

	// ===== F 选区浮动条开关（2026-11-21 用户拍板：默认关闭、工具栏开关控制）=====
	// 覆盖链路：clickBtn 开启（ensure 幂等）→ 插件 handler「开启瞬间若有选区主动刷一次
	// updateFloat」→ 浮条显示——不依赖 selectionchange（程序化 addRange 不触发它，浏览器
	// 设计），因此无需 CDP 鼠标拖选：8124/020 环境 auto-memory 3.3 的记忆条目层常驻浮在
	// 编辑器左上方（pointer-events 命中它），trusted 拖选会选中记忆条目而非草稿文字。
	{
		name: "F1-floatbar-default-off", group: "F", focus: "默认关闭：有选区浮条也不出现",
		channel: "bi-lines", text: () => "第一行是引子\n第二行浮动条开关验证\n第三行收尾",
		ops: [
			{ type: "setPrefs", floatBar: false },
			{ type: "selectRange", from: 9, to: 13 },
			{ type: "expectAbsent", selector: ".dsh-cl-float-on" },
			{ type: "snapshotClass", selector: '[data-cl="floatbar"]:not(.dsh-cl-active)', min: 1 },
		],
	},
	{
		name: "F2-floatbar-enable-show", group: "F", focus: "点开关开启→已有选区浮条立即浮现、按钮高亮",
		channel: "bi-lines", text: () => "第一行是引子\n第二行浮动条开关验证\n第三行收尾",
		ops: [
			{ type: "clickBtn", selector: '[data-cl="floatbar"]', ensure: "off" },
			{ type: "selectRange", from: 9, to: 13 },
			{ type: "clickBtn", selector: '[data-cl="floatbar"]', ensure: "on" },
			{ type: "snapshotClass", selector: ".dsh-cl-float-on", min: 1 },
			{ type: "snapshotClass", selector: '[data-cl="floatbar"].dsh-cl-active', min: 1 },
		],
	},
	{
		name: "F3-floatbar-disable-hide", group: "F", focus: "再点关闭→选区还在浮条收起（收尾复位默认关）",
		channel: "bi-lines", text: () => "第一行是引子\n第二行浮动条开关验证\n第三行收尾",
		ops: [
			{ type: "clickBtn", selector: '[data-cl="floatbar"]', ensure: "on" },
			{ type: "selectRange", from: 9, to: 13 },
			{ type: "clickBtn", selector: '[data-cl="floatbar"]', ensure: "off" },
			{ type: "expectAbsent", selector: ".dsh-cl-float-on" },
			{ type: "snapshotClass", selector: '[data-cl="floatbar"]:not(.dsh-cl-active)', min: 1 },
			{ type: "setPrefs", floatBar: false },
		],
	},

	// ===== F4-F6 源码模式开关（2026-11-22 任务③：全文显示标记的官方原样形态）=====
	{
		name: "F4-srcmode-default-off", group: "F", focus: "默认渲染态：透明化在、渲染字符在、开关未激活",
		channel: "bi-lines", text: () => "第一行是引子\n第二行 **源码开关** 验证\n第三行收尾",
		ops: [
			{ type: "setPrefs", sourceMode: false },
			{ type: "wait", ms: 400 },
			{ type: "snapshotClass", selector: '[data-composer-input].dsh-cl-host', min: 1 },
			{ type: "expectClass", selector: ".dsh-cl-c" },
			{ type: "snapshotClass", selector: '[data-cl="srcmode"]:not(.dsh-cl-active)', min: 1 },
		],
	},
	{
		name: "F5-srcmode-enable-official", group: "F", focus: "开→摘透明化回官方原样、overlay 清空、按钮高亮",
		channel: "bi-lines", text: () => "第一行是引子\n第二行 **源码开关** 验证\n第三行收尾",
		ops: [
			{ type: "clickBtn", selector: '[data-cl="srcmode"]', ensure: "on" },
			{ type: "wait", ms: 400 },
			{ type: "expectAbsent", selector: '[data-composer-input].dsh-cl-host' },
			{ type: "expectAbsent", selector: ".dsh-cl-live .dsh-cl-c" },
			{ type: "snapshotClass", selector: '[data-cl="srcmode"].dsh-cl-active', min: 1 },
			{ type: "type", text: "源" },
			{ type: "wait", ms: 400 },
			{ type: "expectAbsent", selector: '[data-composer-input].dsh-cl-host' },
			// 收尾恢复渲染态（不变量检查需要渲染覆盖；稳态断言已完成）
			{ type: "clickBtn", selector: '[data-cl="srcmode"]', ensure: "off" },
			{ type: "wait", ms: 500 },
			{ type: "setPrefs", sourceMode: false },
		],
	},
	{
		name: "F6-srcmode-disable-restore", group: "F", focus: "关→恢复实时渲染（透明化+渲染字符回来），收尾复位默认关",
		channel: "bi-lines", text: () => "第一行是引子\n第二行 **源码开关** 验证\n第三行收尾",
		ops: [
			{ type: "clickBtn", selector: '[data-cl="srcmode"]', ensure: "on" },
			{ type: "wait", ms: 300 },
			{ type: "clickBtn", selector: '[data-cl="srcmode"]', ensure: "off" },
			{ type: "wait", ms: 500 },
			{ type: "snapshotClass", selector: '[data-composer-input].dsh-cl-host', min: 1 },
			{ type: "expectClass", selector: ".dsh-cl-c" },
			{ type: "snapshotClass", selector: '[data-cl="srcmode"]:not(.dsh-cl-active)', min: 1 },
			{ type: "setPrefs", sourceMode: false },
		],
	},

	// ===== N 渲染保险丝（2026-11-22 任务①：主链抛错→官方原样降级+防重抛）=====
	// 链路：breakRender 劫持 getBoundingClientRect（renderInner 签名段必经）→ 打字
	// 触发渲染 → 薄壳 catch → 摘透明化/清 overlay/设页面级降级标志 → 恢复劫持后再
	// 打字断言「不重试」（入口早退）。resetFuse 恢复常态供不变量检查。
	{
		name: "N1-render-fuse-degrade", group: "N", focus: "主链抛错→摘透明化回官方显示+降级标志；恢复后不重试",
		channel: "bi-lines", text: () => "保险丝验证第一行\n第二行内容在场\n第三行收尾",
		allowConsoleErr: true, // 注入的渲染失败会打设计内的 console.error 留痕（INV-8 场景级豁免）
		ops: [
			{ type: "breakRender" },
			{ type: "type", text: "续" },
			{ type: "expectFuse" },
			{ type: "restoreRender" },
			{ type: "type", text: "打" },
			{ type: "expectFuse", still: true },
			{ type: "resetFuse" },
		],
	},

	// ===== esc 标记转义（2026-11-22 任务⑤：\* \` 不触发格式）=====
	{
		name: "esc1-escaped-star-literal", group: "esc", focus: "\\* 与 \\` 字面化不触发格式；对照真斜体/真行内码正常渲染",
		channel: "bi-text", text: () => "\\*不是斜体\\* 对照 *真斜体* 与 \\`不是代码\\` 及 `真代码`",
		ops: [
			{ type: "wait", ms: 600 },
			{ type: "expectSrc", expect: "\\*不是斜体\\* 对照 *真斜体* 与 \\`不是代码\\` 及 `真代码`" },
			{ type: "expectClass", selector: ".dsh-cl-em" },
			{ type: "expectClass", selector: ".dsh-cl-mk" },
			{ type: "expectClass", selector: ".dsh-cl-cd" },
		],
	},
];
