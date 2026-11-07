/**
 * 0.36.0：会话顶栏「重启时恢复」开关的**五态状态机**单元测试
 * （node --test，无 e2e、不起任何服务、不碰真实 ~/.dsh）。
 *
 * 被测对象（同一口径的两份实现，本文件负责逐态对齐，防两侧漂移）：
 * 1. host 侧 lib/recovery-state.js：recoveryStateOf / recoveryWantOf /
 *    buildRegisteredSnapshot / buildArchivedSnapshot —— POST /session-recovery
 *    的响应 `state` 与 ws 快照两个新字段都由它们产出；
 * 2. client 侧 lib/client.js（经 window.__ModuleLoader__ 桩加载**真实发布文件**，
 *    写法照抄 lib/notice.test.js）：recoveryStateOf / recoveryWantOf /
 *    recoveryButtonView / stateOfSession —— 顶栏常驻按钮的显示与点击意图。
 *
 * 覆盖口径：
 * - RECOVERY_STATES 的顺序（优先级 archived > registered > excluded > auto > none）；
 * - 五态判定 + 四份标记的任意组合（2^4）两侧逐一对齐；
 * - archived 覆盖一切（哪怕同时有登记/排除/候选）；
 * - recoveryWantOf：none/excluded → true、registered/auto → false、archived → null；
 * - recoveryButtonView：五态的文案 key / title key / 灰显 / 禁用 / aria-pressed；
 * - i18n：recovery.* 五态文案 + hover 二选一在 zh/en 两侧都存在且键集对齐；
 * - 两个快照构造器：Map/Record/数组输入、activate:false 保留、脏条目丢弃、不抛错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECOVERY_STATES,
  buildArchivedSnapshot,
  buildRegisteredSnapshot,
  recoveryStateOf,
  recoveryWantOf,
} from './recovery-state.js';

// 必须先装 window 桩再动态 import（client.js 顶层即调 window.__ModuleLoader__.load）
const loaded = {};
globalThis.window = {
	__ModuleLoader__: {
		load(def) {
			loaded[def.id] = def;
		},
	},
};

/**
 * react 桩（极简 hooks）：createElement 返回可遍历普通对象；useState 按队列出值
 * （调用顺序 = flags / pending / hover）、setter 是 no-op（不重渲染，断言首帧即可）；
 * useEffect 不执行（组件里只有一次 GET + ws 订阅的副作用，渲染断言不需要它）。
 */
const hookQueue = [];
const reactStub = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat(Infinity) };
	},
	useState() {
		const value = hookQueue.length > 0 ? hookQueue.shift() : false;
		return [value, () => {}];
	},
	useEffect() { /* 首帧渲染断言不跑副作用 */ },
};
const factoryRequire = (name) => {
	if (name === 'react') return reactStub;
	throw new Error(`unexpected require: ${name}`);
};

await import('./client.js');
const client = loaded['dsh-resume-on-restart'].factory(factoryRequire);
const {
	RECOVERY_STATES: CLIENT_RECOVERY_STATES,
	RECOVERY_BUTTON_KEYS,
	i18nDictionaries,
	recoveryButtonView,
	recoveryStateOf: clientRecoveryStateOf,
	recoveryWantOf: clientRecoveryWantOf,
	ResumeToggle,
	stateOfSession,
} = client;

/** 递归收集元素树里的全部文本（跳过 null/undefined/布尔；纯函数，照抄 notice.test.js）。 */
function collectText(node, out = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return out;
	if (typeof node === 'string' || typeof node === 'number') {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) collectText(child, out);
		return out;
	}
	if (typeof node === 'object' && Array.isArray(node.children)) {
		for (const child of node.children) collectText(child, out);
	}
	return out;
}

/** 用给定快照四态渲染一次 ResumeToggle（hookQueue 按组件调用顺序填值）。 */
function renderResumeToggle(flags, { hover = false } = {}) {
	hookQueue.length = 0;
	hookQueue.push(flags, false, hover);
	return ResumeToggle({ sessionId: 'session-done' });
}

/** 四份标记的全组合（按位枚举，覆盖 16 种输入）。 */
const ALL_FLAG_COMBOS = [];
for (let mask = 0; mask < 16; mask += 1) {
	ALL_FLAG_COMBOS.push({
		archived: (mask & 1) !== 0,
		registered: (mask & 2) !== 0,
		excluded: (mask & 4) !== 0,
		candidate: (mask & 8) !== 0,
	});
}

// ---- host 侧：优先级与五态 ----

test('RECOVERY_STATES: 顺序即优先级 archived > registered > excluded > auto > none', () => {
	assert.deepEqual([...RECOVERY_STATES], ['archived', 'registered', 'excluded', 'auto', 'none']);
	assert.ok(Object.isFrozen(RECOVERY_STATES), '常量不允许运行期被改');
});

test('recoveryStateOf: 单一标记分别命中五态，全 false → none', () => {
	assert.equal(recoveryStateOf({ archived: true }), 'archived');
	assert.equal(recoveryStateOf({ registered: true }), 'registered');
	assert.equal(recoveryStateOf({ excluded: true }), 'excluded');
	assert.equal(recoveryStateOf({ candidate: true }), 'auto');
	assert.equal(recoveryStateOf({}), 'none');
	assert.equal(recoveryStateOf({ archived: false, registered: false, excluded: false, candidate: false }), 'none');
});

test('recoveryStateOf: archived 覆盖一切（与登记/排除/候选任意组合都仍是 archived）', () => {
	for (const flags of ALL_FLAG_COMBOS) {
		if (!flags.archived) continue;
		assert.equal(recoveryStateOf(flags), 'archived', JSON.stringify(flags));
	}
});

test('recoveryStateOf: registered > excluded > auto 的优先级（排除与候选同时命中不算排除/自动）', () => {
	assert.equal(recoveryStateOf({ registered: true, excluded: true, candidate: true }), 'registered');
	assert.equal(recoveryStateOf({ excluded: true, candidate: true }), 'excluded');
	assert.equal(recoveryStateOf({ candidate: true }), 'auto');
	assert.equal(recoveryStateOf({ registered: true, candidate: true }), 'registered');
});

test('recoveryStateOf: 脏输入（null/非对象/非布尔真值）一律按 none，绝不抛错', () => {
	for (const input of [null, undefined, 42, 'archived', [], { archived: 1 }, { registered: 'true' }]) {
		assert.equal(recoveryStateOf(input), 'none', JSON.stringify(input));
	}
});

test('recoveryWantOf: none/excluded → true（登记）、registered/auto → false（取消）、archived/未知 → null', () => {
	assert.equal(recoveryWantOf('none'), true);
	assert.equal(recoveryWantOf('excluded'), true);
	assert.equal(recoveryWantOf('registered'), false);
	assert.equal(recoveryWantOf('auto'), false);
	assert.equal(recoveryWantOf('archived'), null);
	assert.equal(recoveryWantOf('bogus'), null);
});

// ---- host 侧：两个快照构造器 ----

test('buildRegisteredSnapshot: Map/Record 输入 → { id: { at, activate? } }（title 不下发）', () => {
	const map = new Map([
		['a', { at: '2026-11-07T00:00:00.000Z', title: '会话 A' }],
		['b', { at: '2026-11-07T00:01:00.000Z', activate: false }],
	]);
	assert.deepEqual(buildRegisteredSnapshot(map), {
		a: { at: '2026-11-07T00:00:00.000Z' },
		b: { at: '2026-11-07T00:01:00.000Z', activate: false },
	});
	// Record 同口径（POST /session-recovery 用 Object.fromEntries 中转）
	assert.deepEqual(buildRegisteredSnapshot({ a: { at: 'x' } }), { a: { at: 'x' } });
	// 条目数组（[{ id, at }]）也支持
	assert.deepEqual(buildRegisteredSnapshot([{ id: 'c', at: 'y' }]), { c: { at: 'y' } });
});

test('buildRegisteredSnapshot: 脏条目丢弃、activate 仅 false 携带、绝不抛错', () => {
	assert.deepEqual(buildRegisteredSnapshot(null), {});
	assert.deepEqual(buildRegisteredSnapshot('nope'), {});
	assert.deepEqual(buildRegisteredSnapshot([null, 42, { at: 'x' }, { id: '', at: 'y' }, { id: 'z', at: 'q' }]), {
		z: { at: 'q' },
	});
	// activate: true/非布尔 不带该字段（与 proactive-restore.js 的归一化口径一致）
	assert.deepEqual(buildRegisteredSnapshot({ a: { at: 'x', activate: true } }), { a: { at: 'x' } });
});

test('buildArchivedSnapshot: Set/数组 → { id: true }；空/非可迭代/脏 id 丢弃', () => {
	assert.deepEqual(buildArchivedSnapshot(new Set(['a', 'b'])), { a: true, b: true });
	assert.deepEqual(buildArchivedSnapshot(['a', '', 42, null]), { a: true });
	assert.deepEqual(buildArchivedSnapshot(null), {});
	assert.deepEqual(buildArchivedSnapshot(undefined), {});
	assert.deepEqual(buildArchivedSnapshot({ a: true }), {});
});

// ---- client 侧：与 host 逐态对齐（防两份实现漂移） ----

test('client ↔ host 对齐：RECOVERY_STATES 与 16 种标记组合的判定结果逐一对齐', () => {
	assert.deepEqual([...CLIENT_RECOVERY_STATES], [...RECOVERY_STATES]);
	for (const flags of ALL_FLAG_COMBOS) {
		assert.equal(clientRecoveryStateOf(flags), recoveryStateOf(flags), JSON.stringify(flags));
	}
});

test('client ↔ host 对齐：五态的点击意图（recoveryWantOf）逐态一致', () => {
	for (const state of RECOVERY_STATES) {
		assert.equal(clientRecoveryWantOf(state), recoveryWantOf(state), state);
	}
});

test('stateOfSession: 快照四集合 → 四布尔；字段缺失/形状异常按 false（= none）', () => {
	const snapshot = {
		restoreCandidates: { a: true },
		excluded: { b: '2026-11-07T00:00:00.000Z' },
		registered: { c: { at: '2026-11-07T00:00:00.000Z' } },
		archived: { d: true },
	};
	assert.deepEqual(stateOfSession(snapshot, 'a'), { candidate: true, excluded: false, registered: false, archived: false });
	assert.deepEqual(stateOfSession(snapshot, 'b'), { candidate: false, excluded: true, registered: false, archived: false });
	assert.deepEqual(stateOfSession(snapshot, 'c'), { candidate: false, excluded: false, registered: true, archived: false });
	assert.deepEqual(stateOfSession(snapshot, 'd'), { candidate: false, excluded: false, registered: false, archived: true });
	// 0.36.0 之前的旧快照（无 registered/archived 字段）→ 按 false，退回两态语义不炸
	assert.deepEqual(stateOfSession({ restoreCandidates: { a: true }, excluded: {} }, 'a'), {
		candidate: true, excluded: false, registered: false, archived: false,
	});
	assert.deepEqual(stateOfSession(null, 'a'), { candidate: false, excluded: false, registered: false, archived: false });
});

// ---- client 侧：按钮渲染模型（五态文案 / 灰显 / 禁用 / aria-pressed） ----

test('recoveryButtonView: 五态的文案 key、灰显、禁用、aria-pressed 与点击意图', () => {
	const expected = {
		archived: { labelKey: 'recovery.label.archived', titleKey: 'recovery.title.archived', want: null, muted: true, disabled: true, pressed: false },
		registered: { labelKey: 'recovery.label.registered', titleKey: 'recovery.title.registered', want: false, muted: false, disabled: false, pressed: true },
		excluded: { labelKey: 'recovery.label.excluded', titleKey: 'recovery.title.excluded', want: true, muted: true, disabled: false, pressed: false },
		auto: { labelKey: 'recovery.label.auto', titleKey: 'recovery.title.auto', want: false, muted: false, disabled: false, pressed: true },
		none: { labelKey: 'recovery.label.none', titleKey: 'recovery.title.none', want: true, muted: false, disabled: false, pressed: false },
	};
	for (const [state, want] of Object.entries(expected)) {
		const view = recoveryButtonView(state, false);
		assert.deepEqual(
			{ labelKey: view.labelKey, titleKey: view.titleKey, want: view.want, muted: view.muted, disabled: view.disabled, pressed: view.pressed },
			want,
			state,
		);
	}
	// 未知态兜底 none（防御式）
	assert.equal(recoveryButtonView('bogus', false).labelKey, 'recovery.label.none');
});

test('recoveryButtonView: hover 文案按点击意图二选一（登记 / 取消），归档态保持原文案', () => {
	// want=true → 「点击→重启时恢复」（none / excluded）
	assert.equal(recoveryButtonView('none', true).labelKey, 'recovery.label.hoverOn');
	assert.equal(recoveryButtonView('excluded', true).labelKey, 'recovery.label.hoverOn');
	// want=false → 「点击→重启时不恢复」（auto / registered）
	assert.equal(recoveryButtonView('auto', true).labelKey, 'recovery.label.hoverOff');
	assert.equal(recoveryButtonView('registered', true).labelKey, 'recovery.label.hoverOff');
	// archived（want=null）不换文案
	assert.equal(recoveryButtonView('archived', true).labelKey, 'recovery.label.archived');
});

test('i18n: recovery.* 五态文案 + hover 二选一在 zh/en 两侧都存在，键集逐字对齐', () => {
	const required = [];
	for (const keys of Object.values(RECOVERY_BUTTON_KEYS)) required.push(keys.label, keys.title);
	required.push('recovery.label.hoverOn', 'recovery.label.hoverOff');
	const zhKeys = Object.keys(i18nDictionaries.zh).filter((key) => key.startsWith('recovery.'));
	const enKeys = Object.keys(i18nDictionaries.en).filter((key) => key.startsWith('recovery.'));
	assert.deepEqual(zhKeys.sort(), enKeys.sort(), 'recovery.* 键集 zh/en 必须对齐');
	for (const key of required) {
		assert.equal(typeof i18nDictionaries.zh[key], 'string', `zh 缺 ${key}`);
		assert.equal(typeof i18nDictionaries.en[key], 'string', `en 缺 ${key}`);
		assert.ok(i18nDictionaries.zh[key].length > 0, `zh ${key} 为空`);
		assert.ok(i18nDictionaries.en[key].length > 0, `en ${key} 为空`);
	}
	// 五态按钮文案两两不同（防止复制粘贴漏改）
	const zhLabels = Object.values(RECOVERY_BUTTON_KEYS).map((keys) => i18nDictionaries.zh[keys.label]);
	assert.equal(new Set(zhLabels).size, zhLabels.length, '五态按钮文案不得重复');
});

test('buildRegisteredSnapshot: 被用户排除的登记不算有效（恢复流程排除优先，快照不报 registered）', () => {
  const entries = { a: { at: 'x' }, b: { at: 'y' } };
  // 单条被排除 → 只报未排除的；全部被排除 → 空（顶栏因此稳定显示 excluded，不撒谎）
  assert.deepEqual(buildRegisteredSnapshot(entries, { a: '2026-11-07T00:00:00.000Z' }), { b: { at: 'y' } });
  assert.deepEqual(buildRegisteredSnapshot(entries, new Set(['b'])), { a: { at: 'x' } });
  assert.deepEqual(buildRegisteredSnapshot(entries, ['a', 'b']), {});
  assert.deepEqual(buildRegisteredSnapshot(entries, null), entries);
  // 与状态机合看：重叠条目 → excluded（不是 registered），与真实恢复行为一致
  const flags = { registered: false, excluded: true };
  assert.equal(clientRecoveryStateOf(flags), 'excluded');
  assert.equal(recoveryStateOf(flags), 'excluded');
});

// ---- client 侧：真实渲染路径（极简 react 桩，无 DOM） ----

test('ResumeToggle: 五态真实渲染（常驻、文案/title/aria-disabled/aria-pressed）', () => {
	const stateFlags = {
		archived: { archived: true },
		registered: { registered: true },
		excluded: { excluded: true },
		auto: { candidate: true },
		none: {},
	};
	for (const [state, flags] of Object.entries(stateFlags)) {
		const tree = renderResumeToggle(flags);
		assert.equal(tree.type, 'button', `${state}: 必须渲染 button（常驻，不返回 null）`);
		const text = collectText(tree).join('');
		const keys = RECOVERY_BUTTON_KEYS[state];
		assert.ok(text.includes(i18nDictionaries.zh[keys.label]), `${state}: 文案应为「${i18nDictionaries.zh[keys.label]}」实际「${text}」`);
		assert.equal(tree.props.title, i18nDictionaries.zh[keys.title], `${state}: title 说明`);
		assert.equal(tree.props["aria-disabled"], state === 'archived', `${state}: aria-disabled`);
		assert.equal(tree.props["aria-pressed"], state === 'registered' || state === 'auto', `${state}: aria-pressed`);
		// 布局 token 不变：22px 高 / 12px 字号 / 单行省略
		assert.equal(tree.props.style.height, 22);
		assert.equal(tree.props.style.fontSize, 12);
	}
	// 已排除/已归档灰显（透明底 + 四级文字色），其余常态是浅填充底
	for (const state of ['excluded', 'archived']) {
		assert.equal(renderResumeToggle(stateFlags[state]).props.style.background, 'transparent', state);
	}
	assert.notEqual(renderResumeToggle({ candidate: true }).props.style.background, 'transparent');
});

test('ResumeToggle: 点击按状态机推导 want 并 POST /session-recovery；归档态不发请求、失败不抛错', async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		if (String(url).includes('/session-recovery')) {
			return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) };
		}
		return { ok: false, status: 404, json: async () => null };
	};
	const originalWarn = console.warn;
	console.warn = () => {}; // 失败回滚的告警在用例里静音
	try {
		const expectations = [
			[{}, true], // none → 登记恢复
			[{ excluded: true }, true], // excluded → 改为恢复
			[{ candidate: true }, false], // auto → 取消恢复
			[{ registered: true }, false], // registered → 取消登记
		];
		for (const [flags, want] of expectations) {
			calls.length = 0;
			const tree = renderResumeToggle(flags);
			await tree.props.onClick(); // 失败路径自己回滚，不得抛错
			assert.equal(calls.length, 1, JSON.stringify(flags));
			assert.equal(calls[0].url, '/api/dsh-resume-on-restart/session-recovery');
			assert.equal(calls[0].init.method, 'POST');
			assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 'session-done', want });
		}
		// 归档态：want=null，点击短路（零请求）
		calls.length = 0;
		const archivedTree = renderResumeToggle({ archived: true });
		await archivedTree.props.onClick();
		assert.equal(calls.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
		console.warn = originalWarn;
	}
});

test('ResumeToggle: 悬停文案只说点击后果（点击→重启时恢复 / 点击→重启时不恢复）', () => {
	const on = renderResumeToggle({}, { hover: true });
	assert.ok(collectText(on).join('').includes(i18nDictionaries.zh['recovery.label.hoverOn']));
	const off = renderResumeToggle({ candidate: true }, { hover: true });
	assert.ok(collectText(off).join('').includes(i18nDictionaries.zh['recovery.label.hoverOff']));
	// 归档态悬停不换文案（点击无效，不暗示动作）
	const archived = renderResumeToggle({ archived: true }, { hover: true });
	assert.ok(collectText(archived).join('').includes(i18nDictionaries.zh['recovery.label.archived']));
});
