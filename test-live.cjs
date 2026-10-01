// dsh-composer-live 渲染器测试（node test-live.cjs）
// 在 vm 沙箱里加载 client.js，调用纯函数导出验证输出与安全性。
// 与旧版 dsh-composer-md 的 test-md.cjs 同源（class 前缀 dsh-cm- → dsh-cl-），
// 新增 chip 段落/段落级等宽测试；斜杠触发已由 0.1.5 官方原生收编，相关测试移除。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
let loaded = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (o) => { loaded = o; } } },
  console,
};
vm.runInNewContext(src, sandbox, { filename: 'client.js' });
if (!loaded) { console.error('FAIL: ModuleLoader.load 未被调用'); process.exit(1); }
const mod = loaded.factory((id) => { throw new Error('unexpected require: ' + id); });
const render = mod._renderInline;
const NBSP = String.fromCharCode(160); // U+00A0（空行占位保行高）
const CHIP = String.fromCharCode(0xFFFC); // U+FFFC（chip 投影字符，与官方 detectText 同构）

let pass = 0, fail = 0;
function t(name, actual, expect) {
  const ok = typeof actual === 'object' && actual !== null
    ? JSON.stringify(actual) === JSON.stringify(expect)
    : actual === expect;
  if (ok) { pass++; }
  else { fail++; console.log('FAIL:', name); console.log('  expect:', JSON.stringify(expect)); console.log('  actual:', JSON.stringify(actual)); }
}

// ===== 行内格式（每段落包一个 div；标记字符保留占位 mk——字符级对齐）=====
const MK = (s) => '<span class="dsh-cl-mk">' + s + '</span>';
t('plain', render('你好世界'), '<div>你好世界</div>');
t('bold', render('**粗**'), '<div>' + MK('**') + '<strong>粗</strong>' + MK('**') + '</div>');
t('italic', render('*斜*'), '<div>' + MK('*') + '<em>斜</em>' + MK('*') + '</div>');
t('bold+italic', render('***x***'), '<div>' + MK('***') + '<strong><em>x</em></strong>' + MK('***') + '</div>');
t('inline code', render('`a & b`'), '<div>' + MK('`') + '<code>a &amp; b</code>' + MK('`') + '</div>');
t('del', render('~~删~~'), '<div>' + MK('~~') + '<del>删</del>' + MK('~~') + '</div>');
t('safe link', render('[x](https://example.com)'), '<div>' + MK('[') + '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>' + MK('](https://example.com)') + '</div>');
t('blocked js link', render('[x](javascript:alert(1))'), '<div>[x](javascript:alert(1))</div>');
t('xss script', render('<script>alert(1)</script>'), '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
t('image capsule', render('![alt](https://x.com/i.png)'), '<div><span class="dsh-cl-img">![alt](https://x.com/i.png)</span></div>');
t('image capsule mixed', render('看 ![图](a.png) 和 `码`'), '<div>看 <span class="dsh-cl-img">![图](a.png)</span> 和 ' + MK('`') + '<code>码</code>' + MK('`') + '</div>');
t('mixed', render('**粗** 和 `代码`'), '<div>' + MK('**') + '<strong>粗</strong>' + MK('**') + ' 和 ' + MK('`') + '<code>代码</code>' + MK('`') + '</div>');
t('empty', render(''), '<div>' + NBSP + '</div>');
t('digits untouched', render('版本 2.0 发布'), '<div>版本 2.0 发布</div>');
t('digits with code', render('第 3 次 `v1.2` 更新'), '<div>第 3 次 ' + MK('`') + '<code>v1.2</code>' + MK('`') + ' 更新</div>');

// ===== 空行与多段落 =====
t('blank line', render('a\n\nb'), '<div>a</div><div>' + NBSP + '</div><div>b</div>');
t('multiline', render('第一行\n第二行 **粗**'), '<div>第一行</div><div>第二行 ' + MK('**') + '<strong>粗</strong>' + MK('**') + '</div>');

// ===== 块级视觉（标题/引用/列表/表格分隔行）=====
t('heading', render('# 标题'), '<div><span class="dsh-cl-hmark">#</span> <span class="dsh-cl-heading">标题</span></div>');
t('heading bold', render('## **加粗**'), '<div><span class="dsh-cl-hmark">##</span> <span class="dsh-cl-heading">' + MK('**') + '<strong>加粗</strong>' + MK('**') + '</span></div>');
t('heading six', render('###### 六级'), '<div><span class="dsh-cl-hmark">######</span> <span class="dsh-cl-heading">六级</span></div>');
t('quote', render('> 引用'), '<div class="dsh-cl-quote"><span class="dsh-cl-qmark">&gt;</span> 引用</div>');
t('quote no space', render('>引用'), '<div class="dsh-cl-quote"><span class="dsh-cl-qmark">&gt;</span>引用</div>');
t('list dash', render('- 项目'), '<div><span class="dsh-cl-lmark">-</span> 项目</div>');
t('list star', render('* 项目'), '<div><span class="dsh-cl-lmark">*</span> 项目</div>');
t('list ordered', render('1. 第一'), '<div><span class="dsh-cl-lmark">1.</span> 第一</div>');
t('table sep', render('|---|---|'), '<div><span class="dsh-cl-tmark">|---|---|</span></div>');
t('not heading no space', render('#标题'), '<div>#标题</div>');
t('not list no space', render('-项目'), '<div>-项目</div>');
t('heading with code', render('# `代码` 结尾'), '<div><span class="dsh-cl-hmark">#</span> <span class="dsh-cl-heading">' + MK('`') + '<code>代码</code>' + MK('`') + ' 结尾</span></div>');

// ===== 代码块 =====
const OPEN = '<div class="dsh-cl-cline dsh-cl-fence-open">';
const CLOSE = '<div class="dsh-cl-cline dsh-cl-fence-close">';
const CL = '<div class="dsh-cl-cline">';
t('code block', render('```\ncode\n```'), OPEN + '<span class="dsh-cl-mk">```</span></div>' + CL + 'code</div>' + CLOSE + '<span class="dsh-cl-mk">```</span></div>');
t('code block lang', render('```js\nconst a = 1 < 2\n```'), OPEN + '<span class="dsh-cl-mk">```js</span><span class="dsh-cl-lang">js</span></div>' + CL + '<span class="dsh-cl-tok-kw">const</span> a = <span class="dsh-cl-tok-num">1</span> &lt; <span class="dsh-cl-tok-num">2</span></div>' + CLOSE + '<span class="dsh-cl-mk">```</span></div>');
t('code unclosed renders plain (new flow: ``` alone shows no block)', render('```\nlet x = 1'), '<div>```</div><div>let x = 1</div>');
t('code no bold inside', render('```\n**not bold**\n```'), OPEN + '<span class="dsh-cl-mk">```</span></div>' + CL + '**not bold**</div>' + CLOSE + '<span class="dsh-cl-mk">```</span></div>');
t('code blank line', render('```\n\n```'), OPEN + '<span class="dsh-cl-mk">```</span></div>' + CL + NBSP + '</div>' + CLOSE + '<span class="dsh-cl-mk">```</span></div>');
t('tilde fence', render('~~~\nx\n~~~'), OPEN + '<span class="dsh-cl-mk">~~~</span></div>' + CL + 'x</div>' + CLOSE + '<span class="dsh-cl-mk">~~~</span></div>');
t('code then inline', render('```\nc\n```\nuse `x`'), OPEN + '<span class="dsh-cl-mk">```</span></div>' + CL + 'c</div>' + CLOSE + '<span class="dsh-cl-mk">```</span></div><div>use ' + MK('`') + '<code>x</code>' + MK('`') + '</div>');

// ===== 行内 code 的光标段例外（cursorPara / noMono）=====
t('code mono by default', render('use `x` here'), '<div>use ' + MK('`') + '<code>x</code>' + MK('`') + ' here</div>');
t('cursor para code falls back', render('use `x` here', 0), '<div>use ' + MK('`') + '<code class="dsh-cl-ce">x</code>' + MK('`') + ' here</div>');
t('only cursor para affected', render('a `x`\nb `y`', 1), '<div>a ' + MK('`') + '<code>x</code>' + MK('`') + '</div><div>b ' + MK('`') + '<code class="dsh-cl-ce">y</code>' + MK('`') + '</div>');
t('unclosed single fence renders plain', render('```js', 0), '<div>```js</div>');
t('cursor para not exist', render('a `x`', 5), '<div>a ' + MK('`') + '<code>x</code>' + MK('`') + '</div>');

// ===== chip 段落（@ 引用段落降级：overlay 空占位 + 官方原样显示）=====
t('chip para skipped', render('看这个 ' + CHIP + ' 文件'), '<div class="dsh-cl-skip">' + NBSP + '</div>');
t('chip para among normal', render('a\n' + CHIP + '\nb'), '<div>a</div><div class="dsh-cl-skip">' + NBSP + '</div><div>b</div>');
t('paraHasChip true', mod._paraHasChip('x' + CHIP + 'y'), true);
t('paraHasChip false', mod._paraHasChip('plain'), false);
t('chip not mistaken for text', render('普通段落'), '<div>普通段落</div>');

// ===== 段落级代码态（codeParaFlags：编辑器段落打等宽 class 用）=====
const cpf = mod._codeParaFlags;
t('cpf plain', cpf(['a', 'b']), [false, false]);
t('cpf with block', cpf(['```', 'code', '```', 'after']), [true, true, true, false]);
t('cpf unclosed all plain', cpf(['```js', 'let x']), [false, false]);
t('cpf empty', cpf([]), []);

// ===== 键盘判定（decideKeyAction）=====
const decide = mod._decideKeyAction;
const M = { shift: false, ctrl: false, alt: false, meta: false };
t('enter on open fence', decide('```', 3, 'Enter', M), { type: 'fence', insert: '\n\n```\n', cursor: 4 });
t('enter on open fence with lang', decide('```js', 5, 'Enter', M), { type: 'fence', insert: '\n\n```\n', cursor: 6 });
t('enter on tilde fence', decide('~~~', 3, 'Enter', M), { type: 'fence', insert: '\n\n~~~\n', cursor: 4 });
t('enter mid-doc', decide('标题\n```', 8, 'Enter', M), { type: 'fence', insert: '\n\n```\n', cursor: 9 });
// Shift+Enter 在围栏行同样补全（用户流：``` + Shift+Enter → 封闭代码块）
t('shift-enter on open fence completes', decide('```', 3, 'Enter', { ...M, shift: true }), { type: 'fence', insert: '\n\n```\n', cursor: 4 });
t('shift-enter on plain line passthrough', decide('普通', 2, 'Enter', { ...M, shift: true }), null);
t('enter fence cursor mid-line with text after', decide('```xxx', 3, 'Enter', M), { type: 'fence', insert: '\n\n```\n', cursor: 4 });
t('enter on close fence (no complete)', decide('```\ncode\n```', 11, 'Enter', M), null);
t('enter on plain line', decide('普通文字', 4, 'Enter', M), null);
t('enter fence line with junk', decide('```abc def', 10, 'Enter', M), null);
t('enter inline code span', decide('这是 `code` 行', 14, 'Enter', M), null);
// ArrowDown 跳出：块内最后一个内容行（下一行是闭合围栏）
t('arrow-down escapes block', decide('```\ncode\n```\n', 8, 'ArrowDown', M), { type: 'jumpout', cursor: 13 });
t('arrow-down mid block passthrough', decide('```\na\nb\n```', 5, 'ArrowDown', M), null);
t('arrow-down outside block passthrough', decide('普通\n文字', 3, 'ArrowDown', M), null);
t('arrow-down on fence line passthrough', decide('```\ncode\n```', 9, 'ArrowDown', M), null);
t('arrow-down unclosed block passthrough', decide('```\ncode', 8, 'ArrowDown', M), null);
t('arrow-down last line passthrough', decide('```\ncode', 8, 'ArrowDown', M), null);
t('arrow-down with shift passthrough', decide('```\ncode\n```\n', 8, 'ArrowDown', { ...M, shift: true }), null);
t('tab inside code block', decide('```\nlet x', 9, 'Tab', M), { type: 'indent', insert: '  ' });
t('tab on fence line tail inserts spaces', decide('```\nlet x\n```', 14, 'Tab', M), { type: 'indent', insert: '  ' });
t('tab outside code block inserts at caret', decide('普通文字', 4, 'Tab', M), { type: 'indent', insert: '  ' });
t('tab in closed block after inserts at caret', decide('```\nc\n```\n正文', 13, 'Tab', M), { type: 'indent', insert: '  ' });
t('tab with ctrl', decide('```\nlet x', 9, 'Tab', { ...M, ctrl: true }), null);

// ===== Tab 缩进体系（v0.2.9：行首缩进嵌套 / Shift+Tab 反缩进 / 全拦截防焦点跳）=====
t('tab after list mark indents line head', decide('- 第一项', 2, 'Tab', M), { type: 'indent-at', at: 0, cursor: 4 });
t('tab after continuation item indents', decide('- 项\n- ', 6, 'Tab', M), { type: 'indent-at', at: 4, cursor: 8 });
t('tab after quote mark indents', decide('> 引用', 2, 'Tab', M), { type: 'indent-at', at: 0, cursor: 4 });
t('tab in list mid content inserts at caret', decide('- 第一项', 4, 'Tab', M), { type: 'indent', insert: '  ' });
t('tab at plain line start indents', decide('普通行', 0, 'Tab', M), { type: 'indent-at', at: 0, cursor: 2 });
t('tab at empty line indents', decide('', 0, 'Tab', M), { type: 'indent-at', at: 0, cursor: 2 });
t('tab in leading spaces indents', decide('  缩进行', 2, 'Tab', M), { type: 'indent-at', at: 0, cursor: 4 });
t('shift-tab removes 2 spaces', decide('  - 项', 0, 'Tab', { ...M, shift: true }), { type: 'outdent', rangeStart: 0, rangeEnd: 2 });
t('shift-tab removes 1 space only', decide(' - 项', 0, 'Tab', { ...M, shift: true }), { type: 'outdent', rangeStart: 0, rangeEnd: 1 });
t('shift-tab no indent is noop', decide('- 项', 0, 'Tab', { ...M, shift: true }), { type: 'tab-noop' });
t('shift-tab in code block still indents logic', decide('```\nlet x', 9, 'Tab', { ...M, shift: true }), { type: 'indent', insert: '  ' });

// ===== 表格首行自动补分隔行（v0.2.10）=====
t('table first line completes separator', decide('|列A|列B|', 7, 'Enter', M), { type: 'table-sep', insert: '\n|---|---|\n', cursor: 18 });
t('table 3 cols', decide('|a|b|c|', 7, 'Enter', M), { type: 'table-sep', insert: '\n|---|---|---|\n', cursor: 22 });
t('table next line already separator passthrough', decide('|a|b|\n|---|---|', 5, 'Enter', M), null);
t('table mid line passthrough', decide('|列A|列B|', 4, 'Enter', M), null);
t('single pipe not table', decide('|只有一个|', 6, 'Enter', M), null);

// ===== 任务列表勾选样式（v0.2.10，渲染层）=====
const ri = mod._renderInline;
t('task unchecked renders task class', ri('- [ ] 待办事项').includes('dsh-cl-task') && !ri('- [ ] 待办事项').includes('dsh-cl-task-done'), true);
t('task done renders done + strikethrough', ri('- [x] 已办事项').includes('dsh-cl-task-done') && ri('- [x] 已办事项').includes('<s>'), true);
t('task uppercase X', ri('- [X] 大写勾').includes('dsh-cl-task-done'), true);
t('task chars preserved for alignment', ri('- [ ] 待办').replace(/<[^>]+>/g, ''), '- [ ] 待办');

// ===== 选区批量缩进 decideTabBlock（v0.2.10）=====
const tb = mod._decideTabBlock;
t('block tab indents every line', tb('第一项\n第二项\n第三项', 0, 9, false),
  { type: 'block-indent', rangeStart: 0, rangeEnd: 11, insert: '  第一项\n  第二项\n  第三项', selStart: 0, selEnd: 17 });
t('block shift-tab removes indent', tb('  a\n  b', 0, 7, true),
  { type: 'block-indent', rangeStart: 0, rangeEnd: 7, insert: 'a\nb', selStart: 0, selEnd: 3 });
t('block tab skips empty lines', tb('a\n\nb', 0, 4, false).insert, '  a\n\n  b');
t('block shift-tab no indent noop', tb('a\nb', 0, 3, true), { type: 'tab-noop' });
t('block tab all empty falls to indent', tb('\n\n', 0, 2, false), { type: 'indent', insert: '  ' });
t('block selection mid lines takes whole lines', tb('x\naaa\nbbb\ny', 2, 8, false).insert, '  aaa\n  bbb');
t('other key passthrough', decide('```', 3, 'a', M), null);

// ===== 列表自动续项 / 空项退出（Enter 含 Shift+Enter）=====
// 注意 pos/cursor 均为 UTF-16 偏移（中文每字 1 单位）
t('ul dash continues', decide('- 第一项', 5, 'Enter', M), { type: 'list', insert: '\n- ', cursor: 8 });
t('ul star continues', decide('* item', 6, 'Enter', M), { type: 'list', insert: '\n* ', cursor: 9 });
t('ul plus continues', decide('+ item', 6, 'Enter', M), { type: 'list', insert: '\n+ ', cursor: 9 });
t('ol dot increments', decide('1. 第一', 5, 'Enter', M), { type: 'list', insert: '\n2. ', cursor: 9 });
t('ol paren increments', decide('3) item', 7, 'Enter', M), { type: 'list', insert: '\n4) ', cursor: 11 });
t('ol double digit', decide('10. x', 5, 'Enter', M), { type: 'list', insert: '\n11. ', cursor: 10 });
t('indented list keeps indent', decide('  - 缩进项', 7, 'Enter', M), { type: 'list', insert: '\n  - ', cursor: 12 });
t('shift-enter continues too', decide('- 第一项', 5, 'Enter', { ...M, shift: true }), { type: 'list', insert: '\n- ', cursor: 8 });
t('empty item exits', decide('- 第一项\n- ', 8, 'Enter', M), { type: 'list-exit', rangeStart: 6, rangeEnd: 8, cursor: 6 });
t('empty ol item exits', decide('1. a\n1. ', 8, 'Enter', M), { type: 'list-exit', rangeStart: 5, rangeEnd: 8, cursor: 5 });
t('cursor mid line passthrough', decide('- 长内容项目', 4, 'Enter', M), null);
t('cursor before mark passthrough', decide('- item', 1, 'Enter', M), null);
t('no-space mark passthrough', decide('-item', 5, 'Enter', M), null);
t('number without mark passthrough', decide('普通文字', 4, 'Enter', M), null);
t('list continue mid-doc', decide('前文\n- 项\n后文', 6, 'Enter', M), { type: 'list', insert: '\n- ', cursor: 9 });

// ===== 引用自动续项 / 空项退出（与列表同款交互，两次 Shift+Enter 结束）=====
t('quote continues', decide('> 引用一', 5, 'Enter', M), { type: 'list', insert: '\n> ', cursor: 8 });
t('quote continues shift-enter', decide('> 引用一', 5, 'Enter', { ...M, shift: true }), { type: 'list', insert: '\n> ', cursor: 8 });
t('quote no-space continues', decide('>text', 5, 'Enter', M), { type: 'list', insert: '\n> ', cursor: 8 });
t('indented quote keeps indent', decide('  > 缩进引用', 8, 'Enter', M), { type: 'list', insert: '\n  > ', cursor: 13 });
t('empty quote item exits', decide('> 引用\n> ', 7, 'Enter', M), { type: 'list-exit', rangeStart: 5, rangeEnd: 7, cursor: 5 });
t('bare gt exits', decide('> ', 2, 'Enter', M), { type: 'list-exit', rangeStart: 0, rangeEnd: 2, cursor: 0 });
t('quote mid line passthrough', decide('> 长引用内容', 4, 'Enter', M), null);
t('quote with inner list continues as quote', decide('> - 引用内列表', 9, 'Enter', M), { type: 'list', insert: '\n> ', cursor: 12 });
t('gt in plain text not at line start passthrough', decide('a > b', 5, 'Enter', M), null);

// ===== 工具栏格式插入（decideWrapAction）=====
const wrap = mod._decideWrapAction;
t('wrap bold no selection', wrap('abc', 1, 1, 'bold'), { insert: '****', cursorStart: 3, cursorEnd: 3 });
t('wrap bold with selection', wrap('abcd', 1, 3, 'bold'), { insert: '**bc**', cursorStart: 1, cursorEnd: 7 });
t('wrap italic', wrap('x', 0, 0, 'italic'), { insert: '**', cursorStart: 1, cursorEnd: 1 });
t('wrap code with selection', wrap('ab', 0, 2, 'code'), { insert: '`ab`', cursorStart: 0, cursorEnd: 4 });
t('wrap link', wrap('go', 0, 0, 'link'), { insert: '[](url)', cursorStart: 1, cursorEnd: 1 });
t('wrap list mid-line', wrap('hello\nworld', 8, 8, 'list'), { insert: '- ', cursorStart: 10, cursorEnd: 10, at: 6 });
t('wrap list already has', wrap('- item', 6, 6, 'list'), null);
t('wrap block no selection', wrap('text', 2, 2, 'block'), { insert: '```\n\n```\n', cursorStart: 6, cursorEnd: 6 });
t('wrap block with selection', wrap('code here', 0, 9, 'block'), { insert: '```\ncode here\n```', cursorStart: 4, cursorEnd: 13 });
t('wrap unknown kind', wrap('x', 0, 0, 'nope'), null);

// ===== 语法高亮（highlightLine）=====
const hl = mod._highlightLine;
t('hl js keyword', hl('const x = 1', 'js'), '<span class="dsh-cl-tok-kw">const</span> x = <span class="dsh-cl-tok-num">1</span>');
t('hl js string', hl('say("hi")', 'js'), '<span class="dsh-cl-tok-fn">say</span>(<span class="dsh-cl-tok-str">&quot;hi&quot;</span>)');
t('hl js comment', hl('a // note', 'js'), 'a <span class="dsh-cl-tok-com">// note</span>');
t('hl fn call', hl('foo(1)', 'js'), '<span class="dsh-cl-tok-fn">foo</span>(<span class="dsh-cl-tok-num">1</span>)');
t('hl py keyword', hl('def main():', 'py'), '<span class="dsh-cl-tok-kw">def</span> <span class="dsh-cl-tok-fn">main</span>():');
t('hl py comment', hl('x = 1 # 备注', 'py'), 'x = <span class="dsh-cl-tok-num">1</span> <span class="dsh-cl-tok-com"># 备注</span>');
t('hl literal', hl('return null', 'js'), '<span class="dsh-cl-tok-kw">return</span> <span class="dsh-cl-tok-lit">null</span>');
t('hl json key vs value', hl('{"a": "b"}', 'json'), '{<span class="dsh-cl-tok-fn">&quot;a&quot;</span>: <span class="dsh-cl-tok-str">&quot;b&quot;</span>}');
t('hl xss escaped', hl('<script>', 'js'), '&lt;script&gt;');
t('hl unknown lang generic', hl('foo = "bar"', 'rust'), 'foo = <span class="dsh-cl-tok-str">&quot;bar&quot;</span>');
t('hl no false span on plain', hl('普通文字', 'js'), '普通文字');

// ===== 合成字体栈（buildCodeFont：拉丁=代码等宽，中文=界面栈）=====
const bf = mod._buildCodeFont;
t('bf strips CJK from code stack', bf('"SF Mono", Consolas, "PingFang SC", "Microsoft YaHei"', 'system-ui, "HarmonyOS Sans SC"'),
  '"SF Mono", Consolas, system-ui, "HarmonyOS Sans SC"');
t('bf strips CJK mono fonts too', bf('"LXGW WenKai Mono", "Sarasa Mono SC", monospace', 'ui, "MiSans"'),
  'ui, "MiSans"');
t('bf strips generic families before ui stack', bf('"Sarasa Mono SC", "JetBrains Mono", Consolas, monospace', '"HarmonyOS Sans SC", sans-serif'),
  '"JetBrains Mono", Consolas, "HarmonyOS Sans SC", sans-serif');
t('bf keeps latin fonts', bf('"Fira Code", "Cascadia Code", "JetBrains Mono"', 'ui-stack'),
  '"Fira Code", "Cascadia Code", "JetBrains Mono", ui-stack');
t('bf covers source han and fz series', bf('"Source Han Sans SC", "FZHei-B01", Code', 'ui'),
  'Code, ui');
t('bf empty code stack', bf('', 'ui-font'), 'ui-font');
// Maple Mono NF CN：名含 NF CN（自带中文 1.2em 字形）——必须剔除（度量保护，
// 与 8123 旧版一致），否则代码块中文 advance 两侧不一致（E2E C 系实测）
t('bf strips Maple Mono NF CN', bf('"Maple Mono NF CN", "Anthropic Mono Variable", Consolas, monospace', 'ui, "Noto Sans SC"'),
  '"Anthropic Mono Variable", Consolas, ui, "Noto Sans SC"');

// ===== 语言推断（guessLang）=====
const gl = mod._guessLang;
t('guess json', gl('{"a": 1}'), 'json');
t('guess py', gl('def main():\n    pass'), 'py');
t('guess js', gl('const x = 1'), 'js');
t('guess sh', gl('pnpm install\nsudo apt update'), 'sh');
t('guess none', gl('只是一段说明文字'), '');

// ===== 光标在代码块内判定（isCursorInCodeBlock）=====
const icb = mod._isCursorInCodeBlock;
t('incode unclosed block', icb('```\ncode', 8), true);
t('incode before close fence', icb('```\ncode\n```', 8), true);
t('after closed block', icb('```\ncode\n```', 12), false);
t('on fence line itself', icb('```', 3), false);
t('plain text', icb('plain', 2), false);
t('after close then new text', icb('```\nc\n```\n正文', 13), false);

// ===== 大段粘贴自动包代码块（decidePasteWrap）=====
const pw = mod._decidePasteWrap;
const code10 = Array.from({ length: 10 }, (_, i) => 'let v' + i + ' = ' + i + ';').join('\n');
const code8 = Array.from({ length: 8 }, (_, i) => 'let v' + i + ' = ' + i + ';').join('\n');
const prose12 = Array.from({ length: 12 }, (_, i) => '这是第' + i + '行中文正文内容，用来测试不误伤。').join('\n');
t('wrap code 10 lines', pw('', 0, code10), { insert: '```\n' + code10 + '\n```\n', pad: '', lines: 10 });
t('wrap no pad at empty', pw('', 0, code10).pad, '');
t('wrap pads newline mid-text', pw('看这个', 3, code10).pad, '\n');
t('wrap no pad after newline', pw('abc\n', 4, code10).pad, '');
t('no wrap 8 lines', pw('', 0, code8), null);
t('no wrap chinese prose', pw('', 0, prose12), null);
t('no wrap cursor in code block', pw('```\nx', 6, code10), null);
t('no wrap content already fenced', pw('', 0, '```\ncode\n```\n' + code10), null);
t('no wrap empty paste', pw('', 0, ''), null);
t('wrap by size threshold', pw('', 0, 'let x = 1; '.repeat(500)), { insert: '```\n' + 'let x = 1; '.repeat(500) + '\n```\n', pad: '', lines: 1 });

// ===== 块状态签名（stateKey）=====
const sk = mod._stateKey;
t('stateKey plain', sk({ inCode: false, lang: '', fenceOpen: false, fenceClose: false, kind: null }), 'false|||');
t('stateKey code open', sk({ inCode: true, lang: 'js', fenceOpen: true, fenceClose: false, kind: null }), 'true|js|o|');
t('stateKey quote', sk({ inCode: false, lang: '', fenceOpen: false, fenceClose: false, kind: { type: 'quote' } }), 'false|||quote');

// ===== 浅色主题判定（isLightColor）=====
const ilc = mod._isLightColor;
t('dark theme text is light', ilc('rgb(249, 250, 251)'), false);
t('light theme text is dark', ilc('rgb(31, 35, 40)'), true);
t('light theme white bg dark text', ilc('rgb(0, 0, 0)'), true);
t('rgba parse', ilc('rgba(255, 255, 255, 0.9)'), false);
t('unparseable returns false', ilc('transparent'), false);

// ===== 工具栏状态高亮（decideActiveMarks）=====
const am = mod._decideActiveMarks;
t('marks bold', am('**粗**', 3), ['bold']);
t('marks italic', am('*斜*', 2), ['italic']);
t('marks code', am('`码`', 2), ['code']);
t('marks list', am('- 项目', 3), ['list']);
t('marks block', am('```\ncode', 7), ['block']);
t('marks none', am('普通文字', 2), []);
t('marks boundary', am('**粗**', 0), ['bold']);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
