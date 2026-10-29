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
 *      脏输入防御 / 不改入参）。
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
