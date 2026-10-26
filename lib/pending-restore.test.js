/**
 * 0.13.0 重启确认后「待恢复列表 / 等待计时 / 恢复结果对账」的纯函数单元测试
 * （node --test，无 e2e、不起任何服务）。
 *
 * lib/client.js 是手写浏览器 bundle（window.__ModuleLoader__.load 范式，无构建链），
 * 无法按常规 ESM import 复用其内部逻辑。测试通过桩 window（ModuleLoader 捕获工厂
 * 定义）+ 假 require（react 桩，纯函数不触渲染）加载真实的 client bundle，对其工厂
 * 导出的对账纯函数断言——测的就是发布逻辑本身：
 * 1. readPendingRestore / writePendingRestore：localStorage 存根的防御式读写
 *    （缺失/损坏/形状不对 → null；写入 try/catch 静默）；
 * 2. matchPendingBoot：boot 记录匹配（restartId 相等优先，回退 boot.at >=
 *    pending.at - 2min 时钟容差的最新一条；只认 type==='boot'）；
 * 3. collectSettlementsBySession：restore 记录按会话 id 归组（同 id 取最后一条）；
 * 4. normalizeCandidateDetails：/restart/info 候选明细 → 待恢复列表行
 *    （对象/字符串条目防御兼容，混合版本窗口不炸）。
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

test('readPendingRestore: 合法记录归一化（restartId 保留、候选条目防御归一化、脏条目剔除）', () => {
	const raw = JSON.stringify({
		at: iso(T0),
		restartId: 'rid-1',
		candidates: [
			{ id: 'a', at: iso(T0 - 5), running: true },
			{ id: 'b', at: 42, running: 'yes' }, // 非字符串 at / 非 boolean running
			{ id: '' }, // 空 id
			null,
			'id-str',
		],
	});
	assert.deepEqual(readPendingRestore(fakeStorage({ initial: { [PENDING_RESTORE_KEY]: raw } })), {
		at: iso(T0),
		restartId: 'rid-1',
		candidates: [
			{ id: 'a', at: iso(T0 - 5), running: true },
			{ id: 'b', at: '', running: false },
		],
	});
});

test('readPendingRestore: 无 restartId 的记录不补该字段；候选缺失归空数组', () => {
	const record = readPendingRestore(fakeStorage({
		initial: { [PENDING_RESTORE_KEY]: JSON.stringify({ at: iso(T0) }) },
	}));
	assert.deepEqual(record, { at: iso(T0), candidates: [] });
	assert.equal(Object.prototype.hasOwnProperty.call(record, 'restartId'), false);
});

test('writePendingRestore → readPendingRestore 覆盖式往返；写失败静默不抛', () => {
	const storage = fakeStorage();
	writePendingRestore(storage, {
		at: iso(T0),
		restartId: 'rid-9',
		candidates: [{ id: 'a', at: iso(T0 - 1), running: false }],
	});
	assert.deepEqual(readPendingRestore(storage), {
		at: iso(T0),
		restartId: 'rid-9',
		candidates: [{ id: 'a', at: iso(T0 - 1), running: false }],
	});
	// 单条覆盖：再写一条只剩一条
	writePendingRestore(storage, { at: iso(T0 + 9), candidates: [{ id: 'z', at: '', running: true }] });
	const second = readPendingRestore(storage);
	assert.equal(second.at, iso(T0 + 9));
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

test('0.13.0 常量：存根 key 与容差、结算徽标白名单齐备', () => {
	assert.equal(PENDING_RESTORE_KEY, 'dsh-ror-pending-restore');
	assert.equal(PENDING_BOOT_TOLERANCE_MS, 2 * 60 * 1000);
	assert.deepEqual(SETTLE_RESULTS, [
		'resumed', 'failed', 'excluded', 'archived', 'subagent',
		'skipped-budget', 'skipped-no-human-prompt',
	]);
});
