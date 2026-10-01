#!/usr/bin/env node
/**
 * dsh-composer-live E2E 主 runner：拉起独立 Chrome（默认 headless）→ CDP 直连被测页面
 * → 逐场景注入 → 校验十条不变量 → 报告（report-last.json + 控制台摘要 + 退出码）。
 *
 * 用法：
 *   node run-e2e.mjs                    # 跑全场景（要求被测实例已部署当前源码）
 *   node run-e2e.mjs --with-deploy      # 先跑 deploy.mjs（部署+重启实例）再测
 *   node run-e2e.mjs --only crlf        # 只跑名字含 "crlf" 的场景
 *   node run-e2e.mjs --headed           # 有头模式（人工观察；会弹浏览器窗口）
 *   node run-e2e.mjs --keep-browser     # 结束后不关浏览器（调试用）
 *
 * 环境变量（不设用默认值，默认值对应本机主测试实例）：
 *   DSH_CL_PORT          被测实例端口（默认 8124）
 *   DSH_CL_E2E_PROFILE   E2E 专用 Chrome profile 目录（默认 ~/.dsh-cl-e2e-profile）
 *   DSH_CL_DST_PKG       部署副本的 package.json 路径（版本对照用，默认 .dsh-latest 副本）
 *
 * 鉴权：cookie 注入法（token 拿不到——launchToken 是进程内存随机）。cookie 来源：
 *   环境变量 DSH_CL_AUTH_COOKIE 或本目录 cookie.txt（每行一个「名=值」）。
 *   获取：用户浏览器 DevTools → 应用 → Cookies → http://127.0.0.1:<端口> → 复制
 *   dsh-auth- 开头那行的「名=值」。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PORT = Number(process.env.DSH_CL_PORT) || 8124;
const BASE = `http://127.0.0.1:${PORT}/`;
const PROFILE_DIR = process.env.DSH_CL_E2E_PROFILE
	|| path.join(os.homedir(), ".dsh-cl-e2e-profile"); // 本地目录（绝不放网盘同步目录）
const DST_PKG = process.env.DSH_CL_DST_PKG
	|| path.join(os.homedir(), ".dsh-latest/profiles/web/node_modules/dsh-composer-live/package.json");
const CHROME_CANDIDATES = [
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
// INV-8 已知无害噪音（基线收集后维护；按子串匹配）
const KNOWN_NOISE = [];

const argv = process.argv.slice(2);
const opt = {
	withDeploy: argv.includes("--with-deploy"),
	headed: argv.includes("--headed"),
	keepBrowser: argv.includes("--keep-browser"),
	only: (argv.join(" ").match(/--only\s+(\S+)/) || [])[1] || "",
	diagDy: argv.includes("--diag-dy"),
};

const log = (s) => console.log(s);
const die = (s) => { console.error("失败: " + s); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- cookie ----------
const cookieRaw = process.env.DSH_CL_AUTH_COOKIE
	|| (() => { try { return fs.readFileSync(path.join(HERE, "cookie.txt"), "utf8"); } catch { return ""; } })();
const cookiePairs = String(cookieRaw).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
if (!cookiePairs.length) {
	die(`缺少鉴权 cookie。获取方法：\n  用户浏览器打开 ${BASE} → F12 → 应用(Application) → Cookies → http://127.0.0.1:${PORT}\n  → 复制 dsh-auth- 开头那行的「名=值」→ 存入 ${path.join(HERE, "cookie.txt")}（每行一个，不进 git）\n  或临时用环境变量 DSH_CL_AUTH_COOKIE="名=值"`);
}

// ---------- 前置：部署 / 探活 / 版本 ----------
if (opt.withDeploy) {
	log("== 先部署（deploy.mjs）==");
	const r = spawnSync(process.execPath, [path.join(ROOT, "deploy.mjs")], { stdio: "inherit" });
	if (r.status !== 0) die("deploy.mjs 失败");
}

try {
	const res = await fetch(BASE, { redirect: "manual", signal: AbortSignal.timeout(5000) });
	if (![200, 303, 401].includes(res.status)) die(`${PORT} 探活异常（HTTP ${res.status}）`);
	log(`${PORT} 探活通过（HTTP ${res.status}）`);
} catch (e) {
	die(`${PORT} 未启动（${e.message}）。先跑 node ${path.join(ROOT, "deploy.mjs")} 或用 --with-deploy`);
}

const srcVer = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const dstVer = JSON.parse(fs.readFileSync(DST_PKG, "utf8")).version;
if (srcVer !== dstVer) die(`源码 v${srcVer} 与部署副本 v${dstVer} 不一致——先部署（--with-deploy）再测`);
log(`插件版本 v${srcVer}（源码=部署副本）`);

// ---------- Chrome ----------
const exe = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!exe) die("找不到 Chrome/Edge 可执行文件：" + CHROME_CANDIDATES.join(" ; "));
const dbgPort = 9400 + Math.floor(Math.random() * 400); // 避开 superpowers-chrome 的 9222
const chromeArgs = [
	opt.headed ? "" : "--headless=new",
	`--remote-debugging-port=${dbgPort}`,
	`--user-data-dir=${PROFILE_DIR}`,
	"--no-first-run", "--no-default-browser-check", "--disable-extensions",
	"--window-size=1440,900", "about:blank",
].filter(Boolean);
const chrome = spawn(exe, chromeArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: !opt.headed });
const killChrome = () => { try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch { /* 已退 */ } } };
process.on("exit", () => { if (!opt.keepBrowser) try { chrome.kill(); } catch { /* 已退 */ } });

// 等调试端口就绪
let pageWs = null;
for (let i = 0; i < 40 && !pageWs; i++) {
	await sleep(400);
	try {
		const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json();
		const page = list.find((t) => t.type === "page");
		if (page) pageWs = page.webSocketDebuggerUrl;
	} catch { /* 还没起来 */ }
}
if (!pageWs) { killChrome(); die("Chrome 调试端口 30s 未就绪"); }
log(`Chrome 就绪（${path.basename(exe)}，CDP 端口 ${dbgPort}）`);

// ---------- CDP ----------
class CDP {
	constructor(url) {
		this.ws = new WebSocket(url);
		this.id = 0;
		this.pending = new Map();
		this.consoleErrors = [];
		this.ready = new Promise((res, rej) => {
			this.ws.onopen = () => res();
			this.ws.onerror = (e) => rej(new Error("CDP WebSocket 错误"));
		});
		this.ws.onmessage = (ev) => this._onMsg(String(ev.data));
	}
	_onMsg(text) {
		let msg;
		try { msg = JSON.parse(text); } catch { return; }
		if (msg.id && this.pending.has(msg.id)) {
			const { res, rej, timer } = this.pending.get(msg.id);
			clearTimeout(timer);
			this.pending.delete(msg.id);
			msg.error ? rej(new Error(msg.error.message || JSON.stringify(msg.error))) : res(msg.result);
		} else if (msg.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(msg.params.type)) {
			const args = (msg.params.args || []).map((a) => a.value != null ? String(a.value) : (a.description || a.type)).join(" ");
			this.consoleErrors.push(args.slice(0, 300));
		} else if (msg.method === "Runtime.exceptionThrown") {
			const d = msg.params.exceptionDetails;
			this.consoleErrors.push(String((d.exception && d.exception.description) || d.text || "exception").slice(0, 300));
		}
	}
	send(method, params = {}, timeout = 30000) {
		return new Promise((res, rej) => {
			const id = ++this.id;
			const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP 超时: ${method}`)); }, timeout);
			this.pending.set(id, { res, rej, timer });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	async eval(expression, awaitPromise = false) {
		const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
		if (r.exceptionDetails) {
			const d = r.exceptionDetails;
			throw new Error("页面执行异常: " + String((d.exception && d.exception.description) || d.text).slice(0, 500));
		}
		return r.result && r.result.value;
	}
}

const cdp = new CDP(pageWs);
await cdp.ready;
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Network.enable");

// ---------- 打开页面 + cookie ----------
for (const pair of cookiePairs) {
	const eq = pair.indexOf("=");
	const name = pair.slice(0, eq), value = pair.slice(eq + 1);
	const ok = await cdp.send("Network.setCookie", { name, value, url: BASE });
	if (!ok.success) die(`cookie 设置失败: ${name}`);
}
log(`已注入 ${cookiePairs.length} 个 cookie`);
await cdp.send("Page.navigate", { url: BASE });
await sleep(2500);

const INPAGE_SRC = fs.readFileSync(path.join(HERE, "inpage.js"), "utf8");
async function ensureInpage() {
	const v = await cdp.eval(INPAGE_SRC);
	if (v !== "e2e-inpage-loaded") die("inpage 注入返回异常: " + v);
}
async function waitForComposer(timeoutMs = 30000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const st = await cdp.eval("(() => { var i = document.querySelector('[data-composer-input]'); return i ? { edit: i.getAttribute('contenteditable'), url: location.pathname } : null; })()");
		if (st && st.edit === "true") return st;
		await sleep(400);
	}
	// 失败截图留档
	try {
		const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
		const f = path.join(HERE, `fail-composer-${Date.now()}.png`);
		fs.writeFileSync(f, Buffer.from(shot.data, "base64"));
		die(`30s 等不到可编辑输入框（cookie 失效或落在工作区选择页？截图: ${f}）`);
	} catch { die("30s 等不到可编辑输入框（cookie 失效或落在工作区选择页？）"); }
}
await waitForComposer();
await ensureInpage();
const dbgOk = await cdp.eval("typeof window.__dshClDebug === 'function'");
if (!dbgOk) die("页面无 __dshClDebug（插件未激活或部署的是旧版——先 --with-deploy）");
log("输入框就绪，插件调试钩子在位");

// ---------- 稳定等待 ----------
async function waitStable(timeoutMs = 10000) {
	const t0 = Date.now();
	let last = "", same = 0;
	while (Date.now() - t0 < timeoutMs) {
		const snap = await cdp.eval("JSON.stringify(window.__e2e.snapshot())");
		if (snap === last) { same++; if (same >= 3) return true; }
		else { same = 0; last = snap; }
		await sleep(150);
	}
	return false; // 超时：不稳定，照常校验（报告标注）
}

// ---------- 场景执行 ----------
function normSteps(sc) {
	if (sc.steps) return sc.steps.map((s) => ({ channel: s.channel, text: s.text, html: s.html, caretProjOff: s.caretProjOff }));
	return [{ channel: sc.channel, text: sc.text, html: sc.html, caretProjOff: sc.caretProjOff }];
}

const todo = SCENARIOS.filter((sc) => !opt.only || sc.name.toLowerCase().includes(opt.only.toLowerCase()));
log(`\n======== E2E 开始：${todo.length} 个场景 ========\n`);

const results = [];
let browserDead = false;
for (const sc of todo) {
	const row = { name: sc.name, group: sc.group, focus: sc.focus || "", ok: true, invs: {}, injects: [], unstable: false, error: null };
	results.push(row);
	try {
		const cMark = cdp.consoleErrors.length;
		await cdp.eval("window.__e2e.clearDraft()");
		if (!(await waitStable())) row.unstable = true;

		for (const step of normSteps(sc)) {
			const inj = await cdp.eval(`window.__e2e.inject(${JSON.stringify({ channel: step.channel, text: step.text ? step.text() : "", html: step.html, caretProjOff: step.caretProjOff })})`);
			row.injects.push(inj);
			if (!inj || !inj.ok) { row.ok = false; row.error = "注入失败: " + JSON.stringify(inj); break; }
			await waitStable(6000);
		}
		if (row.error) { finishRow(row, cMark); logLine(row); continue; }

		if (sc.refresh) {
			await cdp.send("Page.reload");
			await sleep(2000);
			await waitForComposer();
			await ensureInpage();
		}
		if (!(await waitStable())) row.unstable = true;

		if (opt.diagDy) {
			const d = await cdp.eval("window.__e2e.diagDy(300)");
			log("  [diag] 统计 " + JSON.stringify(d.stat));
			log("  [diag] 前 12 行样本 " + JSON.stringify(d.rows.slice(0, 12)));
			log("  [diag] overlay 字体: " + d.ovFont);
			log("  [diag] 编辑器字体: " + d.edFont);
			log("  [diag] MONO 打点: " + d.monoTag + " | 字体 " + d.monoFont + " | p 级 " + d.monoPCount + " 个");
			log("  [diag] overlay 行高 " + d.ovLineH + " | code-font 变量 " + d.codeFontVar);
		}

		for (const o of sc.ops || []) {
			const opr = await cdp.eval(`window.__e2e.op(${JSON.stringify(o)})`);
			if (opr && opr.ok === false) {
				row.ok = false;
				row.error = "op 断言失败（" + JSON.stringify(o).slice(0, 80) + "）：实际投影 " + JSON.stringify(opr.got || "");
				break;
			}
			await waitStable(6000);
		}
		if (row.error) { finishRow(row, cMark); logLine(row); continue; }

		const v = await cdp.eval("window.__e2e.verify()");
		if (!v || v.error) { row.ok = false; row.error = "校验器异常: " + (v && v.error); }
		else {
			row.invs = v.invs;
			row.meta = v.meta;
			row.ok = v.ok;
		}
		// INV-8 console 错误增量（白名单过滤）
		const errs = cdp.consoleErrors.slice(cMark).filter((e) => !KNOWN_NOISE.some((k) => e.includes(k)));
		row.invs["INV-8"] = { ok: errs.length === 0, detail: errs.length ? errs.slice(0, 3).join(" | ") : "零错误" };
		if (errs.length) row.ok = false;
		finishRow(row, cMark);
	} catch (e) {
		row.ok = false;
		row.error = String(e.message || e).slice(0, 300);
		if (/CDP|WebSocket/i.test(row.error)) browserDead = true;
	}
	logLine(row);
	if (browserDead) { log("\n浏览器连接断开，中止剩余场景"); break; }
}

function finishRow(row, cMark) { /* 占位：结果已在 row 上 */ }
function logLine(row) {
	const mark = row.ok ? "PASS" : "FAIL";
	const bad = Object.entries(row.invs).filter(([, v]) => v && !v.ok).map(([k, v]) => {
		const d = String(v.detail || "").slice(0, 160);
		return `${k}: ${d}`;
	});
	log(`[${mark}] ${row.name}${row.focus ? "（" + row.focus + "）" : ""}${row.unstable ? " [渲染未稳定]" : ""}`);
	if (!row.ok) {
		if (row.error) log(`       错误: ${row.error}`);
		for (const b of bad.slice(0, 6)) log(`       ${b}`);
		if (bad.length > 6) log(`       …另有 ${bad.length - 6} 条`);
	}
}

// 收尾：清空草稿（恢复原状；全程未派发 Enter，未发送任何内容）
if (!browserDead) { try { await cdp.eval("window.__e2e.clearDraft()"); } catch { /* 尽力 */ } }

// ---------- 报告 ----------
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
const byInv = {};
for (const r of results) for (const [k, v] of Object.entries(r.invs)) {
	if (!v || v.ok) continue;
	byInv[k] = byInv[k] || [];
	byInv[k].push(r.name);
}
const report = {
	meta: { time: new Date().toISOString(), pluginVersion: srcVer, total: results.length, pass, fail, headed: opt.headed },
	byInv,
	results,
};
fs.writeFileSync(path.join(HERE, "report-last.json"), JSON.stringify(report, null, 2));
log(`\n======== 完成：${pass} 过 / ${fail} 失败（共 ${results.length}）========`);
if (fail) {
	log("按不变量分布：");
	for (const [k, names] of Object.entries(byInv)) log(`  ${k}: ${names.length} 个场景（${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}）`);
	log(`明细见 ${path.join(HERE, "report-last.json")}`);
}
if (!opt.keepBrowser) { try { chrome.kill(); } catch { /* 已退 */ } }
process.exitCode = fail ? 1 : 0;
// 不 process.exit（detached/spawn 环境下强退有 libuv 句柄断言噪音——deploy.mjs 同款经验）
