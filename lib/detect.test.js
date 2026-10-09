import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotice,
  computeProcessStartAtMs,
  detectRestart,
  humanizeDowntime,
  pickRestoreTargets,
} from './detect.js';

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

// —— pickRestoreTargets（0.3.0 新增）：重启后恢复候选的挑选 ——

test('pickRestoreTargets: max 非正/非有限 或 marker 非对象 → []', () => {
  const marker = { recentSessions: [{ id: 'a', at: 100 }] };
  assert.deepEqual(pickRestoreTargets(marker, 0), []);
  assert.deepEqual(pickRestoreTargets(marker, -1), []);
  assert.deepEqual(pickRestoreTargets(marker, NaN), []);
  assert.deepEqual(pickRestoreTargets(marker, Infinity), []);
  assert.deepEqual(pickRestoreTargets(null, 3), []);
  assert.deepEqual(pickRestoreTargets(undefined, 3), []);
  assert.deepEqual(pickRestoreTargets('not-an-object', 3), []);
});

test('pickRestoreTargets: recentSessions 混合条目 → 过滤非法条目并归一化 at', () => {
  const isoMs = Date.parse('2026-10-08T07:00:00.000Z');
  const marker = {
    recentSessions: [
      { id: 'sess-num', at: 1700000000000 },              // number at：有限则直接用
      { id: 'sess-iso', at: '2026-10-08T07:00:00.000Z' }, // string at：Date.parse
      { id: 'sess-noat' },                                 // 无 at → 0
      'plain-session-id',                                  // 纯字符串条目 → {id, at: 0}
      { id: 'sess-nan', at: NaN },                         // number at 非有限 → 0
      { id: 'sess-inf', at: Infinity },                    // number at 非有限 → 0
      null,                                                // 非法条目：忽略
      42,                                                  // 非法条目：忽略
      { at: 123 },                                         // 缺 id：忽略
      { id: '', at: 999 },                                 // 空 id：忽略
      { id: 123 },                                         // id 非字符串：忽略
    ],
  };
  assert.deepEqual(pickRestoreTargets(marker, 10), [
    { id: 'sess-iso', at: isoMs },
    { id: 'sess-num', at: 1700000000000 },
    { id: 'sess-noat', at: 0 },
    { id: 'plain-session-id', at: 0 },
    { id: 'sess-nan', at: 0 },
    { id: 'sess-inf', at: 0 },
  ]);
});

test('pickRestoreTargets: 同 id 去重 → 保留首次出现的条目（含其 at）', () => {
  // 后一条重复条目即使 at 更大也忽略
  const marker = { recentSessions: [{ id: 'dup', at: 100 }, { id: 'dup', at: 9999 }] };
  assert.deepEqual(pickRestoreTargets(marker, 10), [{ id: 'dup', at: 100 }]);
  // 纯字符串条目与对象条目同 id 同样去重
  const mixed = { recentSessions: ['dup', { id: 'dup', at: 5 }] };
  assert.deepEqual(pickRestoreTargets(mixed, 10), [{ id: 'dup', at: 0 }]);
});

test('pickRestoreTargets: 输出按 at 降序；相同 at 保持输入相对顺序（稳定）', () => {
  const marker = {
    recentSessions: [{ id: 'old', at: 100 }, { id: 'newest', at: 300 }, { id: 'mid', at: 200 }],
  };
  assert.deepEqual(pickRestoreTargets(marker, 10), [
    { id: 'newest', at: 300 },
    { id: 'mid', at: 200 },
    { id: 'old', at: 100 },
  ]);
  // at 相同（都未知为 0）时保持输入相对顺序
  const tied = { recentSessions: [{ id: 'first-tie' }, { id: 'second-tie' }] };
  assert.deepEqual(pickRestoreTargets(tied, 10), [
    { id: 'first-tie', at: 0 },
    { id: 'second-tie', at: 0 },
  ]);
});

test('pickRestoreTargets: max 截断，floor 语义（2.9 → 2 条）', () => {
  const marker = { recentSessions: [{ id: 'a', at: 3 }, { id: 'b', at: 2 }, { id: 'c', at: 1 }] };
  assert.deepEqual(pickRestoreTargets(marker, 2), [{ id: 'a', at: 3 }, { id: 'b', at: 2 }]);
  assert.deepEqual(pickRestoreTargets(marker, 2.9), [{ id: 'a', at: 3 }, { id: 'b', at: 2 }]);
  assert.deepEqual(pickRestoreTargets(marker, 1), [{ id: 'a', at: 3 }]);
  assert.deepEqual(pickRestoreTargets(marker, 100), [
    { id: 'a', at: 3 },
    { id: 'b', at: 2 },
    { id: 'c', at: 1 },
  ]);
});

test('pickRestoreTargets: recentSessions 产出候选时不与旧字段混用', () => {
  const marker = {
    recentSessions: ['recent-only'],
    lastSessionId: 'legacy-id',
    lastActiveAt: '2026-10-08T07:00:00.000Z',
  };
  assert.deepEqual(pickRestoreTargets(marker, 10), [{ id: 'recent-only', at: 0 }]);
});

test('pickRestoreTargets: 旧字段回退 → lastSessionId + lastActiveAt(ISO) 单候选', () => {
  const iso = '2026-10-08T07:00:00.000Z';
  assert.deepEqual(
    pickRestoreTargets({ lastSessionId: 'legacy-id', lastActiveAt: iso }, 5),
    [{ id: 'legacy-id', at: Date.parse(iso) }],
  );
});

test('pickRestoreTargets: 旧字段回退 → lastActiveAt 非法则 at=0；lastSessionId 空 → []', () => {
  assert.deepEqual(
    pickRestoreTargets({ lastSessionId: 'legacy-id', lastActiveAt: 'not-a-date' }, 5),
    [{ id: 'legacy-id', at: 0 }],
  );
  assert.deepEqual(pickRestoreTargets({ lastSessionId: '' }, 5), []);
  // recentSessions 为空数组时同样回退旧字段
  assert.deepEqual(
    pickRestoreTargets({ recentSessions: [], lastSessionId: 'legacy-id', lastActiveAt: 123 }, 5),
    [{ id: 'legacy-id', at: 123 }],
  );
});

// —— buildNotice（0.3.0 新增可选参数）：自动恢复提示行 ——

test('buildNotice: 传 restoredSessionId + restoredActiveAt → 追加含括号时间的恢复行', () => {
  const text = buildNotice({
    bootAt: '2026-08-28T00:00:05.000Z',
    prevBootAt: '2026-08-28T00:00:00.000Z',
    downtimeMs: 5000,
    lastSessionId: 'session-abc',
    lastActiveAt: '2026-08-28T00:00:00.000Z',
    restoredSessionId: 'session-abc',
    restoredActiveAt: '2026-08-28T00:00:00.000Z',
  });
  const lines = text.split('\n');
  const restoredLine = '已自动恢复重启前活跃的会话 session-abc（最后活跃于 2026-08-28T00:00:00.000Z）。';
  assert.ok(lines.includes(restoredLine));
  // 恢复行位于"最近会话"信息行之后、结尾提示之前
  const sessionIdx = lines.findIndex((line) => line.startsWith('重启前最近活跃的会话'));
  assert.ok(sessionIdx !== -1);
  assert.ok(lines.indexOf(restoredLine) > sessionIdx);
  assert.equal(lines[lines.length - 1], '如需继续之前的工作，或启动新任务，请自主决定下一步。');
});

test('buildNotice: 只传 restoredSessionId → 恢复行无括号部分', () => {
  const text = buildNotice({ bootAt: '2026-08-28T00:00:05.000Z', restoredSessionId: 'session-abc' });
  assert.ok(text.split('\n').includes('已自动恢复重启前活跃的会话 session-abc。'));
  assert.ok(!text.includes('会话 session-abc（'));
});

test('buildNotice: 不传 restored 参数 → 输出不含恢复行（与 0.2.0 逐字一致）', () => {
  const text = buildNotice({ bootAt: '2026-08-28T00:00:05.000Z' });
  assert.equal(
    text,
    '[resume-on-restart] 检测到 DSH 服务已重启。\n'
    + '本次于 2026-08-28T00:00:05.000Z 启动。\n'
    + '如需继续之前的工作，或启动新任务，请自主决定下一步。',
  );
});
