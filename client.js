// dsh-composer-live — 浏览器端（client plugin bundle）。
//
// 手写 CJS + ModuleLoader 包装（零构建步骤，与 dsh-anthropic-style 相同形状）。
//
// 做什么（dsh 0.1.5-rc.2+ 的 Lexical contenteditable 输入框，仿 Open WebUI）：
//   1. markdown 实时渲染：加粗/斜体/行内代码/删除线/链接/图片胶囊 + 代码块
//      背景/围栏隐藏/语法高亮/语言标签 + 标题/引用/列表/表格块级视觉
//   2. 代码块体验：``` 行 Enter/Shift+Enter 自动补全「块内空行+闭合围栏+块后
//      空行」的封闭块（光标落块内）、块内 Tab 两空格缩进、块内最后行 ↓ 直接
//      跳出到块后普通行、整框等宽（含块期间）
//   3. 格式工具栏：常驻顶条（B/I/code/link/list/block + 展开）+ 选区浮动条
//   4. 70vh 展开写作区
//   5. 大段粘贴自动包代码块（>8 行且像代码；中文长文不误伤）
//   6. Esc 分发：候选菜单开→归官方；展开态→收起；生成中→停止生成
//   7. 明暗主题自适应、行级增量渲染 + rAF 合帧（observer 回调同样合帧）、
//      中文字体恒定
//
// 架构（0.1.5 输入框 = shell 持有的 Lexical 编辑器；多行草稿=单 <p>+<br> 分行，
// Enter=发送 / Shift+Enter=换行；@ 引用 chip=span[data-composer-chip]）：
//   - 透明化：[data-composer-input] 用 -webkit-text-fill-color:transparent 只隐藏
//     「绘制」（color 属性保留原值：caret、官方 hint 的 ::after、chip 恢复都靠它）
//   - chip 恢复：span[data-composer-chip] 恢复 currentColor；含 chip 的段落整体
//     恢复显示（KEEP）——overlay 无法复刻 chip 宽度，含 chip 段降级官方原样显示
//   - overlay：自建 .dsh-cl-live 渲染层按行一一对应渲染；度量从行容器 <p> 复制
//     + 首行动态 top 偏移（签名守卫，仅布局变化时测量）
//   - 数据源：直接读编辑器 DOM 产出「投影文本」（br/p=换行、chip=￼）——零服务
//     依赖，不碰 conversation/sessions API；光标/选区 offset 互查基于锚表
//   - 插入：单行走 execCommand insertText、多行走合成 beforeinput 事件序列
//     （都要 setTimeout 延后；详见 insertInline 注释的四个实测坑）
//   - 等宽整框：文档含已闭合代码块期间，编辑器整框 + 渲染全段同步切等宽合成栈
//     （v0.1.x 同策略；行级等宽对大段粘贴的「单文本锚跨多行」形态物理不可行）
//   - 候选菜单让行：[data-trigger-menu]/[role="listbox"] 存在或 data-phase≠plain
//     时，Enter/Tab/Esc/粘贴一律放行归官方
window.__ModuleLoader__.load({
	id: "dsh-composer-live",
	factory: (require) => {
		'use strict';
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region dsh-composer-live: 常量
		/** 注入的 <style> 元素 id。 */
		const STYLE_ID = "dsh-composer-live-style";
		/** 输入卡片标记：已初始化则不重复注入监听器。 */
		const READY_KEY = "data-dsh-cl-ready";
		/** 展开态 class（挂在 [data-input-scroll]）。 */
		const EXPANDED = "dsh-cl-expanded";
		/** 透明化宿主 class（挂在 [data-composer-input]）。 */
		const HOST = "dsh-cl-host";
		/** 含 chip 的编辑器段落 class（恢复官方显示）。 */
		const KEEP = "dsh-cl-keep";
		/** 等宽整框 class（挂在 [data-composer-input]）：文档含已闭合代码块期间整框切
		 * 等宽合成栈（v0.1.x 同策略；行级等宽对「字面 \n」单锚形态物理不可行）。 */
		const MONO_ALL = "dsh-cl-mono-all";
		/** 自建实时渲染层 class。 */
		const LIVE = "dsh-cl-live";
		/** 哨兵 class（读继承字体链）。 */
		const SENTINEL = "dsh-cl-sentinel";
		/** 常驻工具栏 class。 */
		const TOOLBAR = "dsh-cl-toolbar";
		/** 选区浮动格式条 class。 */
		const FLOAT = "dsh-cl-float";
		/** 轻提示 class。 */
		const TOAST = "dsh-cl-toast";
		/** DOM 锚点（0.1.5 官方稳定 data 属性；类名是随机 hash 不可用）。 */
		const CARD_SEL = "[data-composer-card]";
		const INPUT_SEL = "[data-composer-input]";
		const SCROLL_SEL = "[data-input-scroll]";
		const PLACEHOLDER_SEL = "[data-composer-placeholder]";
		const MENU_SEL = '[data-trigger-menu], [role="listbox"], [role="menu"], [role="dialog"]';
		const CHIP_HOST_SEL = "[data-composer-chip]";
		/** 文本引用装饰（热词高亮）：内容参与投影（非原子 chip），但透明化下需要恢复显示。 */
		const TEXT_REF_SEL = "[data-composer-text-ref]";
		/** chip 在「投影文本」里的字符（与官方 detectText 同构）。 */
		const CHIP_CHAR = "￼";
		/** 行内代码/图片占位控制字符（不与正文数字混淆）。 */
		const PH_CODE = "";
		const PH_IMG = "";
		/** 防 XSS：链接 href 白名单协议。 */
		const SAFE_LINK = /^(https?:|mailto:)/i;
		/** 大段粘贴自动包代码块的阈值。 */
		const PASTE_WRAP_MAX_LINES = 8;
		const PASTE_WRAP_MAX_CHARS = 4096;
		/** 「停止生成」按钮 aria-label（i18n 双语；实测校正清单见 README）。 */
		const STOP_BTN_HINTS = ["停止生成", "Stop generating", "停止"];
		/** 工具栏高度 + 呼吸（占位同步值）。 */
		const BAR_RESERVE = "6px"; // v0.2.8：sticky 工具栏在流内占 38px，编辑器 padding 只留呼吸（原 absolute 方案的 44px 占位退役）
		//#endregion

		//#region dsh-composer-live: 安全工具
		function escapeHtml(s) {
			return String(s)
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#39;")
				// \r 必须走字符实体：innerHTML 解析会把字面 \r（含 \r\n）规范化成 \n
				// ——段 text 里的 \r 会凭空变成真换行（pre-wrap 下断行）＝粘贴长文
				// 「多余空白/行错乱」的来源；实体引用不参与换行规范化，解析回 DOM
				// 仍是 \r（0 宽，与编辑器渲染一致）。
				.replace(/\r/g, "&#13;");
		}

		function safeHref(url) {
			const u = String(url || "").trim();
			return SAFE_LINK.test(u) ? u : "";
		}
		//#endregion

		//#region dsh-composer-live: 行内 Markdown 解析（纯函数，与旧版同源）
		/** 围栏行判定：行首（允许缩进）三个及以上 ` 或 ~，后面可跟语言名。 */
		const FENCE_RE = /^(\s*)(`{3,}|~{3,})([\w+#./-]*)\s*$/;

		/**
		 * 行内 Markdown → HTML。支持加粗/斜体/行内代码/删除线/链接；图片与行内代码
		 * 用控制字符占位后整体 escapeHtml，防内部二次解析。与旧版 dsh-composer-md
		 * 的 inlineParse 同源（class 前缀已换 dsh-cl-）。
		 *
		 * 字符级对齐（2026-09-13）：标记字符（**、`、~~、[]()）必须保留占位（mk 淡化
		 * span），不能删除——光标按编辑器透明文字布局绘制，渲染行少字符=光标漂移；
		 * 粗体不用 font-weight（改字符 advance），用 -webkit-text-stroke 伪粗（paint-only）。
		 */
		var MK_OPEN = '<span class="dsh-cl-mk">';
		function inlineParse(line, noMono) {
			const codeSpans = [];
			const imgSpans = [];
			let out = String(line || "");

			out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m) => {
				imgSpans.push(escapeHtml(m));
				return PH_IMG + (imgSpans.length - 1) + PH_IMG;
			});

			out = out.replace(/(^|[^`])`([^`]+)`(?!`)/g, (m, pre, code) => {
				codeSpans.push(escapeHtml(code));
				return pre + PH_CODE + (codeSpans.length - 1) + PH_CODE;
			});

			out = escapeHtml(out);

			out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
				const href = safeHref(url);
				if (!href) return m;
				return MK_OPEN + "[</span>" + '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + "</a>" + MK_OPEN + "](" + url + ")</span>";
			});

			out = out.replace(/\*\*\*([^*]+)\*\*\*/g, MK_OPEN + "***</span><strong><em>$1</em></strong>" + MK_OPEN + "***</span>");
			// 内容组排除 <（escape 后正文无裸 <，只有本函数产出的标签）——防标记
			// 替换产物被后续规则二次匹配（*** 产物里的 ** 再被 bold 规则嵌套）。
			out = out.replace(/\*\*([^*<]+)\*\*/g, MK_OPEN + "**</span><strong>$1</strong>" + MK_OPEN + "**</span>");
			out = out.replace(/(^|[^*<])\*([^*\s<][^*<]*)\*(?!\*)/g, "$1" + MK_OPEN + "*</span><em>$2</em>" + MK_OPEN + "*</span>");
			out = out.replace(/~~([^~<]+)~~/g, MK_OPEN + "~~</span><del>$1</del>" + MK_OPEN + "~~</span>");

			out = out.replace(new RegExp(PH_CODE + "(\\d+)" + PH_CODE, "g"), (m, i) => MK_OPEN + "`</span><code" + (noMono ? ' class="dsh-cl-ce"' : "") + ">" + codeSpans[+i] + "</code>" + MK_OPEN + "`</span>");
			out = out.replace(new RegExp(PH_IMG + "(\\d+)" + PH_IMG, "g"), (m, i) => '<span class="dsh-cl-img">' + imgSpans[+i] + "</span>");
			return out;
		}
		//#endregion

		//#region dsh-composer-live: 代码语法高亮（零依赖正则，颜色-only）
		const LANG_ALIAS = {
			js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js",
			javascript: "js", typescript: "js", node: "js",
			py: "py", python: "py", python3: "py",
			sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", fish: "sh",
			json: "json", yml: "yml", yaml: "yml", toml: "yml",
			css: "css", scss: "css", less: "css",
			html: "html", htm: "html", xml: "html", svg: "html", vue: "html"
		};

		const KEYWORDS = {
			js: new Set("const let var function return if else for while do switch case break continue new class extends super import export from as default try catch finally throw typeof instanceof in of async await yield this delete void static get set console require module".split(" ")),
			py: new Set("def return if elif else for while break continue pass class import from as with lambda yield global nonlocal raise try except finally assert del in is not and or self print len range int str float list dict set tuple bool type enumerate zip map filter sorted sum min max abs open super".split(" ")),
			sh: new Set("if then else elif fi for while do done case esac in function echo export cd return local source set sudo apt pnpm npm git curl grep sed awk cat mkdir rm cp mv ls chmod".split(" "))
		};

		const LITERALS = new Set("true false null undefined NaN None True False".split(" "));

		const HL_RE = {
			js: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g,
			py: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[^\n]*)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g,
			sh: /("(?:[^"\\]|\\.)*"|'[^']*')|(#[^\n]*)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w-]*)/g,
			json: /("(?:[^"\\]|\\.)*")|(\/\/[^\n]*)|(-?\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g,
			gen: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*|<!--[\s\S]*?-->|--[^\n]*)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][\w-]*)/g
		};

		function guessLang(text) {
			const t = String(text || "");
			if (/^\s*[{[]/.test(t) && /"[^"\n]*"\s*:/.test(t)) return "json";
			if (/\b(def |elif |import \w+|print\()/.test(t)) return "py";
			if (/\b(const |let |var |function|=>|console\.|require\(|export |await )/.test(t)) return "js";
			if (/^\s*(\$\(|npm |pnpm |yarn |sudo |apt |brew |git |cd |ls |echo |mkdir )/m.test(t)) return "sh";
			if (/[{}]\s*;|;\s*$/m.test(t) && /=/.test(t)) return "js";
			return "";
		}

		function highlightLine(line, lang) {
			const family = LANG_ALIAS[lang] || "gen";
			const re = HL_RE[family] || HL_RE.gen;
			const kw = KEYWORDS[family];
			re.lastIndex = 0;
			let out = "";
			let last = 0;
			let m;
			while ((m = re.exec(line))) {
				out += escapeHtml(line.slice(last, m.index));
				const full = m[0];
				const after = line.slice(m.index + full.length);
				const before = line.slice(0, m.index);
				let cls = "";
				if (m[1]) {
					cls = family === "json" && /^\s*:/.test(after) ? "dsh-cl-tok-fn" : "dsh-cl-tok-str";
				} else if (m[2]) {
					cls = "dsh-cl-tok-com";
				} else if (m[3]) {
					cls = "dsh-cl-tok-num";
				} else if (m[4]) {
					if (kw && kw.has(m[4])) cls = "dsh-cl-tok-kw";
					else if (LITERALS.has(m[4])) cls = "dsh-cl-tok-lit";
					else if (family === "html" && /<\/?$/.test(before)) cls = "dsh-cl-tok-kw";
					else if (/^\s*\(/.test(after)) cls = "dsh-cl-tok-fn";
				}
				out += cls ? '<span class="' + cls + '">' + escapeHtml(full) + "</span>" : escapeHtml(full);
				last = m.index + full.length;
			}
			out += escapeHtml(line.slice(last));
			return out || " ";
		}
		//#endregion

		//#region dsh-composer-live: 块状态与段落渲染（行=段落，与旧版同源）
		const NBSP = " ";

		function codeLineContent(line, extraCls, lang, withBadge, isCursor) {
			const isFence = extraCls === "dsh-cl-fence-open" || extraCls === "dsh-cl-fence-close";
			let content;
			if (!line) content = NBSP;
			// 围栏字符统一淡化（mk）：可见弱化、光标行无需特判（字符锚定渲染下
			// 没有「行级隐藏+光标行显示」的切换，统一淡化消灭切换闪烁）
			else if (isFence) content = '<span class="dsh-cl-mk">' + escapeHtml(line) + "</span>";
			else content = highlightLine(line, lang);
			const badge = withBadge && lang ? '<span class="dsh-cl-lang">' + escapeHtml(lang) + "</span>" : "";
			return content + badge;
		}

		function blockKindOf(line) {
			const l = String(line || "");
			let m;
			m = l.match(/^(#{1,6})(\s+)(.+)$/);
			if (m) return { type: "heading", mark: m[1], space: m[2], text: m[3] };
			m = l.match(/^(>)(\s?)(.*)$/);
			if (m) return { type: "quote", mark: m[1], space: m[2], text: m[3] };
			m = l.match(/^(\s{0,3})([-*+])(\s+)(.+)$/);
			if (m) return { type: "list", indent: m[1], mark: m[2], space: m[3], text: m[4] };
			m = l.match(/^(\s{0,3})(\d+)([.)])(\s+)(.+)$/);
			if (m) return { type: "list", indent: m[1], mark: m[2] + m[3], space: m[4], text: m[5] };
			if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && /-{3,}/.test(l)) return { type: "table", raw: l };
			return null;
		}

		function renderBlockLine(line, kind, noMono) {
			if (!kind) return inlineParse(line, noMono);
			if (kind.type === "heading") return '<span class="dsh-cl-hmark">' + escapeHtml(kind.mark) + '</span>' + escapeHtml(kind.space) + '<span class="dsh-cl-heading">' + inlineParse(kind.text, noMono) + '</span>';
			if (kind.type === "quote") return '<span class="dsh-cl-qmark">' + escapeHtml(kind.mark) + '</span>' + escapeHtml(kind.space) + inlineParse(kind.text, noMono);
			if (kind.type === "list") {
				// 任务列表勾选样式（v0.2.10）：`- [ ] 任务` / `- [x] 任务`——标记三字符
				// 整体进胶囊背景（字符流不变，光标对齐不受影响）；已勾时行内容加划线
				// （<s> → tokenizeViaDom 映射 dsh-cl-dl，line-through 是 paint-only）。
				const tm = kind.text.match(/^(\[(?: |x|X)\])(\s+)([\s\S]*)$/);
				if (tm) {
					const done = tm[1].charAt(1) !== " ";
					return escapeHtml(kind.indent || "") + '<span class="dsh-cl-lmark">' + escapeHtml(kind.mark) + '</span>' + escapeHtml(kind.space)
						+ '<span class="dsh-cl-task' + (done ? " dsh-cl-task-done" : "") + '">' + escapeHtml(tm[1]) + '</span>' + escapeHtml(tm[2])
						+ (done ? "<s>" + inlineParse(tm[3], noMono) + "</s>" : inlineParse(tm[3], noMono));
				}
				return escapeHtml(kind.indent || "") + '<span class="dsh-cl-lmark">' + escapeHtml(kind.mark) + '</span>' + escapeHtml(kind.space) + inlineParse(kind.text, noMono);
			}
			if (kind.type === "table") return '<span class="dsh-cl-tmark">' + escapeHtml(kind.raw) + "</span>";
			return inlineParse(line, noMono);
		}

		function inlineLineContent(line, noMono) {
			if (!line) return NBSP;
			return renderBlockLine(line, blockKindOf(line), noMono);
		}

		function computeBlockStates(lines) {
			const states = [];
			const blocks = [];
			let inCode = false;
			let cur = null;
			for (let i = 0; i < lines.length; i++) {
				const fm = lines[i].match(FENCE_RE);
				if (fm) {
					if (!inCode) {
						cur = { start: i, lang: (fm[3] || "").toLowerCase() };
						blocks.push(cur);
					} else {
						cur.end = i;
					}
					inCode = !inCode;
				}
			}
			const blockAt = new Map();
			for (const b of blocks) {
				// 只渲染「已闭合」的块：未闭合（end==null）= 用户还在围栏输入阶段
				// （打了 ``` 还没按 Shift+Enter 补全，或删掉闭合围栏编辑中），整块按
				// 普通文本渲染——代码块样式在补全封闭的那一刻才出现（2026-09-12
				// 用户指定的流：输入 ``` 界面不出块，Shift+Enter 后出封闭块）。
				if (b.end == null) continue;
				if (!b.lang) b.lang = guessLang(lines.slice(b.start + 1, b.end).join("\n"));
				for (let i = b.start; i <= b.end; i++) blockAt.set(i, b);
			}
			for (let i = 0; i < lines.length; i++) {
				const b = blockAt.get(i);
				if (!b) { states.push({ inCode: false, lang: "", fenceOpen: false, fenceClose: false, kind: blockKindOf(lines[i]) }); continue; }
				states.push({ inCode: true, lang: b.lang, fenceOpen: i === b.start, fenceClose: i === b.end, kind: null });
			}
			return states;
		}

		function lineClass(st) {
			if (!st.inCode) return st.kind && st.kind.type === "quote" ? "dsh-cl-quote" : "";
			return "dsh-cl-cline" + (st.fenceOpen ? " dsh-cl-fence-open" : "") + (st.fenceClose ? " dsh-cl-fence-close" : "");
		}

		function lineContent(line, st, cursorLine) {
			if (!st.inCode) return inlineLineContent(line, cursorLine);
			return codeLineContent(line, st.fenceOpen ? "dsh-cl-fence-open" : (st.fenceClose ? "dsh-cl-fence-close" : ""), st.lang, st.fenceOpen, cursorLine);
		}

		/** 段落是否含 chip 投影字符（￼）。 */
		function paraHasChip(line) {
			return String(line || "").indexOf(CHIP_CHAR) !== -1;
		}

		/**
		 * 渲染主体（逐段落，与编辑器段落一一对应）。含 chip 的段落渲染为空占位
		 * （该段落由官方原样显示，KEEP class 恢复——overlay 无法复刻 chip 宽度，
		 * 零错位优先）。
		 */
		function renderInline(src, cursorLine) {
			const lines = String(src || "").split("\n");
			const states = computeBlockStates(lines);
			let out = "";
			for (let i = 0; i < lines.length; i++) {
				if (paraHasChip(lines[i])) {
					out += '<div class="dsh-cl-skip">' + NBSP + "</div>";
					continue;
				}
				const cls = lineClass(states[i]);
				out += '<div' + (cls ? ' class="' + cls + '"' : "") + '>' + lineContent(lines[i], states[i], i === cursorLine) + "</div>";
			}
			return out;
		}

		/** 段落级代码态列表（供编辑器段落打等宽 class；行=段落）。 */
		function codeParaFlags(lines) {
			return computeBlockStates(lines).map((st) => st.inCode);
		}

		// ---------- 字符锚定渲染（v0.2 根治架构） ----------
		// 渲染层不再自己排版：逐字符测量编辑器的真实坐标（Range rect），渲染
		// 字符绝对定位画在同一坐标上。字体/字重/断行/行结构/等宽打点时序/任何
		// 度量维度怎么变，渲染物理跟随编辑器——漂移/抖动/错位从架构上不存在。
		// 这是对「透明编辑器 + overlay 两遍绘制」开环逼近的历史总结：修不胜修
		// 的根因是两套排版引擎各自计算，字符锚定后只剩一套（编辑器）。

		/** 行 HTML → token 序列（复用行内/高亮正则链，DOM 解析嵌套取样式类）。 */
		function tokenizeViaDom(html) {
			const holder = document.createElement("div");
			holder.innerHTML = html;
			const tokens = [];
			const clsOf = (el, inherited) => {
				const tag = el.tagName;
				if (tag === "STRONG" || tag === "B") return "dsh-cl-strong";
				if (tag === "EM" || tag === "I") return "dsh-cl-em";
				if (tag === "CODE") return "dsh-cl-cd";
				if (tag === "DEL" || tag === "S") return "dsh-cl-dl";
				if (tag === "A") return "dsh-cl-lk";
				const cn = String(el.className || "");
				if (cn) return cn; // mk / hmark / heading / qmark / lmark / tmark / img / tok-*
				return inherited;
			};
			const walk = (el, cls) => {
				for (const n of Array.prototype.slice.call(el.childNodes)) {
					if (n.nodeType === Node.TEXT_NODE) {
						if (n.nodeValue) tokens.push({ text: n.nodeValue, cls: cls || "" });
					} else if (n.nodeType === Node.ELEMENT_NODE) {
						walk(n, clsOf(n, cls));
					}
				}
			};
			walk(holder, "");
			return tokens;
		}

		/**
		 * 逐行逐字符测量编辑器 rect。返回 lineChars[行] = [{off(行内偏移), x, y, w, h}]；
		 * chip 跳过（其所在行整段降级官方显示）。
		 */
		function measureAnchorChars(anchors, lineCount) {
			const range = document.createRange();
			const lineChars = [];
			for (let i = 0; i < lineCount; i++) lineChars.push([]);
			let lineIdx = 0;
			let off = 0; // 行内字符偏移
			for (const a of anchors) {
				if (a.kind === "br" || a.kind === "para") { lineIdx++; off = 0; continue; }
				if (a.kind === "chip") { off++; continue; }
				const node = a.node;
				if (!node || node.nodeType !== Node.TEXT_NODE) { continue; }
				const len = node.nodeValue.length;
				// 逐锚容错：大段粘贴/批量编辑期间 DOM 可能正被 Lexical 重建，个别
				// 节点测量抛错时跳过该锚（下一轮渲染自愈），不让整个渲染中断。
				// 文本节点内的字面 \n 必须推进行号（与 src.split("\n") 的行边界
				// 一致）——粘贴的大段文本正是「单节点含字面 \n」形态（官方 paste
				// 管线 insertText 不转 br），不推进会导致 chars 全记到第 0 行而
				// lines 已被切多行 → charAt 越界 → 渲染段全空 →「一片空白」。
				try {
					for (let i = 0; i < len; i++) {
						if (node.nodeValue.charCodeAt(i) === 10) { lineIdx++; off = 0 - i - 1; continue; }
						range.setStart(node, i);
						range.setEnd(node, i + 1);
						const r = range.getBoundingClientRect();
						if (r) lineChars[lineIdx].push({ off: off + i, x: r.left, y: r.top, w: r.width, h: r.height });
					}
				} catch (err) { /* 跳过该锚 */ }
				off += len;
			}
			return lineChars;
		}

		/** 字符锚定渲染主入口：清空 overlay，按测量坐标输出「整块背景 + 定位字符段」。 */
		function renderCharOverlay(ov, input, anchors, lines, states) {
			const ovRect = ov.getBoundingClientRect();
			const ox = ovRect.left, oy = ovRect.top;
			const segLineHeight = getComputedStyle(ov).lineHeight; // 段定位的 half-leading 修正用
			const lineChars = measureAnchorChars(anchors, lines.length);
			// 容器内容区（块背景的水平范围——统一宽度消灭按行宽的锯齿）
			const inpRect = input.getBoundingClientRect();
			const ics = getComputedStyle(input);
			const pl = parseFloat(ics.paddingLeft) || 0, pr = parseFloat(ics.paddingRight) || 0;
			const contentLeft = inpRect.left + pl - 12;
			const contentW = inpRect.width - pl - pr + 24;
			let out = "";
			// ===== 块级背景（代码块整块一个矩形：垂直无缝；引用段同理） =====
			// 逐行画背景会按行内容宽度锯齿 + 行间露缝——聚合到块级：从块首行首字符顶
			// 到块末行末字符底 ±2.5px，水平取容器内容宽。块内空行天然被矩形覆盖。
			const blockBgDone = new Set();
			const verticalPad = 2.5;
			for (let li = 0; li < lines.length; li++) {
				const st = states[li];
				if (!st.inCode || blockBgDone.has(li)) continue;
				// 找块尾（连续 inCode 段的最后一行）
				let end = li;
				while (end + 1 < lines.length && states[end + 1].inCode) end++;
				let top = Infinity, bottom = -Infinity;
				for (let k = li; k <= end; k++) {
					for (const c of lineChars[k]) { if (c.y < top) top = c.y; if (c.y + c.h > bottom) bottom = c.y + c.h; }
				}
				if (top === Infinity) { // 整块无字符（空块）——跳过
					for (let k = li; k <= end; k++) blockBgDone.add(k);
					continue;
				}
				const cls = "dsh-cl-bg" + (st.fenceOpen ? " dsh-cl-bg-open" : "") + (states[end].fenceClose ? " dsh-cl-bg-close" : "");
				out += '<div class="' + cls + '" style="left:' + (contentLeft - ox) + "px;top:" + (top - oy - verticalPad) + "px;width:" + contentW + "px;height:" + (bottom - top + verticalPad * 2) + 'px"></div>';
				if (st.fenceOpen && st.lang) out += '<span class="dsh-cl-lang" style="top:' + (top - oy + 2) + 'px">' + escapeHtml(st.lang) + "</span>";
				for (let k = li; k <= end; k++) blockBgDone.add(k);
			}
			// 引用段（连续 quote 行聚合一个背景）
			const quoteBgDone = new Set();
			for (let li = 0; li < lines.length; li++) {
				const st = states[li];
				if (!st.kind || st.kind.type !== "quote" || quoteBgDone.has(li)) continue;
				let end = li;
				while (end + 1 < lines.length && states[end + 1].kind && states[end + 1].kind.type === "quote" && !paraHasChip(lines[end + 1])) end++;
				let top = Infinity, bottom = -Infinity;
				for (let k = li; k <= end; k++) {
					for (const c of lineChars[k]) { if (c.y < top) top = c.y; if (c.y + c.h > bottom) bottom = c.y + c.h; }
				}
				if (top !== Infinity) out += '<div class="dsh-cl-qbg" style="left:' + (contentLeft - ox) + "px;top:" + (top - oy - verticalPad) + "px;width:" + contentW + "px;height:" + (bottom - top + verticalPad * 2) + 'px"></div>';
				for (let k = li; k <= end; k++) quoteBgDone.add(k);
			}
			// ===== 字符段渲染 =====
			for (let li = 0; li < lines.length; li++) {
				const line = lines[li];
				const st = states[li];
				if (paraHasChip(line)) continue; // chip 行：官方原样（KEEP）
				const chars = lineChars[li];
				if (!chars.length) continue; // 空行：背景已由块级矩形覆盖
				// 行字符的样式 token（HTML 复用既有正则链 → DOM 解析）
				let html;
				if (st.inCode) html = codeLineContent(line, st.fenceOpen ? "dsh-cl-fence-open" : (st.fenceClose ? "dsh-cl-fence-close" : ""), st.lang, st.fenceOpen, -2);
				else html = inlineLineContent(line, null);
				const tokens = tokenizeViaDom(html);
				// token → 每字符样式类（token 文本流 = 源文字符流，mk 占位保证逐字符对应）
				const charCls = new Array(chars.length).fill("");
				let ci = 0;
				for (const tk of tokens) {
					const tl = tk.text.length;
					for (let k = 0; k < tl && ci < chars.length; k++, ci++) charCls[ci] = tk.cls;
				}
				// 合并「同样式 + 同视觉行 + 横向连续」的字符成段（段内浏览器排版同字体零差）。
				// 等宽整框语义：文档含代码块时全部段用等宽合成栈（与编辑器 MONO_ALL 同源变量）。
				const anyCode = states.some((st) => st.inCode);
				const codeCls = anyCode ? " dsh-cl-codefont" : "";
				// 段定位必须用「行盒顶」而非「字形盒顶」：段内字符随段自身行盒排版，
				// 字形顶 = 段top + half-leading((行高-字形高)/2)。直接拿测量出的字形顶
				// 定位会让渲染文字整体下移 half-leading（实测恒 +3px：行高27/字形21）。
				// 段内其余字符的相对排布与编辑器同构（同字体同行高同基线规则），首字符
				// 对齐即全段对齐；代码行等宽段用该段首字符的字形高计算。
				const segLineH = parseFloat(segLineHeight) || 0;
				let segStart = 0;
				const flush = (endExclusive) => {
					const s = chars[segStart];
					let text = "";
					// 段 text 剔除 \r：CRLF 粘贴的行尾 \r 在段内（white-space:pre）会被当
					// 真换行——段盒凭空多撑一行（代码块背景多一块）。编辑器把 \r 当
					// 换行语义的一部分（0 宽不可见），渲染侧同样零宽处理＝直接不画。
					for (let k = segStart; k < endExclusive; k++) {
						const ch = line.charAt(chars[k].off);
						if (ch !== "\r") text += ch;
					}
					if (!text) { segStart = endExclusive; return; } // 整段全 \r：无可视字符，不输出空段
					const cls = charCls[segStart] + codeCls;
					const half = segLineH > s.h ? (segLineH - s.h) / 2 : 0;
					out += '<span class="dsh-cl-c' + (cls ? " " + cls : "") + '" style="left:' + (s.x - ox) + "px;top:" + (s.y - oy - half) + 'px">' + escapeHtml(text) + "</span>";
					segStart = endExclusive;
				};
				for (let i = 1; i <= chars.length; i++) {
					const cont = i < chars.length
						&& charCls[i] === charCls[segStart]
						&& Math.abs(chars[i].y - chars[segStart].y) < 2
						&& (chars[i].x - (chars[i - 1].x + chars[i - 1].w)) < 1.5;
					if (!cont) flush(i);
				}
			}
			ov.innerHTML = out;
		}
		//#endregion

		//#region dsh-composer-live: 字体合成 / 判定函数（与旧版同源）
		const CJK_FONT_HINTS = ["cjk", "yahei", "pingfang", "hiragino", "simsun", "simhei",
			"kaiti", "fangsong", "heiti", "songti", "dengxian", "zenhei", "wqy", "wenkai",
			"lxgw", "sarasa", "noto sans sc", "noto serif sc", "source han", "misans", "nf cn",
			"harmonyos", "honor sans", "oppo sans", "smiley", "hyqihei", "hywenhei",
			"jinghua", "fz", " han", "sans sc", "serif sc"];
		const GENERIC_FAMILIES = new Set(["monospace", "serif", "sans-serif", "cursive",
			"fantasy", "system-ui", "ui-monospace", "ui-serif", "ui-sans-serif",
			"ui-rounded", "math", "emoji", "fangsong", "inherit", "initial"]);
		function buildCodeFont(codeStack, uiStack) {
			const parts = String(codeStack || "").split(",").map((s) => s.trim()).filter(Boolean);
			const kept = parts.filter((p) => {
				const bare = p.replace(/^["']+|["']+$/g, "").trim().toLowerCase();
				if (GENERIC_FAMILIES.has(bare)) return false;
				return !CJK_FONT_HINTS.some((h) => bare.includes(h));
			});
			const ui = String(uiStack || "").trim();
			return (kept.length ? kept.join(", ") + ", " : "") + ui;
		}

		function decideWrapAction(value, selStart, selEnd, kind) {
			const s = selStart == null ? 0 : selStart;
			const e = selEnd == null ? s : selEnd;
			const sel = String(value || "").slice(s, e);
			const pairs = {
				bold: ["**", "**"],
				italic: ["*", "*"],
				code: ["`", "`"],
				link: ["[", "](url)"],
				list: null,
				block: null
			};
			if (kind === "list") {
				const before = String(value || "").slice(0, s);
				const lineStart = before.lastIndexOf("\n") + 1;
				if (String(value || "").slice(lineStart, lineStart + 2) === "- ") return null;
				return { insert: "- ", cursorStart: s + 2, cursorEnd: s + 2, at: lineStart };
			}
			if (kind === "block") {
				const after = String(value || "").slice(e);
				const insert = "```\n" + sel + "\n```" + (after && !after.startsWith("\n") ? "\n" : "");
				return { insert: insert, cursorStart: s + 4, cursorEnd: s + 4 + sel.length };
			}
			const pair = pairs[kind];
			if (!pair) return null;
			const insert = pair[0] + sel + pair[1];
			if (!sel) {
				const c = s + pair[0].length;
				return { insert: insert, cursorStart: c, cursorEnd: c };
			}
			return { insert: insert, cursorStart: s, cursorEnd: s + insert.length };
		}

		const LIST_RE = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)/;
		/** 引用行前缀（缩进 + > + 可选空白；`>text` 无空格也认——CommonMark 语义）。 */
		const QUOTE_RE = /^(\s*)(>)(\s*)/;

		function decideKeyAction(value, pos, key, mods) {
			if (key === "Enter") {
				// 围栏行上的 Enter（含 Shift+Enter）：自动补全完整代码块——
				// 块内空行（光标落点）+ 闭合围栏 + 块后空行（↓ 跳出落点）。
				// Shift+Enter 原语义是官方换行，在围栏行上替换为补全（用户流：
				// 输入 ``` 后 Shift+Enter → 出现封闭代码块）；无 Shift 的 Enter
				// 原语义是发送，拦截防误发并同样补全。
				const before = String(value).slice(0, pos);
				const lineStart = before.lastIndexOf("\n") + 1;
				const m = before.slice(lineStart).match(/^(\s*)(`{3,}|~{3,})([\w+#./-]*)\s*$/);
				if (!m) {
					// 表格首行行尾的 Enter（含 Shift+Enter）：自动补分隔行 + 空行，
					// 光标落空行（继续打表体）。只认首尾包夹形态（|列A|列B|），且下一
					// 行已是分隔行时不重复补（防连按 Enter 反复插入）。
					const tv = String(value);
					const tnl = tv.indexOf("\n", lineStart);
					const tEnd = tnl === -1 ? tv.length : tnl;
					const tbl = tv.slice(lineStart, tEnd).match(/^\s*\|(.+)\|\s*$/);
					if (tbl && tbl[1].indexOf("|") !== -1 && pos === tEnd) {
						const nextNl = tv.indexOf("\n", tEnd + 1); // 从行尾+1 搜（tEnd 处本身就是 \n）
						const nextLine = tv.slice(tEnd + 1, nextNl === -1 ? tv.length : nextNl);
						if (!/^\s*\|[-\s|:]*-{3,}/.test(nextLine)) {
							const cols = tbl[1].split("|").length;
							const sep = "\n|" + "---|".repeat(cols) + "\n";
							return { type: "table-sep", insert: sep, cursor: pos + sep.length };
						}
					}
					// 列表行尾的 Enter（含 Shift+Enter）：自动续项（无序保持符号、
					// 有序递增编号、缩进保留）。空列表项（只有标记没内容）上按 →
					// 退出列表：删除行首标记，行原地变普通行（两次 Shift+Enter
					// 即结束列表的流：第一次续出空项，第二次退出）。光标不在行尾
					// 时放行官方（本行内普通换行，不做拆项）。
					const text = String(value);
					const nlIdx = text.indexOf("\n", lineStart);
					const lineEnd = nlIdx === -1 ? text.length : nlIdx;
					const curLine = text.slice(lineStart, lineEnd);
					const lm = curLine.match(LIST_RE);
					if (lm && pos === lineEnd) {
						const rest = curLine.slice(lm[0].length);
						if (rest.trim() === "") {
							// 空项退出：删除「缩进+标记+空白」，光标落行首
							return { type: "list-exit", rangeStart: lineStart, rangeEnd: lineStart + lm[0].length, cursor: lineStart };
						}
						const mark = lm[2];
						const nextMark = lm[3] ? String(parseInt(lm[3], 10) + 1) + lm[4] : mark;
						const prefix = lm[1] + nextMark + " ";
						return { type: "list", insert: "\n" + prefix, cursor: pos + 1 + prefix.length };
					}
					// 引用行尾的 Enter（含 Shift+Enter）：自动续「> 」前缀（与列表续项
					// 同款交互——两次 Shift+Enter 结束引用：第一次续出空引用行、第二次
					// 退出变普通行）。光标不在行尾放行官方。
					const qm = curLine.match(QUOTE_RE);
					if (qm && pos === lineEnd) {
						if (curLine.slice(qm[0].length).trim() === "") {
							// 空引用项退出：删除「缩进+>+空白」，光标落行首
							return { type: "list-exit", rangeStart: lineStart, rangeEnd: lineStart + qm[0].length, cursor: lineStart };
						}
						const qprefix = qm[1] + "> ";
						return { type: "list", insert: "\n" + qprefix, cursor: pos + 1 + qprefix.length };
					}
					return null;
				}
				let fences = 0;
				for (const l of before.slice(0, lineStart).split("\n")) {
					if (FENCE_RE.test(l)) fences++;
				}
				if (fences % 2 === 1) return null;
				const fence = m[2][0] === "~" ? "~~~" : "```";
				const insert = "\n\n" + fence + "\n";
				return { type: "fence", insert: insert, cursor: pos + 1 };
			}
			if (key === "ArrowDown" && !mods.shift && !mods.ctrl && !mods.alt && !mods.meta) {
				// 代码块内最后一个内容行按 ↓：直接跳出（光标落到闭合围栏后的行首），
				// 免去逐行穿越闭合围栏。仅已闭合块；未闭合（EOF 收尾）放行官方。
				const text = String(value);
				const s = Math.max(0, Math.min(pos == null ? 0 : pos, text.length));
				const lines = text.split("\n");
				const cur = text.slice(0, s).split("\n").length - 1;
				if (cur >= lines.length - 1) return null;
				if (FENCE_RE.test(lines[cur])) return null;
				let inCode = false;
				for (let i = 0; i < cur; i++) {
					if (FENCE_RE.test(lines[i])) inCode = !inCode;
				}
				if (!inCode) return null;
				if (!FENCE_RE.test(lines[cur + 1])) return null;
				let off = 0;
				for (let i = 0; i <= cur + 1; i++) off += lines[i].length + 1;
				return { type: "jumpout", cursor: off };
			}
			if (key === "Tab" && !mods.ctrl && !mods.alt && !mods.meta) {
				// Tab 缩进体系（v0.2.9）：全部拦截——浏览器默认 Tab 会把焦点切出输入框。
				// - 代码块内：光标处插两空格（既有行为）
				// - 光标在列表/引用「标记头」内或行首空白区：行首插两空格（嵌套列表/引用
				//   ——列表续项后光标恰在标记后，Tab 即缩进成子列表）
				// - 其余（行中间）：光标处插两空格
				// - Shift+Tab：行首删最多 2 个空白（反缩进）；无缩进可删则只吞按键
				const lines = String(value).slice(0, pos).split("\n");
				let inCode = false;
				for (let i = 0; i < lines.length - 1; i++) {
					if (FENCE_RE.test(lines[i])) inCode = !inCode;
				}
				const curLine = lines[lines.length - 1];
				const lineStart = pos - curLine.length;
				if (inCode && !FENCE_RE.test(curLine)) {
					return { type: "indent", insert: "  " };
				}
				// 反缩进/标记头判定用「完整行」（光标前缀在光标处行首时是空串）
				const text = String(value);
				const nlIdx = text.indexOf("\n", lineStart);
				const fullLine = text.slice(lineStart, nlIdx === -1 ? text.length : nlIdx);
				if (mods.shift) {
					const rm = /^[ \t]{1,2}/.exec(fullLine);
					if (rm) return { type: "outdent", rangeStart: lineStart, rangeEnd: lineStart + rm[0].length };
					return { type: "tab-noop" };
				}
				const hm = fullLine.match(LIST_RE) || fullLine.match(QUOTE_RE);
				const headEnd = hm ? hm[0].length : (/^\s*/.exec(fullLine) || [""])[0].length;
				if (pos - lineStart <= headEnd) {
					return { type: "indent-at", at: lineStart, cursor: pos + 2 };
				}
				return { type: "indent", insert: "  " };
			}
			return null;
		}

		/**
		 * 选区跨行时的 Tab/Shift+Tab：整块每行行首 ±2 空格（空行不缩进）。
		 * 返回 block-indent（整块替换，选区恢复为新块）；
		 * Shift+Tab 无可删缩进 → tab-noop（吞键防焦点跳）；
		 * Tab 空行块 → 退化为 indent（选区替换为两空格，行内 Tab 语义）。
		 */
		function decideTabBlock(value, from, to, shift) {
			const text = String(value);
			let a = Math.max(0, Math.min(from, to));
			let b = Math.min(Math.max(from, to), text.length);
			a = Math.min(a, text.length);
			const lineStartA = text.lastIndexOf("\n", Math.max(0, a - 1)) + 1;
			const lastNl = text.indexOf("\n", b);
			const blockEnd = lastNl === -1 ? text.length : lastNl;
			const blockLines = text.slice(lineStartA, blockEnd).split("\n");
			const newLines = blockLines.map((l) => (shift ? l.replace(/^[ \t]{1,2}/, "") : (l.trim() === "" ? l : "  " + l)));
			const changed = newLines.some((l, i) => l !== blockLines[i]);
			if (shift && !changed) return { type: "tab-noop" };
			if (!shift && !changed) return { type: "indent", insert: "  " };
			const insert = newLines.join("\n");
			return { type: "block-indent", rangeStart: lineStartA, rangeEnd: blockEnd, insert, selStart: lineStartA, selEnd: lineStartA + insert.length };
		}

		function spanHit(line, col, re, preGroup) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(line))) {
				const s = m.index + (preGroup ? m[1].length : 0);
				if (col >= s && col <= m.index + m[0].length) return true;
			}
			return false;
		}

		function decideActiveMarks(value, pos) {
			const text = String(value || "");
			const s = Math.max(0, Math.min(pos == null ? 0 : pos, text.length));
			const before = text.slice(0, s);
			const lineStart = before.lastIndexOf("\n") + 1;
			const nl = text.slice(s).indexOf("\n");
			const lineEnd = nl === -1 ? text.length : s + nl;
			const line = text.slice(lineStart, lineEnd);
			const col = s - lineStart;
			const marks = [];
			if (spanHit(line, col, /(^|[^`])`([^`]+)`(?!`)/g, true)) marks.push("code");
			if (spanHit(line, col, /\*\*([^*]+)\*\*/g, false)) marks.push("bold");
			else if (spanHit(line, col, /(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, true)) marks.push("italic");
			if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)) marks.push("list");
			const beforeLines = before.split("\n");
			let inCode = false;
			for (let i = 0; i < beforeLines.length - 1; i++) {
				if (FENCE_RE.test(beforeLines[i])) inCode = !inCode;
			}
			if (inCode && !FENCE_RE.test(line)) marks.push("block");
			return marks;
		}

		function isCursorInCodeBlock(value, pos) {
			const text = String(value || "");
			const s = Math.max(0, Math.min(pos == null ? 0 : pos, text.length));
			const before = text.slice(0, s);
			const beforeLines = before.split("\n");
			let inCode = false;
			for (let i = 0; i < beforeLines.length - 1; i++) {
				if (FENCE_RE.test(beforeLines[i])) inCode = !inCode;
			}
			return inCode && !FENCE_RE.test(beforeLines[beforeLines.length - 1]);
		}

		function decidePasteWrap(value, pos, pasted) {
			const text = String(pasted || "");
			if (!text) return null;
			const lines = text.split("\n");
			if (lines.length <= PASTE_WRAP_MAX_LINES && text.length <= PASTE_WRAP_MAX_CHARS) return null;
			if (!guessLang(text)) return null;
			if (isCursorInCodeBlock(value, pos)) return null;
			if (/^(`{3,}|~{3,})/m.test(text)) return null;
			const before = String(value || "").slice(0, pos == null ? 0 : pos);
			const pad = before && !before.endsWith("\n") ? "\n" : "";
			return { insert: pad + "```\n" + text + "\n```\n", pad: pad, lines: lines.length };
		}

		function stateKey(st) {
			return st.inCode + "|" + st.lang + "|" + (st.fenceOpen ? "o" : "") + (st.fenceClose ? "c" : "") + "|" + (st.kind ? st.kind.type : "");
		}

		function isLightColor(colorStr) {
			const m = String(colorStr || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
			if (!m) return false;
			const lum = 0.299 * (+m[1]) + 0.587 * (+m[2]) + 0.114 * (+m[3]);
			return lum < 128;
		}
		//#endregion

		//#region dsh-composer-live: injected styles
		function styleText() {
			return (
				"#" + STYLE_ID + "{}" +
				// 常驻工具栏（absolute 横贯输入卡顶部）：占位由 input/placeholder 的
				// padding-top 同步让出（overlay 的 padding 每次渲染从 input 复制）。
				"." + TOOLBAR + "{position:sticky;top:0;left:0;right:0;z-index:60;display:flex;align-items:center;box-sizing:border-box;height:38px;padding:0 10px;gap:2px;background:rgba(28,30,36,.95);border-bottom:1px solid rgba(127,127,127,.16);}" +
				// sticky 工具栏钉滚动视口顶（v0.2.8）：内容从其下方滚过永不重叠；附件栏在
				// 滚动容器外，scroll 顶=附件栏底，天然让位（v0.2.7 的让位变量退役）。背景色
				// 必须不透明——滚动内容从下方经过（实测反馈「工具栏透明」问题的根治）。
				"body.dsh-cl-light ." + TOOLBAR + "{background:rgba(250,251,253,.97);border-bottom-color:rgba(0,0,0,.08);}" +
				"." + TOOLBAR + " [data-cl=\"expand\"]{margin-left:auto;}" +
				
				// 编辑层与占位层让出工具栏一行（38px 工具栏 + 6px 呼吸）
				CARD_SEL + " " + INPUT_SEL + "{padding-top:" + BAR_RESERVE + " !important;}" +
				CARD_SEL + " " + PLACEHOLDER_SEL + "{padding-top:" + BAR_RESERVE + " !important;box-sizing:border-box;}" +
				// 透明化：只隐藏文字「绘制」（-webkit-text-fill-color），color 属性保留
				// ——caret 颜色、官方 hint ::after、chip 恢复全靠 color 不动。
				// 提层：编辑器自身 z-index:1 画在 overlay（z:0）之上——caret/选区是编辑器
				// 内容的一部分，随层自然盖在 overlay 上（caret 可见），而文字透明不遮挡
				// overlay 的渲染文字。不能用「overlay 压 z-index:-1」的思路：负 z 会掉到
				// 输入框背景之下，渲染文字整体不可见。
				INPUT_SEL + "." + HOST + "{-webkit-text-fill-color:transparent;caret-color:#67a0fe;position:relative;z-index:1;}" +
				// 选中态：Chromium 会用 ::selection 的默认反色把透明文字重绘出来（白字），
				// 与 overlay 渲染文字形成双影——选中文字保持隐形（color:transparent），
				// 但必须同时显式给 background：::selection 规则一旦匹配，未声明的属性
				// 取初始值（transparent），会把浏览器默认高亮一并洗掉（选中无色）。
				SCROLL_SEL + "{--dsh-cl-sel-bg:rgba(103,160,254,.35);}" +
				SCROLL_SEL + ".dsh-cl-light{--dsh-cl-sel-bg:rgba(59,130,246,.28);}" +
				INPUT_SEL + "." + HOST + "::selection{color:transparent;background:var(--dsh-cl-sel-bg);}" +
				INPUT_SEL + "." + HOST + " ::selection{color:transparent;background:var(--dsh-cl-sel-bg);}" +
				// chip（@ 引用胶囊宿主）与热词装饰恢复显示；hint 的 ::after 恢复
				INPUT_SEL + "." + HOST + " " + CHIP_HOST_SEL + "{-webkit-text-fill-color:currentColor;}" +
				INPUT_SEL + "." + HOST + " p::after{-webkit-text-fill-color:currentColor;}" +
				// 含 chip 段落整体恢复（KEEP，JS 打 class）：该段 overlay 只放空占位
				INPUT_SEL + "." + HOST + " p." + KEEP + "{-webkit-text-fill-color:currentColor;}" +
				// 代码段（编辑器）等宽：整框切换，与 overlay 渲染段同字体变量
				INPUT_SEL + "." + MONO_ALL + "{font-family:var(--dsh-cl-code-font,var(--ds-font-family-code,monospace)) !important;}" +
				// 按钮
				".dsh-cl-btn{display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;border-radius:7px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;padding:0;line-height:0;transition:background .15s ease,transform .1s ease;}" +
				".dsh-cl-btn:hover{background:rgba(127,127,127,.18);}" +
				".dsh-cl-btn:active{transform:scale(.92);background:rgba(127,127,127,.28);}" +
				".dsh-cl-btn:focus-visible{outline:2px solid #3b82f6;outline-offset:1px;}" +
				".dsh-cl-btn svg{width:15px;height:15px;opacity:.85;}" +
				".dsh-cl-btn:hover svg{opacity:1;}" +
				".dsh-cl-btn.dsh-cl-active{background:rgba(59,130,246,.16);color:#3b82f6;}" +
				// 展开态：滚动容器定高 70vh（只有 max-height 时高度仍由内容决定——
				// 内容少的瞬间点展开纹丝不动，用户感知「按钮失效」）
				"." + EXPANDED + "{max-height:70vh !important;height:70vh !important;}" +
				// 自建实时渲染层：铺满 grow、z:0（编辑器 z:1 盖其上，caret/选区可见）、点击穿透
				"." + LIVE + "{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;}" +
				"." + LIVE + " div{margin:var(--dsh-cl-line-margin,0);}" +
				// 哨兵：零尺寸不占布局，读官方输入框继承字体链
				"." + SENTINEL + "{position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;}" +
				// 行内渲染标签样式（作用于 overlay）。
				// 粗体/标题一律 paint-only（-webkit-text-stroke 伪粗），font-weight 变化
				// 会改字符 advance——渲染行与编辑器透明文字错位，光标漂移。
				"." + LIVE + " strong{font-weight:inherit;-webkit-text-stroke:.45px currentColor;}" +
				"." + LIVE + " em{font-style:italic;}" +
				"." + LIVE + " del{text-decoration:line-through;opacity:.75;}" +
				"." + LIVE + " a{color:#3b82f6;text-decoration:none;}" +
				"." + LIVE + " code{font-family:inherit;color:#3b82f6;background:rgba(59,130,246,.13);border-radius:5px;padding:1px 5px;margin:0 -5px;}" +
				// 行内格式的标记字符（**、`、~~、[]()）：淡化但保留占位（字符级对齐）
				".dsh-cl-mk{color:rgba(127,127,127,.5);}" +

				".dsh-cl-hmark{color:#3b82f6;font-weight:inherit;-webkit-text-stroke:.45px currentColor;}" +
				".dsh-cl-heading{font-weight:inherit;-webkit-text-stroke:.45px currentColor;}" +
				".dsh-cl-qmark{color:#3b82f6;}" +
				".dsh-cl-quote{position:relative;z-index:0;}" +
				".dsh-cl-quote::before{content:\"\";position:absolute;inset:0 -12px;background:rgba(127,127,127,.10);border-left:3px solid #3b82f6;z-index:-1;}" +
				".dsh-cl-lmark{color:#3b82f6;}" +
				".dsh-cl-tmark{color:#8b949e;}" +
				".dsh-cl-img{background:rgba(59,130,246,.13);color:#3b82f6;border-radius:5px;padding:1px 5px;margin:0 -5px;}" +
				// 代码段 overlay 行：等宽 + 伪元素外扩背景（GitHub Dark/Light 两套变量）
				SCROLL_SEL + "{--dsh-cl-tok-kw:#ff7b72;--dsh-cl-tok-str:#a5d6ff;--dsh-cl-tok-com:#8b949e;--dsh-cl-tok-num:#79c0ff;--dsh-cl-tok-fn:#d2a8ff;--dsh-cl-tok-lit:#79c0ff;--dsh-cl-code-bg:rgba(13,17,23,.92);--dsh-cl-lang-fg:rgba(249,250,251,.9);}" +
				SCROLL_SEL + ".dsh-cl-light{--dsh-cl-tok-kw:#cf222e;--dsh-cl-tok-str:#0a3069;--dsh-cl-tok-com:#6e7781;--dsh-cl-tok-num:#0550ae;--dsh-cl-tok-fn:#8250df;--dsh-cl-tok-lit:#0550ae;--dsh-cl-code-bg:rgba(246,248,250,.96);--dsh-cl-lang-fg:rgba(31,35,40,.85);}" +
				".dsh-cl-cline{position:relative;z-index:0;}" +
				".dsh-cl-cline{font-family:var(--dsh-cl-code-font,var(--ds-font-family-code,monospace));}" +
				".dsh-cl-cline::before{content:\"\";position:absolute;inset:0 -12px;background:var(--dsh-cl-code-bg);border-radius:0;z-index:-1;}" +
				".dsh-cl-cline.dsh-cl-fence-open::before{border-radius:10px 10px 0 0;inset:2px -14px 0;}" +
				".dsh-cl-cline.dsh-cl-fence-close::before{border-radius:0 0 10px 10px;inset:0 -14px 2px;}" +
				".dsh-cl-fch{visibility:hidden;}" +
				".dsh-cl-lang{position:absolute;right:26px;font-size:10px;line-height:1;padding:3px 7px;border-radius:5px;background:rgba(127,127,127,.3);border:1px solid rgba(255,255,255,.12);letter-spacing:.07em;text-transform:uppercase;color:var(--dsh-cl-lang-fg);pointer-events:none;}" +
				// ===== 字符锚定渲染（v0.2）：定位字符段 + 背景块 =====
				// 字符段：绝对定位画在编辑器字符 rect 上；字体继承 overlay（syncMetrics
				// 复制官方度量）；样式类只改 paint（伪粗/染色/胶囊背景外扩），零 advance 变化。
				".dsh-cl-c{position:absolute;white-space:pre;pointer-events:none;color:inherit;font-family:inherit;}" +
				".dsh-cl-c.dsh-cl-codefont{font-family:var(--dsh-cl-code-font,var(--ds-font-family-code,monospace));}" +
				".dsh-cl-c.dsh-cl-strong,.dsh-cl-c.dsh-cl-heading{font-weight:inherit;-webkit-text-stroke:.45px currentColor;}" +
				".dsh-cl-c.dsh-cl-em{font-style:italic;}" +
				// cd/img 胶囊背景外扩：横向 padding+负 margin 互相抵消（advance 零变化）；
				// 垂直同理必须 margin:-1px 抵消 padding-top:1px——段是绝对定位块，
				// 只补横向会让段内文字整体下移 1px（E2E INV-3 实测 dy 恒 +1.00）。
				".dsh-cl-c.dsh-cl-cd{color:#3b82f6;background:rgba(59,130,246,.13);border-radius:5px;padding:1px 5px;margin:-1px -5px;}" +
				".dsh-cl-c.dsh-cl-dl{text-decoration:line-through;opacity:.75;}" +
				".dsh-cl-c.dsh-cl-lk{color:#3b82f6;}" +
				".dsh-cl-c.dsh-cl-mk{color:rgba(127,127,127,.5);}" +
				".dsh-cl-c.dsh-cl-hmark{color:#3b82f6;}" +
				".dsh-cl-c.dsh-cl-qmark{color:#3b82f6;}" +
				".dsh-cl-c.dsh-cl-lmark{color:#3b82f6;}" +
				// 任务列表勾选标记（[ ]/[x] 三字符胶囊；done 绿底+行内容划线由 dsh-cl-dl）
				".dsh-cl-c.dsh-cl-task{color:rgba(127,127,127,.55);background:rgba(59,130,246,.12);border-radius:4px;padding:1px 3px;margin:-1px -3px;}" +
				".dsh-cl-c.dsh-cl-task-done{color:#16a34a;background:rgba(34,197,94,.18);}" +
				".dsh-cl-c.dsh-cl-tmark{color:#8b949e;}" +
				".dsh-cl-c.dsh-cl-img{color:#3b82f6;background:rgba(59,130,246,.13);border-radius:5px;padding:1px 5px;margin:-1px -5px;}" +
				".dsh-cl-c.dsh-cl-tok-kw{color:var(--dsh-cl-tok-kw);}" +
				".dsh-cl-c.dsh-cl-tok-str{color:var(--dsh-cl-tok-str);}" +
				".dsh-cl-c.dsh-cl-tok-com{color:var(--dsh-cl-tok-com);}" +
				".dsh-cl-c.dsh-cl-tok-num{color:var(--dsh-cl-tok-num);}" +
				".dsh-cl-c.dsh-cl-tok-fn{color:var(--dsh-cl-tok-fn);}" +
				".dsh-cl-c.dsh-cl-tok-lit{color:var(--dsh-cl-tok-lit);}" +
				// 背景块：代码行（外扩已含在 JS 定位里）/ 引用行
				".dsh-cl-bg{position:absolute;background:var(--dsh-cl-code-bg);pointer-events:none;}" +
				".dsh-cl-bg-open{border-radius:10px 10px 0 0;}" +
				".dsh-cl-bg-close{border-radius:0 0 10px 10px;}" +
				".dsh-cl-qbg{position:absolute;background:rgba(127,127,127,.10);border-left:3px solid #3b82f6;pointer-events:none;}" +
				".dsh-cl-tok-kw{color:var(--dsh-cl-tok-kw);}" +
				".dsh-cl-tok-str{color:var(--dsh-cl-tok-str);}" +
				".dsh-cl-tok-com{color:var(--dsh-cl-tok-com);}" +
				".dsh-cl-tok-num{color:var(--dsh-cl-tok-num);}" +
				".dsh-cl-tok-fn{color:var(--dsh-cl-tok-fn);}" +
				".dsh-cl-tok-lit{color:var(--dsh-cl-tok-lit);}" +
				// 选区浮动格式条：body 级 fixed（避免被输入卡 overflow 裁剪）
				"." + FLOAT + "{position:fixed;z-index:80;display:none;align-items:center;gap:2px;padding:3px;border-radius:9px;background:rgba(28,30,36,.95);border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 14px rgba(0,0,0,.28);}" +
				"." + FLOAT + ".dsh-cl-float-on{display:flex;}" +
				"body.dsh-cl-light ." + FLOAT + "{background:rgba(250,251,253,.97);border-color:rgba(0,0,0,.08);}" +
				// 轻提示
				"." + TOAST + "{position:absolute;top:-40px;left:50%;transform:translateX(-50%);z-index:70;background:rgba(28,30,36,.93);color:rgba(240,242,246,.95);font-size:12px;line-height:1;padding:8px 14px;border-radius:8px;pointer-events:none;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.09);opacity:0;transition:opacity .18s ease;}" +
				"." + TOAST + ".dsh-cl-toast-on{opacity:1;}" +
				SCROLL_SEL + ".dsh-cl-light ." + TOAST + "{background:rgba(250,251,253,.96);color:rgba(28,32,40,.92);border-color:rgba(0,0,0,.08);}" +
				""
			);
		}
		//#endregion

		//#region dsh-composer-live: DOM 工具
		function findCard() {
			return document.querySelector(CARD_SEL);
		}

		function toast(card, message) {
			if (!card) return;
			let el = card.querySelector("." + TOAST);
			if (!el) {
				el = document.createElement("div");
				el.className = TOAST;
				el.setAttribute("aria-hidden", "true");
				card.appendChild(el);
			}
			el.textContent = message;
			void el.offsetWidth;
			el.classList.add("dsh-cl-toast-on");
			clearTimeout(el.__dshClToastTimer);
			el.__dshClToastTimer = setTimeout(() => el.classList.remove("dsh-cl-toast-on"), 2500);
		}

		/** aria-label 命中提示集合的按钮查找（限定 root 内）。 */
		function findButtonByHint(root, hints) {
			if (!root || !root.querySelectorAll) return null;
			for (const b of root.querySelectorAll("button")) {
				const label = b.getAttribute("aria-label") || "";
				for (const h of hints) {
					if (label === h || label.indexOf(h) !== -1) return b;
				}
			}
			return null;
		}

		/** 官方候选建议/弹层是否开着（开着时 Enter/Tab/Esc/粘贴一律归官方）。 */
		function menuOpen(card) {
			if (!card || !card.querySelector) return false;
			return card.querySelector(MENU_SEL) !== null;
		}

		function iconSvg(kind) {
			const S = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
			const icons = {
				bold: '<path d="M4 2.5h4.2a2.4 2.4 0 0 1 0 4.8H4zm0 4.8h4.8a2.6 2.6 0 0 1 0 5.2H4z"/>',
				italic: '<path d="M10.5 2.5h-4M9.5 13.5h-4M9.8 2.5L6.2 13.5"/>',
				code: '<path d="M9.5 4L5.5 8l4 4M13 4L9 8l4 4"/>',
				link: '<path d="M6.5 9.5l3-3M5 7L3.8 8.2a2.4 2.4 0 0 0 3.4 3.4L8.4 10.4M11 9l1.2-1.2a2.4 2.4 0 0 0-3.4-3.4L7.6 5.6"/>',
				list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="2.8" cy="12" r=".9" fill="currentColor" stroke="none"/>',
				block: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M5.5 6.5L4 8l1.5 1.5M10.5 6.5L12 8l-1.5 1.5"/>',
				expand: '<path d="M3 6V3h3M13 10v3h-3M3 10v3h3M13 6V3h-3"/>',
				collapse: '<path d="M6 10v3H3M10 6V3h3M6 6V3H3M10 10v3h3"/>'
			};
			return S + (icons[kind] || icons.expand) + "</svg>";
		}
		//#endregion

		//#region dsh-composer-live: 编辑器「投影文本」与 DOM Selection 映射
		/**
		 * 0.1.5 编辑器的真实 DOM 形态（实测于 dsh 0.1.5 web 应用）：**单个 <p> + <br>（Lexical
		 * LineBreakNode）分 行**，文本在 <span data-lexical-text> 里，chip 宿主是
		 * <span data-composer-chip|data-composer-text-ref>。setDraft（程序化灌入）
		 * 才会产生多个 <p>。因此「行」按 br 与 p 边界切，不按 p 元素切。
		 *
		 * buildAnchors 深度遍历编辑器根，产出锚表：
		 *   {kind:'text', node, len}   文本节点（投影=nodeValue）
		 *   {kind:'br', len:1}         行分隔（投影=\n）
		 *   {kind:'chip', el, len:1}   chip 宿主（投影=￼，与官方 detectText 同构）
		 *   {kind:'para', len:1}       p 元素边界（投影=\n）
		 * 投影文本 = 锚表顺序拼接；行序列 = 投影文本 split("\n")。
		 * 光标/选区与投影 offset 的互查全部基于锚表。
		 */
		function buildAnchors(input) {
			const anchors = [];
			if (!input) return anchors;
			let firstPara = true;
			const visit = (node) => {
				for (let c = node.firstChild; c; c = c.nextSibling) {
					if (c.nodeType === Node.TEXT_NODE) {
						if (c.nodeValue.length > 0) anchors.push({ kind: "text", node: c, len: c.nodeValue.length });
					} else if (c.nodeType === Node.ELEMENT_NODE) {
						if (c.tagName === "BR") {
							// Lexical 的行尾 managed br（data-lexical-managed-linebreak）是
							// 「让空行可见」的占位标记，不产生新行——不计为行分隔。
							if (c.getAttribute && c.getAttribute("data-lexical-managed-linebreak") != null) continue;
							anchors.push({ kind: "br", el: c, len: 1 });
							continue;
						}
						if (c.tagName === "P") {
							if (!firstPara) anchors.push({ kind: "para", el: c, len: 1 });
							firstPara = false;
							visit(c);
							continue;
						}
						if (c.matches && c.matches(CHIP_HOST_SEL)) { anchors.push({ kind: "chip", el: c, len: 1 }); continue; }
						// 其余元素（B/I/STRONG/DIV 等富文本粘贴产物、装饰壳）一律继续
						// 下钻收集文字——「忽略内容」会把粘贴的富文本结构整个漏掉：锚表
						// 空转 → 渲染层空白 + 透明化已生效 = 大段粘贴「一片空白」（文字
						// 在编辑器里透明不可见，发送时却在）。chip 宿主已在上面拦截。
						visit(c);
					}
				}
			};
			visit(input);
			return anchors;
		}

		/** 锚表 → 投影文本。 */
		function anchorsText(anchors) {
			let s = "";
			for (const a of anchors) {
				if (a.kind === "text") s += a.node.nodeValue;
				else if (a.kind === "chip") s += CHIP_CHAR;
				else s += "\n";
			}
			return s;
		}

		/**
		 * DOM Selection 某端（node, offset）→ 投影 offset。锚表顺序累计，端点在
		 * 文本节点上取其锚起点 + offset；端点在元素上（选区端在元素边界）按
		 * 「该元素子树首个文本锚起点」近似。不在编辑器内返回 null。
		 */
		function offsetFromSelection(input, anchors, node, off) {
			if (!node || !input.contains(node)) return null;
			let acc = 0;
			for (const a of anchors) {
				if (a.kind === "text") {
					if (a.node === node) return acc + Math.min(off, a.len);
					if (a.node.parentElement === node) return acc; // 端点在父元素 offset=0 的保守近似
					acc += a.len;
				} else {
					if (a.el === node) return acc; // 端点恰在 br/chip 元素上
					if (node.nodeType === Node.ELEMENT_NODE && (a.kind === "chip") && a.el.contains(node)) return acc;
					acc += 1;
				}
			}
			return acc;
		}

		/** DOM Selection 的 anchor/focus 端 → 投影 offset。 */
		function domOffsetOf(input, anchors, useAnchor) {
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0) return null;
			const node = useAnchor ? sel.anchorNode : sel.focusNode;
			const off = useAnchor ? sel.anchorOffset : sel.focusOffset;
			return offsetFromSelection(input, anchors, node, off);
		}

		/** 投影 offset → DOM Range 起点（沿锚表走到目标；br/chip 处取其后）。 */
		function rangeAtOffset(input, anchors, absOffset) {
			let acc = 0;
			const range = document.createRange();
			for (const a of anchors) {
				if (a.kind === "text") {
					if (absOffset <= acc + a.len) {
						try { range.setStart(a.node, Math.max(0, absOffset - acc)); } catch (err) { return null; }
						return range;
					}
					acc += a.len;
				} else {
					acc += 1;
					if (absOffset <= acc) {
						try { range.setStartAfter(a.el); } catch (err) { return null; }
						return range;
					}
				}
			}
			// 超尾：落在最后一个文本锚尾
			for (let i = anchors.length - 1; i >= 0; i--) {
				if (anchors[i].kind === "text") {
					try { range.setStart(anchors[i].node, anchors[i].len); } catch (err) { return null; }
					return range;
				}
			}
			try { range.selectNodeContents(input); range.collapse(false); } catch (err) { return null; }
			return range;
		}

		/** 设置 DOM Selection（投影文本 offset 区间）。 */
		function setSelectionByOffset(input, start, end) {
			const anchors = buildAnchors(input);
			const ra = rangeAtOffset(input, anchors, start);
			const rb = end == null || end === start ? ra : rangeAtOffset(input, anchors, end);
			if (!ra || !rb) return;
			const sel = window.getSelection();
			sel.removeAllRanges();
			const full = document.createRange();
			full.setStart(ra.startContainer, ra.startOffset);
			full.setEnd(rb.startContainer, rb.startOffset);
			sel.addRange(full);
		}
		//#endregion

		//#region dsh-composer-live: 渲染引擎
		/** 从编辑层复制影响排版与对齐的度量到 overlay（签名变化才重写）。
		 * font/行高度量优先从编辑器首个 <p>（行的真实排版容器）读——行高用 p 的
		 * computed line-height（行盒高，不是字形高；合成栈的 normal 行高不同但
		 * overlay 行 div 走同一 computed 值即可对齐）；padding 从 input 读；
		 * 首行常量垂直偏差（实测 ~2px）用动态 top 偏移吸收。 */
		const METRIC_KEYS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
			"tabSize", "whiteSpace", "wordBreak", "overflowWrap", "wordWrap",
			"boxSizing", "textAlign", "textIndent"];
		function syncMetrics(input, ov) {
			const cs = getComputedStyle(input);
			const fp = input.querySelector(":scope > p");
			const fc = fp ? getComputedStyle(fp) : cs;
			let color = cs.color;
			if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") {
				color = getComputedStyle(input.parentElement).color;
			}
			const sig = [fc.fontFamily, fc.fontSize, fc.fontWeight, fc.lineHeight, cs.padding, color].join("|");
			if (ov.__dshClSig === sig) return color;
			for (const k of METRIC_KEYS) ov.style[k] = fc[k];
			ov.style.padding = cs.padding;
			ov.style.setProperty("--dsh-cl-line-margin", fc.marginTop + " 0 " + fc.marginBottom);
			ov.style.color = color;
			ov.__dshClSig = sig;
			return color;
		}

		/**
		 * 主渲染（幂等；所有同步路径必经）：
		 * 锚表收集（br/p 切行）→ 增量渲染 overlay 行 → 编辑器 p 打 class（chip 恢复
		 * 优先 / 代码行等宽）→ 度量/主题/工具栏高亮。
		 *
		 * 行对齐说明：编辑器是单 p + br 分行，行高由 font/line-height 决定——overlay
		 * 与编辑器同字体同行高（syncMetrics 复制），行高天然一致，无需逐行高度对齐。
		 */
		function render(card) {
			const input = card.querySelector(INPUT_SEL);
			const ov = card.querySelector("." + LIVE);
			if (!input || !ov) return;
			fixTriggerMenuPos(card); // 官方菜单悬空兜底（图片附件在场时 @// 菜单定位）
			const editable = input.getAttribute("contenteditable") === "true";
			input.classList.toggle(HOST, editable);
			if (!editable) {
				ov.innerHTML = "";
				ov.__dshClLineCache = null;
				return;
			}
			const anchors = buildAnchors(input);
			const src = anchorsText(anchors);
			const lines = src.split("\n");
			const caret = domOffsetOf(input, anchors, true);
			const cursorLine = caret == null ? -1 : src.slice(0, caret).split("\n").length - 1;

			// 合成字体栈（拉丁=代码等宽，中文=界面栈）写入 card 变量
			const sentinel = card.__dshClSentinel;
			if (sentinel && sentinel.isConnected) {
				const sc = getComputedStyle(sentinel);
				const merged = buildCodeFont(sc.getPropertyValue("--ds-font-family-code"), sc.fontFamily);
				if (card.__dshClFontSig !== merged) {
					card.__dshClFontSig = merged;
					card.style.setProperty("--dsh-cl-code-font", merged);
				}
			}

			// 编辑器 class（打点在测量前——等宽打点影响布局，先定型再测量）：
			// - KEEP（chip 段恢复）段落级
			// - 等宽「整框」级：文档含已闭合代码块 → input 整框切等宽、渲染全段同栈
			//   （v0.1.x 同策略）。行级等宽（MONO_SPAN）在「字面 \n」形态物理不可行：
			//   大段粘贴是单文本锚跨全部行，class 只能打锚 parent（波及整锚），且打点
			//   循环的行号推进对字面 \n 会全部落 0（v0.2.3 只修了测量侧）。整框两侧
			//   恒同字体，测量 rect 自动跟随。
			const states = computeBlockStates(lines);
			const ps = input.querySelectorAll(":scope > p");
			const hasChip = lines.some(paraHasChip);
			for (const p of ps) {
				p.classList.toggle(KEEP, hasChip);
			}
			const hasCode = states.some((st) => st.inCode);
			input.classList.toggle(MONO_ALL, hasCode);

			// 度量与主题（字符渲染的字体继承 overlay——syncMetrics 复制的度量仍是基准）
			const scrollEl = card.querySelector(SCROLL_SEL);
			const color = syncMetrics(input, ov);
			if (scrollEl) {
				scrollEl.classList.toggle("dsh-cl-light", isLightColor(color));
				document.body.classList.toggle("dsh-cl-light", isLightColor(color));
			}

			// 字符锚定渲染：逐字符测量编辑器 rect，渲染字符绝对定位画在同一坐标。
			// 三类兜底（都回退官方显示——移除透明化，保证任何情况都有文字可读；
			// 官方文字与渲染段同字体同坐标，来回切换无视觉跳变，下一轮渲染自愈）：
			// ① 锚表漏收检测：编辑器有文字但投影文本全空（未来官方结构变化/未知
			//    元素吞内容）——继续渲染就是「一片空白」；
			// ② 渲染抛错：测量/解析异常时 overlay 停在空白态 + 透明化已生效，同样空白；
			// ③ 批量插入中间态：粘贴等大段内容进入的窗口期（官方插入是异步的，渲染
			//    尚未跟上），「编辑器已有字但渲染段为 0」——此前用户看到的「粘贴后
			//    一片空白」正是这个约 1 秒的空窗（诊断实测：粘贴 1 秒后渲染正常）。
			const fallbackToOfficial = () => {
				input.classList.remove(HOST);
				input.classList.remove(MONO_ALL);
				input.querySelectorAll("." + KEEP).forEach((el) => el.classList.remove(KEEP));
				ov.innerHTML = "";
			};
			const hasContent = input.textContent.replace(/￼/g, "").trim() !== "";
			if (hasContent && src.replace(/￼/g, "").trim() === "") {
				fallbackToOfficial();
			} else {
				try {
					renderCharOverlay(ov, input, anchors, lines, states);
					if (hasContent && ov.querySelectorAll(".dsh-cl-c").length === 0) fallbackToOfficial();
				} catch (err) {
					fallbackToOfficial();
				}
			}

			// 工具栏高亮
			if (card.__dshClBtns && caret != null) {
				const marks = decideActiveMarks(src, caret);
				for (const kind in card.__dshClBtns) {
					card.__dshClBtns[kind].classList.toggle("dsh-cl-active", marks.indexOf(kind) !== -1);
				}
			}
			card.__dshClSrc = src;
			card.__dshClCaret = caret;
		}
		//#endregion

		//#region dsh-composer-live: 插入通道
		/**
		 * 文本插入（单行/多行统一）：**合成 beforeinput 事件** → Lexical 原生编辑
		 * 管线（保撤销栈）。一律 setTimeout(0) 延后执行。
		 *
		 * 四个实测坑（Chromium + Lexical 0.49）：
		 * ① **keydown 处理器内执行编辑类 execCommand 静默失败**（返回 true 零效果）
		 *   ——必须延后到事件处理完（setTimeout 0 实测生效）。
		 * ② execCommand("insertText") 对含 \n 的文本静默失败。
		 * ③ 「合成 paste 事件」复用官方 PASTE_COMMAND 也不行：官方 handler 走
		 *   SessionInputShell.paste → selection.insertText(clean)，Lexical 的
		 *   insertText 把 \n 当普通字符插进同一文本节点。
		 * ④ 唯一全通的通道 = 合成 beforeinput：inputType=insertText（带 data）插
		 *   文本、inputType=insertParagraph 插换行（Lexical LineBreakNode，即官方
		 *   Shift+Enter 的产物）。两者 Lexical 都异步 commit——效果要下一帧才可见。
		 */
		function insertInline(input, text) {
			setTimeout(() => {
				try {
					const s = String(text);
					if (s.indexOf("\n") === -1) {
						// 单行：execCommand（keydown 处理器外实测有效；合成 beforeinput
						// 的 insertText 在 keydown 后的 setTimeout 里偶发不生效——Tab 缩进实测）
						document.execCommand("insertText", false, s);
						return;
					}
					const lines = s.split("\n");
					for (let i = 0; i < lines.length; i++) {
						if (i > 0) {
							input.dispatchEvent(new InputEvent("beforeinput", {
								inputType: "insertParagraph", bubbles: true, cancelable: true
							}));
						}
						if (lines[i]) {
							input.dispatchEvent(new InputEvent("beforeinput", {
								inputType: "insertText", data: lines[i], bubbles: true, cancelable: true
							}));
						}
					}
				} catch (err) { /* 编辑区失焦等场景静默放弃 */ }
			}, 0);
			return true;
		}

		/** 工具栏格式动作执行（value/选区基于「投影文本」）。 */
		function applyWrapAction(card, input, kind) {
			const anchors = buildAnchors(input);
			const src = anchorsText(anchors);
			const anchor = domOffsetOf(input, anchors, true);
			if (anchor == null) return;
			const focus = domOffsetOf(input, anchors, false);
			const start = focus == null ? anchor : Math.min(anchor, focus);
			const end = focus == null ? anchor : Math.max(anchor, focus);
			const act = decideWrapAction(src, start, end, kind);
			if (!act) return;
			input.focus();
			if (act.at != null) {
				// list：光标行行首插入（单行）
				setSelectionByOffset(input, act.at, act.at);
				insertInline(input, act.insert);
			} else if (act.insert.indexOf("\n") === -1) {
				// 行内格式（bold/italic/code/link）：替换选区（单行）
				setSelectionByOffset(input, start, end);
				insertInline(input, act.insert);
				requestAnimationFrame(() => setSelectionByOffset(input, act.cursorStart, act.cursorEnd == null ? act.cursorStart : act.cursorEnd));
			} else {
				// 代码块（多行）：beforeinput 逐行序列
				insertInline(input, act.insert);
			}
		}
		//#endregion

		//#region dsh-composer-live: 候选菜单定位修正（官方 bug 兜底）
	/**
	 * 官方 input-trigger 候选菜单（[data-trigger-menu]，@ 引用与 / 命令共用）向上
	 * 展开时锚定「输入组件容器顶」——输入框带图片附件（附件栏占编辑器上方
	 * 66px+）时锚点不随之下移，菜单悬空 84px、整体浮出输入卡 300px+ 盖在
	 * 消息流上（2026-09-25 三组对照实测：无图 gap=12px 正常 / 有图 gap=84px /
	 * 抵消插件 padding-top 不变 → 官方自身定位问题，非本插件引入）。
	 *
	 * 兜底：菜单底边与编辑器顶的间隙 > 30px 时，用 transform:translateY 平移
	 * 到贴住编辑器上沿（同无附件形态，gap≈12px）。**必须用 translateY**：
	 * 实测官方菜单是 absolute + bottom:4px 锚定——bottom 锚定时 margin-top
	 * 零位移（首版 marginTop 方案实测不动，且 gap 不收敛导致叠加正反馈失控
	 * 累积到 7704px）、top 会与 bottom 冲突拉伸高度；官方无 transform（无弹出
	 * 动画冲突），getBoundingClientRect 含 transform——每轮重测实测 rect 天然
	 * 幂等收敛（gap 修到 12 即停），官方重开菜单是新元素修正不残留。只管与
	 * 输入卡横向重叠且向上展开（底边在编辑器上方）的菜单，向下展开与其他
	 * 组件弹层不碰；600px 上限防不可控场景的无限叠加。
	 */
	function fixTriggerMenuPos(card) {
		const input = card.querySelector(INPUT_SEL);
		if (!input) return;
		const inputTop = input.getBoundingClientRect().top;
		const cardRect = card.getBoundingClientRect();
		for (const menu of document.querySelectorAll("[data-trigger-menu]")) {
			if (!menu.isConnected) continue;
			const mr = menu.getBoundingClientRect();
			if (mr.width === 0 || mr.height === 0) continue;
			if (mr.right < cardRect.left || mr.left > cardRect.right) continue; // 与输入卡无关的弹层
			const gap = inputTop - mr.bottom;
			if (gap <= 30) continue; // 12px 正常贴边；向下展开 gap 为负
			const applied = parseFloat(menu.dataset.dshClTy) || 0;
			const total = applied + (gap - 12);
			if (total > 600) continue; // 防御：修不动（官方定位法变化）就别叠加
			menu.style.transform = "translateY(" + total + "px)";
			menu.dataset.dshClTy = String(total);
		}
	}
	//#endregion

	//#region dsh-composer-live: 选区浮动格式条
		function updateFloat(card, floatBar) {
			const input = card.querySelector(INPUT_SEL);
			if (!input || input.getAttribute("contenteditable") !== "true") { floatBar.classList.remove("dsh-cl-float-on"); return; }
			if (menuOpen(card)) { floatBar.classList.remove("dsh-cl-float-on"); return; }
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.anchorNode || !input.contains(sel.anchorNode)) {
				floatBar.classList.remove("dsh-cl-float-on");
				return;
			}
			const text = String(sel);
			if (!text.trim()) { floatBar.classList.remove("dsh-cl-float-on"); return; }
			const rect = sel.getRangeAt(0).getBoundingClientRect();
			if (!rect || (rect.width === 0 && rect.height === 0)) { floatBar.classList.remove("dsh-cl-float-on"); return; }
			floatBar.style.left = Math.round(rect.left + rect.width / 2 - 70) + "px";
			floatBar.style.top = Math.round(rect.top - 40) + "px";
			floatBar.classList.add("dsh-cl-float-on");
		}
		//#endregion

		//#region dsh-composer-live: Esc 分发
		function handleEscape(e, card) {
			if (menuOpen(card)) return; // 候选/弹层开着 → 归官方
			const scroll = card.querySelector(SCROLL_SEL);
			if (scroll && scroll.classList.contains(EXPANDED)) {
				const btn = card.querySelector('[data-cl="expand"]');
				if (btn) btn.click();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			const stop = findButtonByHint(card, STOP_BTN_HINTS);
			if (stop) {
				e.preventDefault();
				e.stopPropagation();
				stop.click();
			}
		}
		//#endregion

		//#region dsh-composer-live: DOM wiring
		function setupCard(card) {
			if (!card) return;
			const input = card.querySelector(INPUT_SEL);
			if (!input) return;

			if (card.getAttribute(READY_KEY) !== "1" && !card.querySelector("." + TOOLBAR)) {
				card.setAttribute(READY_KEY, "1");
				const scroll = card.querySelector(SCROLL_SEL);
				if (scroll) scroll.classList.add("dsh-cl-anchor");

				// 常驻格式工具栏（6 格式键 + 展开键）
				const toolbar = document.createElement("div");
				toolbar.className = TOOLBAR;
				toolbar.setAttribute("role", "toolbar");
				toolbar.setAttribute("aria-label", "格式工具栏");
				const fmtBtn = (kind, icon, label) => {
					const b = document.createElement("button");
					b.type = "button";
					b.className = "dsh-cl-btn";
					b.dataset.cl = kind;
					b.title = label;
					b.setAttribute("aria-label", label);
					b.innerHTML = iconSvg(icon);
					b.addEventListener("mousedown", (ev) => ev.preventDefault());
					b.addEventListener("click", () => {
						const c = findCard();
						const i = c && c.querySelector(INPUT_SEL);
						if (!i) return;
						applyWrapAction(c, i, kind);
						render(c);
					});
					card.__dshClBtns = card.__dshClBtns || {};
					card.__dshClBtns[kind] = b;
					return b;
				};
				toolbar.appendChild(fmtBtn("bold", "bold", "粗体 **文字**"));
				toolbar.appendChild(fmtBtn("italic", "italic", "斜体 *文字*"));
				toolbar.appendChild(fmtBtn("code", "code", "行内代码 `代码`"));
				toolbar.appendChild(fmtBtn("link", "link", "链接 [文字](地址)"));
				toolbar.appendChild(fmtBtn("list", "list", "列表项 - "));
				toolbar.appendChild(fmtBtn("block", "block", "代码块 ```"));
				const expandBtn = document.createElement("button");
				expandBtn.type = "button";
				expandBtn.className = "dsh-cl-btn";
				expandBtn.dataset.cl = "expand";
				expandBtn.title = "展开 / 收起（70vh 写作区）";
				expandBtn.setAttribute("aria-label", "展开或收起写作区");
				expandBtn.innerHTML = iconSvg("expand");
				expandBtn.addEventListener("mousedown", (ev) => ev.preventDefault());
				expandBtn.addEventListener("click", () => {
					const s = card.querySelector(SCROLL_SEL);
					if (!s) return;
					const on = s.classList.toggle(EXPANDED);
					expandBtn.classList.toggle("dsh-cl-active", on);
					expandBtn.title = on ? "收起（恢复自动高度）" : "展开（70vh 写作区）";
					expandBtn.innerHTML = iconSvg(on ? "collapse" : "expand");
				});
				toolbar.appendChild(expandBtn);
				card.__dshClToolbar = toolbar; // 只创建不挂载——sticky 需挂进滚动容器，见下方 grow 块
				// 挂载延后到 grow（sticky 需在滚动容器内，与 overlay 同一安全位置）

				// 选区浮动格式条（body 级 fixed）
				const floatBar = document.createElement("div");
				floatBar.className = FLOAT;
				floatBar.setAttribute("role", "toolbar");
				floatBar.setAttribute("aria-label", "选区格式");
				const mkFloatBtn = (kind, icon, label) => {
					const b = document.createElement("button");
					b.type = "button";
					b.className = "dsh-cl-btn";
					b.title = label;
					b.setAttribute("aria-label", label);
					b.innerHTML = iconSvg(icon);
					b.addEventListener("mousedown", (ev) => ev.preventDefault());
					b.addEventListener("click", () => {
						const c = findCard();
						const i = c && c.querySelector(INPUT_SEL);
						if (!i) return;
						applyWrapAction(c, i, kind);
						render(c);
					});
					return b;
				};
				floatBar.appendChild(mkFloatBtn("bold", "bold", "粗体"));
				floatBar.appendChild(mkFloatBtn("italic", "italic", "斜体"));
				floatBar.appendChild(mkFloatBtn("code", "code", "行内代码"));
				floatBar.appendChild(mkFloatBtn("link", "link", "链接"));
				document.body.appendChild(floatBar);
				card.__dshClFloat = floatBar;

				// 事件监听（挂 card capture，React/Lexical 替换内部节点后依然有效）
				if (card.__dshClDisposables) {
					for (const d of card.__dshClDisposables) { try { d(); } catch (err) { /* 已失效 */ } }
				}
				const disposables = card.__dshClDisposables = [];
				const on = (type, fn, opts) => {
					card.addEventListener(type, fn, opts);
					disposables.push(() => card.removeEventListener(type, fn, opts));
				};

				let rafId = 0;
				const lite = () => {
					const c = findCard();
					if (!c) return;
					render(c);
				};
				const liteRaf = () => {
					if (rafId) return;
					rafId = requestAnimationFrame(() => { rafId = 0; lite(); });
				};

				on("input", liteRaf, true);
				on("compositionstart", () => { card.__dshClComposing = true; }, true);
				on("compositionend", () => { card.__dshClComposing = false; }, true);
				on("scroll", liteRaf, { capture: true, passive: true });

				// 粘贴：大段代码自动包围栏（其余放行官方管线——含官方原生粘贴图片）
				on("paste", (e) => {
					if (e.__dshClSynthetic) return; // 自己派发的合成 paste 放行
					if (card.__dshClComposing) return;
					const input2 = card.querySelector(INPUT_SEL);
					if (!input2 || input2.getAttribute("contenteditable") !== "true") return;
					const phase = input2.getAttribute("data-phase");
					if (phase && phase !== "plain") return;
					if (menuOpen(card)) return;
					if (!e.clipboardData) return;
					const text = e.clipboardData.getData("text/plain") || "";
					if (!text) return; // 图片/文件粘贴归官方 intakeFiles
					const anchors = buildAnchors(input2);
					const src = anchorsText(anchors);
					const caret = domOffsetOf(input2, anchors, true);
					if (caret == null) return;
					const wrap = decidePasteWrap(src, caret, text);
					if (!wrap) return;
					e.preventDefault();
					e.stopPropagation();
					insertInline(input2, wrap.insert);
					toast(card, "已将 " + wrap.lines + " 行文本包成代码块（Ctrl+Z 撤销）");
					liteRaf();
				}, true);

				// 键盘：Enter 围栏补全 / Tab 块内缩进 / Esc 分发
				on("keydown", (e) => {
					if (e.isComposing || e.keyCode === 229 || card.__dshClComposing) return;
					const input2 = e.target && e.target.closest ? e.target.closest(INPUT_SEL) : null;
					if (!input2 || input2.getAttribute("contenteditable") !== "true") return;
					if (e.key === "Escape") { handleEscape(e, card); return; }
					const phase = input2.getAttribute("data-phase");
					if (phase && phase !== "plain") return;
					if (menuOpen(card)) return; // 候选菜单开着 → 全归官方
					const anchors = buildAnchors(input2);
					const src = anchorsText(anchors);
					const caret = domOffsetOf(input2, anchors, true);
					if (caret == null) return;
					const sel = window.getSelection();
					// Ctrl+B/I/E 格式快捷键（选区态包裹/光标态插空标记——applyWrapAction
					// 内部分派，与工具栏按钮同通道）。拦截同时挡掉浏览器对 contenteditable
					// 的默认 execCommand('bold')——那会插真 <b> 富文本标签进编辑器。
					if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
						&& (e.key === "b" || e.key === "B" || e.key === "i" || e.key === "I" || e.key === "e" || e.key === "E")) {
						e.preventDefault();
						e.stopPropagation();
						applyWrapAction(card, input2, e.key.toLowerCase() === "b" ? "bold" : (e.key.toLowerCase() === "i" ? "italic" : "code"));
						liteRaf();
						return;
					}
					// 选区跨行 Tab/Shift+Tab：整块每行 ±2 空格（缩进完选区恢复为新块，
					// 连按 Tab 可逐级缩进）
					if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && sel && !sel.isCollapsed) {
						const focus = domOffsetOf(input2, anchors, false);
						if (focus != null) {
							const bact = decideTabBlock(src, caret, focus, e.shiftKey);
							e.preventDefault();
							e.stopPropagation();
							if (bact.type === "block-indent") {
								// 整块替换走「先删后插」三步链：直接在有选区上跑 insertInline 的
								// beforeinput 序列会与 Lexical 内部 selection 状态不同步（E2E 实测
								// 首段丢失）——先合成删除选区（list-exit 同款通道），commit 后再
								// 插入新块，最后恢复选区。
								setSelectionByOffset(input2, bact.rangeStart, bact.rangeEnd);
								setTimeout(() => {
									try {
										input2.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
									} catch (err) { /* 放弃 */ }
									setTimeout(() => {
										insertInline(input2, bact.insert);
										setTimeout(() => { setSelectionByOffset(input2, bact.selStart, bact.selEnd); }, 120);
									}, 80);
								}, 0);
							} else if (bact.type !== "tab-noop") {
								insertInline(input2, bact.insert); // 退化：选区替换为两空格（行内 Tab 语义）
							}
							liteRaf();
							return;
						}
					}
					if (sel && !sel.isCollapsed) return;
					const act = decideKeyAction(src, caret, e.key, {
						shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey
					});
					if (!act) return;
					e.preventDefault();
					e.stopPropagation();
					if (act.type === "indent") {
						insertInline(input2, act.insert);
					} else if (act.type === "indent-at") {
						// 行首缩进（嵌套列表/引用）：光标移行首 → 插两空格 → 延时光标跟到原位+2
						setSelectionByOffset(input2, act.at, act.at);
						insertInline(input2, "  ");
						setTimeout(() => {
							setSelectionByOffset(input2, act.cursor, act.cursor);
						}, 80);
					} else if (act.type === "outdent") {
						// Shift+Tab 反缩进：选区删除（与 list-exit 同款合成删除通道）
						setSelectionByOffset(input2, act.rangeStart, act.rangeEnd);
						setTimeout(() => {
							try {
								input2.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
							} catch (err) { /* 编辑器不可编辑时放弃 */ }
						}, 0);
					} else if (act.type === "tab-noop") {
						// 无缩进可删的 Shift+Tab：仅吞掉按键防焦点跳出（preventDefault 已统一执行）
					} else if (act.type === "fence") {
						insertInline(input2, act.insert);
						// 光标落到块内空行：插入串 "\n\n```..." 的第一个 \n 之后。
						// Lexical 对 beforeinput 的 commit 是异步的（实测 ~几十 ms），
						// 光标设置必须等 commit 完成后再做，否则被 Lexical 重置回插入点。
						setTimeout(() => {
							setSelectionByOffset(input2, caret + 1, caret + 1);
						}, 80);
					} else if (act.type === "table-sep") {
					// 表格首行补分隔行+空行：插入后光标落末尾空行（Lexical 异步 commit 后设置）
					insertInline(input2, act.insert);
					setTimeout(() => {
						setSelectionByOffset(input2, act.cursor, act.cursor);
					}, 80);
				} else if (act.type === "list") {
						// 列表续项：插入 "\n标记 "，光标落标记后（Lexical 异步 commit 后设置）
						insertInline(input2, act.insert);
						setTimeout(() => {
							setSelectionByOffset(input2, act.cursor, act.cursor);
						}, 80);
					} else if (act.type === "list-exit") {
						// 空列表项退出：选中「行首到标记尾」后走合成 beforeinput 删除
						// （execCommand("delete") 需要 user activation——无手势时静默 no-op，
						// CDP/特殊环境下不可靠；Lexical 对 beforeinput 的处理不校验激活）
						setSelectionByOffset(input2, act.rangeStart, act.rangeEnd);
						setTimeout(() => {
							try {
								input2.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
							} catch (err) { /* 编辑器不可编辑时放弃 */ }
						}, 0);
					} else if (act.type === "jumpout") {
						// 块内最后行 ↓ 跳出：纯光标移动（无插入），同步设置即可
						setSelectionByOffset(input2, act.cursor, act.cursor);
					}
					liteRaf();
				}, true);
			}

			// 确保 overlay 与哨兵在位（插在编辑层之前，画在其下不挡光标）
			const grow = input.parentElement;
			if (grow) {
				let ov = grow.querySelector("." + LIVE);
				if (!ov) {
					ov = document.createElement("div");
					ov.className = LIVE;
					ov.setAttribute("aria-hidden", "true");
					grow.insertBefore(ov, input);
				}
				// sticky 工具栏进滚动容器（在 overlay 前）：未挂载或挂错位置都搬正
				const tb = card.__dshClToolbar || card.querySelector("." + TOOLBAR);
				if (tb && (tb.parentElement !== grow || tb.nextElementSibling !== ov)) grow.insertBefore(tb, ov);
				if (!card.__dshClSentinel || !card.__dshClSentinel.isConnected) {
					const s = document.createElement("div");
					s.className = SENTINEL;
					s.setAttribute("aria-hidden", "true");
					grow.appendChild(s);
					card.__dshClSentinel = s;
				}
			}
			render(card);
		}
		//#endregion

		//#region dsh-composer-live: apply
		function apply(ctx) {
			ctx.effect(() => {
				let styleEl = document.getElementById(STYLE_ID);
				if (!styleEl) {
					styleEl = document.createElement("style");
					styleEl.id = STYLE_ID;
					styleEl.textContent = styleText();
					document.head.appendChild(styleEl);
				}

				const run = () => { setupCard(findCard()); };
				run();

				// 只读调试钩子（E2E 测试交叉验证用）：暴露投影文本/行数/锚构成/渲染
				// 段数/透明化状态。纯读取无写入面，不违反零服务依赖原则；cleanup 移除。
				window.__dshClDebug = () => {
					const card = findCard();
					const input = card ? card.querySelector(INPUT_SEL) : null;
					if (!input) return { found: false };
					const anchors = buildAnchors(input);
					const src = anchorsText(anchors);
					const ov = card.querySelector("." + LIVE);
					const segs = ov ? ov.querySelectorAll(".dsh-cl-c").length : -1;
					return {
						found: true,
						src,
						lineCount: String(src || "").split("\n").length,
						anchorKinds: anchors.reduce((m, a) => { m[a.kind] = (m[a.kind] || 0) + 1; return m; }, {}),
						segs,
						host: input.classList.contains(HOST),
						editable: input.getAttribute("contenteditable") === "true"
					};
				};

				// MutationObserver 回调 rAF 合帧：每次击键 Lexical 的 DOM commit 会
				// 触发多次 observer 回调（文本+结构），同步跑 render 会造成每键多次
				// 渲染 + 强制布局（「抖动」感来源之一）——合并到下一帧只跑一次。
				let obsRaf = 0;
				const observer = new MutationObserver(() => {
					if (obsRaf) return;
					obsRaf = requestAnimationFrame(() => { obsRaf = 0; run(); });
				});
				observer.observe(document.body, { childList: true, subtree: true, characterData: true });

				// 窗口尺寸变化：字符锚定渲染的坐标随布局重算（DOM 无变化不触发 MO）
				let rsRaf = 0;
				const onResize = () => {
					if (rsRaf) return;
					rsRaf = requestAnimationFrame(() => { rsRaf = 0; run(); });
				};
				window.addEventListener("resize", onResize);

				const onSelChange = () => {
					const card = findCard();
					if (!card) return;
					const input = card.querySelector(INPUT_SEL);
					if (!input || document.activeElement !== input) {
						if (card.__dshClFloat) card.__dshClFloat.classList.remove("dsh-cl-float-on");
						return;
					}
					render(card);
					if (card.__dshClFloat) updateFloat(card, card.__dshClFloat);
				};
				document.addEventListener("selectionchange", onSelChange);

				const onDocDown = (e) => {
					const card = findCard();
					if (!card || !card.__dshClFloat) return;
					if (card.__dshClFloat.contains(e.target)) return;
					if (e.target.closest && (e.target.closest(CARD_SEL) || e.target.closest(MENU_SEL))) return;
					card.__dshClFloat.classList.remove("dsh-cl-float-on");
				};
				document.addEventListener("pointerdown", onDocDown, true);

				const timer = setInterval(run, 500);

				return () => {
					delete window.__dshClDebug;
					clearInterval(timer);
					observer.disconnect();
					window.removeEventListener("resize", onResize);
					document.removeEventListener("selectionchange", onSelChange);
					document.removeEventListener("pointerdown", onDocDown, true);
					document.body.classList.remove("dsh-cl-light");
					const card = findCard();
					if (card) {
						if (card.__dshClDisposables) {
							for (const d of card.__dshClDisposables) { try { d(); } catch (err) { /* 已失效 */ } }
							card.__dshClDisposables = null;
						}
						if (card.__dshClFloat) { card.__dshClFloat.remove(); card.__dshClFloat = null; }
						card.removeAttribute(READY_KEY);
						const tb = card.querySelector("." + TOOLBAR);
						if (tb) tb.remove();
						const input = card.querySelector(INPUT_SEL);
						if (input) {
							input.classList.remove(HOST, MONO_ALL);
							input.querySelectorAll("p").forEach((p) => p.classList.remove(KEEP));
						}
						const ov = card.querySelector("." + LIVE);
						if (ov) ov.remove();
						const ts = card.querySelector("." + TOAST);
						if (ts) ts.remove();
						if (card.__dshClSentinel) { card.__dshClSentinel.remove(); card.__dshClSentinel = null; }
						const scroll = card.querySelector(SCROLL_SEL);
						if (scroll) scroll.classList.remove(EXPANDED, "dsh-cl-anchor", "dsh-cl-light");
						card.style.removeProperty("--dsh-cl-code-font");
					}
					const s = document.getElementById(STYLE_ID);
					if (s) s.remove();
				};
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = [];
		/** 测试/调试用纯函数导出（生产无副作用）。 */
		exports._renderInline = renderInline;
		exports._computeBlockStates = computeBlockStates;
		exports._lineClass = lineClass;
		exports._lineContent = lineContent;
		exports._blockKindOf = blockKindOf;
		exports._renderBlockLine = renderBlockLine;
		exports._stateKey = stateKey;
		exports._isLightColor = isLightColor;
		exports._decideActiveMarks = decideActiveMarks;
		exports._decideKeyAction = decideKeyAction;
		exports._decideTabBlock = decideTabBlock;
		exports._highlightLine = highlightLine;
		exports._guessLang = guessLang;
		exports._buildCodeFont = buildCodeFont;
		exports._decideWrapAction = decideWrapAction;
		exports._isCursorInCodeBlock = isCursorInCodeBlock;
		exports._decidePasteWrap = decidePasteWrap;
		exports._codeParaFlags = codeParaFlags;
		exports._paraHasChip = paraHasChip;
		return module.exports;
	}
});
