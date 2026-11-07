/**
 * 0.33.0 冷 subagent 会话的宿主接线测试（node --test，mock cordis ctx、临时
 * DSH_HOME；无 e2e、不起服务、绝不读写真实 ~/.dsh）。
 *
 * 术语：「热会话」= session store（`ctx.reflect.get('sessions')`）里有活 Session 的
 * 会话；「冷会话」= 本进程没有活 agent、会话记录只落在磁盘上的会话（重启前被打断、
 * 恢复前尚未加载的会话）。宿主的 sessions store 只对热会话有条目，冷会话
 * `get(id)` 返回 undefined。0.33.0 起 lib/index.js 的 sessionHeaderLookup 在 store
 * 拿不到 header 时回退读磁盘首帧（lib/session-scan.js 的 readSessionHeaderFromDisk），
 * 于是冷 subagent 会话也能被认出来，交给父会话代理而不是直接 resume。
 *
 * 本文件逐条钉住行为口径（每条一个用例）：
 * 1. 冷 subagent 会话不再进入「直接恢复」候选，也不再出现在 GET /restart/info 的
 *    待恢复列表（directRestorableCandidates 同一条链自动生效）；
 * 2. 父会话是候选 → 结算 "subagent session; covered by candidate session <parent>"，
 *    不直接 resume 该子代理会话；
 * 3. 父会话被用户排除 → "subagent session; ancestor session <parent> excluded by
 *    user"，**绝不发 resume**；
 * 4. 父会话归档 → "subagent session; ancestor session <parent> is archived"；
 * 5. 父会话不是候选（不在窗口）→ 走既有 proxies 代理恢复（0.9.1 语义不变）；
 * 6. header origin:'subagent' 但缺/非法 parentSession → "subagent session; no
 *    resumable ancestor session found"；
 * 7. 磁盘也判定不了（记录缺失/坏）→ 维持现状：留在候选里由宿主 RemoteError 兜底，
 *    绝不因为读盘失败把候选当 subagent 丢掉；
 * 8. store 优先：热会话照旧只读 store 的 header（磁盘说什么都不看，0.9.1 逐字不变）；
 * 9. memo：磁盘 header 每进程只读一次——删掉会话记录后 /restart/info 仍按首次判定
 *    （同用例内对照：从没读到过记录的会话照旧是候选）。读盘只走首帧、只读前几 KB 的
 *    证据在 lib/session-header.test.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifySubagentDisposition } from './detect.js';
import { apply } from './index.js';

/** 会话记录根下的项目目录名（DSH 的 slug 形状）。 */
const PROJECT_DIR = '--code-www-my-gitee-my-ai--';
/** 冷 subagent 会话 id（沿用实测事故里的真实 id 形状）。 */
const SUB = '9ae5a36c-f8a4-47ab-a576-8b26bb3498fb';
/** 它的父会话（主会话，带 session- 前缀）。 */
const PARENT = 'session-b1827f5a-a5e2-4650-83e8-eb072b98ae6a';
const T_SUB = 1_700_000_000_002;
const T_PARENT = 1_700_000_000_001;

/** mock cordis ctx：webServer 捕获路由、agents 可注入、reflect 按服务名应答。 */
function buildCtx({ archivedIds, workspaceRegistry, sessions, agents, sessionController } = {}) {
  const captured = { route: null };
  const ctx = {
    on() { return () => {}; },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          webServer: {
            host: '127.0.0.1',
            register(route) { captured.route = route; },
            server: { address: () => ({ port: 3080 }) },
          },
        });
      }
      if (deps.includes('agents')) cb({ agents: agents ?? { roots: () => [], list: () => [] } });
    },
    effect(fn) { fn(); },
    reflect: {
      get(name) {
        if (name === 'workspaceRegistry') {
          if (workspaceRegistry !== undefined) return workspaceRegistry;
          return archivedIds ? { archivedSessionIds: archivedIds } : undefined;
        }
        if (name === 'sessions') return sessions ?? undefined;
        if (name === 'sessionController') return sessionController ?? undefined;
        return undefined; // 其余服务一律缺失
      },
    },
    get() { return undefined; },
  };
  return { ctx, captured };
}

/** 播种上次 marker（pid 不同 → 本次启动判定为重启，恢复流程照常走一遍）。 */
function seedMarker(dshHome, recentSessions) {
  const stateDir = join(dshHome, '.resume-on-restart');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'marker.json'), JSON.stringify({
    lastBootAt: new Date(Date.now() - 60_000).toISOString(),
    pid: process.pid + 4321,
    recentSessions,
  }, null, 2));
}

/** 用户排除名单（`{ sessions: { id: atISO } }`，与 writeExclusions 同形状）。 */
function excludeSession(dshHome, sessionId) {
  const stateDir = join(dshHome, '.resume-on-restart');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'excluded-sessions.json'), JSON.stringify({
    sessions: { [sessionId]: new Date().toISOString() },
  }, null, 2));
}

/** 会话记录文件路径：主会话目录 `session-<uuid>`、子代理会话目录裸 `<uuid>`。 */
function sessionRecordFileOf(dshHome, sessionId) {
  const uuid = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  const dirName = sessionId.startsWith('session-') ? `session-${uuid}` : uuid;
  return join(dshHome, 'sessions', PROJECT_DIR, dirName, 'session.v4.jsonl');
}

/** 在磁盘上写一条会话记录（首行 = header，即冷会话 header 的唯一真源）。 */
function writeSessionRecord(dshHome, sessionId, header) {
  const file = sessionRecordFileOf(dshHome, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(header)}\n`, 'utf8');
  return file;
}

/** 删掉某会话的磁盘记录（模拟「磁盘也判定不了」/ memo 证据里的对照）。 */
function dropSessionRecord(dshHome, sessionId) {
  rmSync(dirname(sessionRecordFileOf(dshHome, sessionId)), { recursive: true, force: true });
}

/** 冷 subagent 会话记录的 header（实测 DSH 首行形状）。 */
const subagentHeader = (parentSession = PARENT) => ({
  type: 'session',
  version: 4,
  id: SUB,
  createdAt: 1794029836193,
  cwd: '/code/www/my/gitee/my-ai',
  origin: 'subagent',
  parentSession,
  delegationDepth: 1,
});

/** 主会话记录的 header（无 origin/parentSession = 不是 subagent）。 */
const mainHeader = (id) => ({
  type: 'session',
  version: 4,
  id,
  createdAt: 1794029836193,
  cwd: '/code/www/my/gitee/my-ai',
});

/** 读 ndjson 文件全部条目（缺失/损坏返回空数组）。 */
function readNdjson(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 某会话的 restore 结算条目（同 id 可能多条，按写入顺序）。 */
const settlementsOf = (dshHome, sessionId) => readNdjson(join(dshHome, '.resume-on-restart', 'restarts.ndjson'))
  .filter((entry) => entry.type === 'restore' && entry.id === sessionId)
  .map((entry) => ({ result: entry.result, error: entry.error }));

/** wake.log 里某会话的投递记录。 */
const wakeEntriesOf = (dshHome, sessionId) => readNdjson(join(dshHome, '.resume-on-restart', 'wake.log'))
  .filter((entry) => entry.deliveredTo === sessionId);

/** 直接调用捕获的 prefix 路由 handler（同 tools/smoke.mjs 的方式，无真实 HTTP）。 */
const callRoute = (route, sub) => new Promise((resolve) => {
  const req = {
    method: 'GET',
    url: `/api/dsh-resume-on-restart${sub}`,
    headers: { host: '127.0.0.1:3080' },
    on() {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = {
    writeHead(status) { this.status = status; },
    end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }); },
  };
  route.handler(req, res);
});

/** 等恢复流程的异步 IIFE 收尾。 */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 120); });

/** 服务桩：resolveAgent 记录被恢复的会话 id；agents.list 空数组 = 此刻没有会话在运行。 */
function buildServices({ resumed, resumes = true } = {}) {
  const fakeAgent = { id: 'primary-fake', followup() {}, inject() {} };
  const sessionController = resumes
    ? {
      resolveAgent: async (id) => {
        resumed.push(id);
        return { agent: fakeAgent };
      },
    }
    : undefined;
  return {
    fakeAgent,
    sessionController,
    agents: { roots: () => [fakeAgent], list: () => [] },
  };
}

/** 启插件（回到开机恢复流程）+ 等恢复异步流程收尾。 */
async function boot(dshHome, options = {}) {
  const resumed = [];
  const services = buildServices({ resumed, resumes: options.resumes });
  const { ctx, captured } = buildCtx({
    archivedIds: options.archivedIds,
    sessions: options.sessions,
    sessionController: services.sessionController,
    agents: services.agents,
  });
  apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 50 });
  assert.ok(captured.route, 'webServer 路由应已注册');
  await settle();
  return { resumed, captured, fakeAgent: services.fakeAgent };
}

/** /restart/info 的待恢复候选 id（顺序 = 候选池顺序）。 */
const candidateIdsOf = async (captured) => {
  const info = await callRoute(captured.route, '/restart/info');
  assert.equal(info.status, 200);
  return info.body.runningCandidates.map((row) => row.id);
};

// ---- 1. 冷 subagent 不再进「直接恢复」候选，也不再出现在 /restart/info ----

test('0.33.0 冷 subagent: 不在 /restart/info 待恢复列表、不进直接恢复候选（父会话照旧在）', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-info-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, [
      { id: SUB, at: T_SUB, running: true },
      { id: PARENT, at: T_PARENT, running: true },
    ]);
    // 两个会话都是冷会话：store 里没有条目，header 只在磁盘上
    writeSessionRecord(dshHome, SUB, subagentHeader());
    writeSessionRecord(dshHome, PARENT, mainHeader(PARENT));
    const { resumed, captured } = await boot(dshHome, { sessions: { get: () => undefined } });

    assert.deepEqual(await candidateIdsOf(captured), [PARENT], '冷 subagent 必须从待恢复列表消失');
    assert.ok(!resumed.includes(SUB), '冷 subagent 绝不能被直接 resume');
    assert.ok(resumed.includes(PARENT), '父会话照旧恢复');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 2. 父会话是候选 → covered by candidate session ----

test('0.33.0 冷 subagent: 父会话是候选 → 结算 covered by candidate session，不直接 resume', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-covered-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, [
      { id: SUB, at: T_SUB, running: true },
      { id: PARENT, at: T_PARENT, running: true },
    ]);
    writeSessionRecord(dshHome, SUB, subagentHeader());
    writeSessionRecord(dshHome, PARENT, mainHeader(PARENT));
    const { resumed } = await boot(dshHome, { sessions: { get: () => undefined } });

    assert.deepEqual(settlementsOf(dshHome, SUB), [
      { result: 'subagent', error: `subagent session; covered by candidate session ${PARENT}` },
    ]);
    const wake = wakeEntriesOf(dshHome, SUB);
    assert.equal(wake.length, 1);
    assert.equal(wake[0].ok, false);
    assert.equal(wake[0].error, `subagent session; covered by candidate session ${PARENT}`);
    assert.ok(!resumed.includes(SUB), '子代理会话本身绝不发 resume');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 3. 父会话被用户排除 → 绝不发 resume ----

test('0.33.0 冷 subagent: 父会话被用户排除 → excluded by user 结算，绝不发 resume', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-excluded-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, [
      { id: SUB, at: T_SUB, running: true },
      { id: PARENT, at: T_PARENT, running: true },
    ]);
    writeSessionRecord(dshHome, SUB, subagentHeader());
    writeSessionRecord(dshHome, PARENT, mainHeader(PARENT));
    excludeSession(dshHome, PARENT);
    const { resumed } = await boot(dshHome, { sessions: { get: () => undefined } });

    assert.deepEqual(settlementsOf(dshHome, SUB), [
      { result: 'subagent', error: `subagent session; ancestor session ${PARENT} excluded by user` },
    ]);
    assert.deepEqual(resumed, [], '被排除的父会话与它的子代理会话都绝不应发 resume');
    assert.ok(!resumed.includes(SUB));
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 4. 父会话归档 → 不代理、不 resume（归档过滤先剔同 lineage；文案见纯函数用例） ----

test('0.33.0 冷 subagent: 父会话归档 → 随父会话被判归档、不代理恢复、绝不 resume', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-archived-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, [
      { id: SUB, at: T_SUB, running: true },
      { id: PARENT, at: T_PARENT, running: true },
    ]);
    writeSessionRecord(dshHome, SUB, subagentHeader());
    writeSessionRecord(dshHome, PARENT, mainHeader(PARENT));
    const { resumed } = await boot(dshHome, {
      sessions: { get: () => undefined },
      archivedIds: [PARENT],
    });

    // 归档过滤（0.9.0，先于 subagent 拆分）沿 lineage 把这个冷子代理会话一并剔除，
    // 结算 result:'archived'（与归档候选同口径，不算失败）；「ancestor … is archived」
    // 是 lineage 走不通时的防御式兜底文案，由 classifySubagentDisposition 单测钉住。
    assert.deepEqual(settlementsOf(dshHome, SUB), [{ result: 'archived', error: 'session is archived' }]);
    assert.ok(!resumed.includes(SUB));
    assert.ok(!resumed.includes(PARENT), '归档父会话不恢复');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 5. 父会话不是候选（不在窗口）→ 走既有 proxies 代理恢复 ----

test('0.33.0 冷 subagent: 父会话不是候选 → resume delegated to ancestor（proxies 代理恢复，0.9.1 语义不变）', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-delegated-'));
  process.env.DSH_HOME = dshHome;
  try {
    // 父会话不在 marker 的最近活跃列表里（不在窗口）→ 不是候选
    seedMarker(dshHome, [{ id: SUB, at: T_SUB, running: true }]);
    writeSessionRecord(dshHome, SUB, subagentHeader());
    const { resumed } = await boot(dshHome, { sessions: { get: () => undefined } });

    assert.deepEqual(settlementsOf(dshHome, SUB), [
      { result: 'subagent', error: `subagent session; resume delegated to ancestor session ${PARENT}` },
    ]);
    assert.ok(resumed.includes(PARENT), '父会话应作为代理目标被恢复');
    assert.ok(!resumed.includes(SUB), '子代理会话本身绝不发 resume');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 6. origin:'subagent' 但缺/非法 parentSession ----

test('0.33.0 冷 subagent: 缺/非法 parentSession → no resumable ancestor session found', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-noancestor-'));
  process.env.DSH_HOME = dshHome;
  try {
    const noParent = 'cold-sub-no-parent';
    const badParent = 'cold-sub-bad-parent';
    seedMarker(dshHome, [
      { id: noParent, at: T_SUB, running: true },
      { id: badParent, at: T_SUB - 1, running: true },
    ]);
    writeSessionRecord(dshHome, noParent, { ...subagentHeader(), parentSession: undefined });
    writeSessionRecord(dshHome, badParent, subagentHeader(42));
    const { resumed } = await boot(dshHome, { sessions: { get: () => undefined } });

    for (const id of [noParent, badParent]) {
      assert.deepEqual(settlementsOf(dshHome, id), [
        { result: 'subagent', error: 'subagent session; no resumable ancestor session found' },
      ]);
      assert.ok(!resumed.includes(id), `${id} 绝不发 resume`);
    }
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 7. 磁盘也判定不了 → 维持现状（留在候选里） ----

test('0.33.0 冷会话: 磁盘也判定不了（记录缺失/坏）→ 维持现状留在候选里，绝不因读盘失败丢弃', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-unknown-'));
  process.env.DSH_HOME = dshHome;
  try {
    const missing = 'cold-sub-record-missing';
    const broken = 'cold-sub-record-broken';
    seedMarker(dshHome, [
      { id: missing, at: T_SUB, running: true },
      { id: broken, at: T_SUB - 1, running: true },
    ]);
    // missing：完全没有磁盘记录；broken：首行坏 JSON（解不出 header）
    writeSessionRecord(dshHome, broken, '{broken json');
    assert.ok(!readNdjson(sessionRecordFileOf(dshHome, missing)).length, 'missing 会话不应有记录文件');
    const { resumed, captured } = await boot(dshHome, { sessions: { get: () => undefined } });

    assert.deepEqual(await candidateIdsOf(captured), [missing, broken], '判定不了的会话必须维持现状（留在候选里）');
    assert.deepEqual(resumed, [missing, broken], '判定不了就按普通候选照旧尝试恢复（由宿主兜底）');
    assert.deepEqual(settlementsOf(dshHome, missing), [{ result: 'resumed', error: null }]);
    assert.deepEqual(settlementsOf(dshHome, broken), [{ result: 'resumed', error: null }]);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 8. store 优先：热会话行为逐字不变 ----

test('0.33.0 热会话: store 有 header 就只认 store（磁盘记录写 subagent 也不影响）', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-hot-'));
  process.env.DSH_HOME = dshHome;
  try {
    const HOT = 'hot-main-session';
    seedMarker(dshHome, [{ id: HOT, at: T_SUB, running: true }]);
    // 磁盘记录故意写成 subagent：热会话只看 store，绝不应被它影响
    writeSessionRecord(dshHome, HOT, { ...subagentHeader(), id: HOT });
    const { resumed, captured } = await boot(dshHome, {
      sessions: { get: (id) => (id === HOT ? { header: mainHeader(HOT) } : undefined) },
    });

    assert.deepEqual(await candidateIdsOf(captured), [HOT], 'store 说不是 subagent 就是普通候选');
    assert.deepEqual(settlementsOf(dshHome, HOT), [{ result: 'resumed', error: null }]);
    assert.deepEqual(resumed, [HOT]);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 9. memo：磁盘 header 每进程只读一次 ----

test('0.33.0 冷会话 memo: 删掉会话记录后 /restart/info 仍按首次读到的 header 判定（不再读盘）', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-cold-memo-'));
  process.env.DSH_HOME = dshHome;
  try {
    const memoized = 'cold-sub-memoized';
    const control = 'cold-sub-control';
    seedMarker(dshHome, [
      { id: memoized, at: T_SUB, running: true },
      { id: control, at: T_SUB - 1, running: true },
    ]);
    writeSessionRecord(dshHome, memoized, { ...subagentHeader(), id: memoized });
    writeSessionRecord(dshHome, control, { ...subagentHeader(), id: control });
    // 对照：control 的记录在开机前就删掉 → 磁盘判定不了 → 维持现状留在候选里
    dropSessionRecord(dshHome, control);
    const { captured } = await boot(dshHome, { sessions: { get: () => undefined } });

    assert.deepEqual(await candidateIdsOf(captured), [control], '首次：memoized 已按 subagent 剔除，control 判定不了照旧在');

    // 删掉 memoized 的磁盘记录：若每次重新读盘，它就会被判 unknown 而重新变成候选
    dropSessionRecord(dshHome, memoized);
    assert.deepEqual(
      await candidateIdsOf(captured),
      [control],
      'memo 生效：判过一次的 header 不再读盘，第二次 /restart/info 结果不变',
    );
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 10. 结算文案的纯函数口径（detect.js classifySubagentDisposition，逐条钉住） ----
// 这五种 mode 就是「子代理会话只能由父会话代理、绝不直接 resume」的全部出口：
// covered / excluded / archived / delegated / none。文案与本插件重启日志、wake.log
// 的历史口径逐字一致（covered/excluded/archived/delegated/none 五句）。

test('classifySubagentDisposition: 父会话是候选 → covered by candidate session', () => {
  assert.deepEqual(
    classifySubagentDisposition({
      ancestorId: PARENT,
      mainOwnedIds: [{ id: PARENT, at: T_PARENT }],
      excludedIds: {},
      archivedIds: new Set(),
    }),
    { mode: 'covered', text: `subagent session; covered by candidate session ${PARENT}` },
  );
});

test('classifySubagentDisposition: 父会话被用户排除 → excluded by user（绝不代理）', () => {
  assert.deepEqual(
    classifySubagentDisposition({
      ancestorId: PARENT,
      mainOwnedIds: [],
      excludedIds: { [PARENT]: new Date().toISOString() },
      archivedIds: [],
    }),
    { mode: 'excluded', text: `subagent session; ancestor session ${PARENT} excluded by user` },
  );
});

test('classifySubagentDisposition: 父会话归档 → is archived（绝不代理）', () => {
  assert.deepEqual(
    classifySubagentDisposition({
      ancestorId: PARENT,
      mainOwnedIds: [],
      excludedIds: {},
      archivedIds: new Set([PARENT]),
    }),
    { mode: 'archived', text: `subagent session; ancestor session ${PARENT} is archived` },
  );
});

test('classifySubagentDisposition: 父会话不是候选 → resume delegated to ancestor（0.9.1 代理恢复）', () => {
  assert.deepEqual(
    classifySubagentDisposition({
      ancestorId: PARENT,
      mainOwnedIds: [{ id: 'other-session', at: T_SUB }],
      excludedIds: {},
      archivedIds: [],
    }),
    { mode: 'delegated', text: `subagent session; resume delegated to ancestor session ${PARENT}` },
  );
});

test('classifySubagentDisposition: 缺/非法 ancestorId → no resumable ancestor session found', () => {
  for (const ancestorId of [null, undefined, '', 42, {}]) {
    assert.deepEqual(
      classifySubagentDisposition({ ancestorId, mainOwnedIds: [], excludedIds: {}, archivedIds: [] }),
      { mode: 'none', text: 'subagent session; no resumable ancestor session found' },
      `ancestorId=${JSON.stringify(ancestorId)} 应判 none`,
    );
  }
});

test('classifySubagentDisposition: 优先级 covered > excluded > archived > delegated，脏输入不抛错', () => {
  // 同时命中三者：covered 优先（父会话会成为候选，子代理工作经它继续）
  const all = classifySubagentDisposition({
    ancestorId: PARENT,
    mainOwnedIds: new Set([PARENT]),
    excludedIds: new Set([PARENT]),
    archivedIds: [PARENT],
  });
  assert.equal(all.mode, 'covered');
  // excluded 优先于 archived
  const excludedFirst = classifySubagentDisposition({
    ancestorId: PARENT,
    mainOwnedIds: [],
    excludedIds: [PARENT],
    archivedIds: [PARENT],
  });
  assert.equal(excludedFirst.mode, 'excluded');
  // 脏输入（mainOwnedIds 是 Set/对象混排、excludedIds 是数组、archivedIds 是对象）
  // 一律按空集合处理，最终落到 delegated，绝不抛错
  assert.equal(classifySubagentDisposition({
    ancestorId: PARENT,
    mainOwnedIds: 'nope',
    excludedIds: 'nope',
    archivedIds: { [PARENT]: true },
  }).mode, 'delegated');
  assert.deepEqual(classifySubagentDisposition(), {
    mode: 'none',
    text: 'subagent session; no resumable ancestor session found',
  });
});
