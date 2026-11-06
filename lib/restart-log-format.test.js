/**
 * 0.31.0：重启日志表格的时长格式化单测（node --test，无 e2e、不起服务）。
 * 0.31.1：追加「重启耗时」取值纯函数 restartMsOf 单测（历史条目回算）。
 *
 * 「距上次重启」列（downtimeMs）与「重启耗时」列（restartMs）共用 client 侧
 * humanizeMs：毫秒 → 紧凑文案（`13s` / `1m 5s` / `2h 46m`，locale 中立）。
 * client.js 是手写浏览器 bundle（window.__ModuleLoader__.load 范式），测试用
 * window 桩捕获工厂定义、以 react 桩 require 加载真实发布文件，断言导出的
 * humanizeMs / restartMsOf —— 测的就是发布逻辑本身（照 lib/pending-restore.test.js
 * 先例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 必须先装 window 桩再动态 import（client.js 顶层即调 window.__ModuleLoader__.load）
const loaded = {};
globalThis.window = {
	__ModuleLoader__: {
		load(def) {
			loaded[def.id] = def;
		},
	},
};

/** react 桩：纯函数测试不触渲染。 */
const factoryRequire = (name) => {
	if (name === 'react') return {};
	throw new Error(`unexpected require: ${name}`);
};

await import('./client.js');
const client = loaded['dsh-resume-on-restart'].factory(factoryRequire);
const { humanizeMs, restartMsOf } = client;

test('humanizeMs: 秒级 → 「13s」', () => {
	assert.equal(humanizeMs(13_000), '13s');
	assert.equal(humanizeMs(1000), '1s');
	// 不足 1 秒按最短 1 秒显示（不出现「0s」）
	assert.equal(humanizeMs(1), '1s');
	assert.equal(humanizeMs(999), '1s');
});

test('humanizeMs: 分秒级 → 「1m 5s」（整分不带秒）', () => {
	assert.equal(humanizeMs(65_000), '1m 5s');
	assert.equal(humanizeMs(60_000), '1m');
	assert.equal(humanizeMs(119_000), '1m 59s');
});

test('humanizeMs: 小时级 → 「2h 46m」（整小时不带分；秒在小时级不显示）', () => {
	// 用户截图里的 2h 46m：9960 秒
	assert.equal(humanizeMs(2 * 3600_000 + 46 * 60_000), '2h 46m');
	assert.equal(humanizeMs(3600_000), '1h');
	assert.equal(humanizeMs(3600_000 + 5_000), '1h');
});

test('humanizeMs: 非正数/非法输入 → 「—」（历史条目无 restartMs 时同款占位）', () => {
	assert.equal(humanizeMs(0), '—');
	assert.equal(humanizeMs(-5000), '—');
	assert.equal(humanizeMs(Number.NaN), '—');
	assert.equal(humanizeMs(null), '—');
	assert.equal(humanizeMs(undefined), '—');
	assert.equal(humanizeMs('abc'), '—');
	// 数字字符串按数值处理（防御式：客户端不信任字段类型）
	assert.equal(humanizeMs('65000'), '1m 5s');
});

test('restartMsOf: 有 restartMs 字段 → 原样返回（不参与回算）', () => {
	// 0.31.0 起 host 落库的字段优先，即便 at/requestedAt 也能算出别的值
	assert.equal(restartMsOf({ restartMs: 13_000, at: '2026-11-06T02:00:13.000Z', origin: { requestedAt: '2026-11-06T02:00:00.000Z' } }), 13_000);
	// 边界：0 是有限数字，原样返回（humanizeMs 再按非正数显示「—」）
	assert.equal(restartMsOf({ restartMs: 0 }), 0);
	assert.equal(humanizeMs(restartMsOf({ restartMs: 0 })), '—');
});

test('restartMsOf: 缺 restartMs 字段 → 按 at − origin.requestedAt 回算（历史条目）', () => {
	// 历史 boot 记录：没有 restartMs，但 at 与 origin.requestedAt 都在
	const historical = {
		at: '2026-11-06T02:00:13.000Z',
		origin: { kind: 'settings-ui', requestedAt: '2026-11-06T02:00:00.000Z' },
	};
	assert.equal(restartMsOf(historical), 13_000);
	assert.equal(humanizeMs(restartMsOf(historical)), '13s');
	// 分秒级长耗时同样回算
	assert.equal(restartMsOf({
		at: '2026-11-06T02:46:05.000Z',
		origin: { requestedAt: '2026-11-06T02:00:00.000Z' },
	}), 2_765_000);
	assert.equal(humanizeMs(restartMsOf({
		at: '2026-11-06T02:46:05.000Z',
		origin: { requestedAt: '2026-11-06T02:00:00.000Z' },
	})), '46m 5s');
});

test('restartMsOf: at 与 requestedAt 都缺（或不可解析/顺序反向） → null（显示「—」）', () => {
	assert.equal(restartMsOf({}), null);
	assert.equal(restartMsOf({ restartMs: null, at: '2026-11-06T02:00:13.000Z' }), null);
	assert.equal(restartMsOf({ at: '2026-11-06T02:00:13.000Z' }), null);
	assert.equal(restartMsOf({ at: '2026-11-06T02:00:13.000Z', origin: {} }), null);
	assert.equal(restartMsOf({ origin: { requestedAt: '2026-11-06T02:00:00.000Z' } }), null);
	// 不可解析
	assert.equal(restartMsOf({ at: 'not-a-date', origin: { requestedAt: '2026-11-06T02:00:00.000Z' } }), null);
	assert.equal(restartMsOf({ at: '2026-11-06T02:00:13.000Z', origin: { requestedAt: 'bad' } }), null);
	// 非字符串（含数字时间戳）不臆测
	assert.equal(restartMsOf({ at: 1_760_000_000_000, origin: { requestedAt: '2026-11-06T02:00:00.000Z' } }), null);
	// 发起时刻晚于完成时刻（时钟漂移/脏数据）不产出负值
	assert.equal(restartMsOf({ at: '2026-11-06T02:00:00.000Z', origin: { requestedAt: '2026-11-06T02:00:13.000Z' } }), null);
	assert.equal(restartMsOf(null), null);
	assert.equal(restartMsOf(undefined), null);
	assert.equal(humanizeMs(restartMsOf({})), '—');
});
