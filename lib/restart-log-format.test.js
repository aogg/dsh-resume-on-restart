/**
 * 0.31.0：重启日志表格的时长格式化单测（node --test，无 e2e、不起服务）。
 *
 * 「距上次重启」列（downtimeMs）与「重启耗时」列（restartMs）共用 client 侧
 * humanizeMs：毫秒 → 紧凑文案（`13s` / `1m 5s` / `2h 46m`，locale 中立）。
 * client.js 是手写浏览器 bundle（window.__ModuleLoader__.load 范式），测试用
 * window 桩捕获工厂定义、以 react 桩 require 加载真实发布文件，断言导出的
 * humanizeMs —— 测的就是发布逻辑本身（照 lib/pending-restore.test.js 先例）。
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
const { humanizeMs } = client;

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
