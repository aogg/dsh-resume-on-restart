/**
 * 0.22.0「注册后守门自动重启」纯函数单测（node --test，无 e2e、不起任何服务）。
 *
 * 直接 import lib/auto-restart.js 断言**全部导出**（范式照抄 lib/proactive-restore.test.js：
 * 真实临时文件 + tmpdir、测完 rmSync 清理；被测函数全部防御式，绝不抛错）：
 * 1. AUTO_RESTART_SCHEMA_VERSION：当前为 1；
 * 2. normalizeAutoRestartArm：合法形状归一化；非对象/数组/schemaVersion!==1/
 *    armedAt 或 by 空或非字符串 → null；
 * 3. readAutoRestartArm：文件缺失/损坏 JSON/形状不对 → null，绝不抛；
 * 4. writeAutoRestartArm：成功落盘为归一化后的 JSON（2 空格缩进 + 尾换行）；
 *    state 非法 → false 且不落盘；写失败（父路径是已存在文件）→ false；
 * 5. removeAutoRestartArm：删除成功；ENOENT 静默按 true；其余失败 → false；
 * 6. mergeAutoRestartArm：existing 非法 → next；next 非法 → existing；都非法 → null；
 *    都合法保留最早 armedAt（ISO 不可解析视为 +Infinity 让位、双方都不可解析保留
 *    prev 原文）、by 取 next；不改写入参；
 * 7. classifyAutoRestartGate：running 空数组/非数组 → { done: true }；全部命中提问中
 *    集合（Set 与数组两种入参）→ done；部分未命中 → done:false 且 running 只含未命中
 *    id；条目兼容字符串与 {id} 对象、脏条目丢弃、非字符串 id 忽略。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_RESTART_SCHEMA_VERSION,
  classifyAutoRestartGate,
  mergeAutoRestartArm,
  normalizeAutoRestartArm,
  readAutoRestartArm,
  removeAutoRestartArm,
  writeAutoRestartArm,
} from './auto-restart.js';

/** 合法武装状态便捷构造（pending-auto-restart.json 的形状）。 */
const ARM = (armedAt, by) => ({ schemaVersion: 1, armedAt, by });

/** 每个用例独立的临时目录，绝不读写真实状态目录。 */
function useTempDir() {
  return mkdtempSync(join(tmpdir(), 'ror-auto-restart-'));
}

test('AUTO_RESTART_SCHEMA_VERSION: 当前为 1（形状不兼容时升版，旧版文件按非法 = 未武装处理）', () => {
  assert.equal(AUTO_RESTART_SCHEMA_VERSION, 1);
});

// ---- normalizeAutoRestartArm：任意解析结果 → 合法武装状态或 null ----

test('normalizeAutoRestartArm: 合法形状 → 归一化对象（多余字段丢弃，不改入参）', () => {
  const raw = { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-a', extra: 'drop-me' };
  const before = { ...raw };
  assert.deepEqual(normalizeAutoRestartArm(raw), {
    schemaVersion: 1,
    armedAt: '2026-10-31T00:00:00.000Z',
    by: 'session-a',
  });
  assert.deepEqual(raw, before, '入参未被改动');
});

test('normalizeAutoRestartArm: 非对象（含 null）/数组 → null', () => {
  for (const bad of [null, undefined, 42, 0, 'x', '', true, false, [], [ARM('t', 's')]]) {
    assert.equal(normalizeAutoRestartArm(bad), null, `input=${JSON.stringify(bad)}`);
  }
});

test('normalizeAutoRestartArm: schemaVersion !== 1（缺失/0/2/字符串 "1"）→ null', () => {
  for (const schemaVersion of [undefined, null, 0, 2, -1, '1', true]) {
    assert.equal(
      normalizeAutoRestartArm({ schemaVersion, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-a' }),
      null,
      `schemaVersion=${JSON.stringify(schemaVersion)}`,
    );
  }
});

test('normalizeAutoRestartArm: armedAt / by 空串或非字符串（含缺失）→ null', () => {
  const good = '2026-10-31T00:00:00.000Z';
  for (const badValue of ['', 0, 42, null, undefined, {}, []]) {
    assert.equal(normalizeAutoRestartArm({ schemaVersion: 1, armedAt: badValue, by: 'session-a' }), null, `armedAt=${JSON.stringify(badValue)}`);
    assert.equal(normalizeAutoRestartArm({ schemaVersion: 1, armedAt: good, by: badValue }), null, `by=${JSON.stringify(badValue)}`);
  }
  // 两个字段同时非法 → 同样 null
  assert.equal(normalizeAutoRestartArm({ schemaVersion: 1, armedAt: '', by: '' }), null);
});

// ---- readAutoRestartArm：真实临时文件，缺失/损坏一律 null ----

test('readAutoRestartArm: 缺失/损坏 JSON/形状不对 → null（绝不抛错）', () => {
  const dir = useTempDir();
  try {
    assert.equal(readAutoRestartArm(join(dir, 'missing.json')), null);
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not json ', 'utf8');
    assert.equal(readAutoRestartArm(corrupt), null);
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ schemaVersion: 2, armedAt: 't', by: 's' }), 'utf8');
    assert.equal(readAutoRestartArm(wrong), null, 'schemaVersion 升版 → 旧文件按非法 = 未武装');
    writeFileSync(wrong, JSON.stringify([ARM('t', 's')]), 'utf8');
    assert.equal(readAutoRestartArm(wrong), null, '数组形状 → null');
    writeFileSync(wrong, JSON.stringify({ schemaVersion: 1, armedAt: '', by: 's' }), 'utf8');
    assert.equal(readAutoRestartArm(wrong), null, 'armedAt 空串 → null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readAutoRestartArm: 合法文件 → 读回归一化对象', () => {
  const dir = useTempDir();
  try {
    const file = join(dir, 'pending-auto-restart.json');
    writeFileSync(file, JSON.stringify(ARM('2026-10-31T00:00:00.000Z', 'session-a')), 'utf8');
    assert.deepEqual(readAutoRestartArm(file), { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-a' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- writeAutoRestartArm：best-effort 写盘，绝不抛错 ----

test('writeAutoRestartArm: 成功 → true，落盘为归一化后的 JSON（2 空格缩进 + 尾换行），读回一致', () => {
  const dir = useTempDir();
  try {
    const file = join(dir, 'nested', 'pending-auto-restart.json'); // 目录不存在 → 自动创建
    const state = { by: 'session-b', armedAt: '2026-10-31T01:02:03.000Z', schemaVersion: 1, junk: 'drop-me' };
    assert.equal(writeAutoRestartArm(file, state), true);
    assert.ok(existsSync(file));
    const normalized = { schemaVersion: 1, armedAt: '2026-10-31T01:02:03.000Z', by: 'session-b' };
    assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(normalized, null, 2)}\n`, '内容为归一化后的 JSON（多余字段丢弃）');
    assert.deepEqual(readAutoRestartArm(file), normalized);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAutoRestartArm: state 非法 → false 且不落盘', () => {
  const dir = useTempDir();
  try {
    const badStates = [
      null,
      undefined,
      42,
      'x',
      [],
      { schemaVersion: 2, armedAt: 't', by: 's' },
      { schemaVersion: 1, armedAt: '', by: 's' },
      { schemaVersion: 1, armedAt: 't', by: 42 },
    ];
    badStates.forEach((bad, index) => {
      const file = join(dir, `bad-${index}.json`);
      assert.equal(writeAutoRestartArm(file, bad), false, `state=${JSON.stringify(bad)}`);
      assert.equal(existsSync(file), false, '非法 state 不落盘');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeAutoRestartArm: 写失败 → false 不抛错（父路径是已存在文件，mkdirSync 必败）', () => {
  const dir = useTempDir();
  try {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    // blocker 是文件、其下还要创建子路径 → mkdirSync 失败
    assert.equal(writeAutoRestartArm(join(blocker, 'sub', 'pending-auto-restart.json'), ARM('t', 's')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- removeAutoRestartArm：开机一次性消费 / 解除武装 ----

test('removeAutoRestartArm: 已存在 → true 且文件消失；不存在（ENOENT）→ true 静默按成功', () => {
  const dir = useTempDir();
  try {
    const file = join(dir, 'pending-auto-restart.json');
    assert.equal(writeAutoRestartArm(file, ARM('t', 's')), true);
    assert.equal(existsSync(file), true);
    assert.equal(removeAutoRestartArm(file), true);
    assert.equal(existsSync(file), false, '文件已被删除');
    assert.equal(removeAutoRestartArm(file), true, 'ENOENT（本来就没武装）静默按 true');
    assert.equal(removeAutoRestartArm(join(dir, 'never-armed.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeAutoRestartArm: 其余失败 → false（目标是目录，unlink EISDIR 而非 ENOENT）', () => {
  const dir = useTempDir();
  try {
    const subdir = join(dir, 'dir-target');
    mkdirSync(subdir);
    assert.equal(removeAutoRestartArm(subdir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- mergeAutoRestartArm：幂等合并（最早 armedAt、最新 by） ----

test('mergeAutoRestartArm: existing 非法 → next（首次武装，归一化）；next 非法 → existing；都非法 → null', () => {
  const next = ARM('2026-10-31T01:00:00.000Z', 'session-b');
  for (const badExisting of [null, undefined, 42, 'x', [], { schemaVersion: 1, armedAt: '', by: 's' }]) {
    assert.deepEqual(mergeAutoRestartArm(badExisting, next), { schemaVersion: 1, armedAt: '2026-10-31T01:00:00.000Z', by: 'session-b' });
  }
  const existing = ARM('2026-10-31T00:00:00.000Z', 'session-a');
  for (const badNext of [null, undefined, 'junk', [], { schemaVersion: 1, armedAt: 42, by: 's' }]) {
    assert.deepEqual(mergeAutoRestartArm(existing, badNext), { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-a' });
  }
  assert.equal(mergeAutoRestartArm(null, undefined), null, '两者都非法 → null');
  assert.equal(mergeAutoRestartArm([], {}), null);
  assert.equal(mergeAutoRestartArm({ schemaVersion: 2 }, { schemaVersion: '1' }), null);
});

test('mergeAutoRestartArm: 都合法 → armedAt 保留最早、by 取 next（最新注册者）', () => {
  const earlier = ARM('2026-10-31T00:00:00.000Z', 'session-a');
  const later = ARM('2026-10-31T05:00:00.000Z', 'session-b');
  // 多次注册不把时刻越推越晚：prev 早 → 保留 prev 的 armedAt
  assert.deepEqual(mergeAutoRestartArm(earlier, later), { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-b' });
  // 参数对调：早的时刻同样胜出（无论谁当 existing），by 仍取 next
  assert.deepEqual(mergeAutoRestartArm(later, earlier), { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-a' });
  // 同刻 → 保留 prev 原文（<=），by 仍取 next
  const same = ARM('2026-10-31T00:00:00.000Z', 'session-c');
  assert.deepEqual(mergeAutoRestartArm(earlier, same), { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-c' });
});

test('mergeAutoRestartArm: ISO 不可解析视为 +Infinity 让位；双方都不可解析保留 prev 原文', () => {
  const parsable = ARM('2026-10-31T00:00:00.000Z', 'session-p');
  const unparsable = ARM('not-a-date', 'session-u');
  // prev 不可解析（+Infinity）→ 让位 next 的可解析时刻
  assert.deepEqual(mergeAutoRestartArm(unparsable, parsable), { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-p' });
  // next 不可解析 → 保留 prev 的可解析时刻
  assert.deepEqual(mergeAutoRestartArm(parsable, unparsable), { schemaVersion: 1, armedAt: '2026-10-31T00:00:00.000Z', by: 'session-u' });
  // 双方都不可解析 → 保留 prev 原文，不臆造时刻
  assert.deepEqual(
    mergeAutoRestartArm(ARM('garbage-1', 'session-u1'), ARM('garbage-2', 'session-u2')),
    { schemaVersion: 1, armedAt: 'garbage-1', by: 'session-u2' },
  );
});

test('mergeAutoRestartArm: 不改写任何入参、返回新对象', () => {
  const existing = ARM('2026-10-31T00:00:00.000Z', 'session-a');
  const next = ARM('2026-10-31T05:00:00.000Z', 'session-b');
  const existingBefore = { ...existing };
  const nextBefore = { ...next };
  const merged = mergeAutoRestartArm(existing, next);
  assert.deepEqual(existing, existingBefore);
  assert.deepEqual(next, nextBefore);
  assert.notEqual(merged, existing);
  assert.notEqual(merged, next);
});

// ---- classifyAutoRestartGate：守门器「全部会话完成」判定 ----

test('classifyAutoRestartGate: running 空数组/非数组 → { done: true }（没有会话在 running）', () => {
  assert.deepEqual(classifyAutoRestartGate([], new Set()), { done: true });
  assert.deepEqual(classifyAutoRestartGate([], ['a']), { done: true });
  for (const notArray of [null, undefined, 42, 'x', {}, new Set(['a'])]) {
    assert.deepEqual(classifyAutoRestartGate(notArray, new Set()), { done: true }, 'runningEntries 非数组 → 按空处理');
  }
});

test('classifyAutoRestartGate: running 全部命中提问中集合（Set 入参）→ { done: true }（提问中亦算完成）', () => {
  assert.deepEqual(classifyAutoRestartGate(['a', 'b'], new Set(['a', 'b'])), { done: true });
  // 集合比 running 多（别的会话曾提问）→ 同样 done
  assert.deepEqual(classifyAutoRestartGate(['a'], new Set(['a', 'b', 'c'])), { done: true });
});

test('classifyAutoRestartGate: running 全部命中提问中集合（数组入参）→ { done: true }', () => {
  assert.deepEqual(classifyAutoRestartGate(['a', 'b'], ['a', 'b']), { done: true });
  assert.deepEqual(classifyAutoRestartGate([{ id: 'a' }, 'b'], ['b', 'a']), { done: true });
});

test('classifyAutoRestartGate: 部分未命中 → { done: false, running: 只含未命中 id }（顺序保持）', () => {
  assert.deepEqual(classifyAutoRestartGate(['working', 'asking', 'also-working'], new Set(['asking'])), {
    done: false,
    running: ['working', 'also-working'],
  });
  assert.deepEqual(classifyAutoRestartGate(['x', 'y'], []), { done: false, running: ['x', 'y'] }, '全未命中 → 全部列出');
});

test('classifyAutoRestartGate: 条目兼容字符串与 {id} 对象，脏条目/非字符串 id 丢弃（绝不抛错）', () => {
  const entries = [
    'str-id',                            // 字符串条目
    { id: 'obj-id', status: 'running' }, // {id} 对象条目（多余字段无碍）
    null,                                // 脏条目：丢弃
    42,                                  // 脏条目：丢弃
    {},                                  // 脏条目：无 id，丢弃
    { id: 42 },                          // id 非字符串：忽略
    { id: '' },                          // id 空串：忽略
    { id: null },                        // id null：忽略
    [],                                  // 数组条目：id undefined，忽略
  ];
  assert.deepEqual(classifyAutoRestartGate(entries, new Set(['str-id'])), { done: false, running: ['obj-id'] });
  // 脏条目全部丢弃后 running 为空 → 直接 done
  assert.deepEqual(classifyAutoRestartGate([null, {}, { id: 42 }], new Set()), { done: true });
});

test('classifyAutoRestartGate: pendingQuestionIds 脏元素忽略；非数组/非 Set 入参按空处理 → 全部算未完成', () => {
  // 数组里的脏元素（非字符串/空串）忽略
  assert.deepEqual(classifyAutoRestartGate(['a', 'x'], ['a', 42, '', null, {}]), { done: false, running: ['x'] });
  // Set 里的脏元素同样忽略
  assert.deepEqual(classifyAutoRestartGate(['a', 'x'], new Set(['a', 42, ''])), { done: false, running: ['x'] });
  // pendingQuestionIds 非数组/非 Set → 按空集合：所有 running 都阻塞
  for (const badAsking of [null, undefined, 42, 'a', {}, new Map()]) {
    assert.deepEqual(
      classifyAutoRestartGate(['a', 'b'], badAsking),
      { done: false, running: ['a', 'b'] },
      `pendingQuestionIds=${JSON.stringify(badAsking instanceof Map ? 'Map' : badAsking)}`,
    );
  }
});
