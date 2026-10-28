/**
 * 0.13.0 重启确认后「待恢复列表 / 等待计时 / 恢复结果对账」的纯函数单元测试
 * （node --test，无 e2e、不起任何服务）。
 *
 * lib/client.js 是手写浏览器 bundle（window.__ModuleLoader__.load 范式，无构建链），
 * 无法按常规 ESM import 复用其内部逻辑。测试通过桩 window（ModuleLoader 捕获工厂
 * 定义）+ 假 require（react 桩，纯函数不触渲染）加载真实的 client bundle，对其工厂
 * 导出的对账纯函数断言——测的就是发布逻辑本身：
 * 1. readPendingRestore / writePendingRestore：localStorage 存根的防御式读写
 *    （缺失/损坏/形状不对 → null；写入 try/catch 静默；候选条目 title 非空
 *    字符串才保留——对账视图标题为主、缺失退 shortId 弱化显示）；
 * 2. matchPendingBoot：boot 记录匹配（restartId 相等优先，回退 boot.at >=
 *    pending.at - 2min 时钟容差的最新一条；只认 type==='boot'）；
 * 3. collectSettlementsBySession：restore 记录按会话 id 归组（同 id 取最后一条）；
 * 4. normalizeCandidateDetails：/restart/info 候选明细 → 待恢复列表行
 *    （对象/字符串条目防御兼容，混合版本窗口不炸）；
 * 5. mergePendingRows / setPendingCancelled / activePendingCount：0.14.0 待恢复
 *    列表逐行 / 批量「取消 / 恢复」纯函数（服务端为准合并、服务端剔除行保留
 *    并强制 cancelled=true 防「取消后无法恢复」、取消标记与未取消计数）；
 * 6. 0.17.0 待恢复列表「刷新」按钮的数据管线（normalizeCandidateDetails →
 *    mergePendingRows 的组合口径：保留本地取消标记、服务端为准、剔除行保留缀后）
 *    与结算徽标白名单的 skipped-completed（宿主正常结束门的 restore 结算）。
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
	PENDING_RESTORE_KEY,
	PENDING_BOOT_TOLERANCE_MS,
	SETTLE_RESULTS,
	readPendingRestore,
	writePendingRestore,
	matchPendingBoot,
	collectSettlementsBySession,
	normalizeCandidateDetails,
	mergePendingRows,
	setPendingCancelled,
	activePendingCount,
	groupPendingRows,
} = client;

/** 最小 localStorage 桩（Map 存储，可注入故障）。 */
function fakeStorage({ failSet = false, initial = {} } = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => {
			if (failSet) throw new Error('quota exceeded');
			map.set(key, value);
		},
	};
}

const iso = (ms) => new Date(ms).toISOString();
const T0 = 1_700_000_000_000;

// ---- readPendingRestore / writePendingRestore：localStorage 存根防御式读写 ----

test('readPendingRestore: 无存储/无记录/损坏 JSON/形状不对一律 null', () => {
	assert.equal(readPendingRestore(null), null);
	assert.equal(readPendingRestore(undefined), null);
	assert.equal(readPendingRestore(fakeStorage()), null);
	assert.equal(readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: '{oops' } })), null);
	assert.equal(readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: '42' } })), null);
	assert.equal(readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: '[]' } })), null);
	assert.equal(readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: '{"candidates":[]}' } })), null);
	assert.equal(readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: JSON.stringify({ at: 42, candidates: [] }) } })), null);
});

test('readPendingRestore: 合法记录归一化（restartId 保留、候选条目防御归一化、title 非空才带、脏条目剔除）', () => {
	const raw = JSON.stringify({
		at: iso(T0),
		restartId: 'rid-1',
		candidates: [
			{ id: 'a', at: iso(T0 - 5), running: true, title: '会话标题' },
			{ id: 'b', at: 42, running: 'yes', title: '' }, // 非字符串 at / title 空 → 不带 title
			{ id: 'c', title: 42 }, // title 非字符串 → 不带
			{ id: '' }, // 空 id
			null,
			'id-str',
		],
	});
	assert.deepEqual(readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: raw } })), {
		at: iso(T0),
		restartId: 'rid-1',
		candidates: [
			{ id: 'a', at: iso(T0 - 5), running: true, title: '会话标题' },
			{ id: 'b', at: '', running: false },
			{ id: 'c', at: '', running: false },
		],
	});
	// title 保留是"非空字符串才带"：合法条目必须有该字段，省略条目绝不能出现空 title
	const record = readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: raw } }));
	assert.equal('title' in record.candidates[0], true);
	assert.equal('title' in record.candidates[1], false);
	assert.equal('title' in record.candidates[2], false);
});

test('readPendingRestore: 无 restartId 的记录不补该字段；候选缺失归空数组', () => {
	const record = readPendingRestore(fakeStorage({
		initial: { [PENDING_RESTORE_KEY]: JSON.stringify({ at: iso(T0) }) },
	}));
	assert.deepEqual(record, { at: iso(T0), candidates: [] });
	assert.equal(Object.prototype.hasOwnProperty.call(record, 'restartId'), false);
});

test('writePendingRestore → readPendingRestore 覆盖式往返（title 一并保留）；写失败静默不抛', () => {
	const storage = fakeStorage();
	writePendingRestore(storage, {
		at: iso(T0),
		restartId: 'rid-9',
		candidates: [{ id: 'a', at: iso(T0 - 1), running: false, title: '带标题的会话' }],
	});
	assert.deepEqual(readPendingRestore(storage), {
		at: iso(T0),
		restartId: 'rid-9',
		candidates: [{ id: 'a', at: iso(T0 - 1), running: false, title: '带标题的会话' }],
	});
	// 单条覆盖：再写一条只剩一条；title 空（未命名会话）→ 读取端不保留该字段
	writePendingRestore(storage, {
		at: iso(T0 + 9),
		candidates: [{ id: 'z', at: '', running: true, title: '' }],
	});
	const second = readPendingRestore(storage);
	assert.equal(second.at, iso(T0 + 9));
	assert.equal(second.restartId, undefined);
	assert.deepEqual(second.candidates, [{ id: 'z', at: '', running: true }]);
	// 存储故障（隐私模式配额等）：静默，绝不抛错
	assert.doesNotThrow(() => writePendingRestore(fakeStorage({ failSet: true }), { at: iso(T0), candidates: [] }));
	// 非法 record / 非法 storage：静默
	assert.doesNotThrow(() => writePendingRestore(storage, null));
	assert.doesNotThrow(() => writePendingRestore(null, { at: iso(T0), candidates: [] }));
});

// ---- matchPendingBoot：boot 记录匹配（restartId 优先，时间容差回退） ----

const bootAt = (ms, restartId = null, extra = {}) => ({
	type: 'boot',
	at: iso(ms),
	...(restartId === null ? {} : { origin: { restartId } }),
	...extra,
});

test('matchPendingBoot: restartId 相等优先，即使另一条 boot 更新', () => {
	const pending = { at: iso(T0), restartId: 'rid-1' };
	const boots = [
		bootAt(T0 + 60_000, 'rid-other'),
		bootAt(T0 + 30_000, 'rid-1'),
	];
	assert.equal(matchPendingBoot(pending, boots), boots[1]);
});

test('matchPendingBoot: 同 restartId 多条并列取较新；at 无法解析的并列保持先到', () => {
	const pending = { at: iso(T0), restartId: 'rid-1' };
	const older = bootAt(T0 + 10_000, 'rid-1');
	const newer = bootAt(T0 + 20_000, 'rid-1');
	assert.equal(matchPendingBoot(pending, [older, newer]), newer);
	const badAt = { type: 'boot', at: 'not-a-date', origin: { restartId: 'rid-1' } };
	assert.equal(matchPendingBoot(pending, [badAt]), badAt);
});

test('matchPendingBoot: 无 restartId 回退时间窗——取容差窗口内最新一条，太旧的剔除', () => {
	const pending = { at: iso(T0) };
	const inWindow1 = bootAt(T0 + 5_000);
	const inWindow2 = bootAt(T0 + 60_000);
	const tooOld = bootAt(T0 - PENDING_BOOT_TOLERANCE_MS - 1);
	// 边界：恰在容差线上（-tolerance）可命中，再旧 1ms 剔除
	const boundary = bootAt(T0 - PENDING_BOOT_TOLERANCE_MS);
	assert.equal(matchPendingBoot(pending, [tooOld, inWindow1, inWindow2]), inWindow2);
	assert.equal(matchPendingBoot(pending, [tooOld, boundary]), boundary);
	assert.equal(matchPendingBoot(pending, [tooOld]), null);
});

test('matchPendingBoot: 只认 type==="boot" 的条目，restore 记录不参与匹配', () => {
	const pending = { at: iso(T0) };
	const restore = { type: 'restore', at: iso(T0 + 60_000), bootAt: iso(T0 + 60_000), id: 'x' };
	assert.equal(matchPendingBoot(pending, [restore]), null);
});

test('matchPendingBoot: 无匹配/脏输入一律 null，绝不抛错', () => {
	assert.equal(matchPendingBoot({ at: iso(T0) }, []), null);
	assert.equal(matchPendingBoot(null, [bootAt(T0)]), null);
	assert.equal(matchPendingBoot({ at: 'nope' }, [bootAt(T0 - PENDING_BOOT_TOLERANCE_MS - 9_999)]), null);
	assert.equal(matchPendingBoot(undefined, undefined), null);
	// restartId 有但谁都匹配不上 → 回退时间窗
	const pending = { at: iso(T0), restartId: 'rid-missing' };
	const inWindow = bootAt(T0 + 1_000, 'rid-a');
	assert.equal(matchPendingBoot(pending, [inWindow]), inWindow);
});

// ---- collectSettlementsBySession：restore 记录按 id 归组 ----

test('collectSettlementsBySession: 按 id 归组，同 id 取最后一条（时间正序 → 最新结算）', () => {
	const byId = collectSettlementsBySession([
		{ type: 'restore', bootAt: iso(T0), id: 'a', result: 'failed', error: 'x' },
		{ type: 'restore', bootAt: iso(T0), id: 'b', result: 'resumed', error: null },
		{ type: 'restore', bootAt: iso(T0), id: 'a', result: 'resumed', error: null },
	]);
	assert.equal(byId.size, 2);
	assert.equal(byId.get('a').result, 'resumed');
	assert.equal(byId.get('b').result, 'resumed');
});

test('collectSettlementsBySession: 脏条目忽略；非数组输入空 Map', () => {
	const byId = collectSettlementsBySession([
		null,
		42,
		{ type: 'restore', id: '' },
		{ type: 'restore' },
		{ type: 'restore', id: 'ok', result: 'excluded' },
	]);
	assert.equal(byId.size, 1);
	assert.ok(byId.has('ok'));
	assert.equal(collectSettlementsBySession('nope').size, 0);
	assert.equal(collectSettlementsBySession(undefined).size, 0);
});

// ---- normalizeCandidateDetails：候选明细 → 待恢复列表行 ----

test('normalizeCandidateDetails: 对象条目归一化（at 非字符串归空、running 严格 boolean、title 拿到才带）', () => {
	assert.deepEqual(
		normalizeCandidateDetails([
			{ id: 'a', at: iso(T0), running: true, title: '标题' },
			{ id: 'b', at: '', running: false },
			{ id: 'c', running: 'yes' },
			{ id: '' },
			null,
		]),
		[
			{ id: 'a', at: iso(T0), running: true, title: '标题' },
			{ id: 'b', at: '', running: false },
			{ id: 'c', at: '', running: false },
		],
	);
});

test('0.18.0 normalizeCandidateDetails: workspace 非空字符串才带（旧宿主无字段/未知 "" 一律不带）', () => {
	assert.deepEqual(
		normalizeCandidateDetails([
			{ id: 'a', at: iso(T0), running: true, workspace: '/code/www/my/github/app' },
			{ id: 'b', at: '', running: false, workspace: '' }, // 未知工作区 → 不带
			{ id: 'c', at: '', running: false, workspace: 42 }, // 非字符串 → 不带
			{ id: 'd', at: '', running: false }, // 旧宿主（无字段）→ 不带
			'legacy-str', // string[] 混合窗口 → 占位行，无 workspace
		]),
		[
			{ id: 'a', at: iso(T0), running: true, workspace: '/code/www/my/github/app' },
			{ id: 'b', at: '', running: false },
			{ id: 'c', at: '', running: false },
			{ id: 'd', at: '', running: false },
			{ id: 'legacy-str', at: '', running: false },
		],
	);
});

test('normalizeCandidateDetails: 旧版 string[]（混合版本窗口）兼容为占位行；非数组空数组', () => {
	assert.deepEqual(
		normalizeCandidateDetails(['session-a', 'session-b']),
		[
			{ id: 'session-a', at: '', running: false },
			{ id: 'session-b', at: '', running: false },
		],
	);
	assert.deepEqual(normalizeCandidateDetails(undefined), []);
	assert.deepEqual(normalizeCandidateDetails({ id: 'a' }), []);
});

// ---- 常量与徽标白名单 ----

test('0.13.0 常量：存根 key 与容差、结算徽标白名单齐备（0.17.0 起含 skipped-completed）', () => {
	assert.equal(PENDING_RESTORE_KEY, 'dsh-ror-pending-restore');
	assert.equal(PENDING_BOOT_TOLERANCE_MS, 2 * 60 * 1000);
	assert.deepEqual(SETTLE_RESULTS, [
		'resumed', 'failed', 'excluded', 'archived', 'subagent',
		'skipped-budget', 'skipped-no-human-prompt',
		'skipped-completed',
	]);
});

// ---- 0.14.0 mergePendingRows：重拉合并（服务端为准，cancelled 保本地旧值） ----

test('mergePendingRows: 服务端行为准（id/at/running/title 取服务端），cancelled 用本地旧值，本地没有的行视为未取消', () => {
	const prev = [
		{ id: 'a', at: iso(T0), running: false, title: '本地A', cancelled: true },
		{ id: 'b', at: iso(T0 + 1), running: true, title: '本地B', cancelled: false },
	];
	const next = [
		{ id: 'a', at: iso(T0 + 99), running: true, title: '服务端A' },
		{ id: 'b', at: iso(T0 + 98), running: false, title: '服务端B' },
		{ id: 'c', at: iso(T0 + 97), running: true }, // 本地没有的行
	];
	const prevSnapshot = JSON.parse(JSON.stringify(prev));
	assert.deepEqual(mergePendingRows(prev, next), [
		{ id: 'a', at: iso(T0 + 99), running: true, title: '服务端A', cancelled: true },
		{ id: 'b', at: iso(T0 + 98), running: false, title: '服务端B', cancelled: false },
		{ id: 'c', at: iso(T0 + 97), running: true, cancelled: false },
	]);
	// 纯函数：入参行不被改写（字段变化只落在新数组上）
	assert.deepEqual(prev, prevSnapshot);
	assert.equal('cancelled' in next[2], false);
});

test('mergePendingRows: 本地有但服务端不再返回的行保留缀后并强制 cancelled=true（防「取消后无法恢复」）', () => {
	const prev = [
		{ id: 'stay', at: iso(T0), running: false, cancelled: false },
		{ id: 'dropped-false', at: iso(T0 + 1), running: true, title: '被剔除', cancelled: false },
		{ id: 'dropped-true', at: iso(T0 + 2), running: true, cancelled: true },
		// 0.18.0：保留行的 workspace 沿本地旧值（行留在列表里分组不变）
		{ id: 'dropped-ws', at: iso(T0 + 3), running: false, workspace: '/gone/ws', cancelled: false },
	];
	const next = [{ id: 'stay', at: iso(T0 + 9), running: true }];
	assert.deepEqual(mergePendingRows(prev, next), [
		{ id: 'stay', at: iso(T0 + 9), running: true, cancelled: false },
		{ id: 'dropped-false', at: iso(T0 + 1), running: true, title: '被剔除', cancelled: true },
		{ id: 'dropped-true', at: iso(T0 + 2), running: true, cancelled: true },
		{ id: 'dropped-ws', at: iso(T0 + 3), running: false, workspace: '/gone/ws', cancelled: true },
	]);
});

test('mergePendingRows: title 服务端缺失/空串回退本地旧值；两边都没有则不带 title 字段', () => {
	const prev = [
		{ id: 'fallback', at: iso(T0), running: true, title: '本地旧标题', cancelled: true },
		{ id: 'fallback-empty', at: iso(T0 + 1), running: true, title: '旧标题', cancelled: true },
		{ id: 'both-missing', at: iso(T0 + 2), running: true, cancelled: true },
		{ id: 'local-empty', at: iso(T0 + 3), running: true, title: '', cancelled: true },
	];
	const next = [
		{ id: 'fallback', at: iso(T0 + 9), running: true }, // 服务端这轮没带 title
		{ id: 'fallback-empty', at: iso(T0 + 8), running: true, title: '' },
		{ id: 'both-missing', at: iso(T0 + 7), running: true },
		{ id: 'local-empty', at: iso(T0 + 6), running: true },
	];
	const merged = mergePendingRows(prev, next);
	assert.deepEqual(merged, [
		{ id: 'fallback', at: iso(T0 + 9), running: true, cancelled: true, title: '本地旧标题' },
		{ id: 'fallback-empty', at: iso(T0 + 8), running: true, cancelled: true, title: '旧标题' },
		{ id: 'both-missing', at: iso(T0 + 7), running: true, cancelled: true },
		{ id: 'local-empty', at: iso(T0 + 6), running: true, cancelled: true },
	]);
	assert.equal('title' in merged[2], false);
	assert.equal('title' in merged[3], false);
});

test('0.18.0 mergePendingRows: workspace 服务端为准、服务端没带回退本地旧值、两边都没有不带该字段', () => {
	const prev = [
		{ id: 'srv-wins', at: iso(T0), running: true, workspace: '/old/path', cancelled: true },
		{ id: 'local-fallback', at: iso(T0 + 1), running: true, workspace: '/keep/old', cancelled: true },
		{ id: 'both-missing', at: iso(T0 + 2), running: true, cancelled: true },
		{ id: 'srv-empty', at: iso(T0 + 3), running: true, workspace: '/emptied/old', cancelled: true },
	];
	const next = [
		{ id: 'srv-wins', at: iso(T0 + 9), running: true, workspace: '/new/path' }, // 服务端为准
		{ id: 'local-fallback', at: iso(T0 + 8), running: true }, // 服务端没带 → 本地旧值
		{ id: 'both-missing', at: iso(T0 + 7), running: true }, // 两边都没有 → 不带
		{ id: 'srv-empty', at: iso(T0 + 6), running: true, workspace: '' }, // 服务端未知 → 本地旧值
		// 服务端不再返回的行保留并置 cancelled=true，workspace 沿本地
	];
	const merged = mergePendingRows(prev, next);
	assert.deepEqual(merged, [
		{ id: 'srv-wins', at: iso(T0 + 9), running: true, workspace: '/new/path', cancelled: true },
		{ id: 'local-fallback', at: iso(T0 + 8), running: true, workspace: '/keep/old', cancelled: true },
		{ id: 'both-missing', at: iso(T0 + 7), running: true, cancelled: true },
		{ id: 'srv-empty', at: iso(T0 + 6), running: true, workspace: '/emptied/old', cancelled: true },
	]);
	assert.equal('workspace' in merged[2], false);
});

test('mergePendingRows: 按 id 去重（重复取首条）；服务端顺序在前、本地多出的行按原顺序缀后', () => {
	const prev = [
		{ id: 'local-1', at: iso(T0), running: true, cancelled: true },
		{ id: 'local-2', at: iso(T0 + 1), running: true, cancelled: true },
	];
	const next = [
		{ id: 'srv-2', at: iso(T0 + 9), running: false },
		{ id: 'dup', at: iso(T0 + 8), running: true, title: '首条为准' },
		{ id: 'srv-1', at: iso(T0 + 7), running: true },
		{ id: 'dup', at: iso(T0 + 6), running: false, title: '重复忽略' },
	];
	assert.deepEqual(mergePendingRows(prev, next), [
		{ id: 'srv-2', at: iso(T0 + 9), running: false, cancelled: false },
		{ id: 'dup', at: iso(T0 + 8), running: true, title: '首条为准', cancelled: false },
		{ id: 'srv-1', at: iso(T0 + 7), running: true, cancelled: false },
		{ id: 'local-1', at: iso(T0), running: true, cancelled: true },
		{ id: 'local-2', at: iso(T0 + 1), running: true, cancelled: true },
	]);
});

test('mergePendingRows: 行级防御（缺 id/空 id/null/非对象行剔除、at/running 归一化）；非法输入不抛错返回空', () => {
	assert.deepEqual(
		mergePendingRows(
			[null, 42, { id: '' }, { noId: true }, { id: 'ok', cancelled: true }],
			[null, { id: '' }, { id: 'ok', at: 'srv-at', running: 'yes' }, { id: 'dirty', at: 42 }],
		),
		[
			{ id: 'ok', at: 'srv-at', running: false, cancelled: true },
			{ id: 'dirty', at: '', running: false, cancelled: false },
		],
	);
	assert.deepEqual(mergePendingRows(null, null), []);
	assert.deepEqual(mergePendingRows(undefined, []), []);
	assert.deepEqual(mergePendingRows([], undefined), []);
	assert.deepEqual(mergePendingRows('nope', 42), []);
});

// ---- 0.17.0 待恢复列表「刷新」按钮的纯函数组合（refreshPendingList 的数据管线）----

test('0.17.0 刷新管线：normalizeCandidateDetails → mergePendingRows（保留本地取消标记，服务端为准）', () => {
	// 本地既有列表：a 已被用户取消、c 本地才有（服务端这轮没返回）
	const localRows = [
		{ id: 'a', at: iso(T0), running: true, title: '本地A', cancelled: true },
		{ id: 'b', at: iso(T0 + 1), running: false },
		{ id: 'c', at: iso(T0 + 2), running: true, cancelled: true },
	];
	// 刷新拿到的服务端口径：a 恢复了标题、b 更新运行态、d 是新会话（c 已不在候选）
	const infoRows = normalizeCandidateDetails([
		{ id: 'a', at: iso(T0 + 9), running: true, title: '服务端A' },
		{ id: 'b', at: iso(T0 + 9), running: true },
		{ id: 'd', at: iso(T0 + 9), running: false, title: '新会话D' },
	]);
	const merged = mergePendingRows(localRows, infoRows);
	assert.deepEqual(merged, [
		// 服务端为准：at/running/title 取服务端；cancelled 用本地旧值（a 保持已取消）
		{ id: 'a', at: iso(T0 + 9), running: true, title: '服务端A', cancelled: true },
		{ id: 'b', at: iso(T0 + 9), running: true, cancelled: false },
		{ id: 'd', at: iso(T0 + 9), running: false, title: '新会话D', cancelled: false },
		// 服务端不再返回的 c 保留缀后并置 cancelled=true（行留在列表里才能「恢复」撤销）
		{ id: 'c', at: iso(T0 + 2), running: true, cancelled: true },
	]);
	// 计数口径联动：「重启后将自动恢复 N 个」按未取消行数显示（b、d 未取消）
	assert.equal(activePendingCount(merged), 2);
	// 刷新在空列表本地态（理论不可达：按钮只在列表已构建时渲染）也能直接采用服务端行
	assert.deepEqual(mergePendingRows(null, infoRows), [
		{ id: 'a', at: iso(T0 + 9), running: true, title: '服务端A', cancelled: false },
		{ id: 'b', at: iso(T0 + 9), running: true, cancelled: false },
		{ id: 'd', at: iso(T0 + 9), running: false, title: '新会话D', cancelled: false },
	]);
});

// ---- 0.14.0 setPendingCancelled：行级 / 批量取消标记（新数组，不改入参） ----

test('setPendingCancelled: ids 单字符串 / 字符串数组都能命中，其余行原样', () => {
	const rows = [
		{ id: 'a', at: iso(T0), running: true, cancelled: false },
		{ id: 'b', at: iso(T0 + 1), running: true, cancelled: false },
		{ id: 'c', at: iso(T0 + 2), running: false, cancelled: true },
	];
	assert.deepEqual(setPendingCancelled(rows, 'a', true), [
		{ id: 'a', at: iso(T0), running: true, cancelled: true },
		{ id: 'b', at: iso(T0 + 1), running: true, cancelled: false },
		{ id: 'c', at: iso(T0 + 2), running: false, cancelled: true },
	]);
	assert.deepEqual(setPendingCancelled(rows, ['b', 'c'], false), [
		{ id: 'a', at: iso(T0), running: true, cancelled: false },
		{ id: 'b', at: iso(T0 + 1), running: true, cancelled: false },
		{ id: 'c', at: iso(T0 + 2), running: false, cancelled: false },
	]);
});

test('setPendingCancelled: 返回新数组不改入参；命中行浅拷贝、未命中行保持原引用', () => {
	const a = { id: 'a', cancelled: false };
	const b = { id: 'b', cancelled: false };
	const rows = [a, b];
	const out = setPendingCancelled(rows, ['a'], true);
	assert.notEqual(out, rows); // 新数组
	assert.equal(a.cancelled, false); // 入参未被改
	assert.notEqual(out[0], a); // 命中行是新对象
	assert.equal(out[1], b); // 未命中行原引用
	assert.deepEqual(out, [{ id: 'a', cancelled: true }, b]);
	// cancelled 只有严格 === true 才置真（真值但非 true 一律按未取消）
	assert.deepEqual(setPendingCancelled([{ id: 'x' }], 'x', 1), [{ id: 'x', cancelled: false }]);
});

test('setPendingCancelled: 非法输入不抛错——rows 非数组返回空、ids 非法无命中、脏行原样穿过', () => {
	assert.deepEqual(setPendingCancelled(null, 'a', true), []);
	assert.deepEqual(setPendingCancelled(undefined, ['a'], true), []);
	assert.deepEqual(setPendingCancelled('nope', 'a', true), []);
	const a = { id: 'a' };
	const b = { id: 'b' };
	// ids 非法（空串 / 非字符串非数组 / 数组含脏条目 / undefined）→ 无命中，行原引用保留
	assert.deepEqual(setPendingCancelled([a, b], '', true), [a, b]);
	assert.deepEqual(setPendingCancelled([a, b], 42, true), [a, b]);
	assert.deepEqual(setPendingCancelled([a, b], undefined, true), [a, b]);
	assert.deepEqual(setPendingCancelled([a, b], [null, '', 42, 'a'], true), [{ id: 'a', cancelled: true }, b]);
	// 脏行（null / 非对象）原样穿过，绝不抛错
	assert.deepEqual(setPendingCancelled([null, 42, a], 'a', true), [null, 42, { id: 'a', cancelled: true }]);
});

// ---- 0.14.0 activePendingCount：未取消（仍会自动恢复）行计数 ----

test('activePendingCount: 只数 cancelled !== true 的对象行；非法输入按 0', () => {
	assert.equal(activePendingCount([
		{ id: 'a', cancelled: false },
		{ id: 'b', cancelled: true },
		{ id: 'c' }, // cancelled 缺失 → 仍会恢复，计数
		{ id: 'd', cancelled: 'no' }, // 非 true → 计数
		null,
		42,
		'x',
	]), 3);
	assert.equal(activePendingCount([{ cancelled: true }, { cancelled: true }]), 0);
	assert.equal(activePendingCount([]), 0);
	assert.equal(activePendingCount(null), 0);
	assert.equal(activePendingCount(undefined), 0);
	assert.equal(activePendingCount('nope'), 0);
	assert.equal(activePendingCount(42), 0);
});

// ---- 0.18.0 groupPendingRows：待恢复列表按工作区分组（纯函数，不改入参） ----

test('0.18.0 groupPendingRows: 按工作区分组，组内按 at 倒序、组间按组内最新 at 倒序', () => {
	const rows = [
		{ id: 'a1', at: iso(T0), workspace: '/ws/a' },
		{ id: 'b1', at: iso(T0 + 100), workspace: '/ws/b' },
		{ id: 'a2', at: iso(T0 + 50), workspace: '/ws/a' },
		{ id: 'b2', at: iso(T0 + 200), workspace: '/ws/b' },
		{ id: 'a3', at: iso(T0 + 10), workspace: '/ws/a' },
	];
	const snapshot = JSON.parse(JSON.stringify(rows));
	const groups = groupPendingRows(rows);
	// 组间：/ws/b 最新（+200）在前、/ws/a（+50）在后
	assert.deepEqual(groups.map((g) => g.workspace), ['/ws/b', '/ws/a']);
	// 组内：at 倒序
	assert.deepEqual(groups[0].rows.map((r) => r.id), ['b2', 'b1']);
	assert.deepEqual(groups[1].rows.map((r) => r.id), ['a2', 'a3', 'a1']);
	// 纯函数：入参不被修改
	assert.deepEqual(rows, snapshot);
});

test('0.18.0 groupPendingRows: workspace 缺失/空串/非字符串归「未知工作区」组且恒排最后', () => {
	const rows = [
		{ id: 'u1', at: iso(T0 + 900) }, // 未知（缺失）但 at 最新
		{ id: 'w1', at: iso(T0), workspace: '/ws/only' },
		{ id: 'u2', at: iso(T0 + 800), workspace: '' }, // 空串 = 未知
		{ id: 'u3', at: iso(T0 + 700), workspace: 42 }, // 非字符串 = 未知
	];
	const groups = groupPendingRows(rows);
	assert.deepEqual(groups.map((g) => g.workspace), ['/ws/only', '']);
	assert.deepEqual(groups[0].rows.map((r) => r.id), ['w1']);
	// 未知组的行保持输入顺序（同组内 at 倒序：u1 > u2 > u3）
	assert.deepEqual(groups[1].rows.map((r) => r.id), ['u1', 'u2', 'u3']);
});

test('0.18.0 groupPendingRows: at 缺失/解析失败按 0（最旧）；相等保持输入顺序', () => {
	const rows = [
		{ id: 'bad-at', at: 'not-a-date', workspace: '/ws/x' },
		{ id: 'no-at', workspace: '/ws/x' },
		{ id: 'ok', at: iso(T0), workspace: '/ws/x' },
	];
	const groups = groupPendingRows(rows);
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0].rows.map((r) => r.id), ['ok', 'bad-at', 'no-at']);
});

test('0.18.0 groupPendingRows: 返回新数组新组对象、行引用原样保留（不改写行）', () => {
	const a = { id: 'a', at: iso(T0), workspace: '/ws/a', cancelled: true };
	const b = { id: 'b', at: iso(T0 + 1), workspace: '/ws/a' };
	const groups = groupPendingRows([a, b]);
	assert.notEqual(groups[0].rows, [a, b]); // 新行数组
	// 行引用原样保留（组内排序只重排引用，不复制行）
	assert.deepEqual(groups[0].rows, [b, a]); // 组内 at 倒序：b 在前
	assert.equal(groups[0].rows[0], b);
	assert.equal(groups[0].rows[1], a);
	assert.equal(a.cancelled, true); // 入参行未被改写
	// 组对象是新造的：给输出组加字段不会污染后续分组
	groups[0].extra = true;
	assert.equal('extra' in groupPendingRows([a, b])[0], false);
});

test('0.18.0 groupPendingRows: 空数组/非数组/脏行——空组不出现、绝不抛错', () => {
	assert.deepEqual(groupPendingRows([]), []);
	assert.deepEqual(groupPendingRows(null), []);
	assert.deepEqual(groupPendingRows(undefined), []);
	assert.deepEqual(groupPendingRows('nope'), []);
	assert.deepEqual(groupPendingRows(42), []);
	// 脏行跳过（非对象/缺 id/空 id），不产生空组
	assert.deepEqual(groupPendingRows([null, 42, { id: '' }, { noId: true }]), []);
});

test('0.18.0 groupPendingRows: 单组也正常输出；工作区按首次出现聚合（行完整字段保留）', () => {
	const rows = [
		{ id: 'x', at: iso(T0), running: true, workspace: '/only/ws', title: '标题' },
	];
	const groups = groupPendingRows(rows);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].workspace, '/only/ws');
	assert.deepEqual(groups[0].rows, rows); // 行对象原样（含全部字段）
});
