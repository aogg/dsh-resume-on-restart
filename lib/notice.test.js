/**
 * 0.32.0：提示词展示（tab3「技能展示」）与重启日志「恢复已取消」的纯函数单测。
 *
 * 两块被测逻辑分处两侧、必须保持对齐，所以放在同一个文件：
 * 1. host 侧 lib/detect.js 的 noticeSegments（提示词分段）：
 *    - 分段 key 必须落在 NOTICE_SEGMENT_KEYS 白名单内、顺序稳定；
 *    - join 结果必须与 buildNotice 逐字一致（拆分不改文案）。
 * 2. client 侧 lib/client.js（经 window.__ModuleLoader__ 桩加载真实发布文件）：
 *    - zh/en 字典都覆盖每个分段 key 的「出现条件」文案 notice.when.<key>；
 *    - tab3 标签已是「技能展示」/「Skill Showcase」；
 *    - groupEntries 把 resume-cancel 条目归入所属 boot 组（含孤儿组）；
 *    - resumeCancelText 的降级口径（缺字段、抛错/超时标记）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOTICE_SEGMENT_KEYS, buildNotice, noticeSegments } from './detect.js';

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
 * react 桩：纯函数测试不触渲染；createElement 返回可遍历的普通对象，
 * 供 NoticePanel 的渲染冒烟测试（不引真实 react / 不做 DOM 渲染）。
 */
const factoryRequire = (name) => {
	if (name === 'react') {
		return {
			createElement(type, props, ...children) {
				return { type, props: props ?? {}, children: children.flat(Infinity) };
			},
		};
	}
	throw new Error(`unexpected require: ${name}`);
};

await import('./client.js');
const client = loaded['dsh-resume-on-restart'].factory(factoryRequire);
const { groupEntries, resumeCancelText, i18nDictionaries, NoticePanel } = client;

/** 递归收集元素树里的全部文本（跳过 null/undefined/布尔；纯函数）。 */
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

// ---- 1. host 侧：noticeSegments ----

test('noticeSegments: 全字段齐全时 8 段全出现，顺序与 key 白名单一致', () => {
	const segments = noticeSegments({
		bootAt: '2026-11-07T00:00:05.000Z',
		prevBootAt: '2026-11-07T00:00:00.000Z',
		downtimeMs: 5000,
		lastSessionId: 'session-abc',
		lastActiveAt: '2026-11-07T00:00:00.000Z',
		restoredSessionId: 'session-abc',
		restoredActiveAt: '2026-11-07T00:00:00.000Z',
		customNotice: '别忘了先跑测试',
	});
	assert.deepEqual(segments.map((segment) => segment.key), [...NOTICE_SEGMENT_KEYS]);
	assert.equal(segments[0].text, '[resume-on-restart] 检测到 DSH 服务已重启。');
	assert.equal(segments.at(-1).text, '如需继续之前的工作，或启动新任务，请自主决定下一步。');
	assert.ok(segments.find((segment) => segment.key === 'custom').text.includes('别忘了先跑测试'));
});

test('noticeSegments: 只有 bootAt 时 3 段（header/boot/tail），join 与 buildNotice 逐字一致', () => {
	const opts = { bootAt: '2026-11-07T00:00:05.000Z' };
	const segments = noticeSegments(opts);
	assert.deepEqual(segments.map((segment) => segment.key), ['header', 'boot', 'tail']);
	assert.equal(segments[1].text, '本次于 2026-11-07T00:00:05.000Z 启动。');
	assert.equal(segments.map((segment) => segment.text).join('\n'), buildNotice(opts));
});

test('noticeSegments: 恢复行两种形态（带/不带最后活跃时刻）', () => {
	const withAt = noticeSegments({ bootAt: 'b', restoredSessionId: 's1', restoredActiveAt: 'a1' });
	assert.ok(withAt.some((segment) => segment.key === 'restored' && segment.text.includes('（最后活跃于 a1）')));
	const withoutAt = noticeSegments({ bootAt: 'b', restoredSessionId: 's1' });
	assert.ok(withoutAt.some((segment) => segment.key === 'restored' && segment.text === '已自动恢复重启前活跃的会话 s1。'));
});

test('noticeSegments: 每个 key 都在白名单里（白名单是客户端 i18n 的锚点）', () => {
	for (const segment of noticeSegments({
		bootAt: 'b', prevBootAt: 'p', downtimeMs: 1, lastSessionId: 's', lastActiveAt: 'a',
		restoredSessionId: 's', restoredActiveAt: 'a', customNotice: 'c',
	})) {
		assert.ok(NOTICE_SEGMENT_KEYS.includes(segment.key), `${segment.key} 不在 NOTICE_SEGMENT_KEYS`);
	}
});

// ---- 2. client 侧：文案与渲染辅助 ----

test('tab3 已改名：zh「技能展示」/ en「Skill Showcase」', () => {
	assert.equal(i18nDictionaries.zh['restart.tabSkills'], '技能展示');
	assert.equal(i18nDictionaries.en['restart.tabSkills'], 'Skill Showcase');
});

test('zh/en 字典都覆盖每个提示词片段的出现条件文案', () => {
	for (const key of NOTICE_SEGMENT_KEYS) {
		const i18nKey = `notice.when.${key}`;
		for (const [locale, dict] of Object.entries(i18nDictionaries)) {
			const text = dict[i18nKey];
			assert.equal(typeof text, 'string', `${locale} 缺 ${i18nKey}`);
			assert.notEqual(text, '', `${locale} 的 ${i18nKey} 为空`);
			assert.notEqual(text, i18nKey, `${locale} 的 ${i18nKey} 实际是 key 本身`);
		}
	}
});

test('zh/en 的 notice 区块与取消文案 key 齐全（两侧同 key 集）', () => {
	const zhKeys = Object.keys(i18nDictionaries.zh).filter((key) => key.startsWith('notice.'));
	const enKeys = Object.keys(i18nDictionaries.en).filter((key) => key.startsWith('notice.'));
	assert.deepEqual([...zhKeys].sort(), [...enKeys].sort());
	for (const key of ['notice.title', 'notice.note', 'notice.sampleLabel', 'notice.segmentsLabel', 'notice.unavailable']) {
		assert.ok(zhKeys.includes(key), `zh 缺 ${key}`);
	}
	for (const key of ['log.cancelled', 'detail.cancelTitle', 'detail.cancelBy', 'detail.cancelReason', 'restart.cancelledByHook']) {
		for (const [locale, dict] of Object.entries(i18nDictionaries)) {
			assert.equal(typeof dict[key], 'string', `${locale} 缺 ${key}`);
		}
	}
});

test('groupEntries: resume-cancel 归入所属 boot 组，restore 照旧归组，整体倒序', () => {
	const groups = groupEntries([
		{ type: 'boot', at: '2026-11-07T00:00:00.000Z' },
		{ type: 'restore', bootAt: '2026-11-07T00:00:00.000Z', id: 'a', result: 'resumed' },
		{ type: 'resume-cancel', bootAt: '2026-11-07T00:00:00.000Z', by: 'dsh-backup', reason: '正在备份' },
		{ type: 'boot', at: '2026-11-07T01:00:00.000Z' },
	]);
	assert.equal(groups.length, 2);
	// 倒序：最近的重启在前
	assert.equal(groups[0].boot.at, '2026-11-07T01:00:00.000Z');
	assert.deepEqual(groups[0].cancels, []);
	assert.equal(groups[1].restores.length, 1);
	assert.deepEqual(groups[1].cancels.map((entry) => entry.by), ['dsh-backup']);
});

test('groupEntries: 无归属 boot 的 resume-cancel 自成孤儿组；未知类型忽略', () => {
	const groups = groupEntries([
		{ type: 'resume-cancel', bootAt: '2026-11-07T00:00:00.000Z', by: 'x' },
		{ type: 'whatever' },
		null,
		'oops',
	]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].boot, null);
	assert.deepEqual(groups[0].restores, []);
	assert.equal(groups[0].cancels.length, 1);
});

test('groupEntries: 非数组 / 空输入 → []，旧调用方缺 cancels 字段也能补上', () => {
	assert.deepEqual(groupEntries(undefined), []);
	assert.deepEqual(groupEntries([]), []);
});

test('resumeCancelText: by/reason 齐全、缺字段降级、抛错/超时标记', () => {
	const t = (key) => key; // 直接用 key 断言拼接结构
	assert.equal(
		resumeCancelText({ by: 'dsh-backup', reason: '正在备份' }, t),
		'detail.cancelBy: dsh-backup · detail.cancelReason: 正在备份',
	);
	// by 缺失 → —；reason 缺失 → 用 detail 兜底；两者都缺 → 只剩取消方一行
	assert.equal(resumeCancelText({}, t), 'detail.cancelBy: —');
	assert.equal(resumeCancelText({ detail: 'hook timeout' }, t), 'detail.cancelBy: — · detail.cancelReason: hook timeout');
	// 抛错 / 超时标记追加在末尾（排障区分「插件主动取消」与「兜底取消」）
	assert.equal(
		resumeCancelText({ by: 'dsh-x', hookTimeout: true }, t),
		'detail.cancelBy: dsh-x · detail.cancelHookTimeout',
	);
	assert.equal(
		resumeCancelText({ by: 'dsh-x', hookError: true }, t),
		'detail.cancelBy: dsh-x · detail.cancelHookError',
	);
	// 非对象输入不抛错
	assert.equal(resumeCancelText(null, t), 'detail.cancelBy: —');
});

// ---- 3. client 侧：NoticePanel 渲染冒烟（react 桩，不做 DOM） ----

test('NoticePanel: 有数据 → 渲染样本正文、8 个片段 key、未出现占位与投递方式', () => {
	const sample = '[resume-on-restart] 检测到 DSH 服务已重启。\n本次于 B 启动。\n如需继续之前的工作，或启动新任务，请自主决定下一步。';
	const segments = ['header', 'boot', 'downtime', 'lastSession', 'lastActive', 'restored', 'custom', 'tail']
		.map((key) => ({ key, text: key === 'header' || key === 'boot' || key === 'tail' ? `${key}-text` : null }));
	const tree = NoticePanel({
		notice: {
			ok: true,
			sample,
			segments,
			delivery: {
				method: 'followup',
				wakeup: true,
				source: { kind: 'dsh-resume-on-restart', form: 'notice', summary: 'resume-on-restart: DSH restarted at B' },
				customNotice: null,
			},
		},
		t: (key) => key,
	});
	const text = collectText(tree).join('\n');
	// 样本正文原样出现（换行是语义的一部分，<pre> 原样承载）
	assert.ok(text.includes(sample));
	// 8 个片段 key 全部列出
	for (const { key } of segments) assert.ok(text.includes(key), `缺片段 ${key}`);
	// 未出现片段显示占位与「本次未出现」说明
	assert.ok(text.includes('notice.absent'));
	// 投递方式与消息来源
	assert.ok(text.includes('notice.deliveryFollowup'));
	assert.ok(text.includes('dsh-resume-on-restart · notice'));
	// 未配置自定义行时的占位
	assert.ok(text.includes('notice.customNone'));
});

test('NoticePanel: notice 为 null（404 / 混合版本窗口）→ 只显示「重启 DSH 后可见」', () => {
	const text = collectText(NoticePanel({ notice: null, t: (key) => key })).join('\n');
	assert.ok(text.includes('notice.title'));
	assert.ok(text.includes('notice.unavailable'));
	// 没有正文区块（没有 sample / segments 标题）
	assert.equal(text.includes('notice.sampleLabel'), false);
});
