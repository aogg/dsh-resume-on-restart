/**
 * 0.15.0「暂停所有会话（pause-all）」的纯函数单元测试（node --test，无 e2e、不起任何服务）。
 *
 * - detect 侧直接 import（范式照抄 lib/detect.test.js）：
 *   1. unionRestoreCandidateIds：候选 id 并集去重（ids 顺序在前 / Set 输入 / 脏元素丢弃）；
 *   2. mergePausedCandidates：暂停条目并入恢复候选（picked 优先去重 / at 降序 /
 *      restoreMax 截断 / 脏输入防御 / 不改入参）；
 *   3. selectRunningAgentIds：agents.list() 运行中枚举（running 过滤 / 忽略前缀 / 脏数据）。
 * - client 侧经 window.__ModuleLoader__ 桩加载真实 bundle 后测工厂导出
 *   （范式照抄 lib/pending-restore.test.js）：
 *   4. formatPauseResult：暂停结果摘要各分支（doneNone / done 主段 + 附加段 / 脏输入 /
 *      t 缺失回退内置 zh 字典）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePausedCandidates,
  selectRunningAgentIds,
  unionRestoreCandidateIds,
} from './detect.js';

// 必须先装 window 桩再动态 import（client.js 顶层即调 window.__ModuleLoader__.load），
// 静态 import 会被提升到模块体之前，这里只能用 await import。
const loaded = {};
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loaded[def.id] = def;
    },
  },
};

/** react 桩：工厂只在组件渲染期才触达 react.*，纯函数测试不需要任何实现。 */
const factoryRequire = (name) => {
  if (name === 'react') return {};
  throw new Error(`unexpected require: ${name}`);
};

await import('./client.js');
const { formatPauseResult } = loaded['dsh-resume-on-restart'].factory(factoryRequire);

// ---- unionRestoreCandidateIds：候选 id 并集去重（0.15.0） ----

test('unionRestoreCandidateIds: 并集去重，ids 顺序在前、extraIds 未出现的按原顺序缀后', () => {
  assert.deepEqual(unionRestoreCandidateIds(['a', 'b'], ['b', 'c', 'a']), ['a', 'b', 'c']);
  assert.deepEqual(unionRestoreCandidateIds([], ['x', 'y']), ['x', 'y']);
  assert.deepEqual(unionRestoreCandidateIds(['x', 'y'], []), ['x', 'y']);
  assert.deepEqual(unionRestoreCandidateIds(['a'], ['a']), ['a']);
});

test('unionRestoreCandidateIds: 支持 Set 输入（collectRestoreCandidateIds 的返回形状）', () => {
  assert.deepEqual(unionRestoreCandidateIds(new Set(['a', 'b']), new Set(['b', 'c'])), ['a', 'b', 'c']);
});

test('unionRestoreCandidateIds: 脏输入防御——非数组/非 Set 按空、非字符串与空串元素丢弃、不抛错', () => {
  assert.deepEqual(unionRestoreCandidateIds(null, undefined), []);
  assert.deepEqual(unionRestoreCandidateIds('nope', 42), []);
  assert.deepEqual(unionRestoreCandidateIds(['a', '', 42, null, 'b'], ['', 'c', {}]), ['a', 'b', 'c']);
});

// ---- mergePausedCandidates：暂停条目并入恢复候选（0.15.0） ----

test('mergePausedCandidates: 按 id 去重 picked 优先（at/running 保留 picked 的），at 降序', () => {
  const picked = [{ id: 'a', at: 300, running: true }];
  const paused = [
    { id: 'b', at: 500, running: false },
    { id: 'a', at: 999, running: false }, // 同 id：picked 优先，at/running 不被覆盖
    { id: 'c', at: 100, running: false },
  ];
  assert.deepEqual(mergePausedCandidates(picked, paused, 0), [
    { id: 'b', at: 500, running: false },
    { id: 'a', at: 300, running: true },
    { id: 'c', at: 100, running: false },
  ]);
});

test('mergePausedCandidates: restoreMax>0 截断到前 N；<=0 或非法不截断', () => {
  const paused = [
    { id: 'a', at: 500, running: false },
    { id: 'b', at: 400, running: false },
    { id: 'c', at: 300, running: false },
  ];
  assert.deepEqual(mergePausedCandidates([], paused, 2), [
    { id: 'a', at: 500, running: false },
    { id: 'b', at: 400, running: false },
  ]);
  assert.deepEqual(mergePausedCandidates([], paused, 0), paused);
  assert.deepEqual(mergePausedCandidates([], paused, -1), paused);
  assert.deepEqual(mergePausedCandidates([], paused, NaN), paused);
  assert.deepEqual(mergePausedCandidates([], paused, 2.9), paused.slice(0, 2)); // floor
});

test('mergePausedCandidates: at 非法（负数/NaN/缺失）按 0；at 相同保持原相对顺序（排序稳定）', () => {
  const paused = [
    { id: 'a', at: -5, running: false },
    { id: 'b', at: Number.NaN, running: false },
    { id: 'c', running: false },
    { id: 'd', at: 100, running: false },
    { id: 'e', at: 0, running: false },
  ];
  assert.deepEqual(mergePausedCandidates([], paused, 0), [
    { id: 'd', at: 100, running: false },
    { id: 'a', at: 0, running: false },
    { id: 'b', at: 0, running: false },
    { id: 'c', at: 0, running: false },
    { id: 'e', at: 0, running: false },
  ]);
});

test('mergePausedCandidates: 纯函数不改入参；输出为归一化新对象（running 严格 boolean）', () => {
  const picked = [{ id: 'a', at: 1, running: 'yes' }];
  const paused = [{ id: 'b', at: 2, running: false }];
  const out = mergePausedCandidates(picked, paused, 0);
  assert.deepEqual(out, [
    { id: 'b', at: 2, running: false },
    { id: 'a', at: 1, running: false },
  ]);
  assert.notEqual(out[0], paused[0]); // 输出条目是新对象
  assert.notEqual(out[1], picked[0]);
  assert.deepEqual(picked, [{ id: 'a', at: 1, running: 'yes' }]); // 入参未被改写
  assert.deepEqual(paused, [{ id: 'b', at: 2, running: false }]);
});

test('mergePausedCandidates: 脏输入防御——非数组按空、缺 id/空 id/非对象条目丢弃、不抛错', () => {
  assert.deepEqual(mergePausedCandidates(null, undefined, 0), []);
  assert.deepEqual(mergePausedCandidates('nope', 42, 5), []);
  assert.deepEqual(
    mergePausedCandidates(
      [null, 42, { id: '' }, { noId: true }, { id: 'ok', at: 10, running: true }],
      [{ id: 'p', at: 20, running: false }],
      0,
    ),
    [
      { id: 'p', at: 20, running: false },
      { id: 'ok', at: 10, running: true },
    ],
  );
});

// ---- selectRunningAgentIds：运行中枚举（0.15.0） ----

test('selectRunningAgentIds: 只取 status==="running" 的 id，忽略前缀剔除', () => {
  const list = [
    { id: 's1', status: 'running' },
    { id: 's2', status: 'idle' },
    { id: 'head-root', status: 'running' },
    { id: 's3', status: 'running' },
  ];
  assert.deepEqual(selectRunningAgentIds(list, ['head-']), ['s1', 's3']);
  assert.deepEqual(selectRunningAgentIds(list, []), ['s1', 'head-root', 's3']);
  assert.deepEqual(selectRunningAgentIds(list, undefined), ['s1', 'head-root', 's3']);
});

test('selectRunningAgentIds: 脏数据防御——非数组空、脏条目/缺 status/缺 id 丢弃、前缀脏元素忽略、不抛错', () => {
  assert.deepEqual(selectRunningAgentIds(null, ['head-']), []);
  assert.deepEqual(selectRunningAgentIds('nope', undefined), []);
  assert.deepEqual(
    selectRunningAgentIds([
      null,
      42,
      { id: 'x' }, // 缺 status
      { status: 'running' }, // 缺 id
      { id: '', status: 'running' }, // 空 id
      { id: 42, status: 'running' }, // id 非字符串
      { id: 'ok', status: 'running' },
      { id: 'head-a', status: 'running' }, // 命中忽略前缀
    ], [null, 42, 'head-']),
    ['ok'],
  );
});

// ---- formatPauseResult：暂停结果摘要（client 工厂导出，0.15.0） ----

/** 词条桩：映射表未命中的 key 原样返回，便于断言 %s 替换与段拼接逻辑。 */
const stubT = (key) => ({
  'pause.doneNone': 'NONE',
  'pause.done': 'done %s',
  'pause.doneSubagent': 'sub %s',
  'pause.doneFailed': 'fail %s',
}[key] ?? key);

test('formatPauseResult: stopped=0 且 failed=0 → doneNone（subagent 有值也不变）', () => {
  assert.equal(formatPauseResult({ stopped: [], subagent: [], failed: [] }, stubT), 'NONE');
  assert.equal(formatPauseResult({ stopped: [], subagent: ['x'], failed: [] }, stubT), 'NONE');
  assert.equal(formatPauseResult({ stopped: 'nope' }, stubT), 'NONE');
});

test('formatPauseResult: stopped>0 → done 主段，subagent/failed 计数>0 依次附加（· 连接、%s 替换）', () => {
  assert.equal(formatPauseResult({ stopped: [{ id: 'a' }], subagent: [], failed: [] }, stubT), 'done 1');
  assert.equal(
    formatPauseResult({ stopped: [{ id: 'a' }, { id: 'b' }], subagent: ['s'], failed: [] }, stubT),
    'done 2 · sub 1',
  );
  assert.equal(
    formatPauseResult({
      stopped: [{ id: 'a' }],
      subagent: ['s1', 's2'],
      failed: [{ id: 'f', error: 'x' }],
    }, stubT),
    'done 1 · sub 2 · fail 1',
  );
});

test('formatPauseResult: stopped=0 且 failed>0 → 保留 done 0 与失败段（失败信息不吞）', () => {
  assert.equal(
    formatPauseResult({
      stopped: [],
      subagent: [],
      failed: [{ id: 'f', error: 'x' }, { id: 'g', error: 'y' }],
    }, stubT),
    'done 0 · fail 2',
  );
});

test('formatPauseResult: 脏输入不抛错——非对象返回空串、段非数组按 0 计', () => {
  assert.equal(formatPauseResult(null, stubT), '');
  assert.equal(formatPauseResult(undefined, stubT), '');
  assert.equal(formatPauseResult('nope', stubT), '');
  assert.equal(formatPauseResult(42, stubT), '');
});

test('formatPauseResult: t 非函数回退内置 zh 字典（zh 为权威）', () => {
  assert.equal(formatPauseResult({ stopped: [], subagent: [], failed: [] }), '没有正在运行的会话');
  assert.equal(formatPauseResult({ stopped: [{ id: 'a' }], subagent: [], failed: [] }), '已暂停 1 个会话');
  assert.equal(
    formatPauseResult({ stopped: [{ id: 'a' }], subagent: ['s'], failed: [{ id: 'f', error: 'x' }] }),
    '已暂停 1 个会话 · 1 个子代理会话由主会话接管 · 1 个失败',
  );
});
