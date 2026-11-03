/**
 * 0.26.0「续等阶梯 + 上次重启无法恢复 store」的纯函数单元测试
 * （node --test，无 e2e、不起任何服务）。
 *
 * 直接 import 断言（范式照抄 lib/proactive-restore.test.js）：
 * 1. escalationDelayMs（lib/index.js 导出）：续等逐级递增等待阶梯
 *    （attempt=1..5 → 2s/4s/8s/16s/30s 封顶、attempt≥6 恒 30s、
 *      非法入参按 1 处理绝不抛错）；
 * 2. normalizeUnrestored：任意解析结果 → 条目数组（接受 { sessions:[...] } 或
 *    裸数组、非空字符串 id+at 才保留、可选字段拿到才带、同 id 保留先出现、
 *    损坏形状 → []）；
 * 3. capUnrestored：超出 max 按 at 丢最旧（新在前语义）、MAX_UNRESTORED=100、
 *    非法 max 不裁剪；
 * 4. upsertUnrestored：同 id 原位更新不新增、新条目插到最前、非法条目原样返回；
 * 5. removeUnrestoredIds：移除指定 id（单字符串/数组）、无变化返回原引用、
 *    非法输入原样返回；
 * 6. readUnrestored / writeUnrestored：真实临时文件（缺失/损坏 → []；写盘 + 读回
 *    一致；写失败不抛错返回 false）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationDelayMs } from './index.js';
import {
  MAX_UNRESTORED,
  capUnrestored,
  normalizeUnrestored,
  readUnrestored,
  removeUnrestoredIds,
  upsertUnrestored,
  writeUnrestored,
} from './unrestored.js';

// ---- escalationDelayMs：续等逐级递增等待阶梯（lib/index.js 导出） ----

test('escalationDelayMs: attempt=1..5 精确阶梯 2s/4s/8s/16s/30s（第 5 轮恰被 30s 封顶）', () => {
  assert.equal(escalationDelayMs(1), 2000);
  assert.equal(escalationDelayMs(2), 4000);
  assert.equal(escalationDelayMs(3), 8000);
  assert.equal(escalationDelayMs(4), 16000);
  // 2000 * 2^4 = 32000 > 30000 → 封顶
  assert.equal(escalationDelayMs(5), 30000);
});

test('escalationDelayMs: attempt≥6 恒 30s 封顶，不再增长', () => {
  assert.equal(escalationDelayMs(6), 30000);
  assert.equal(escalationDelayMs(7), 30000);
  assert.equal(escalationDelayMs(100), 30000);
});

test('escalationDelayMs: 非法入参按 1 处理（首轮 2s），绝不抛错', () => {
  // 实现口径：Number(attempt) 取整后 < 1 或非有限数 → 按 1
  assert.equal(escalationDelayMs(0), 2000);
  assert.equal(escalationDelayMs(-3), 2000);
  assert.equal(escalationDelayMs(NaN), 2000);
  assert.equal(escalationDelayMs(Infinity), 2000);
  assert.equal(escalationDelayMs(undefined), 2000);
  assert.equal(escalationDelayMs(null), 2000);
  assert.equal(escalationDelayMs('nope'), 2000);
  assert.equal(escalationDelayMs({}), 2000);
});

test('escalationDelayMs: 小数向下取整、纯数字字符串按数值（实现口径）', () => {
  assert.equal(escalationDelayMs(2.9), 4000); // floor(2.9)=2 → 4s
  assert.equal(escalationDelayMs('3'), 8000); // Number('3')=3 → 8s
});

// ---- normalizeUnrestored：任意解析结果 → 条目数组（新在前） ----

test('normalizeUnrestored: { sessions:[...] } 落盘格式归一化，可选字段拿到才带', () => {
  assert.deepEqual(normalizeUnrestored({
    sessions: [
      { id: 'a', at: '2026-01-01T00:00:00.000Z', bootAt: '2026-01-01T00:00:00.000Z', title: '会话 A', workspace: '/ws/a', error: 'timeout' },
      { id: 'b', at: '2026-01-02T00:00:00.000Z' }, // 无任何可选字段
    ],
  }), [
    { id: 'a', at: '2026-01-01T00:00:00.000Z', bootAt: '2026-01-01T00:00:00.000Z', title: '会话 A', workspace: '/ws/a', error: 'timeout' },
    { id: 'b', at: '2026-01-02T00:00:00.000Z' },
  ]);
});

test('normalizeUnrestored: 裸数组也接受（容忍手写文件）；输入顺序即输出顺序（新在前）', () => {
  assert.deepEqual(normalizeUnrestored([
    { id: 'new', at: '2026-01-03T00:00:00.000Z' },
    { id: 'old', at: '2026-01-01T00:00:00.000Z' },
  ]), [
    { id: 'new', at: '2026-01-03T00:00:00.000Z' },
    { id: 'old', at: '2026-01-01T00:00:00.000Z' },
  ]);
});

test('normalizeUnrestored: 脏条目丢弃——非对象/数组条目/缺 id/空 id/非字符串 id/缺 at/空 at', () => {
  assert.deepEqual(normalizeUnrestored([
    { id: 'ok', at: '2026-01-01T00:00:00.000Z' },
    null,
    [1, 2], // 数组条目
    { at: '2026-01-01T00:00:00.000Z' }, // 缺 id
    { id: '', at: '2026-01-01T00:00:00.000Z' }, // 空 id
    { id: 42, at: '2026-01-01T00:00:00.000Z' }, // 非字符串 id
    { id: 'no-at' }, // 缺 at
    { id: 'empty-at', at: '' }, // 空 at
    { id: 'num-at', at: 42 }, // 非字符串 at
    'id-str', // 字符串条目
  ]), [{ id: 'ok', at: '2026-01-01T00:00:00.000Z' }]);
});

test('normalizeUnrestored: 可选字段空串/非字符串一律不带（key 不存在而非空值）', () => {
  const rows = normalizeUnrestored([
    { id: 'a', at: '2026-01-01T00:00:00.000Z', title: '', workspace: 42, error: null, bootAt: {} },
  ]);
  assert.deepEqual(rows, [{ id: 'a', at: '2026-01-01T00:00:00.000Z' }]);
  for (const key of ['bootAt', 'title', 'workspace', 'error']) {
    assert.equal(key in rows[0], false);
  }
});

test('normalizeUnrestored: 同 id 保留先出现的条目（后出现的含更多字段也不覆盖）', () => {
  assert.deepEqual(normalizeUnrestored([
    { id: 'dup', at: '2026-01-01T00:00:00.000Z' },
    { id: 'dup', at: '2026-01-02T00:00:00.000Z', title: '后来者' },
    { id: 'only', at: '2026-01-03T00:00:00.000Z' },
  ]), [
    { id: 'dup', at: '2026-01-01T00:00:00.000Z' },
    { id: 'only', at: '2026-01-03T00:00:00.000Z' },
  ]);
});

test('normalizeUnrestored: 损坏形状一律 []，绝不抛错', () => {
  assert.deepEqual(normalizeUnrestored(null), []);
  assert.deepEqual(normalizeUnrestored(undefined), []);
  assert.deepEqual(normalizeUnrestored(42), []);
  assert.deepEqual(normalizeUnrestored('nope'), []);
  assert.deepEqual(normalizeUnrestored({}), []); // 对象但无 sessions
  assert.deepEqual(normalizeUnrestored({ sessions: 'nope' }), []); // sessions 非数组
  assert.deepEqual(normalizeUnrestored({ sessions: null }), []);
  assert.deepEqual(normalizeUnrestored([]), []);
});

// ---- capUnrestored：超出上限丢最旧（按 at，无法解析按 0 最先丢） ----

test('capUnrestored: 超出 max 按 at 丢最旧，返回新数组不改入参、保留原顺序（新在前）', () => {
  const rows = [
    { id: 'newest', at: '2026-01-03T00:00:00.000Z' },
    { id: 'oldest', at: '2026-01-01T00:00:00.000Z' },
    { id: 'mid', at: '2026-01-02T00:00:00.000Z' },
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));
  const capped = capUnrestored(rows, 2);
  assert.deepEqual(capped, [
    { id: 'newest', at: '2026-01-03T00:00:00.000Z' },
    { id: 'mid', at: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.deepEqual(rows, snapshot); // 入参未被改动
});

test('capUnrestored: MAX_UNRESTORED=100——101 条裁到 100 条、丢 at 最旧（新在前不变）', () => {
  assert.equal(MAX_UNRESTORED, 100);
  const rows = [];
  for (let i = MAX_UNRESTORED; i >= 0; i--) {
    rows.push({ id: `s-${i}`, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }); // 新在前
  }
  const capped = capUnrestored(rows, MAX_UNRESTORED);
  assert.equal(capped.length, MAX_UNRESTORED);
  assert.equal(capped[0].id, `s-${MAX_UNRESTORED}`); // 最新在前
  assert.equal(capped.at(-1).id, 's-1'); // 最旧 s-0 被丢
  assert.equal(capped.some((row) => row.id === 's-0'), false);
});

test('capUnrestored: at 无法解析按 0 最先丢；不超过上限原样（新数组）返回', () => {
  const rows = [
    { id: 'unparsable', at: 'not-a-date' }, // at=0 → 最旧
    { id: 'later', at: '2026-01-02T00:00:00.000Z' },
    { id: 'earlier', at: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(capUnrestored(rows, 2), [
    { id: 'later', at: '2026-01-02T00:00:00.000Z' },
    { id: 'earlier', at: '2026-01-01T00:00:00.000Z' },
  ]);
  const small = capUnrestored(rows, 10);
  assert.deepEqual(small, rows);
  assert.notEqual(small, rows); // 归一化新数组
});

test('capUnrestored: max 非正/非法不裁剪；脏形状 → []', () => {
  const rows = [{ id: 'a', at: '2026-01-01T00:00:00.000Z' }];
  assert.deepEqual(capUnrestored(rows, 0), rows);
  assert.deepEqual(capUnrestored(rows, -1), rows);
  assert.deepEqual(capUnrestored(rows, NaN), rows);
  assert.deepEqual(capUnrestored(rows, 'nope'), rows);
  assert.deepEqual(capUnrestored(null, 1), []);
  assert.deepEqual(capUnrestored('nope', 1), []);
  // 入参接受 { sessions:[...] } 落盘格式
  assert.deepEqual(capUnrestored({ sessions: rows }, 1), rows);
});

// ---- upsertUnrestored：同 id 原位更新不新增、新条目插最前 ----

test('upsertUnrestored: 同 id 原位更新（位置不变、字段整体替换），其余条目原序', () => {
  const rows = [
    { id: 'a', at: '2026-01-01T00:00:00.000Z', error: '旧原因' },
    { id: 'b', at: '2026-01-02T00:00:00.000Z' },
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));
  const next = upsertUnrestored(rows, { id: 'b', at: '2026-01-09T00:00:00.000Z', title: '更新后' });
  assert.deepEqual(next, [
    { id: 'a', at: '2026-01-01T00:00:00.000Z', error: '旧原因' }, // 位置不变、字段原样
    { id: 'b', at: '2026-01-09T00:00:00.000Z', title: '更新后' }, // 原位整体替换，旧字段不残留
  ]);
  assert.deepEqual(rows, snapshot); // 入参未被改动
});

test('upsertUnrestored: 不存在的 id 插到最前（新在前），返回新数组不改入参', () => {
  const rows = [{ id: 'a', at: '2026-01-01T00:00:00.000Z' }];
  const next = upsertUnrestored(rows, { id: 'new', at: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(next, [
    { id: 'new', at: '2026-01-02T00:00:00.000Z' },
    { id: 'a', at: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.notEqual(next, rows);
  assert.equal(rows.length, 1);
});

test('upsertUnrestored: 非法条目（非对象/数组/缺 id/空 id/缺 at/空 at）原样返回旧数组', () => {
  const rows = [{ id: 'a', at: '2026-01-01T00:00:00.000Z' }];
  for (const bad of [null, 42, 'x', [1], { at: '2026-01-01T00:00:00.000Z' }, { id: '', at: 'x' }, { id: 'a' }, { id: 'a', at: '' }]) {
    const out = upsertUnrestored(rows, bad);
    assert.deepEqual(out, rows);
    assert.equal(out, rows); // 同一引用（未产生新数组）
  }
  // rows 非数组 → 按空列表处理：非法条目返回 []、合法条目照样插入
  assert.deepEqual(upsertUnrestored(null, { id: 'bad' }), []);
  assert.deepEqual(upsertUnrestored('nope', { id: 'a', at: 'x' }), [{ id: 'a', at: 'x' }]);
});

// ---- removeUnrestoredIds：移除指定 id（无变化返回原引用） ----

test('removeUnrestoredIds: 单字符串与数组都能命中，其余条目原序保留', () => {
  const rows = [
    { id: 'a', at: '2026-01-01T00:00:00.000Z' },
    { id: 'b', at: '2026-01-02T00:00:00.000Z' },
    { id: 'c', at: '2026-01-03T00:00:00.000Z' },
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));
  assert.deepEqual(removeUnrestoredIds(rows, 'b'), [
    { id: 'a', at: '2026-01-01T00:00:00.000Z' },
    { id: 'c', at: '2026-01-03T00:00:00.000Z' },
  ]);
  assert.deepEqual(removeUnrestoredIds(rows, ['a', 'c']), [
    { id: 'b', at: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.deepEqual(rows, snapshot); // 入参未被改动
});

test('removeUnrestoredIds: 无 ids/非法 ids 无变化返回原引用（实现口径）；命中但不存在的 id 返回等价新数组', () => {
  const rows = [{ id: 'a', at: '2026-01-01T00:00:00.000Z' }];
  for (const noIds of ['', 42, null, undefined, [], [null, '', 42]]) {
    assert.equal(removeUnrestoredIds(rows, noIds), rows); // 原引用
  }
  // 合法 ids 但没有任何条目命中 → 等价内容的新数组
  const missing = removeUnrestoredIds(rows, 'no-such-id');
  assert.deepEqual(missing, rows);
  assert.notEqual(missing, rows);
});

test('removeUnrestoredIds: 脏条目（非对象）原样穿过不被剔除；rows 非数组 → []', () => {
  const rows = [null, 42, { id: 'a', at: 'x' }];
  assert.deepEqual(removeUnrestoredIds(rows, 'a'), [null, 42]);
  assert.deepEqual(removeUnrestoredIds('nope', 'a'), []);
  assert.deepEqual(removeUnrestoredIds(undefined, ['a']), []);
});

// ---- readUnrestored / writeUnrestored：真实临时文件 round-trip ----

test('readUnrestored: 缺失/损坏/形状不对一律 []（绝不抛错）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-unrestored-'));
  try {
    const missing = join(dir, 'missing.json');
    assert.deepEqual(readUnrestored(missing), []);
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not json ', 'utf8');
    assert.deepEqual(readUnrestored(corrupt), []);
    const wrongShape = join(dir, 'wrong.json');
    // 旧版 proactive 风格的 { [id]: { at } } 映射形状不识别 → 按空
    writeFileSync(wrongShape, JSON.stringify({ a: { at: '2026-01-01T00:00:00.000Z' } }), 'utf8');
    assert.deepEqual(readUnrestored(wrongShape), []);
    const dirtyEntries = join(dir, 'dirty.json');
    writeFileSync(dirtyEntries, JSON.stringify({ sessions: [{ id: '', at: '' }, { id: 'ok', at: '2026-01-01T00:00:00.000Z' }] }), 'utf8');
    assert.deepEqual(readUnrestored(dirtyEntries), [{ id: 'ok', at: '2026-01-01T00:00:00.000Z' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUnrestored → readUnrestored 往返一致；脏条目归一化写回、落盘固定 { sessions:[...] } 形状', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-unrestored-'));
  try {
    const file = join(dir, 'unrestored.json');
    const data = [
      { id: 'a', at: '2026-01-01T00:00:00.000Z', bootAt: '2026-01-01T00:00:00.000Z', title: '会话 A', workspace: '/ws/a', error: '等待超时' },
      { id: 'bad', title: '缺 at 丢弃' },
    ];
    assert.equal(writeUnrestored(file, data), true);
    assert.deepEqual(readUnrestored(file), [
      { id: 'a', at: '2026-01-01T00:00:00.000Z', bootAt: '2026-01-01T00:00:00.000Z', title: '会话 A', workspace: '/ws/a', error: '等待超时' },
    ]);
    // 落盘文本：固定 { sessions: [...] } 包装、缩进 JSON + 末尾换行
    const text = readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(text.startsWith('{'));
    assert.deepEqual(JSON.parse(text).sessions, [
      { id: 'a', at: '2026-01-01T00:00:00.000Z', bootAt: '2026-01-01T00:00:00.000Z', title: '会话 A', workspace: '/ws/a', error: '等待超时' },
    ]);
    // 入参接受 { sessions:[...] } 形状，往返仍一致
    assert.equal(writeUnrestored(file, { sessions: [{ id: 'b', at: '2026-01-02T00:00:00.000Z' }] }), true);
    assert.deepEqual(readUnrestored(file), [{ id: 'b', at: '2026-01-02T00:00:00.000Z' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUnrestored: 父目录不存在自动创建（stateDir 首写）；写失败不抛错返回 false 只降级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-unrestored-'));
  try {
    // 深层路径一次性创建
    const nested = join(dir, 'state', 'nested', 'unrestored.json');
    assert.equal(writeUnrestored(nested, [{ id: 'a', at: 'x' }]), true);
    assert.deepEqual(readUnrestored(nested), [{ id: 'a', at: 'x' }]);
    // blocker 是文件、其下还要创建子路径 → mkdirSync 失败
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const badFile = join(blocker, 'sub', 'unrestored.json');
    assert.equal(writeUnrestored(badFile, [{ id: 'a', at: 'x' }]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 组合管线：登记（upsert）→ 裁剪（cap）→ 恢复成功移除（remove） ----

test('0.26.0 登记管线组合：upsert 去重 → cap 封顶 → remove 移除，接 normalize/读写全链不抛错', () => {
  let rows = [];
  // 同 id 重复登记 = 原位更新不新增
  rows = upsertUnrestored(rows, { id: 'x', at: '2026-01-01T00:00:00.000Z', error: '第一次' });
  rows = upsertUnrestored(rows, { id: 'x', at: '2026-01-01T00:00:00.000Z', error: '第二次' });
  rows = upsertUnrestored(rows, { id: 'y', at: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(rows, [
    { id: 'y', at: '2026-01-02T00:00:00.000Z' },
    { id: 'x', at: '2026-01-01T00:00:00.000Z', error: '第二次' },
  ]);
  // x 恢复成功 → 移除
  rows = removeUnrestoredIds(rows, 'x');
  assert.deepEqual(rows, [{ id: 'y', at: '2026-01-02T00:00:00.000Z' }]);
  // 写盘再读回一致（落盘形状经 normalize 也能被 cap 接受）
  const dir = mkdtempSync(join(tmpdir(), 'ror-unrestored-'));
  try {
    const file = join(dir, 'unrestored.json');
    assert.equal(writeUnrestored(file, rows), true);
    assert.deepEqual(capUnrestored(readUnrestored(file), MAX_UNRESTORED), rows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
