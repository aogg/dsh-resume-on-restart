import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotice,
  collectRestoreCandidateIds,
  computeProcessStartAtMs,
  createNoticeMessage,
  detectRestart,
  filterExcludedCandidates,
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

// —— 0.4.0 补充：恢复候选按「停止时仍运行中」过滤（恢复与顶栏开关显示同一口径） ——

test('pickRestoreTargets: running 过滤 → running:false 被滤掉，true/缺失按候选，输出形状仍 {id, at}', () => {
  const marker = {
    recentSessions: [
      { id: 'done', at: 900, running: false }, // 停止时已正常结束：不恢复
      { id: 'live', at: 800, running: true },  // 停止时仍运行：候选
      { id: 'legacy', at: 700 },               // 旧格式无 running：按候选（兼容旧 marker）
    ],
  };
  assert.deepEqual(pickRestoreTargets(marker, 10), [
    { id: 'live', at: 800 },
    { id: 'legacy', at: 700 },
  ]);
});

test('pickRestoreTargets: running 过滤先于排序/截断 → newest 的 running:false 不占 max 名额', () => {
  const marker = {
    recentSessions: [
      { id: 'done-newest', at: 300, running: false },
      { id: 'b', at: 200, running: true },
      { id: 'c', at: 100, running: true },
    ],
  };
  assert.deepEqual(pickRestoreTargets(marker, 1), [{ id: 'b', at: 200 }]);
});

test('pickRestoreTargets: recentSessions 全部 running:false（正常结束）→ 不恢复，也不经旧字段回退混回候选', () => {
  const marker = {
    recentSessions: [{ id: 'done', at: 900, running: false }],
    lastSessionId: 'done',
    lastActiveAt: '2026-10-08T07:00:00.000Z',
  };
  assert.deepEqual(pickRestoreTargets(marker, 10), []);
});

test('pickRestoreTargets: recentSessions 缺失/无有效条目 → legacy lastSessionId 仍出候选（running 视为 true）', () => {
  const iso = '2026-10-08T07:00:00.000Z';
  assert.deepEqual(
    pickRestoreTargets({ recentSessions: [null, 42, { at: 1 }], lastSessionId: 'legacy-id', lastActiveAt: iso }, 5),
    [{ id: 'legacy-id', at: Date.parse(iso) }],
  );
});

test('collectRestoreCandidateIds: running !== false 视为候选（缺失按 true），非法条目忽略', () => {
  const ids = collectRestoreCandidateIds([
    { id: 'live', at: 3, running: true },
    { id: 'done', at: 2, running: false },
    { id: 'legacy', at: 1 }, // 缺 running：按候选
    null,                    // 非法条目：忽略
    { at: 9 },               // 缺 id：忽略
    { id: '' },              // 空 id：忽略
    { id: 42 },              // id 非字符串：忽略
  ]);
  assert.ok(ids instanceof Set);
  assert.deepEqual([...ids], ['live', 'legacy']);
});

test('collectRestoreCandidateIds: 非数组输入 → 空 Set；同 id 只计一次', () => {
  assert.deepEqual([...collectRestoreCandidateIds(null)], []);
  assert.deepEqual([...collectRestoreCandidateIds(undefined)], []);
  assert.deepEqual([...collectRestoreCandidateIds('nope')], []);
  assert.deepEqual([...collectRestoreCandidateIds([])], []);
  const dup = collectRestoreCandidateIds([{ id: 'a', running: true }, { id: 'a' }]);
  assert.deepEqual([...dup], ['a']);
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

// —— createNoticeMessage（0.3.1 新增，fix 751b46d）：通知消息 source 必须通过 DSH 会话格式 v4 准入 ——

/**
 * 复刻 @deepseek-ai/dsh-session-format-v3-to-v4 的 source() 校验逻辑（防回退谓词）。
 *
 * v4 源码（dsh-session-format-v3-to-v4/lib/index.js）：
 *   function source(message) {
 *     const value = message["source"];
 *     if (!isSessionFormatJsonObject(value)
 *       || typeof value["kind"] !== "string"
 *       || value["kind"].length === 0
 *       || value["kind"] === "plugin") throw new SessionFormatError("format v4 message requires a producer-owned source kind");
 *   }
 * 即 message.source 必须是普通对象，且 source.kind 为非空字符串且 !== 'plugin'。
 * 注意：已废弃 v3 写法 `{ kind: 'plugin', plugin: ... }` 会因 kind === 'plugin' 被拒绝，
 * 这正是 751b46d 修复的回退点——一旦回归，会话采纳消息时抛 SessionFormatError，通知投递失败。
 * @param {{source?: unknown}} message 待校验的消息对象
 * @returns {boolean} true 表示该消息的 source 可被 v4 会话采纳
 */
function passesV4SourceAdmission(message) {
  const source = message?.source;
  return (
    source !== null
    && typeof source === 'object'
    && !Array.isArray(source) // 普通对象（非 null、非数组）
    && typeof source.kind === 'string'
    && source.kind.length > 0
    && source.kind !== 'plugin'
  );
}

test('createNoticeMessage: source 通过 DSH v4 准入判定（防回退到已废弃 v3 plugin 写法）', () => {
  const msg = createNoticeMessage({ text: 'hello', bootAt: '2026-10-12T00:00:00.000Z' });
  assert.ok(passesV4SourceAdmission(msg), 'source 必须满足 v4 准入：普通对象 + 非空字符串 kind 且 !== plugin');
  // 防回退对照：旧 v3 写法在本谓词下必须不通过（kind 为保留字 'plugin' 即被拒）
  assert.ok(!passesV4SourceAdmission({ source: { kind: 'plugin', plugin: 'resume-on-restart' } }));
  assert.equal(msg.source.kind, 'dsh-resume-on-restart');
});

test('createNoticeMessage: source.summary 含传入的 bootAt；source.form 为 notice', () => {
  const bootAt = '2026-08-28T00:00:05.000Z';
  const msg = createNoticeMessage({ text: 'hello', bootAt });
  assert.equal(typeof msg.source.summary, 'string');
  assert.ok(msg.source.summary.length > 0);
  assert.ok(msg.source.summary.includes(bootAt), 'summary 应包含本次启动时间');
  assert.equal(msg.source.form, 'notice');
});

test('createNoticeMessage: role 为 user；content 为单元素 text 块且 text 原样透传', () => {
  const text = '[resume-on-restart] 检测到 DSH 服务已重启。\n第二行，含换行与中文。';
  const msg = createNoticeMessage({ text, bootAt: '2026-08-28T00:00:05.000Z' });
  assert.equal(msg.role, 'user');
  assert.ok(Array.isArray(msg.content));
  assert.equal(msg.content.length, 1);
  assert.deepEqual(msg.content, [{ type: 'text', text }]);
  assert.equal(msg.content[0].text, text); // 原样透传，不改写
});

test('createNoticeMessage: id 是合法 v4 UUID 形状；两次调用 id 不同', () => {
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const first = createNoticeMessage({ text: 'a', bootAt: '2026-08-28T00:00:05.000Z' });
  const second = createNoticeMessage({ text: 'a', bootAt: '2026-08-28T00:00:05.000Z' });
  assert.match(first.id, UUID_V4_RE);
  assert.notEqual(first.id, second.id, '每次调用应生成新的唯一 id');
});

// —— filterExcludedCandidates（0.4.0 新增）：恢复候选按用户排除集合过滤 ——

test('filterExcludedCandidates: 命中排除集合的候选进 excluded，其余按原顺序进 kept', () => {
  const candidates = [
    { id: 'excluded-one', at: 300 },
    { id: 'kept-one', at: 200 },
    { id: 'excluded-two', at: 100 },
    { id: 'kept-two', at: 0 },
  ];
  const map = { 'excluded-one': '2026-10-12T00:00:00.000Z', 'excluded-two': '2026-10-12T01:00:00.000Z' };
  assert.deepEqual(filterExcludedCandidates(candidates, map), {
    kept: [{ id: 'kept-one', at: 200 }, { id: 'kept-two', at: 0 }],
    excluded: [{ id: 'excluded-one', at: 300 }, { id: 'excluded-two', at: 100 }],
  });
});

test('filterExcludedCandidates: 值非字符串 / 非自身属性 → 不算排除', () => {
  const candidates = [{ id: 'a', at: 1 }, { id: 'b', at: 2 }];
  // 值非字符串（脏数据）：不算命中
  assert.deepEqual(filterExcludedCandidates(candidates, { a: 42 }), {
    kept: candidates,
    excluded: [],
  });
  // inherited 属性不算命中（own property 才算）
  const inherited = Object.create({ a: '2026-10-12T00:00:00.000Z' });
  assert.deepEqual(filterExcludedCandidates(candidates, inherited), {
    kept: candidates,
    excluded: [],
  });
});

test('filterExcludedCandidates: 空排除集合 → 全部保留、excluded 为空', () => {
  const candidates = [{ id: 'a', at: 1 }];
  assert.deepEqual(filterExcludedCandidates(candidates, {}), { kept: candidates, excluded: [] });
});

test('filterExcludedCandidates: 非法输入不抛错 → candidates 非数组返回 kept=[]；map 非对象视为空', () => {
  assert.deepEqual(filterExcludedCandidates(null, { a: 'x' }), { kept: [], excluded: [] });
  assert.deepEqual(filterExcludedCandidates(undefined, { a: 'x' }), { kept: [], excluded: [] });
  assert.deepEqual(filterExcludedCandidates('nope', { a: 'x' }), { kept: [], excluded: [] });
  const candidates = [{ id: 'a', at: 1 }];
  assert.deepEqual(filterExcludedCandidates(candidates, null), { kept: candidates, excluded: [] });
  assert.deepEqual(filterExcludedCandidates(candidates, undefined), { kept: candidates, excluded: [] });
  // 数组不是合法的排除集合形状，视为空
  assert.deepEqual(filterExcludedCandidates(candidates, ['a']), { kept: candidates, excluded: [] });
});

test('filterExcludedCandidates: 全部被排除 → kept 为空（宿主据此直接回退通知主会话）', () => {
  const candidates = [{ id: 'only', at: 9 }];
  assert.deepEqual(filterExcludedCandidates(candidates, { only: '2026-10-12T00:00:00.000Z' }), {
    kept: [],
    excluded: [{ id: 'only', at: 9 }],
  });
});
