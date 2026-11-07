/**
 * 0.19.0「主动注册重启恢复（proactive-restore）」的纯函数单元测试
 * （node --test，无 e2e、不起任何服务）。
 *
 * 直接 import lib/proactive-restore.js 断言（范式照抄 lib/pause-all.test.js）：
 * 1. normalizeProactiveRestore：任意解析结果 → 归一化记录（脏条目丢弃）；
 * 2. readProactiveRestore：缺失/损坏文件 → {}（真实临时文件）；
 * 3. writeProactiveRestore：写盘 + 读回一致（真实临时文件）；失败不抛错；
 * 4. capProactiveRestore：超上限丢最旧（at 升序剔除）；非法 max 不裁剪；
 * 5. mergeProactiveCandidatePool：/restart/info 候选池 = 自动 ∪ 主动注册
 *    （去重主动注册优先 / 主动注册命中排除丢弃 / at·source 保留）；
 * 6. mergeProactiveRestoreCandidates：恢复候选池三列表合并
 *    （picked > paused > proactive 去重 / at 降序 / restoreMax 截断但主动注册豁免 /
 *      脏输入防御 / 不改入参）；
 * 7. pendingRestartRegistrations（0.30.0）：只留「登记时间 at 晚于最近一次 boot
 *    （lastBootAt）」的登记、按 at 倒序；无 boot 时刻/at 不可解析按保留；activate
 *    仅 false 携带（tab1「已登记重启恢复（未重启）」列表口径）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capProactiveRestore,
  mergeProactiveCandidatePool,
  mergeProactiveRestoreCandidates,
  normalizeProactiveRestore,
  pendingRestartRegistrations,
  readProactiveRestore,
  writeProactiveRestore,
} from './proactive-restore.js';

// ---- normalizeProactiveRestore：任意解析结果 → 归一化记录 ----

test('normalizeProactiveRestore: 正常记录只保留 id+at，title 拿到才带', () => {
  const raw = {
    a: { at: '2026-01-01T00:00:00.000Z', title: '会话 A' },
    b: { at: '2026-01-02T00:00:00.000Z' },
  };
  assert.deepEqual(normalizeProactiveRestore(raw), {
    a: { at: '2026-01-01T00:00:00.000Z', title: '会话 A' },
    b: { at: '2026-01-02T00:00:00.000Z' },
  });
});

test('normalizeProactiveRestore: 脏条目丢弃——非对象/空 id/缺 at/非字符串 title/空串 title', () => {
  const raw = {
    ok: { at: '2026-01-01T00:00:00.000Z', title: 'ok' },
    '': { at: '2026-01-01T00:00:00.000Z' }, // 空 id
    noAt: { title: '无 at' }, // 缺 at
    nullEntry: null, // 非对象
    arrEntry: [1, 2], // 数组条目
    badAt: { at: 42 }, // at 非字符串
    emptyAt: { at: '' }, // at 空串
    emptyTitle: { at: '2026-01-01T00:00:00.000Z', title: '' }, // title 空串 → 不带
    numTitle: { at: '2026-01-01T00:00:00.000Z', title: 42 }, // title 非字符串 → 不带
  };
  assert.deepEqual(normalizeProactiveRestore(raw), {
    ok: { at: '2026-01-01T00:00:00.000Z', title: 'ok' },
    emptyTitle: { at: '2026-01-01T00:00:00.000Z' },
    numTitle: { at: '2026-01-01T00:00:00.000Z' },
  });
});

test('normalizeProactiveRestore: 非对象/数组/空值输入 → {}', () => {
  assert.deepEqual(normalizeProactiveRestore(null), {});
  assert.deepEqual(normalizeProactiveRestore(undefined), {});
  assert.deepEqual(normalizeProactiveRestore(42), {});
  assert.deepEqual(normalizeProactiveRestore('nope'), {});
  assert.deepEqual(normalizeProactiveRestore([]), {});
  assert.deepEqual(normalizeProactiveRestore([{ at: '2026-01-01T00:00:00.000Z' }]), {});
});

// ---- readProactiveRestore / writeProactiveRestore：真实临时文件 ----

test('readProactiveRestore: 缺失/损坏文件 → {}（绝不抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-proactive-'));
  try {
    const missing = join(dir, 'missing.json');
    assert.deepEqual(readProactiveRestore(missing), {});
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not json ', 'utf8');
    assert.deepEqual(readProactiveRestore(corrupt), {});
    const wrongShape = join(dir, 'wrong.json');
    writeFileSync(wrongShape, JSON.stringify({ sessions: { a: '2026-01-01T00:00:00.000Z' } }), 'utf8');
    // 旧版 sessions 包装形状不识别 → 按空（本文件格式是无包装的 { [id]: { at } }）
    assert.deepEqual(readProactiveRestore(wrongShape), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeProactiveRestore: 写盘后读回一致；脏条目归一化写回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-proactive-'));
  try {
    const file = join(dir, 'proactive-restore.json');
    const data = {
      a: { at: '2026-01-01T00:00:00.000Z', title: '会话 A' },
      bad: { title: '缺 at' },
    };
    const ok = writeProactiveRestore(file, data);
    assert.equal(ok, true);
    // 读回：脏条目被归一化丢弃
    assert.deepEqual(readProactiveRestore(file), { a: { at: '2026-01-01T00:00:00.000Z', title: '会话 A' } });
    // 文件确为带换行缩进的 JSON
    const text = readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.equal(text.startsWith('{'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeProactiveRestore: 写失败不抛错返回 false（路径是已存在的文件），只降级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-proactive-'));
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    // blocker 是文件、其下还要创建子路径 → mkdirSync 失败
    const badFile = join(blocker, 'sub', 'proactive-restore.json');
    assert.equal(writeProactiveRestore(badFile, { a: { at: '2026-01-01T00:00:00.000Z' } }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- capProactiveRestore：超上限丢最旧（按 at 升序剔除） ----

test('capProactiveRestore: 超出 max 丢最旧（at 最小先丢），返回新对象不改入参', () => {
  const data = {
    old: { at: '2026-01-01T00:00:00.000Z' },
    mid: { at: '2026-01-02T00:00:00.000Z' },
    new: { at: '2026-01-03T00:00:00.000Z' },
  };
  const before = { ...data };
  const capped = capProactiveRestore(data, 2);
  assert.deepEqual(capped, {
    mid: { at: '2026-01-02T00:00:00.000Z' },
    new: { at: '2026-01-03T00:00:00.000Z' },
  });
  // 入参未被改动
  assert.deepEqual(data, before);
});

test('capProactiveRestore: at 无法解析按 0（最早先丢）；不超过上限原样返回', () => {
  const data = {
    unparsable: { at: 'not-a-date' }, // at=0 → 最早
    later: { at: '2026-01-02T00:00:00.000Z' },
    earlier: { at: '2026-01-01T00:00:00.000Z' },
  };
  const capped = capProactiveRestore(data, 2);
  assert.deepEqual(capped, {
    later: { at: '2026-01-02T00:00:00.000Z' },
    earlier: { at: '2026-01-01T00:00:00.000Z' },
  });
  // 不超过上限 → 原样（新对象）返回
  const small = capProactiveRestore(data, 10);
  assert.deepEqual(small, data);
  assert.notEqual(small, data);
});

test('capProactiveRestore: max 非正/非法不裁剪；空/非对象输入 → {}', () => {
  const data = { a: { at: '2026-01-01T00:00:00.000Z' } };
  assert.deepEqual(capProactiveRestore(data, 0), data);
  assert.deepEqual(capProactiveRestore(data, -1), data);
  assert.deepEqual(capProactiveRestore(data, NaN), data);
  assert.deepEqual(capProactiveRestore(data, Infinity), data);
  assert.deepEqual(capProactiveRestore(null, 1), {});
  assert.deepEqual(capProactiveRestore([], 1), {});
});

// ---- mergeProactiveCandidatePool：/restart/info 候选池（自动 ∪ 主动注册） ----

test('mergeProactiveCandidatePool: 主动注册优先去重，同 id 保留主动注册的 at/source', () => {
  const auto = [
    { id: 'a', at: 111 },
    { id: 'b', at: 222 },
  ];
  const proactive = [
    { id: 'b', at: 999 }, // 同 id：主动注册优先，at=注册时间
    { id: 'c', at: 333 },
  ];
  assert.deepEqual(mergeProactiveCandidatePool(auto, proactive, {}), [
    { id: 'a', at: 111, source: 'auto' },
    { id: 'b', at: 999, source: 'skill' },
    { id: 'c', at: 333, source: 'skill' },
  ]);
});

test('mergeProactiveCandidatePool: 主动注册命中用户排除 → 丢弃主动注册身份；自动候选维持现状', () => {
  const auto = [
    { id: 'a', at: 111 },
    { id: 'b', at: 222 }, // 自动候选在排除里 → 维持现状（保留，客户端显示为已取消）
  ];
  const proactive = [
    { id: 'a', at: 999 }, // 主动注册 + 排除 → 丢弃主动注册身份（a 仍以自动候选出现）
    { id: 'c', at: 333 },
  ];
  const excluded = { a: '2026-01-01T00:00:00.000Z', b: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(mergeProactiveCandidatePool(auto, proactive, excluded), [
    { id: 'a', at: 111, source: 'auto' },
    { id: 'b', at: 222, source: 'auto' },
    { id: 'c', at: 333, source: 'skill' },
  ]);
});

test('mergeProactiveCandidatePool: 排除集合支持数组与 Record；脏输入防御不抛错', () => {
  const auto = [{ id: 'a', at: 111 }];
  const proactive = [{ id: 'b', at: 222 }];
  // 数组形式排除
  assert.deepEqual(mergeProactiveCandidatePool(auto, proactive, ['b']), [
    { id: 'a', at: 111, source: 'auto' },
  ]);
  // 非数组/空/脏 → 不排除
  assert.deepEqual(mergeProactiveCandidatePool(auto, proactive, null), [
    { id: 'a', at: 111, source: 'auto' },
    { id: 'b', at: 222, source: 'skill' },
  ]);
  // 候选输入非数组/脏条目 → 归一化
  assert.deepEqual(mergeProactiveCandidatePool('nope', [null, { at: 1 }, { id: '', at: 1 }], {}), []);
  assert.deepEqual(mergeProactiveCandidatePool([{ id: 'a', at: -5 }, { id: 'b', at: 0 }], [], {}), [
    { id: 'a', at: 0, source: 'auto' },
    { id: 'b', at: 0, source: 'auto' },
  ]);
});

// ---- mergeProactiveRestoreCandidates：恢复候选池三列表合并 ----

test('mergeProactiveRestoreCandidates: picked > paused > proactive 去重，at 降序', () => {
  const picked = [{ id: 'a', at: 300, running: true }];
  const paused = [
    { id: 'b', at: 500, running: false },
    { id: 'a', at: 999, running: false }, // 同 id：picked 优先（at/running 不被覆盖）
  ];
  const proactive = [
    { id: 'c', at: 700, running: false },
    { id: 'b', at: 888, running: false }, // 同 id：paused 优先（用暂停集合 at）
    { id: 'a', at: 777, running: false }, // 同 id：picked 优先（proactive at 不生效）
  ];
  assert.deepEqual(mergeProactiveRestoreCandidates(picked, paused, proactive, 0), [
    { id: 'c', at: 700, running: false },
    { id: 'b', at: 500, running: false },
    { id: 'a', at: 300, running: true },
  ]);
});

test('mergeProactiveRestoreCandidates: 主动注册会话总是恢复——不受 restoreMax 截断', () => {
  const picked = [
    { id: 'auto1', at: 800, running: false },
    { id: 'auto2', at: 700, running: false },
  ];
  const paused = [];
  const proactive = [{ id: 'skill1', at: 1000, running: false }];
  // restoreMax=1：预算 1 只作用于自动候选（auto1 最新保住），skill1 主动注册豁免
  // （不占预算、绝不被截）——结果 [skill1, auto1]，auto2 被预算截掉
  assert.deepEqual(mergeProactiveRestoreCandidates(picked, paused, proactive, 1), [
    { id: 'skill1', at: 1000, running: false },
    { id: 'auto1', at: 800, running: false },
  ]);
  // restoreMax=2：预算 2 保住 auto1+auto2，主动注册追加——全部保留
  assert.deepEqual(mergeProactiveRestoreCandidates(picked, paused, proactive, 2), [
    { id: 'skill1', at: 1000, running: false },
    { id: 'auto1', at: 800, running: false },
    { id: 'auto2', at: 700, running: false },
  ]);
  // 全部主动注册 + restoreMax=1：主动注册条目全保留，无自动候选被截
  assert.deepEqual(
    mergeProactiveRestoreCandidates([], [], [
      { id: 's1', at: 1000, running: false },
      { id: 's2', at: 900, running: false },
    ], 1),
    [
      { id: 's1', at: 1000, running: false },
      { id: 's2', at: 900, running: false },
    ],
  );
});

test('mergeProactiveRestoreCandidates: 无主动注册时退化 mergePausedCandidates 口径', () => {
  const picked = [{ id: 'a', at: 300, running: true }];
  const paused = [{ id: 'b', at: 500, running: false }];
  assert.deepEqual(mergeProactiveRestoreCandidates(picked, paused, [], 0), [
    { id: 'b', at: 500, running: false },
    { id: 'a', at: 300, running: true },
  ]);
});

test('mergeProactiveRestoreCandidates: 脏输入防御不抛错、不改写入参、归一化输出', () => {
  const picked = [{ id: 'a', at: 300, running: true }];
  const proactive = [{ id: 'b', at: -1 }, { id: '', at: 5 }, null, { at: 7 }, { id: 'c', at: 100 }];
  const before = JSON.stringify([picked, proactive]);
  const merged = mergeProactiveRestoreCandidates(picked, [], proactive, 0);
  assert.deepEqual(merged, [
    { id: 'a', at: 300, running: true },
    { id: 'c', at: 100, running: false },
    { id: 'b', at: 0, running: false },
  ]);
  // 入参未改动
  assert.equal(JSON.stringify([picked, proactive]), before);
  // 全部非数组 → []
  assert.deepEqual(mergeProactiveRestoreCandidates('nope', 42, null, 0), []);
});

// ---- 0.23.0 注册但不激活：activate 仅 false 落盘（true/缺失一律不写，旧文件字节不变） ----

test('normalizeProactiveRestore: activate:false 保留；true/非布尔/缺失一律不落盘（旧格式兼容）', () => {
  assert.deepEqual(normalizeProactiveRestore({
    off: { at: '2026-01-01T00:00:00.000Z', activate: false },
    on: { at: '2026-01-02T00:00:00.000Z', activate: true },
    legacy: { at: '2026-01-03T00:00:00.000Z', title: '旧条目' },
    weird: { at: '2026-01-04T00:00:00.000Z', activate: 'no' }, // 非布尔 → 不带
    nulled: { at: '2026-01-05T00:00:00.000Z', activate: null },
  }), {
    off: { at: '2026-01-01T00:00:00.000Z', activate: false },
    on: { at: '2026-01-02T00:00:00.000Z' },
    legacy: { at: '2026-01-03T00:00:00.000Z', title: '旧条目' },
    weird: { at: '2026-01-04T00:00:00.000Z' },
    nulled: { at: '2026-01-05T00:00:00.000Z' },
  });
});

test('readProactiveRestore/writeProactiveRestore: activate:false 回环保留；true/缺失不写该字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-proactive-'));
  try {
    const file = join(dir, 'proactive-restore.json');
    const ok = writeProactiveRestore(file, {
      off: { at: '2026-01-01T00:00:00.000Z', activate: false, title: '不激活' },
      on: { at: '2026-01-02T00:00:00.000Z', activate: true },
    });
    assert.equal(ok, true);
    assert.deepEqual(readProactiveRestore(file), {
      off: { at: '2026-01-01T00:00:00.000Z', title: '不激活', activate: false },
      on: { at: '2026-01-02T00:00:00.000Z' },
    });
    // 落盘文本：仅 false 条目带 activate 字段（true/缺失不写，旧文件字节不变）
    const text = readFileSync(file, 'utf8');
    assert.equal((text.match(/"activate"/g) ?? []).length, 1);
    // 旧格式文件（0.19.0~0.22.0，无 activate）读回不带该字段
    const legacy = join(dir, 'legacy.json');
    writeFileSync(legacy, JSON.stringify({ a: { at: '2026-01-01T00:00:00.000Z' } }), 'utf8');
    assert.deepEqual(readProactiveRestore(legacy), { a: { at: '2026-01-01T00:00:00.000Z' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capProactiveRestore: 裁剪丢最旧不丢 activate 标记（保留条目 flag 原样）', () => {
  const data = {
    old: { at: '2026-01-01T00:00:00.000Z', activate: false }, // 最旧 → 被裁掉
    keep: { at: '2026-01-02T00:00:00.000Z', activate: false },
  };
  assert.deepEqual(capProactiveRestore(data, 1), {
    keep: { at: '2026-01-02T00:00:00.000Z', activate: false },
  });
  // 不超上限 → 归一化新对象同样保留 flag
  assert.deepEqual(capProactiveRestore(data, 10), data);
});

test('mergeProactiveCandidatePool: 输出行带 activate:false 仅限 false 条目（true/缺失不带）', () => {
  const proactive = [
    { id: 'off', at: 999, activate: false },
    { id: 'on', at: 888, activate: true },
    { id: 'legacy', at: 777 },
  ];
  assert.deepEqual(mergeProactiveCandidatePool([], proactive, {}), [
    { id: 'off', at: 999, source: 'skill', activate: false },
    { id: 'on', at: 888, source: 'skill' },
    { id: 'legacy', at: 777, source: 'skill' },
  ]);
  // 自动候选来源（source:'auto'）即使脏带 activate 也不该有语义——但按通用透传
  // 规则仍仅 false 才带（真实宿主只在主动注册条目上传 activate）
  assert.deepEqual(
    mergeProactiveCandidatePool([{ id: 'a', at: 1, activate: false }], [], {}),
    [{ id: 'a', at: 1, source: 'auto', activate: false }],
  );
});

// ---- pendingRestartRegistrations：at > lastBootAt 的「已登记、尚未重启」过滤 ----

test('pendingRestartRegistrations: 只留 at 晚于 lastBootAt 的登记，按 at 倒序', () => {
  const raw = {
    old: { at: '2026-11-06T04:00:00.000Z', title: '重启前登记的' },
    mid: { at: '2026-11-06T06:00:00.000Z' },
    newest: { at: '2026-11-06T07:30:00.000Z' },
  };
  const rows = pendingRestartRegistrations(raw, '2026-11-06T05:00:00.000Z');
  assert.deepEqual(rows, [
    { sessionId: 'newest', at: '2026-11-06T07:30:00.000Z' },
    { sessionId: 'mid', at: '2026-11-06T06:00:00.000Z' },
  ]);
});

test('pendingRestartRegistrations: at 恰好等于 lastBootAt 视为已经历重启（剔除）', () => {
  const raw = {
    equal: { at: '2026-11-06T05:00:00.000Z' },
    after: { at: '2026-11-06T05:00:00.001Z' },
  };
  assert.deepEqual(
    pendingRestartRegistrations(raw, '2026-11-06T05:00:00.000Z').map((row) => row.sessionId),
    ['after'],
  );
});

test('pendingRestartRegistrations: lastBootAt 缺失/不可解析 → 无从判断，全部保留（按 at 倒序）', () => {
  const raw = {
    a: { at: '2026-11-06T04:00:00.000Z' },
    b: { at: '2026-11-06T06:00:00.000Z' },
  };
  for (const lastBootAt of ['', 'not-a-date', undefined, null]) {
    assert.deepEqual(
      pendingRestartRegistrations(raw, lastBootAt).map((row) => row.sessionId),
      ['b', 'a'],
    );
  }
});

test('pendingRestartRegistrations: title 拿到才带、activate 仅 false 携带（true/缺失不带）', () => {
  const raw = {
    off: { at: '2026-11-06T06:00:00.000Z', title: '收尾会话', activate: false },
    on: { at: '2026-11-06T07:00:00.000Z', activate: true },
  };
  assert.deepEqual(pendingRestartRegistrations(raw, '2026-11-06T05:00:00.000Z'), [
    { sessionId: 'on', at: '2026-11-06T07:00:00.000Z' },
    { sessionId: 'off', at: '2026-11-06T06:00:00.000Z', title: '收尾会话', activate: false },
  ]);
});

test('pendingRestartRegistrations: at 不可解析时保留（排末位）；脏输入 → []，绝不抛错', () => {
  const rows = pendingRestartRegistrations(
    { broken: { at: 'not-a-date' }, good: { at: '2026-11-06T06:00:00.000Z' } },
    '2026-11-06T05:00:00.000Z',
  );
  assert.deepEqual(rows.map((row) => row.sessionId), ['good', 'broken']);
  // 脏输入（非对象 / 数组 / null / undefined / 空对象）一律空数组
  for (const raw of [null, undefined, [], 'x', 42, {}]) {
    assert.deepEqual(pendingRestartRegistrations(raw, '2026-11-06T05:00:00.000Z'), []);
  }
});

// ---- 0.36.0：顶栏「重启时恢复」给已完成会话补登记 → 仍进入恢复候选 ----

test('mergeProactiveRestoreCandidates: 已完成会话（不在自动候选里）+ 主动登记 → 仍进入恢复候选', () => {
  const at = Date.parse('2026-11-07T00:00:00.000Z');
  // 已完成会话被「正常结束门」从自动候选（picked，visibleRestoreCandidateIds）剔除，
  // 但它若在 proactive 登记集合里（0.36.0 顶栏点一下「重启时恢复」= 写登记），
  // 恢复候选池仍是它：picked/paused 为空也照样并入（不在 recentSessions 也一样）
  const merged = mergeProactiveRestoreCandidates([], [], [{ id: 'session-done', at, running: false }], 0);
  assert.deepEqual(merged, [{ id: 'session-done', at, running: false }]);
  // 恢复预算（restoreMax）只截自动/暂停候选，主动登记的已完成会话不受影响
  const withBudget = mergeProactiveRestoreCandidates(
    [
      { id: 'session-a', at: at + 1000, running: true },
      { id: 'session-b', at: at + 2000, running: true },
    ],
    [],
    [{ id: 'session-done', at, running: false }],
    1,
  );
  assert.deepEqual(withBudget.map((entry) => entry.id).sort(), ['session-b', 'session-done']);
});
