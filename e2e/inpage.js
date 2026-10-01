// e2e/inpage.js — 页面内注入器 + 不变量校验器。
// 由 run-e2e.mjs 经 CDP Runtime.evaluate 注入执行，把 API 挂到 window.__e2e。
//
// 设计原则：**观测者不修复**——如实记录编辑器与渲染层的真实状态。
// 与插件投影（window.__dshClDebug，client.js 暴露）交叉对比的是本文件的「独立投影」
// （对 buildAnchors/anchorsText/measureAnchorChars 的同构复刻）——独立实现降低
// 「两侧同源同错」的漏检概率。行号推进语义与 v0.2.3 一致（字面 \n 推进行号）。
(() => {
	"use strict";
	var CHIP = "￼";
	var CARD_SEL = "[data-composer-card]";
	var INPUT_SEL = "[data-composer-input]";
	var OV_SEL = ".dsh-cl-live";
	var SEG_SEL = ".dsh-cl-c";
	var HOST_CLS = "dsh-cl-host";
	var KEEP_CLS = "dsh-cl-keep";

	function getCardInput() {
		var card = document.querySelector(CARD_SEL);
		if (!card) return null;
		var input = card.querySelector(INPUT_SEL);
		if (!input) return null;
		return { card: card, input: input, ov: card.querySelector(OV_SEL) };
	}

	// ---------- 独立锚表 / 投影（buildAnchors + anchorsText 同构复刻） ----------
	function buildIndAnchors(input) {
		var anchors = [];
		var firstPara = true;
		var visit = function (node) {
			for (var c = node.firstChild; c; c = c.nextSibling) {
				if (c.nodeType === 3) {
					if (c.nodeValue.length > 0) anchors.push({ kind: "text", node: c, len: c.nodeValue.length });
				} else if (c.nodeType === 1) {
					if (c.tagName === "BR") {
						// Lexical 行尾占位 br 不产生新行
						if (c.getAttribute && c.getAttribute("data-lexical-managed-linebreak") != null) continue;
						anchors.push({ kind: "br", el: c, len: 1 });
					} else if (c.tagName === "P") {
						if (!firstPara) anchors.push({ kind: "para", el: c, len: 1 });
						firstPara = false;
						visit(c);
					} else if (c.matches && c.matches("[data-composer-chip]")) {
						anchors.push({ kind: "chip", el: c, len: 1 });
					} else {
						// 富文本粘贴产物（B/I/STRONG/DIV）与装饰壳继续下钻
						visit(c);
					}
				}
			}
		};
		visit(input);
		return anchors;
	}

	function indProject(anchors) {
		var s = "";
		for (var i = 0; i < anchors.length; i++) {
			var a = anchors[i];
			if (a.kind === "text") s += a.node.nodeValue;
			else if (a.kind === "chip") s += CHIP;
			else s += "\n";
		}
		return s;
	}

	// ---------- 投影 offset → DOM Range（rangeAtOffset 同构复刻） ----------
	function rangeAtProj(input, anchors, absOffset) {
		var acc = 0;
		var range = document.createRange();
		for (var i = 0; i < anchors.length; i++) {
			var a = anchors[i];
			if (a.kind === "text") {
				if (absOffset <= acc + a.len) {
					try { range.setStart(a.node, Math.max(0, absOffset - acc)); } catch (e) { return null; }
					return range;
				}
				acc += a.len;
			} else {
				acc += 1;
				if (absOffset <= acc) {
					try { range.setStartAfter(a.el); } catch (e) { return null; }
					return range;
				}
			}
		}
		for (var j = anchors.length - 1; j >= 0; j--) {
			if (anchors[j].kind === "text") {
				try { range.setStart(anchors[j].node, anchors[j].len); } catch (e) { return null; }
				return range;
			}
		}
		try { range.selectNodeContents(input); range.collapse(false); } catch (e) { return null; }
		return range;
	}

	function setSelCollapsed(input, anchors, projOff) {
		var r = rangeAtProj(input, anchors, projOff);
		if (!r) return false;
		var sel = window.getSelection();
		sel.removeAllRanges();
		var r2 = document.createRange();
		r2.setStart(r.startContainer, r.startOffset);
		r2.collapse(true);
		sel.addRange(r2);
		return true;
	}

	// ---------- 编辑器逐字符测量（measureAnchorChars 同构复刻，含字面 \n 行号推进） ----------
	// 返回 chars 流（DOM 序）：{line, off(行内偏移，含 \r 占位), voff(行内可见序，\r 不占位),
	// ch, x, y, w, h}；\n、\r 不入流、chip 不测量。
	// voff 用于行内覆盖检查与 caret 期望位置（\r 是视觉零宽的换行语义，不占可见序）。
	function measureEditor(anchors) {
		var range = document.createRange();
		var chars = [];
		var missed = 0;
		var firstErr = null;
		var lineIdx = 0;
		var off = 0;
		var vis = 0;
		for (var ai = 0; ai < anchors.length; ai++) {
			var a = anchors[ai];
			if (a.kind === "br" || a.kind === "para") { lineIdx++; off = 0; vis = 0; continue; }
			if (a.kind === "chip") { off++; vis++; continue; }
			var node = a.node;
			if (!node || node.nodeType !== 3) continue;
			var val = node.nodeValue;
			var len = val.length;
			try {
				for (var i = 0; i < len; i++) {
					var code = val.charCodeAt(i);
					if (code === 10) { lineIdx++; off = 0 - i - 1; vis = 0; continue; }
					if (code === 13) continue; // \r 视觉零宽（换行语义的一部分），不入对比流
					range.setStart(node, i);
					range.setEnd(node, i + 1);
					var r = range.getBoundingClientRect();
					var rec = { line: lineIdx, off: off + i, voff: vis, ch: val.charAt(i), x: r ? r.left : 0, y: r ? r.top : 0, w: r ? r.width : 0, h: r ? r.height : 0 };
					if (!r || (r.width === 0 && r.height === 0)) { rec.noRect = true; missed++; }
					chars.push(rec);
					vis++;
				}
			} catch (e) {
				if (!firstErr) firstErr = String((e && e.message) || e);
			}
			off += len;
		}
		return { chars: chars, missed: missed, err: firstErr };
	}

	// ---------- overlay 段字符测量 ----------
	function measureOverlay(ov) {
		var segs = ov ? ov.querySelectorAll(SEG_SEL) : [];
		var chars = [];
		var emptySegs = 0;
		var range = document.createRange();
		for (var si = 0; si < segs.length; si++) {
			var tn = segs[si].firstChild; // 段内容是单个文本节点（renderCharOverlay 纯文本 + escapeHtml）
			if (!tn || tn.nodeType !== 3 || !tn.nodeValue) { emptySegs++; continue; }
			var val = tn.nodeValue;
			for (var i = 0; i < val.length; i++) {
				range.setStart(tn, i);
				range.setEnd(tn, i + 1);
				var r = range.getBoundingClientRect();
				chars.push({ ch: val.charAt(i), x: r ? r.left : 0, y: r ? r.top : 0, w: r ? r.width : 0, h: r ? r.height : 0 });
			}
		}
		return { chars: chars, segCount: segs.length, emptySegs: emptySegs };
	}

	// ---------- 输入通道 ----------
	function bi(input, type, data) {
		var init = { inputType: type, bubbles: true, cancelable: true };
		if (data != null) init.data = data;
		input.dispatchEvent(new InputEvent("beforeinput", init));
	}

	function domShape(input) {
		var brs = input.querySelectorAll("br");
		var managed = 0;
		for (var i = 0; i < brs.length; i++) if (brs[i].getAttribute("data-lexical-managed-linebreak") != null) managed++;
		var t = input.textContent;
		return {
			p: input.querySelectorAll(":scope > p").length,
			br: brs.length - managed,
			brManaged: managed,
			nl: (t.match(/\n/g) || []).length,
			cr: (t.match(/\r/g) || []).length,
			textLen: t.length
		};
	}

	/** 注入。spec: {channel, text, html?, caretProjOff?}。
	 * 通道：
	 *  - "bi-text"      单次 beforeinput insertText，text 原样（含 \n 或 \r\n 由场景文本决定；
	 *                   复刻官方 paste 管线「单文本节点字面换行」形态）
	 *  - "bi-lines"     逐行 insertText + 行间 insertParagraph（插件 insertInline 同款）
	 *  - "bi-linebreak" 逐行 insertText + 行间 insertLineBreak（实测产物形态用）
	 *  - "paste-plain"  合成 ClipboardEvent paste（text/plain；官方走「吞 \n 单行」路径）
	 *  - "paste-html"   合成 ClipboardEvent paste（text/html 富文本 → B/STRONG/DIV 形态）
	 */
	function inject(spec) {
		var ci = getCardInput();
		if (!ci) return { ok: false, error: "no-input" };
		var input = ci.input;
		input.focus();
		var anchors = buildIndAnchors(input);
		var src = indProject(anchors);
		var at = spec.caretProjOff != null ? Math.max(0, Math.min(spec.caretProjOff, src.length)) : src.length;
		setSelCollapsed(input, anchors, at);
		var ch = spec.channel;
		var text = String(spec.text == null ? "" : spec.text);
		if (ch === "bi-text") {
			bi(input, "insertText", text);
		} else if (ch === "bi-lines" || ch === "bi-linebreak") {
			var ls = text.replace(/\r\n?/g, "\n").split("\n"); // 手打通道不含 \r
			for (var i = 0; i < ls.length; i++) {
				if (i > 0) bi(input, ch === "bi-lines" ? "insertParagraph" : "insertLineBreak");
				if (ls[i]) bi(input, "insertText", ls[i]);
			}
		} else if (ch === "paste-plain" || ch === "paste-html") {
			var dt = new DataTransfer();
			dt.setData("text/plain", text);
			if (ch === "paste-html" && spec.html) dt.setData("text/html", spec.html);
			var ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
			Object.defineProperty(ev, "clipboardData", { value: dt });
			input.dispatchEvent(ev);
		} else {
			return { ok: false, error: "unknown-channel:" + ch };
		}
		return { ok: true, channel: ch, shape: domShape(input) };
	}

	/** 清空草稿：全选 + 合成 beforeinput deleteContentBackward（execCommand delete
	 *  无 user activation 静默 no-op——CLAUDE.md 插入通道第五坑）。 */
	function clearDraft() {
		var ci = getCardInput();
		if (!ci) return { ok: false, error: "no-input" };
		var input = ci.input;
		input.focus();
		var anchors = buildIndAnchors(input);
		if (indProject(anchors) === "") return { ok: true, already: true };
		// Range 框选全部（不用 execCommand selectAll——modal 弹窗/焦点不在位时会溢出
		// 到页面级，020 实测；Range 直指 input 内容不受影响）
		var r = document.createRange();
		r.selectNodeContents(input);
		var sel = window.getSelection();
		sel.removeAllRanges();
		sel.addRange(r);
		bi(input, "deleteContentBackward");
		return { ok: true };
	}

	/** 场景后置操作。o.type:
	 *   "type"         在光标处打字（execCommand insertText）
	 *   "backspace"    合成 beforeinput deleteContentBackward
	 *   "caret"        设光标（off=null → 末尾）
	 *   "caretRatio"   按投影长度比例设光标
	 *   "caretSweep"   n 个均匀点位连续设置（触发 selectionchange 渲染路径）
	 *   "pasteLiteral" 光标处单次 insertText（字面 \n 形态的编辑期插入）
	 *   "selectRange"  投影 offset 区间选中 {from,to}
	 *   "selectLine"   选中光标所在整行
	 *   "enter"        合成 Enter keydown（o.shift）——走插件 keydown 捕获层（列表/引用
	 *                  续项、围栏补全）。只用于会被插件拦截的行：普通行的 Enter 放行
	 *                  官方 keymap 会触发「发送消息」！
	 *   "tab"          合成 Tab keydown（o.shift）——缩进/反缩进（全行境均被插件拦截）
	 *   "key"          合成任意 keydown {key, ctrl?, shift?}（Ctrl+B/I/E 格式快捷键、
	 *                  Ctrl+A 全选、Ctrl+Z/Y 撤销重做——官方 keymap 均处理合成事件）
	 *   "expectSrc"    断言当前投影文本 === o.expect（不匹配返回 ok:false + got）
	 *   "expectClass"  断言 overlay 内存在 o.selector 的元素至少 1 个（渲染层断言）
	 *   "attachImage"  造 PNG → 合成 paste（drop 序列兜底）挂官方附件管线（async）
	 *   "detachImages" 移除全部附件胶囊（官方删除按钮；删不净返回 ok:false）
	 *   "toolbarClear" 断言工具栏与附件胶囊（card 内 input 外的 img）零重叠
	 *   "scrollToolbar" 滚动容器滚 o.amount，断言工具栏 sticky 钉住、内容上移（async）
	 *   "menuNearInput" 打 o.text（默认 "@"）触发官方候选菜单，断言菜单贴输入框上沿
	 *                  （间隙 ≤ o.maxGap，默认 30px——v0.2.6 fixTriggerMenuPos 回归）（async）
	 *   "snapshotClass" 断言 o.selector 的元素数 ≥ o.min（通用 DOM 断言，不限 overlay）
	 */
	async function op(o) {
		var ci = getCardInput();
		if (!ci) return { ok: false, error: "no-input" };
		var input = ci.input;
		input.focus();
		var anchors = buildIndAnchors(input);
		var src = indProject(anchors);
		var clamp = function (v) { return Math.max(0, Math.min(v == null ? src.length : v, src.length)); };
		if (o.type === "type") {
			document.execCommand("insertText", false, String(o.text || ""));
		} else if (o.type === "backspace") {
			bi(input, "deleteContentBackward");
		} else if (o.type === "enter") {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, shiftKey: !!o.shift }));
		} else if (o.type === "tab") {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true, shiftKey: !!o.shift }));
		} else if (o.type === "key") {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: o.key, code: o.code || o.key, bubbles: true, cancelable: true, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, altKey: false, metaKey: false }));
		} else if (o.type === "expectClass") {
			var ovEl = document.querySelector(OV_SEL);
			var hits = ovEl ? ovEl.querySelectorAll(o.selector).length : 0;
			if (hits < 1) return { ok: false, got: "0 hits for " + o.selector };
		} else if (o.type === "expectSrc") {
			var srcNow = indProject(buildIndAnchors(input));
			if (srcNow !== String(o.expect == null ? "" : o.expect)) {
				return { ok: false, got: srcNow.length > 160 ? srcNow.slice(0, 160) + "…(" + srcNow.length + ")" : srcNow };
			}
		} else if (o.type === "caret") {
			setSelCollapsed(input, anchors, clamp(o.off));
		} else if (o.type === "caretRatio") {
			setSelCollapsed(input, anchors, clamp(Math.round(src.length * (o.ratio == null ? 1 : o.ratio))));
		} else if (o.type === "caretSweep") {
			var n = o.n || 8;
			for (var i = 1; i <= n; i++) setSelCollapsed(input, anchors, clamp(Math.round(src.length * i / (n + 1))));
		} else if (o.type === "pasteLiteral") {
			bi(input, "insertText", String(o.text || ""));
		} else if (o.type === "selectRange") {
			var a = clamp(o.from);
			var b = clamp(o.to);
			var ra = rangeAtProj(input, anchors, a);
			var rb = rangeAtProj(input, anchors, Math.max(a, b));
			if (ra && rb) {
				var sel = window.getSelection();
				sel.removeAllRanges();
				var r2 = document.createRange();
				r2.setStart(ra.startContainer, ra.startOffset);
				r2.setEnd(rb.startContainer, rb.startOffset);
				sel.addRange(r2);
			}
		} else if (o.type === "selectLine") {
			var cur = 0;
			var selN = window.getSelection();
			if (selN.rangeCount && input.contains(selN.focusNode)) {
				// 现光标 → 投影 offset（focus 端近似：遍历锚表）
				cur = projOffsetOf(input, anchors, selN.focusNode, selN.focusOffset) || 0;
			}
			var lineStart = src.lastIndexOf("\n", Math.max(0, cur - 1)) + 1;
			var nl = src.indexOf("\n", cur);
			var lineEnd = nl === -1 ? src.length : nl;
			var ra3 = rangeAtProj(input, anchors, lineStart);
			var rb3 = rangeAtProj(input, anchors, lineEnd);
			if (ra3 && rb3) {
				var sel3 = window.getSelection();
				sel3.removeAllRanges();
				var r3 = document.createRange();
				r3.setStart(ra3.startContainer, ra3.startOffset);
				r3.setEnd(rb3.startContainer, rb3.startOffset);
				sel3.addRange(r3);
			}
		} else if (o.type === "attachImage") {
			return await attachImage(ci);
		} else if (o.type === "detachImages") {
			return await detachImages(ci);
		} else if (o.type === "toolbarClear") {
			var tb = ci.card.querySelector(".dsh-cl-toolbar");
			if (!tb) return { ok: false, got: "no-toolbar" };
			var tr = tb.getBoundingClientRect();
			var worst = null;
			var imgs2 = ci.card.querySelectorAll("img");
			for (var i3 = 0; i3 < imgs2.length; i3++) {
				if (ci.input.contains(imgs2[i3])) continue; // 只看附件（编辑器外的 img）
				var ir2 = imgs2[i3].getBoundingClientRect();
				var ovY = !(tr.bottom <= ir2.top + 1 || ir2.bottom <= tr.top + 1);
				var ovX = !(tr.right <= ir2.left || ir2.right <= tr.left);
				if (ovY && ovX) worst = { tbTop: +tr.top.toFixed(1), tbBottom: +tr.bottom.toFixed(1), imgTop: +ir2.top.toFixed(1), imgBottom: +ir2.bottom.toFixed(1) };
			}
			if (worst) return { ok: false, got: "工具栏与附件重叠 " + JSON.stringify(worst) };
		} else if (o.type === "scrollToolbar") {
			var tb2 = ci.card.querySelector(".dsh-cl-toolbar");
			if (!tb2) return { ok: false, got: "no-toolbar" };
			var sc = null, n2 = tb2.parentElement;
			while (n2 && n2 !== document.body) {
				var st = getComputedStyle(n2);
				if (/(auto|scroll)/.test(st.overflowY) && n2.scrollHeight > n2.clientHeight + 4) { sc = n2; break; }
				n2 = n2.parentElement;
			}
			if (!sc) return { ok: false, got: "no-scroll-container（内容不够长？）" };
			var tbBefore = tb2.getBoundingClientRect().top;
			var cBefore = input.getBoundingClientRect().top;
			sc.scrollTop = Math.min(sc.scrollTop + (o.amount || 800), sc.scrollHeight - sc.clientHeight);
			await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
			await new Promise(function (r) { setTimeout(r, 120); });
			var tbAfter = tb2.getBoundingClientRect().top;
			var cAfter = input.getBoundingClientRect().top;
			var sticky = Math.abs(tbAfter - tbBefore) < 2; // 工具栏钉视口顶不动
			var scrolled = (cBefore - cAfter) > 50;        // 内容确实滚上去了
			if (!sticky || !scrolled) return { ok: false, got: "sticky=" + sticky + " scrolled=" + scrolled + " 工具栏 top " + tbBefore.toFixed(1) + "→" + tbAfter.toFixed(1) + " 内容位移 " + (cBefore - cAfter).toFixed(1) + "px" };
		} else if (o.type === "menuNearInput") {
			document.execCommand("insertText", false, String(o.text || "@"));
			await new Promise(function (r) { setTimeout(r, o.wait || 1500); });
			var menu = document.querySelector("[data-trigger-menu]") || document.querySelector('[role="listbox"]');
			var mr = menu ? menu.getBoundingClientRect() : null;
			var ir3 = input.getBoundingClientRect();
			var gap = mr ? (ir3.top - mr.bottom) : -1;
			// 收尾：Esc 关菜单（防候选菜单拦截后续 clearDraft 的全选删除）
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
			await new Promise(function (r) { setTimeout(r, 250); });
			if (!mr) return { ok: false, got: "候选菜单未弹出（选择器 [data-trigger-menu]/[role=listbox] 均无命中）" };
			var maxGap = o.maxGap || 30;
			if (gap > maxGap) return { ok: false, got: "菜单底距输入框顶 " + gap.toFixed(1) + "px（> " + maxGap + "）悬空溢出" };
		} else if (o.type === "snapshotClass") {
			var host = o.host === "card" ? ci.card : document;
			var hits2 = host.querySelectorAll(o.selector).length;
			if (hits2 < (o.min || 1)) return { ok: false, got: o.selector + " 命中 " + hits2 + " < " + (o.min || 1) };
		}
		return { ok: true, srcLen: src.length };
	}

	/** 附件胶囊计数：card 内、input 外的 img（几何法与 v0.2.7 offsetToolbarForAttachments
	 * 同源，不依赖官方 hash 类名；编辑器内 img 不算）。 */
	function attachCount(ci) {
		var n = 0;
		var imgs = ci.card.querySelectorAll("img");
		for (var i = 0; i < imgs.length; i++) if (!ci.input.contains(imgs[i])) n++;
		return n;
	}

	/** 造 PNG → 合成 paste（官方 intakeFiles 管线）→ drop 序列兜底。与真实
	 * 「粘贴图片」同路（diag-image.mjs 2026-09-25 实测的注入法）。async op。 */
	async function attachImage(ci) {
		var input = ci.input;
		input.focus();
		var cv = document.createElement("canvas"); cv.width = 240; cv.height = 140;
		var cx = cv.getContext("2d");
		cx.fillStyle = "#3a7bd5"; cx.fillRect(0, 0, 240, 140);
		cx.fillStyle = "#ffd166"; cx.beginPath(); cx.arc(120, 70, 45, 0, 7); cx.fill();
		var blob = await new Promise(function (r) { cv.toBlob(r, "image/png"); });
		var file = new File([blob], "e2e-attach.png", { type: "image/png" });
		var mkDT = function () { var dt = new DataTransfer(); dt.items.add(file); return dt; };
		input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: mkDT() }));
		await new Promise(function (r) { setTimeout(r, 1400); });
		var n = attachCount(ci);
		if (!n) {
			var rect = input.getBoundingClientRect();
			var pt = { clientX: rect.left + 60, clientY: rect.top + 20 };
			for (var i = 0; i < 2; i++) {
				var type = i === 0 ? "dragenter" : "dragover";
				input.dispatchEvent(new DragEvent(type, Object.assign({ bubbles: true, cancelable: true }, pt, { dataTransfer: mkDT() })));
				await new Promise(function (r) { requestAnimationFrame(r); });
			}
			input.dispatchEvent(new DragEvent("drop", Object.assign({ bubbles: true, cancelable: true }, pt, { dataTransfer: mkDT() })));
			await new Promise(function (r) { setTimeout(r, 1600); });
			n = attachCount(ci);
		}
		return n > 0 ? { ok: true, imgs: n } : { ok: false, got: "附件未挂上（paste 与 drop 双通道均失败）" };
	}

	/** 移除全部附件胶囊：找附件 img 的可点击删除按钮（官方胶囊 hover 出现的 × /
	 * aria-label 含 remove|delete|close|移除|删除 的 button），逐个点掉再数。 */
	async function detachImages(ci) {
		for (var round = 0; round < 4; round++) {
			var imgs = Array.prototype.slice.call(ci.card.querySelectorAll("img")).filter(function (el) { return !ci.input.contains(el); });
			if (!imgs.length) return { ok: true };
			for (var i = 0; i < imgs.length; i++) {
				// 胶囊宿主：img 向上到 card 内第一个含 button 的祖先（跳过 img 自身）
				var host = imgs[i].parentElement, guard = 0;
				while (host && host !== ci.card && guard++ < 8) {
					if (host.querySelector("button")) break;
					host = host.parentElement;
				}
				if (!host || host === ci.card) host = imgs[i].parentElement;
				var btns = host ? Array.prototype.slice.call(host.querySelectorAll("button")) : [];
				var del = btns.find(function (b) {
					var al = (b.getAttribute("aria-label") || "") + " " + b.className + " " + (b.title || "");
					return /remove|delete|close|dismiss|移除|删除|×|✕/i.test(al);
				});
				(del || btns[btns.length - 1] || imgs[i]).click();
				await new Promise(function (r) { setTimeout(r, 350); });
			}
		}
		var left = attachCount(ci);
		return left ? { ok: false, got: "残留附件 " + left + " 个（找不到可用的删除按钮）" } : { ok: true };
	}

	/** DOM Selection 端 → 投影 offset（offsetFromSelection 同构复刻，selectLine 用） */
	function projOffsetOf(input, anchors, node, off) {
		if (!node || !input.contains(node)) return null;
		var acc = 0;
		for (var i = 0; i < anchors.length; i++) {
			var a = anchors[i];
			if (a.kind === "text") {
				if (a.node === node) return acc + Math.min(off, a.len);
				if (a.node.parentElement === node) return acc;
				acc += a.len;
			} else {
				if (a.el === node) return acc;
				if (node.nodeType === 1 && a.kind === "chip" && a.el.contains(node)) return acc;
				acc += 1;
			}
		}
		return null;
	}

	// ---------- 快照（渲染稳定轮询用） ----------
	function snapshot() {
		var ci = getCardInput();
		if (!ci) return { hasInput: false };
		var dbg = window.__dshClDebug ? window.__dshClDebug() : null;
		var ov = document.querySelector(OV_SEL);
		return {
			hasInput: true,
			srcLen: dbg ? dbg.src.length : -1,
			segs: ov ? ov.querySelectorAll(SEG_SEL).length : -1,
			host: ci.input.classList.contains(HOST_CLS)
		};
	}

	// ---------- 校验器（十条不变量；INV-8 console 由 runner 侧 CDP 收集） ----------
	function firstDiff(a, b) {
		var n = Math.min(a.length, b.length);
		for (var i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
		return a.length === b.length ? -1 : n;
	}

	function ctxOf(chars, i) {
		var s = "";
		for (var k = Math.max(0, i - 8); k < Math.min(chars.length, i + 8); k++) s += chars[k].ch;
		return JSON.stringify(s);
	}

	/** caret 采样点：均匀取 8 行 × [行首, 行中, 行尾]（投影 offset） */
	function sampleOffsets(src, lines) {
		var offsets = [];
		var step = Math.max(1, Math.floor(lines.length / 8));
		for (var li = 0; li < lines.length; li += step) {
			var base = 0;
			for (var k = 0; k < li; k++) base += lines[k].length + 1;
			var len = lines[li].length;
			if (len === 0) { offsets.push(base); continue; }
			offsets.push(base, base + (len >> 1), base + len);
		}
		offsets.push(src.length);
		return offsets;
	}

	function verify() {
		var out = { ok: true, invs: {}, meta: {} };
		var ci = getCardInput();
		if (!ci) return { ok: false, error: "no-input", invs: {} };
		var input = ci.input, ov = ci.ov;
		var dbg = window.__dshClDebug ? window.__dshClDebug() : null;
		var anchors = buildIndAnchors(input);
		var src = indProject(anchors);
		var lines = src.split("\n");
		var chipLine = [];
		var anyChip = false;
		for (var i = 0; i < lines.length; i++) { chipLine.push(lines[i].indexOf(CHIP) !== -1); if (chipLine[i]) anyChip = true; }
		out.meta = { srcLen: src.length, lineCount: lines.length, crCount: (src.match(/\r/g) || []).length, anchorKinds: dbg ? dbg.anchorKinds : null };
		var inv = function (id, ok, detail) { out.invs[id] = { ok: !!ok, detail: String(detail || "") }; if (!ok) out.ok = false; };

		// INV-1 投影一致：独立投影 vs 插件投影（锚表收集分歧探测器）
		if (!dbg || !dbg.found) inv("INV-1", false, "__dshClDebug 不存在（插件未激活或未部署调试钩子）");
		else {
			var fd = firstDiff(src, dbg.src);
			inv("INV-1", fd === -1, fd === -1 ? "两侧一致（" + src.length + " 字）" :
				"首个分歧 @" + fd + " charCode " + src.charCodeAt(fd) + " vs " + dbg.src.charCodeAt(fd) + " ctx " + JSON.stringify(src.slice(Math.max(0, fd - 8), fd + 8)));
		}

		// 编辑器测量（期望流）
		var ed = measureEditor(anchors);
		var exp = [];
		for (i = 0; i < ed.chars.length; i++) if (!chipLine[ed.chars[i].line]) exp.push(ed.chars[i]);
		var expTotal = 0;
		for (i = 0; i < lines.length; i++) if (!chipLine[i]) expTotal += lines[i].replace(/\r/g, "").length; // \r 不入对比流
		// 行内可见序 → 测量记录（INV-2 完整性 + INV-7 期望位置共用；voff 语义：\r 不占位）
		var byLine = {};
		for (i = 0; i < ed.chars.length; i++) {
			var c = ed.chars[i];
			if (!byLine[c.line]) byLine[c.line] = [];
			byLine[c.line][c.voff] = c;
		}

		// INV-2 完整性：每行（非 chip）off 0..len-1 每个字符都有测量记录
		var offDetail = "", offBad = 0;
		for (i = 0; i < lines.length; i++) {
			var lineLen = lines[i].replace(/\r/g, "").length; // \r 不入对比流
			if (chipLine[i] || lineLen === 0) continue;
			var arr = byLine[i] || [];
			var cnt = 0;
			for (var k2 = 0; k2 < lineLen; k2++) if (arr[k2]) cnt++;
			if (cnt !== lineLen) {
				offBad++;
				if (offBad <= 3) offDetail += "行" + i + " 期望" + lineLen + "字实测" + cnt + "字；";
			}
		}
		inv("INV-2", offBad === 0, offBad === 0 ? (ed.missed ? ("完整，但 " + ed.missed + " 字无 rect（0 尺寸，已记录）") : "完整") :
			offBad + " 行缺字；" + offDetail + (ed.missed ? " 无 rect 字符 " + ed.missed : "") + (ed.err ? " 测量异常: " + ed.err : ""));

		// 段流
		var mo = measureOverlay(ov);

		// INV-4 内容一致 + INV-3 坐标一致（期望流与段流按序对齐）
		var n = Math.min(exp.length, mo.chars.length);
		var bad4 = null, bad3 = null, bad3Count = 0, bad3List = [], maxDx = 0, maxDy = 0, n3 = 0;
		var bad3ByLine = {};
		var step = Math.max(1, Math.floor(n / 1200)); // 坐标抽样上限 1200
		for (i = 0; i < n; i++) {
			var e = exp[i], m = mo.chars[i];
			if (!bad4 && e.ch !== m.ch) bad4 = { at: i, exp: e.ch.charCodeAt(0), got: m.ch.charCodeAt(0), ctx: ctxOf(exp, i) };
			if (i % step === 0 && !e.noRect) {
				n3++;
				var dx = Math.abs(e.x - m.x), dy = Math.abs(e.y - m.y);
				if (dx > maxDx) maxDx = dx;
				if (dy > maxDy) maxDy = dy;
				if (dx > 0.5 || dy > 0.5) {
					bad3Count++;
					bad3ByLine[e.line] = (bad3ByLine[e.line] || 0) + 1;
					if (bad3List.length < 8) bad3List.push("行" + e.line + " ch(" + e.ch.charCodeAt(0) + ") dx=" + dx.toFixed(2) + " dy=" + dy.toFixed(2));
					if (!bad3 || dx > bad3.dxN) bad3 = { at: i, ch: e.ch.charCodeAt(0), dxN: dx, dx: dx.toFixed(2), dy: dy.toFixed(2), line: e.line, ctx: ctxOf(exp, i) };
				}
			}
		}
		inv("INV-4", exp.length === mo.chars.length && !bad4,
			"期望流 " + exp.length + " / 段流 " + mo.chars.length +
			(bad4 ? "；首个内容分歧 @ " + bad4.at + " charCode " + bad4.exp + " vs " + bad4.got + " ctx " + bad4.ctx : ""));
		inv("INV-3", bad3Count === 0, "抽样 " + n3 + "，maxDx=" + maxDx.toFixed(2) + " maxDy=" + maxDy.toFixed(2) +
			(bad3Count ? "；超差 " + bad3Count + " 字符，行分布 " + JSON.stringify(bad3ByLine) + "；样本 [" + bad3List.join(" | ") + "]" : ""));

		// INV-5 段健康：无空段；有内容且透明化时必有段
		var hasContent = input.textContent.replace(new RegExp(CHIP, "g"), "").trim() !== "";
		var host = input.classList.contains(HOST_CLS);
		inv("INV-5", mo.emptySegs === 0 && !(hasContent && host && mo.segCount === 0),
			"段数 " + mo.segCount + "，空段 " + mo.emptySegs + (hasContent && host && mo.segCount === 0 ? "（有内容+透明化+零段=空窗）" : ""));

		// INV-6 行距均匀（「多余空白」探测器）：
		// 期望公式（软换行感知）：后行首字符 y − 前行首字符 y = unit × (V前 − 1 + G)，
		// V前 = 前行占的视觉行数（字符 y 按 unit 分桶去重），G = 行号差（空行也占行）。
		// 普通行 V=1 退化为 unit×G；300 字长行折 9 视觉行 → unit×(9−1+1)。
		var firstChar = {};
		var lineCharYs = {};
		for (i = 0; i < ed.chars.length; i++) {
			var c2 = ed.chars[i];
			if (!firstChar[c2.line] || c2.off < firstChar[c2.line].off) firstChar[c2.line] = c2;
			(lineCharYs[c2.line] = lineCharYs[c2.line] || []).push(c2.y);
		}
		var present = [];
		for (i = 0; i < lines.length; i++) if (firstChar[i]) present.push(i);
		var inv6ok = true, inv6d = "", unit = Infinity;
		if (present.length >= 3) {
			for (i = 1; i < present.length; i++) {
				var d1 = firstChar[present[i]].y - firstChar[present[i - 1]].y;
				if (d1 > 0) unit = Math.min(unit, d1);
			}
			if (isFinite(unit)) {
				var visualRows = function (li) {
					var ys = lineCharYs[li] || [];
					var buckets = {};
					for (var q = 0; q < ys.length; q++) buckets[Math.round(ys[q] / (unit * 0.6))] = 1;
					return Math.max(1, Object.keys(buckets).length);
				};
				for (i = 1; i < present.length; i++) {
					var g2 = present[i] - present[i - 1];
					var want = unit * (visualRows(present[i - 1]) - 1 + g2);
					var real = firstChar[present[i]].y - firstChar[present[i - 1]].y;
					if (Math.abs(real - want) > Math.max(1.5, unit * 0.12)) {
						inv6ok = false;
						inv6d += "行" + present[i - 1] + "→" + present[i] + " 期望" + want.toFixed(1) + " 实测" + real.toFixed(1) + "；";
						if (inv6d.length > 260) { inv6d += "…"; break; }
					}
				}
			} else inv6d = "无法测单位行高";
		}
		if (inv6ok && isFinite(unit)) inv6d = "单位行高 " + unit.toFixed(1) + "px，" + present.length + " 个有字行均匀";
		inv("INV-6", inv6ok, inv6d);

		// INV-9 兜底状态：有内容时「透明化中且有段」或「已回退官方显示」二居其一
		inv("INV-9", !hasContent || (host && mo.segCount > 0) || (!host && mo.segCount === 0),
			"内容=" + hasContent + " host=" + host + " 段=" + mo.segCount);

		// INV-10 chip 行降级：有 chip 时编辑器段落 KEEP 在位（overlay 侧由 INV-4 对齐保证）
		var keepOk = true, keepD = "无 chip";
		if (anyChip) {
			var ps = input.querySelectorAll(":scope > p");
			keepOk = ps.length > 0;
			for (i = 0; i < ps.length; i++) if (!ps[i].classList.contains(KEEP_CLS)) { keepOk = false; }
			keepD = keepOk ? "KEEP 在位" : "含 chip 但段落缺 " + KEEP_CLS;
		}
		inv("INV-10", keepOk, keepD);

		// INV-7 caret 采样（放最后：设 selection 会触发插件重渲染，重建段 DOM）
		var caretBad = null, caretN = 0;
		var offs = sampleOffsets(src, lines);
		for (i = 0; i < offs.length; i++) {
			if (offs[i] > src.length) continue;
			// \r 位置跳过：编辑器把 \r 当换行点（caret 画在行尾/下一行首），与「字符左侧」不可比
			if (src.charCodeAt(offs[i]) === 13) continue;
			// 采样行若是 chip 行则跳过（官方原样显示，几何另算）
			var li2 = src.slice(0, offs[i]).split("\n").length - 1;
			if (chipLine[li2]) continue;
			var ok2 = setSelCollapsed(input, anchors, offs[i]);
			if (!ok2) continue;
			var sel = window.getSelection();
			if (!sel.rangeCount) continue;
			var rr = sel.getRangeAt(0).getClientRects();
			// 折行点：collapsed caret 产两个等价 rect（上一视觉行尾 + 本行首）——
			// 全部候选参与判定，任一匹配即通过（恒取 rr[0] 会在折行点误报，v0.2.8 实测踩中）
			var boxes = rr && rr.length ? Array.prototype.slice.call(rr) : [sel.getRangeAt(0).getBoundingClientRect()];
			boxes = boxes.filter(function (b1) { return b1 && !(b1.width === 0 && b1.height === 0 && b1.left === 0 && b1.top === 0); });
			if (!boxes.length) continue;
			var box = boxes[0];
			caretN++;
			// 期望：offset 处字符的 left/top；行尾取行末字符的 right。
			// offInLine 是投影偏移差（\r 占位），byLine 按 voff（\r 不占位）索引——
			// 从 offInLine 起找最近的有测记录项。
			var lineArr = byLine[li2] || [];
			var offInLine = offs[i] - (function () { var b = 0; for (var k3 = 0; k3 < li2; k3++) b += lines[k3].length + 1; return b; })();
			var visLen = lines[li2].replace(/\r/g, "").length;
			// 投影偏移 → 可见序：减去该位置前的 \r 个数（\r 占投影位不占可见序）
			var vOff = Math.min(lines[li2].slice(0, offInLine).replace(/\r/g, "").length, visLen);
			var ref = null;
			for (var d = 0; d <= 2 && !ref; d++) {
				ref = lineArr[vOff - d] || (vOff + d <= visLen ? lineArr[vOff + d] : null) || null;
			}
			if (!ref) continue;
			var atLineEnd = vOff >= visLen;
			var wantX = atLineEnd ? ref.x + ref.w : ref.x;
			var anyMatch = boxes.some(function (b1) { return Math.abs(b1.left - wantX) <= 1.5 && Math.abs(b1.top - ref.y) <= 1.5; });
			if (!anyMatch) {
				// [diag] 失败现场全量：box/ref 完整 rect、该 offset 的实时字符 rect、byLine 前后项
				var dbgChar = null;
				try {
					var rr2 = document.createRange();
					rr2.setStart(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
					rr2.setEnd(sel.getRangeAt(0).startContainer, Math.min(sel.getRangeAt(0).startOffset + 1, (sel.getRangeAt(0).startContainer.nodeValue || "").length));
					var db2 = rr2.getBoundingClientRect();
					dbgChar = { x: +db2.x.toFixed(1), y: +db2.y.toFixed(1) };
				} catch (e2) { dbgChar = String(e2).slice(0, 80); }
				caretBad = { off: offs[i], line: li2, gotX: box.left.toFixed(1), wantX: wantX.toFixed(1), dy: Math.abs(box.top - ref.y).toFixed(1),
					diag: { box: { l: +box.left.toFixed(1), t: +box.top.toFixed(1), r: +box.right.toFixed(1) }, ref: { x: +ref.x.toFixed(1), y: +ref.y.toFixed(1), w: +ref.w.toFixed(1), ch: ref.ch }, liveChar: dbgChar, vOff: vOff, visLen: visLen, lineLen: (lines[li2] || "").length,
						near: (lineArr.slice(Math.max(0, vOff - 2), vOff + 3) || []).map(function (c2) { return c2.ch + "@" + Math.round(c2.x) + "," + Math.round(c2.y); }).join(" ") } };
				break;
			}
		}
		inv("INV-7", !caretBad, "采样 " + caretN + " 点" + (caretBad ? "；offset " + caretBad.off + "（行" + caretBad.line + "）光标 x=" + caretBad.gotX + " 期望 " + caretBad.wantX + " dy=" + caretBad.dy + " [diag] " + JSON.stringify(caretBad.diag) : ""));

		return out;
	}

	/** 诊断：前 limit 个字符的两侧坐标明细（INV-3 超差分诊用——看 dy 的符号与
	 * 中文/英文分组模式，区分「系统性基线偏移」与「特定字形偏移」）。 */
	function diagDy(limit) {
		var ci = getCardInput();
		if (!ci) return { error: "no-input" };
		var input = ci.input;
		var anchors = buildIndAnchors(input);
		var src = indProject(anchors);
		var lines = src.split("\n");
		var chipLine = [];
		for (var i = 0; i < lines.length; i++) chipLine.push(lines[i].indexOf(CHIP) !== -1);
		var ed = measureEditor(anchors);
		var exp = [];
		for (i = 0; i < ed.chars.length; i++) if (!chipLine[ed.chars[i].line]) exp.push(ed.chars[i]);
		var mo = measureOverlay(ci.ov);
		var n = Math.min(limit || 150, exp.length, mo.chars.length);
		var rows = [];
		var stat = { cjk: { n: 0, dySum: 0, min: 1e9, max: -1e9 }, lat: { n: 0, dySum: 0, min: 1e9, max: -1e9 } };
		for (i = 0; i < n; i++) {
			var e = exp[i], m = mo.chars[i];
			var dy = m.y - e.y;
			var isCjk = e.ch.charCodeAt(0) > 127;
			var g = isCjk ? stat.cjk : stat.lat;
			g.n++; g.dySum += dy; if (dy < g.min) g.min = dy; if (dy > g.max) g.max = dy;
			if (rows.length < 40) rows.push({ i: i, line: e.line, ch: e.ch.charCodeAt(0), edY: +e.y.toFixed(2), ovY: +m.y.toFixed(2), dy: +dy.toFixed(2), edH: +e.h.toFixed(1), ovH: +m.h.toFixed(1) });
		}
		for (var k2 of ["cjk", "lat"]) { var s = stat[k2]; if (s.n) { s.avg = +(s.dySum / s.n).toFixed(2); delete s.dySum; } else delete s.n; }
		var monoEl = input.querySelector(".dsh-cl-mono");
		var monoP = input.querySelectorAll(":scope > p.dsh-cl-mono").length;
		return {
			n: n, stat: stat, rows: rows,
			ovFont: getComputedStyle(ci.ov).fontFamily.slice(0, 120),
			edFont: getComputedStyle(input.querySelector(":scope > p") || input).fontFamily.slice(0, 120),
			monoTag: monoEl ? monoEl.tagName + "." + monoEl.className : "无",
			monoFont: monoEl ? getComputedStyle(monoEl).fontFamily.slice(0, 120) : "-",
			monoPCount: monoP,
			ovLineH: getComputedStyle(ci.ov).lineHeight,
			codeFontVar: getComputedStyle(ci.card).getPropertyValue("--dsh-cl-code-font").slice(0, 100)
		};
	}

	window.__e2e = {
		inject: inject,
		clearDraft: clearDraft,
		op: op,
		snapshot: snapshot,
		verify: verify,
		diagDy: diagDy,
		domShape: function () { var ci = getCardInput(); return ci ? domShape(ci.input) : null; }
	};
	return "e2e-inpage-loaded";
})()
