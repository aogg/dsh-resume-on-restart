import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotice, detectRestart, humanizeDowntime } from './detect.js';

test('detectRestart: no marker → not a restart', () => {
  assert.deepEqual(detectRestart(null, 1000, 42), { wasRestart: false, downtimeMs: 0 });
});

test('detectRestart: same pid → not a restart', () => {
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
