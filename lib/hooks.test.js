/**
 * 0.32.0：对外扩展点（lib/hooks.js）单测。
 *
 * 覆盖三层：
 * 1. normalizeHookCancel / describeHookCancel 的纯函数口径（与 cordis isBailed 对齐）；
 * 2. buildBeforeRestartPayload / buildBeforeResumePayload 的形状、归一化与只读性；
 * 3. runRestartHook 的派发语义：缺 serial 放行、串行等待、取消、抛错=取消、
 *    超时=取消。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEFORE_RESTART_HOOK,
  BEFORE_RESUME_HOOK,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  buildBeforeRestartPayload,
  buildBeforeResumePayload,
  describeHookCancel,
  normalizeHookCancel,
  runRestartHook,
} from './hooks.js';

// ---- 1. 取消值归一化 ----

test('normalizeHookCancel: null / undefined / false → 不取消', () => {
  assert.equal(normalizeHookCancel(null), null);
  assert.equal(normalizeHookCancel(undefined), null);
  assert.equal(normalizeHookCancel(false), null);
});

test('normalizeHookCancel: true → 取消且无原因', () => {
  assert.deepEqual(normalizeHookCancel(true), { cancelled: true, by: null, reason: null });
});

test('normalizeHookCancel: 字符串即原因（空串按无原因）', () => {
  assert.deepEqual(normalizeHookCancel('维护窗口，先别重启'), {
    cancelled: true,
    by: null,
    reason: '维护窗口，先别重启',
  });
  assert.deepEqual(normalizeHookCancel(''), { cancelled: true, by: null, reason: null });
});

test('normalizeHookCancel: {cancel:false} 明确表态继续；其它对象一律取消', () => {
  assert.equal(normalizeHookCancel({ cancel: false, reason: 'x' }), null);
  assert.deepEqual(
    normalizeHookCancel({ cancel: true, by: 'dsh-backup', reason: '正在备份' }),
    { cancelled: true, by: 'dsh-backup', reason: '正在备份' },
  );
  // by / reason 的别名
  assert.deepEqual(
    normalizeHookCancel({ plugin: 'dsh-migrate', message: 'migrating' }),
    { cancelled: true, by: 'dsh-migrate', reason: 'migrating' },
  );
  // 普通对象（无 cancel 字段）= 取消，无原因（与 cordis isBailed 同向）
  assert.deepEqual(normalizeHookCancel({}), { cancelled: true, by: null, reason: null });
});

test('normalizeHookCancel: 数字 0 / 非对象真值 → 按 String 归一（与 isBailed 同向）', () => {
  assert.deepEqual(normalizeHookCancel(0), { cancelled: true, by: null, reason: '0' });
  assert.deepEqual(normalizeHookCancel(42), { cancelled: true, by: null, reason: '42' });
});

test('describeHookCancel: 有 by 有原因 / 只有 by / 全缺的回退口径', () => {
  assert.equal(
    describeHookCancel({ cancelled: true, by: 'dsh-backup', reason: '正在备份' }),
    'cancelled by plugin "dsh-backup": 正在备份',
  );
  assert.equal(
    describeHookCancel({ cancelled: true, by: null, reason: '正在备份' }),
    'cancelled by plugin "dsh-resume-on-restart": 正在备份',
  );
  assert.equal(
    describeHookCancel({ cancelled: true, by: 'dsh-backup', reason: null }),
    'cancelled by plugin "dsh-backup"',
  );
  // 非取消记录 → 空串（调用方直接拼日志不会出现 undefined）
  assert.equal(describeHookCancel(null), '');
  assert.equal(describeHookCancel({ cancelled: false }), '');
});

// ---- 2. payload 构造 ----

test('buildBeforeRestartPayload: 形状固定、候选归一化、整体冻结', () => {
  const payload = buildBeforeRestartPayload({
    origin: { kind: 'model-tool', sessionId: 'session-1' },
    mode: 'pid1-exit',
    delayMs: 1500,
    instanceId: 'inst-1',
    pid: 42,
    port: 3080,
    requestedAt: '2026-11-07T00:00:00.000Z',
    candidates: [
      { id: 'session-1', at: '2026-11-06T23:00:00.000Z', running: true },
      { id: 'session-2' },
      { id: '' }, // 非法 id 剔除
      null, // 非对象剔除
    ],
  });
  assert.equal(payload.event, BEFORE_RESTART_HOOK);
  assert.equal(payload.plugin, 'dsh-resume-on-restart');
  assert.equal(payload.phase, 'before-restart');
  assert.deepEqual(payload.origin, { kind: 'model-tool', sessionId: 'session-1' });
  assert.equal(payload.mode, 'pid1-exit');
  assert.equal(payload.delayMs, 1500);
  assert.equal(payload.port, 3080);
  assert.equal(payload.requestedAt, '2026-11-07T00:00:00.000Z');
  assert.deepEqual(payload.candidates, [
    { id: 'session-1', at: '2026-11-06T23:00:00.000Z', running: true },
    { id: 'session-2', at: '', running: false },
  ]);
  assert.ok(Object.isFrozen(payload));
  assert.ok(Object.isFrozen(payload.candidates));
  assert.ok(Object.isFrozen(payload.candidates[0]));
  assert.ok(Object.isFrozen(payload.origin));
});

test('buildBeforeRestartPayload: origin 缺失、mode 非法 → null / helper 兜底', () => {
  const payload = buildBeforeRestartPayload({ mode: 'bogus' });
  assert.equal(payload.origin, null);
  assert.equal(payload.mode, 'helper');
  assert.deepEqual(payload.candidates, []);
  // 未传 requestedAt → 用当前时间（ISO 可解析）
  assert.ok(Number.isFinite(Date.parse(payload.requestedAt)));
});

test('buildBeforeResumePayload: 候选/登记/暂停/排除同形状，整体冻结', () => {
  const payload = buildBeforeResumePayload({
    bootAt: '2026-11-07T00:00:00.000Z',
    prevBootAt: '2026-11-06T20:00:00.000Z',
    downtimeMs: 1000,
    reason: 'restart-button',
    origin: { kind: 'settings-ui', sessionId: null },
    candidates: [{ id: 'a', at: '2026-11-06T23:00:00.000Z', running: true }],
    registered: ['a', '', 3],
    paused: ['b'],
    excluded: { c: '2026-11-06T21:00:00.000Z', d: 1 },
  });
  assert.equal(payload.event, BEFORE_RESUME_HOOK);
  assert.equal(payload.phase, 'before-resume');
  assert.equal(payload.bootAt, '2026-11-07T00:00:00.000Z');
  assert.equal(payload.prevBootAt, '2026-11-06T20:00:00.000Z');
  assert.equal(payload.downtimeMs, 1000);
  assert.equal(payload.reason, 'restart-button');
  assert.deepEqual(payload.candidates, [{ id: 'a', at: '2026-11-06T23:00:00.000Z', running: true }]);
  assert.deepEqual(payload.registered, ['a']);
  assert.deepEqual(payload.paused, ['b']);
  // 排除集合只收字符串时刻（数字/脏值归一为空串）
  assert.deepEqual(payload.excluded, { c: '2026-11-06T21:00:00.000Z', d: '' });
  assert.ok(Object.isFrozen(payload));
  assert.ok(Object.isFrozen(payload.candidates));
  assert.ok(Object.isFrozen(payload.excluded));
});

// ---- 3. 派发语义 ----

test('runRestartHook: 宿主没有 ctx.serial → 放行（不阻塞原有逻辑）', async () => {
  assert.equal(await runRestartHook(null, BEFORE_RESTART_HOOK, {}), null);
  assert.equal(await runRestartHook({}, BEFORE_RESTART_HOOK, {}), null);
  assert.equal(await runRestartHook({ serial: 'nope' }, BEFORE_RESTART_HOOK, {}), null);
});

test('runRestartHook: 传给 ctx.serial 的是事件名 + 冻结 payload，按返回值判定', async () => {
  const calls = [];
  const payload = buildBeforeRestartPayload({ mode: 'helper' });
  const ctx = {
    serial(event, data) {
      calls.push([event, data]);
      return undefined; // 不取消
    },
  };
  assert.equal(await runRestartHook(ctx, BEFORE_RESTART_HOOK, payload), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], BEFORE_RESTART_HOOK);
  assert.equal(calls[0][1], payload);
  assert.equal(HOOK_EVENTS.beforeRestart, BEFORE_RESTART_HOOK);
  assert.equal(HOOK_EVENTS.beforeResume, BEFORE_RESUME_HOOK);
});

test('runRestartHook: 处理器 async 串行完成之后才返回（宿主等它跑完）', async () => {
  const order = [];
  const ctx = {
    async serial() {
      order.push('hook-start');
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push('hook-end');
      return undefined;
    },
  };
  const cancel = await runRestartHook(ctx, BEFORE_RESUME_HOOK, {});
  order.push('after-hook');
  assert.equal(cancel, null);
  assert.deepEqual(order, ['hook-start', 'hook-end', 'after-hook']);
});

test('runRestartHook: 处理器的取消值原样归一为取消记录', async () => {
  const ctx = { serial: () => ({ cancel: true, by: 'dsh-backup', reason: '正在备份' }) };
  assert.deepEqual(await runRestartHook(ctx, BEFORE_RESTART_HOOK, {}), {
    cancelled: true,
    by: 'dsh-backup',
    reason: '正在备份',
  });
});

test('runRestartHook: 处理器抛错 → 取消（fail-closed）且带原因', async () => {
  const ctx = { serial: () => { throw new Error('boom'); } };
  const cancel = await runRestartHook(ctx, BEFORE_RESUME_HOOK, {});
  assert.equal(cancel?.cancelled, true);
  assert.equal(cancel?.error, true);
  assert.match(cancel?.reason ?? '', /before-resume hook error: boom/);
});

test('runRestartHook: 处理器超时 → 取消（timeout 标记，不永久挂住重启）', async () => {
  const ctx = { serial: () => new Promise(() => { /* 永不 resolve */ }) };
  const started = Date.now();
  const cancel = await runRestartHook(ctx, BEFORE_RESTART_HOOK, {}, { timeoutMs: 30 });
  assert.equal(cancel?.cancelled, true);
  assert.equal(cancel?.timeout, true);
  assert.match(cancel?.reason ?? '', /before-restart hook timeout after 30ms/);
  assert.ok(Date.now() - started >= 25);
});

test('runRestartHook: timeoutMs 非法 → 回退默认上限（不因配置脏值变成 0ms 立即取消）', async () => {
  const ctx = { serial: () => undefined };
  assert.equal(await runRestartHook(ctx, BEFORE_RESTART_HOOK, {}, { timeoutMs: Number.NaN }), null);
  assert.equal(await runRestartHook(ctx, BEFORE_RESTART_HOOK, {}, { timeoutMs: -1 }), null);
  assert.equal(DEFAULT_HOOK_TIMEOUT_MS, 10_000);
});
