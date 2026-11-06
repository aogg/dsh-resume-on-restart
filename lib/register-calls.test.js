/**
 * 0.31.0：登记调用留痕与重启周期统计的单元测试（node --test，无 e2e、不起服务）。
 *
 * 覆盖 lib/register-calls.js 的发布逻辑本身：
 * 1. cycleRegistrations：重启周期窗口 `[prevBootAt, requestedAt]`（两端闭区间）
 *    ——边界命中、窗口外（早于上次 boot / 晚于重启发起时刻）剔除、按 at 取
 *    最早一条（乱序输入亦然）、空记录、脏输入（非数组/非对象/数组条目/
 *    缺 at/at 不可解析）一律跳过、边界不可解析时该侧按无边界处理；
 * 2. createRegisterCallWriter / readRegisterCalls：追加、读回、上限超出丢最旧、
 *    重写顺带剔除损坏行、文件缺失读成空数组。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	MAX_REGISTER_CALL_ENTRIES,
	createRegisterCallWriter,
	cycleRegistrations,
	readRegisterCalls,
	registerCallsPathOf,
} from './register-calls.js';

/** 临时目录（每用例独立，避免相互干扰）。 */
function tempDir() {
	return mkdtempSync(join(tmpdir(), 'dsh-ror-register-calls-'));
}

/** 造一条登记留痕条目。 */
function call(at, sessionId = 'sess-1', extra = {}) {
	return { at, sessionId, ...extra };
}

// ---- cycleRegistrations：窗口与边界 ----

test('cycleRegistrations: 空记录 → 次数 0、首条信息为 null', () => {
	assert.deepEqual(cycleRegistrations([], { prevBootAt: '2026-11-06T00:00:00.000Z', requestedAt: '2026-11-06T02:00:00.000Z' }), {
		registrationCount: 0,
		registrationFirstAt: null,
		registrationFirstSessionId: null,
	});
	// 非数组输入同样按空处理
	assert.deepEqual(cycleRegistrations(null, {}), {
		registrationCount: 0,
		registrationFirstAt: null,
		registrationFirstSessionId: null,
	});
});

test('cycleRegistrations: 窗口两端闭区间——prevBootAt 与 requestedAt 恰好命中', () => {
	const prevBootAt = '2026-11-06T00:00:00.000Z';
	const requestedAt = '2026-11-06T02:00:00.000Z';
	const records = [
		call(prevBootAt, 'boot-boundary'),
		call('2026-11-06T01:00:00.000Z', 'middle'),
		call(requestedAt, 'requested-boundary'),
		// 窗口外：早 1ms / 晚 1ms
		call('2026-11-05T23:59:59.999Z', 'before'),
		call('2026-11-06T02:00:00.001Z', 'after'),
	];
	assert.deepEqual(cycleRegistrations(records, { prevBootAt, requestedAt }), {
		registrationCount: 3,
		registrationFirstAt: prevBootAt,
		registrationFirstSessionId: 'boot-boundary',
	});
});

test('cycleRegistrations: 首条按 at 取最早（乱序输入不依赖写入顺序）', () => {
	const records = [
		call('2026-11-06T01:30:00.000Z', 'later'),
		call('2026-11-06T01:00:00.000Z', 'first'),
		call('2026-11-06T01:45:00.000Z', 'last'),
	];
	const result = cycleRegistrations(records, {
		prevBootAt: '2026-11-06T00:00:00.000Z',
		requestedAt: '2026-11-06T02:00:00.000Z',
	});
	assert.equal(result.registrationCount, 3);
	assert.equal(result.registrationFirstAt, '2026-11-06T01:00:00.000Z');
	assert.equal(result.registrationFirstSessionId, 'first');
});

test('cycleRegistrations: 周期外的记录不计数', () => {
	const records = [
		call('2026-11-05T00:00:00.000Z', 'before-window'),
		call('2026-11-06T03:00:00.000Z', 'after-window'),
	];
	assert.equal(cycleRegistrations(records, {
		prevBootAt: '2026-11-06T00:00:00.000Z',
		requestedAt: '2026-11-06T02:00:00.000Z',
	}).registrationCount, 0);
});

test('cycleRegistrations: 边界不可解析时该侧按无边界（crash 等无 requestedAt 的周期仍可统计）', () => {
	const records = [call('2026-11-06T01:00:00.000Z', 'a'), call('2026-11-06T05:00:00.000Z', 'b')];
	// prevBootAt 可解析、requestedAt 缺失 → 只留上界无界
	const noRequested = cycleRegistrations(records, { prevBootAt: '2026-11-06T00:00:00.000Z' });
	assert.equal(noRequested.registrationCount, 2);
	assert.equal(noRequested.registrationFirstSessionId, 'a');
	// 两个边界都不可解析 → 全部计入
	const noBounds = cycleRegistrations(records, { prevBootAt: 'not-a-time', requestedAt: undefined });
	assert.equal(noBounds.registrationCount, 2);
	assert.equal(noBounds.registrationFirstAt, '2026-11-06T01:00:00.000Z');
	// requestedAt 不可解析但 prevBootAt 有效：下界仍生效
	const badUpper = cycleRegistrations([call('2026-11-05T00:00:00.000Z', 'old'), call('2026-11-06T01:00:00.000Z', 'new')], {
		prevBootAt: '2026-11-06T00:00:00.000Z',
		requestedAt: 'garbage',
	});
	assert.equal(badUpper.registrationCount, 1);
	assert.equal(badUpper.registrationFirstSessionId, 'new');
});

test('cycleRegistrations: 无 sessionId 的首条 → registrationFirstSessionId 为 null（字段缺省）', () => {
	const result = cycleRegistrations([
		{ at: '2026-11-06T01:00:00.000Z' },
		{ at: '2026-11-06T01:30:00.000Z', sessionId: 'later' },
	], { prevBootAt: '2026-11-06T00:00:00.000Z', requestedAt: '2026-11-06T02:00:00.000Z' });
	assert.equal(result.registrationCount, 2);
	assert.equal(result.registrationFirstAt, '2026-11-06T01:00:00.000Z');
	assert.equal(result.registrationFirstSessionId, null);
});

test('cycleRegistrations: 脏输入跳过（非对象/数组条目/缺 at/at 不可解析/非字符串 at）', () => {
	const records = [
		null,
		undefined,
		'not-an-object',
		42,
		['array', 'entry'],
		{ sessionId: 'no-at' },
		{ at: 12345, sessionId: 'numeric-at' },
		{ at: 'not-a-time', sessionId: 'bad-at' },
		{ at: '', sessionId: 'empty-at' },
		call('2026-11-06T01:00:00.000Z', 'good'),
	];
	const result = cycleRegistrations(records, {
		prevBootAt: '2026-11-06T00:00:00.000Z',
		requestedAt: '2026-11-06T02:00:00.000Z',
	});
	assert.equal(result.registrationCount, 1);
	assert.equal(result.registrationFirstSessionId, 'good');
});

test('cycleRegistrations: activate=false 的条目同样计数（两种模式都算登记调用）', () => {
	const records = [call('2026-11-06T01:00:00.000Z', 'no-activate', { activate: false })];
	const result = cycleRegistrations(records, {
		prevBootAt: '2026-11-06T00:00:00.000Z',
		requestedAt: '2026-11-06T02:00:00.000Z',
	});
	assert.equal(result.registrationCount, 1);
	assert.equal(result.registrationFirstSessionId, 'no-activate');
});

// ---- 写入器 / 读取器 ----

test('registerCallsPathOf: 固定落在 <stateDir>/register-calls.ndjson', () => {
	assert.equal(registerCallsPathOf('/state/dir'), join('/state/dir', 'register-calls.ndjson'));
});

test('writer + reader: 追加后按写入顺序读回，形状为 { at, sessionId, activate? }', () => {
	const file = join(tempDir(), 'nested', 'register-calls.ndjson');
	const write = createRegisterCallWriter(file);
	write({ at: '2026-11-06T01:00:00.000Z', sessionId: 's1' });
	write({ at: '2026-11-06T01:05:00.000Z', sessionId: 's2', activate: false });
	const entries = readRegisterCalls(file);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries[0], { at: '2026-11-06T01:00:00.000Z', sessionId: 's1' });
	assert.deepEqual(entries[1], { at: '2026-11-06T01:05:00.000Z', sessionId: 's2', activate: false });
});

test('writer: 超出上限丢最旧（重写后只留最近 max 条），且顺带剔除损坏行', () => {
	const file = join(tempDir(), 'register-calls.ndjson');
	writeFileSync(file, 'not-json\n[1,2]\n', 'utf8'); // 两条损坏行（启动计数含它们）
	const write = createRegisterCallWriter(file, 3);
	write({ at: '2026-11-06T01:00:00.000Z', sessionId: 'a' });
	write({ at: '2026-11-06T02:00:00.000Z', sessionId: 'b' });
	// 第 3 条触发裁剪：损坏行剔除、有效条目暂未超出
	write({ at: '2026-11-06T03:00:00.000Z', sessionId: 'c' });
	assert.deepEqual(readRegisterCalls(file).map((entry) => entry.sessionId), ['a', 'b', 'c']);
	// 再写一条又触发裁剪：丢最旧的 a，只留 b、c、d
	write({ at: '2026-11-06T04:00:00.000Z', sessionId: 'd' });
	const kept = readRegisterCalls(file);
	assert.deepEqual(kept.map((entry) => entry.sessionId), ['b', 'c', 'd']);
	assert.equal(readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length, 3);
});

test('readRegisterCalls: 文件不存在 → 空数组（首次部署属预期，不抛错）', () => {
	assert.deepEqual(readRegisterCalls(join(tempDir(), 'missing.ndjson')), []);
});

test('MAX_REGISTER_CALL_ENTRIES: 上限 200（与 restarts.ndjson 同口径）', () => {
	assert.equal(MAX_REGISTER_CALL_ENTRIES, 200);
});
