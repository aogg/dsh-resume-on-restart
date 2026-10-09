import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotice, computeProcessStartAtMs, detectRestart, humanizeDowntime } from './detect.js';

test('detectRestart: no marker → not a restart', () => {
  assert.deepEqual(detectRestart(null, 1000, 42), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: same pid → not a restart', () => {
  // 新语义下：3 参调用（startAtMs 缺省）且 pid 相同 → 启动时间不可用，走保守分支判非重启。
  const marker = { lastBootAt: '2026-08-28T00:00:00.000Z', pid: 42 };
  assert.deepEqual(detectRestart(marker, 1000, 42), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: different pid → restart with downtime', () => {
  const marker = { lastBootAt: '2026-08-28T00:00:00.000Z', pid: 42 };
  const now = Date.parse('2026-08-28T00:00:05.000Z');
  assert.deepEqual(detectRestart(marker, now, 99), { wasRestart: true, downtimeMs: 5000 });
});

test('detectRestart: corrupt marker (missing pid) → not a restart', () => {
  assert.deepEqual(detectRestart({ lastBootAt: 'x' }, 1000, 1), { wasRestart: false, downtimeMs: 0 });
});

// —— 容器 PID 1 场景：pid 相同时改为对比进程启动时间（±2000ms 双向容差） ——

test('detectRestart: PID 1, startAtMs later than marker.startAt by >2000ms → restart, downtime from lastBootAt', () => {
  const marker = {
    lastBootAt: '2026-10-08T07:00:00.000Z',
    pid: 1,
    startAt: Date.parse('2026-10-08T06:59:50.000Z'),
  };
  const nowMs = Date.parse('2026-10-08T07:00:05.000Z');
  const startAtMs = Date.parse('2026-10-08T07:00:03.000Z'); // 比 marker.startAt 晚 13s
  // downtime 从 lastBootAt 算（5000ms），而不是从 startAt 偏差（13000ms）算
  assert.deepEqual(detectRestart(marker, nowMs, 1, startAtMs), { wasRestart: true, downtimeMs: 5000 });
});

test('detectRestart: PID 1, startAtMs earlier than marker.startAt by >2000ms (clock rollback) → restart', () => {
  const marker = { lastBootAt: '2026-10-08T07:00:00.000Z', pid: 1, startAt: Date.parse('2026-10-08T07:00:00.000Z') };
  const nowMs = Date.parse('2026-10-08T07:00:02.000Z');
  const startAtMs = Date.parse('2026-10-08T06:59:55.000Z'); // 时钟回拨：比 marker.startAt 早 5s
  assert.deepEqual(detectRestart(marker, nowMs, 1, startAtMs), { wasRestart: true, downtimeMs: 2000 });
});

test('detectRestart: PID 1, |skew| exactly 2000ms → not restart; 2001ms → restart (both directions)', () => {
  const base = Date.parse('2026-10-08T07:00:00.000Z');
  const marker = { lastBootAt: '2026-10-08T07:00:00.000Z', pid: 1, startAt: base };
  const nowMs = base + 4000;
  assert.deepEqual(detectRestart(marker, nowMs, 1, base + 2000), { wasRestart: false, downtimeMs: 0 });
  assert.deepEqual(detectRestart(marker, nowMs, 1, base + 2001), { wasRestart: true, downtimeMs: 4000 });
  assert.deepEqual(detectRestart(marker, nowMs, 1, base - 2000), { wasRestart: false, downtimeMs: 0 });
  assert.deepEqual(detectRestart(marker, nowMs, 1, base - 2001), { wasRestart: true, downtimeMs: 4000 });
});

test('detectRestart: PID 1, skew within tolerance (500ms) → not restart, downtimeMs 0 even after a long gap', () => {
  const base = Date.parse('2026-10-08T07:00:00.000Z');
  const marker = { lastBootAt: '2026-10-08T07:00:00.000Z', pid: 1, startAt: base };
  const nowMs = base + 30_000; // 距 lastBootAt 已 30s，但进程未换
  assert.deepEqual(detectRestart(marker, nowMs, 1, base + 500), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: legacy marker (no startAt) + PID 1 + startAtMs far after lastBootAt → restart (container upgrade)', () => {
  const marker = { lastBootAt: '2026-10-08T07:09:54.778Z', pid: 1 }; // v0.1.0 遗留格式，无 startAt
  const nowMs = Date.parse('2026-10-08T07:10:30.000Z');
  const startAtMs = Date.parse('2026-10-08T07:10:20.000Z'); // markerStart 回退用 lastBootAt，偏差远超容差
  assert.deepEqual(detectRestart(marker, nowMs, 1, startAtMs), { wasRestart: true, downtimeMs: 35_222 });
});

test('detectRestart: legacy marker (no startAt) + PID 1 + startAtMs close to lastBootAt → not restart', () => {
  const marker = { lastBootAt: '2026-10-08T07:09:54.778Z', pid: 1 };
  const prev = Date.parse(marker.lastBootAt);
  assert.deepEqual(detectRestart(marker, prev + 800, 1, prev + 500), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: PID 1 + startAtMs unavailable (undefined/NaN) → conservative not restart', () => {
  const marker = { lastBootAt: '2026-10-08T07:00:00.000Z', pid: 1, startAt: Date.parse('2026-10-08T07:00:00.000Z') };
  const nowMs = Date.parse('2026-10-08T07:05:00.000Z');
  assert.deepEqual(detectRestart(marker, nowMs, 1), { wasRestart: false, downtimeMs: 0 }); // undefined
  assert.deepEqual(detectRestart(marker, nowMs, 1, NaN), { wasRestart: false, downtimeMs: 0 }); // NaN
});

test('computeProcessStartAtMs: uptime 0 → equals nowMs; fractional uptime → rounded integer epoch ms', () => {
  assert.equal(computeProcessStartAtMs(1_000_000, 0), 1_000_000);
  assert.equal(computeProcessStartAtMs(1_000_000, 1.5), 998_500);
  assert.ok(Number.isInteger(computeProcessStartAtMs(1_000_000, 0)));
  assert.ok(Number.isInteger(computeProcessStartAtMs(1_000_000, 1.5)));
  assert.ok(Number.isInteger(computeProcessStartAtMs(1_000_000, 1.2345)));
});

test('detectRestart: different pid → restart even when startAtMs equals marker.startAt (branch order)', () => {
  const base = Date.parse('2026-10-08T07:00:00.000Z');
  const marker = { lastBootAt: '2026-10-08T07:00:00.000Z', pid: 1, startAt: base };
  const nowMs = base + 7000;
  assert.deepEqual(detectRestart(marker, nowMs, 2, base), { wasRestart: true, downtimeMs: 7000 });
});

test('buildNotice: includes restart, downtime and session info', () => {
  const text = buildNotice({
    bootAt: '2026-08-28T00:00:05.000Z',
    prevBootAt: '2026-08-28T00:00:00.000Z',
    downtimeMs: 5000,
    lastSessionId: 'session-abc',
    lastActiveAt: '2026-08-28T00:00:00.000Z',
  });
  assert.ok(text.includes('检测到 DSH 服务已重启'));
  assert.ok(text.includes('中断约 5 秒'));
  assert.ok(text.includes('session-abc'));
  assert.ok(text.includes('自主决定下一步'));
});

test('buildNotice: no downtime or session → omits those lines', () => {
  const text = buildNotice({ bootAt: '2026-08-28T00:00:00.000Z', prevBootAt: null, downtimeMs: 0 });
  assert.ok(!text.includes('中断约'));
  assert.ok(!text.includes('最近活跃的会话'));
});

test('humanizeDowntime: formats seconds, minutes and hours', () => {
  assert.equal(humanizeDowntime(5000), '5 秒');
  assert.equal(humanizeDowntime(65000), '1 分 5 秒');
  assert.equal(humanizeDowntime(3900000), '1 小时 5 分');
});
