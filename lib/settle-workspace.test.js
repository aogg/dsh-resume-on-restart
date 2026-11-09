/**
 * 0.38.0 对账表格「所在工作区」列的纯函数单元测试（node --test，无 e2e、
 * 不起任何服务）。lib/client.js 经 window 桩加载真实 bundle（同
 * lib/pending-restore.test.js 范式，测的就是发布逻辑本身）：
 *
 * 1. workspaceBasename：绝对路径 → 名称（basename）提取——posix / Windows
 *    分隔符、结尾分隔符、裸名、非字符串/空/全是分隔符（渲染层据此显示「—」）；
 * 2. settleRowWorkspace：行级 before ∪ after 工作区取值——before 优先（存根
 *    口径、已有不覆盖）、after 兜底（历史轮次的宿主写入/下发补齐落在 restore
 *    侧）、都缺返回 ''（渲染层据此显示「—」）、脏形状防御；
 * 3. 存根带 workspace：settlementRounds 存根轮次的 candidates.workspace 直接进
 *    before 侧行数据（0.25.0 口径透传）；存根不带 workspace 的旧行兼容；
 * 4. restore 记录带 workspace：normalizeSettleAfter 保留（宿主写入探测与
 *    GET /restarts 下发补齐的数据落点；服务端补齐行为另见 lib/routes.test.js
 *    的 0.38.0 两用例）；
 * 5. i18n：settle.colWorkspace zh/en 成对，且 settle.* 键集两侧完全对齐。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 必须先装 window 桩再动态 import（client.js 顶层即调 window.__ModuleLoader__.load），
// 静态 import 会被提升到模块体之前，这里只能用 await import。
const loaded = {};
globalThis.window = {
	__ModuleLoader__: {
		load(def) {
			loaded[def.id] = def;
		},
	},
};

/** react 桩：工厂只在组件渲染期才触达 react.*，纯函数测试不需要任何实现。 */
const factoryRequire = (name) => {
	if (name === 'react') return {};
	throw new Error(`unexpected require: ${name}`);
};

const clientModule = await import('./client.js');
const client = loaded['dsh-resume-on-restart'].factory(factoryRequire);
const {
	workspaceBasename,
	settleRowWorkspace,
	settlementRounds,
	normalizeSettleBefore,
	normalizeSettleAfter,
	i18nDictionaries,
} = client;

assert.equal(typeof clientModule, 'object');

test('0.38.0 workspaceBasename: posix 绝对路径取末段（basename 提取）', () => {
	assert.equal(workspaceBasename('/code/www/my/github/dsh-resume-on-restart'), 'dsh-resume-on-restart');
	assert.equal(workspaceBasename('/wsp/alpha'), 'alpha');
});

test('0.38.0 workspaceBasename: Windows 分隔符与结尾分隔符同口径', () => {
	assert.equal(workspaceBasename('D:\\code\\www\\proj'), 'proj');
	assert.equal(workspaceBasename('/code/www/proj/'), 'proj');
	assert.equal(workspaceBasename('D:\\code\\www\\proj\\'), 'proj');
	// 混用两种分隔符也能取到末段
	assert.equal(workspaceBasename('/code\\mixed/path'), 'path');
});

test('0.38.0 workspaceBasename: 裸名原样、点开头条目保留点前缀', () => {
	assert.equal(workspaceBasename('my-project'), 'my-project');
	assert.equal(workspaceBasename('/repos/.dsh'), '.dsh');
});

test('0.38.0 workspaceBasename: 非字符串/空/全是分隔符返回 \'\'（渲染层显示「—」）', () => {
	assert.equal(workspaceBasename(''), '');
	assert.equal(workspaceBasename('/'), '');
	assert.equal(workspaceBasename('\\\\'), '');
	assert.equal(workspaceBasename(null), '');
	assert.equal(workspaceBasename(undefined), '');
	assert.equal(workspaceBasename(123), '');
	assert.equal(workspaceBasename({ path: '/wsp' }), '');
});

test('0.38.0 settleRowWorkspace: before 优先（存根口径，已有不覆盖）', () => {
	assert.equal(
		settleRowWorkspace({ id: 'a', before: { at: '', running: true, workspace: '/wsp/stub' }, after: { result: 'resumed', workspace: '/wsp/backfill' } }),
		'/wsp/stub',
	);
});

test('0.38.0 settleRowWorkspace: after 兜底（历史轮次补齐落在 restore 侧）', () => {
	assert.equal(
		settleRowWorkspace({ id: 'a', before: { at: '', running: false }, after: { result: 'resumed', workspace: '/wsp/backfill' } }),
		'/wsp/backfill',
	);
	assert.equal(
		settleRowWorkspace({ id: 'a', before: null, after: { result: 'resumed', workspace: '/wsp/backfill' } }),
		'/wsp/backfill',
	);
});

test('0.38.0 settleRowWorkspace: 都缺/脏形状返回 \'\'（渲染层显示「—」）', () => {
	assert.equal(settleRowWorkspace({ id: 'a', before: null, after: null }), '');
	assert.equal(settleRowWorkspace({ id: 'a', before: { at: '' }, after: { result: 'resumed' } }), '');
	// workspace 空串按缺失处理（拿到才带口径，空串绝不出现）
	assert.equal(settleRowWorkspace({ id: 'a', before: { workspace: '' }, after: { workspace: '' } }), '');
	// 脏输入防御：非对象行 / before·after 非对象 / 行本身 null
	assert.equal(settleRowWorkspace(null), '');
	assert.equal(settleRowWorkspace(undefined), '');
	assert.equal(settleRowWorkspace('row'), '');
	assert.equal(settleRowWorkspace({ id: 'a', before: 'x', after: 42 }), '');
});

test('0.38.0 存根带 workspace: settlementRounds 存根轮次 candidates.workspace 直接进 before 侧行数据', () => {
	const pending = {
		at: '2026-11-09T03:00:00.000Z',
		candidates: [
			{ id: 'sess-a', at: '2026-11-09T02:59:00.000Z', running: true, title: '甲', workspace: '/wsp/alpha' },
			{ id: 'sess-b', at: '2026-11-09T02:58:00.000Z', running: false, title: '乙' },
		],
	};
	const rounds = settlementRounds([], pending);
	assert.equal(rounds.length, 1);
	assert.equal(rounds[0].fromStub, true);
	assert.deepEqual(rounds[0].rows.map((row) => row.id), ['sess-a', 'sess-b']);
	// 带 workspace 的存根候选：workspace 进 before（所在工作区列数据源）
	assert.equal(rounds[0].rows[0].before.workspace, '/wsp/alpha');
	// 旧存根不带 workspace：before 无该字段（渲染层显示「—」）
	assert.equal('workspace' in rounds[0].rows[1].before, false);
	assert.equal(settleRowWorkspace(rounds[0].rows[1]), '');
});

test('0.38.0 restore 记录带 workspace: normalizeSettleAfter 保留（写入探测/下发补齐的数据落点）', () => {
	const after = normalizeSettleAfter({ result: 'resumed', error: null, at: '2026-11-09T03:00:05.000Z', title: 't', workspace: '/wsp/alpha' });
	assert.equal(after.workspace, '/wsp/alpha');
	// 空串/非字符串不带（拿到才带口径）
	assert.equal('workspace' in normalizeSettleAfter({ result: 'resumed', workspace: '' }), false);
	assert.equal('workspace' in normalizeSettleAfter({ result: 'resumed', workspace: 42 }), false);
	// before 侧同口径（存根候选/boot.runningSessions 条目）
	assert.equal(normalizeSettleBefore({ id: 'a', at: '', running: false, workspace: '/wsp/alpha' }).workspace, '/wsp/alpha');
	assert.equal('workspace' in normalizeSettleBefore({ id: 'a', at: '', running: false }), false);
});

test('0.38.0 历史轮次: boot 记录 + 带 workspace 的 restore 记录 → 行 after 侧携带、行级取值可用', () => {
	const bootAt = '2026-11-08T03:00:00.000Z';
	const records = [
		{ type: 'boot', at: bootAt, runningSessions: [{ id: 'sess-a', at: '2026-11-08T02:59:00.000Z', running: true }] },
		{ type: 'restore', bootAt, id: 'sess-a', result: 'resumed', error: null, at: '2026-11-08T03:00:05.000Z', title: '甲', workspace: '/wsp/alpha' },
	];
	const rounds = settlementRounds(records, null);
	assert.equal(rounds.length, 1);
	const [row] = rounds[0].rows;
	assert.equal(row.id, 'sess-a');
	assert.equal(row.after.workspace, '/wsp/alpha');
	// before（历史 runningSessions 落盘不带 workspace）缺、after 兜底 → 行级有值
	assert.equal(settleRowWorkspace(row), '/wsp/alpha');
});

test('0.38.0 i18n: settle.colWorkspace zh/en 成对，settle.* 键集两侧对齐', () => {
	assert.equal(i18nDictionaries.zh['settle.colWorkspace'], '所在工作区');
	assert.equal(i18nDictionaries.en['settle.colWorkspace'], 'Workspace');
	const zhKeys = Object.keys(i18nDictionaries.zh).filter((key) => key.startsWith('settle.'));
	const enKeys = Object.keys(i18nDictionaries.en).filter((key) => key.startsWith('settle.'));
	assert.deepEqual(enKeys.sort(), zhKeys.sort());
});
