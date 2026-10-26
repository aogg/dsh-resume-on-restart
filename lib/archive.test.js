/**
 * 0.9.0 归档会话过滤的单元测试（node --test，无 e2e、不起任何服务）：
 * 1. 纯函数层（lib/detect.js）：归档名单归一化、ArchivedSessionGate 同款
 *    lineage 判定（自身/直系/多级祖先/缺失父会话/fork 不继承/防环）、
 *    候选过滤（含空名单零 lookup 与 store 缺失只查直系）、回退决策
 *    （archived 不触发 fallback、用户排除/可恢复失败仍回退）；
 * 2. 宿主接线层（lib/index.js，mock cordis ctx）：GET /restart/info 的候选
 *    计数口径剔除归档（含 subagent 后代）、候选全归档时的安静收尾
 *    （result: 'archived' 结算 + 不 fallbackWake）、workspaceRegistry 缺失时
 *    行为完全不变（候选照旧 + 回退通知照旧）；
 * 3. 0.10.0 恢复口径接线（反转 0.4.0）：手动停止（running:false）的会话
 *    重启后同样恢复并显示顶栏开关——播种沿用 marker 最后已知 running、
 *    boot 记录 runningSessions 如实取条目值、恢复候选循环与 GET /state
 *    的 restoreCandidates 都含 running:false 会话；
 * 4. 0.13.0 候选明细接线：GET /restart/info 的 runningCandidates 为对象数组
 *    [{ id, at, running, title? }]（真实最后活跃时间/运行态、归档剔除口径不变、
 *    title 防御探测——session projection（sessionProjections.stateOf）优先、
 *    record.title/header.title 回退，stateOf 未落地/store.get undefined/服务
 *    全缺失一律不带 title 且路由 200）。
 * DSH_HOME 重定向到临时目录，绝不读写真实 ~/.dsh。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyRestoreFallback,
  filterArchivedCandidates,
  normalizeArchivedSessionIds,
  sessionUnderArchivedLineage,
} from './detect.js';
import { apply } from './index.js';

// ---- normalizeArchivedSessionIds：防御式归一化 ----

test('normalizeArchivedSessionIds: 只收非空字符串并去重，非法元素忽略', () => {
  assert.deepEqual(
    [...normalizeArchivedSessionIds(['a', 'b', 'a', 42, null, '', {}, 'c'])],
    ['a', 'b', 'c'],
  );
});

test('normalizeArchivedSessionIds: 非数组输入一律空 Set（registry 缺失 = 不过滤）', () => {
  assert.equal(normalizeArchivedSessionIds(undefined).size, 0);
  assert.equal(normalizeArchivedSessionIds(null).size, 0);
  assert.equal(normalizeArchivedSessionIds('a,b').size, 0);
  assert.equal(normalizeArchivedSessionIds({ archivedSessionIds: ['a'] }).size, 0);
});

// ---- sessionUnderArchivedLineage：与 ArchivedSessionGate 同规则 ----

test('lineage: 会话自身在名单 → true（不需要 store）', () => {
  assert.equal(sessionUnderArchivedLineage('s1', ['s1', 's2'], null), true);
});

test('lineage: 不在名单且拿不到 store（lookup null）→ false（只查直系名单）', () => {
  assert.equal(sessionUnderArchivedLineage('s1', ['s2'], null), false);
});

test('lineage: subagent 直接子代，父会话归档 → true', () => {
  const lookup = (id) => (id === 'c1' ? { origin: 'subagent', parentSession: 'p1' } : null);
  assert.equal(sessionUnderArchivedLineage('c1', ['p1'], lookup), true);
});

test('lineage: 多级祖先（孙代沿 header 向上）→ true', () => {
  const headers = {
    c2: { origin: 'subagent', parentSession: 'c1' },
    c1: { origin: 'subagent', parentSession: 'p1' },
    p1: { parentSession: undefined },
  };
  const lookup = (id) => headers[id] ?? null;
  assert.equal(sessionUnderArchivedLineage('c2', ['p1'], lookup), true);
});

test('lineage: 父会话不在 store，但父 id 在名单 → true（gate 对缺失父会话同款）', () => {
  const lookup = (id) => (id === 'c1' ? { origin: 'subagent', parentSession: 'p-gone' } : null);
  assert.equal(sessionUnderArchivedLineage('c1', ['p-gone'], lookup), true);
});

test('lineage: 父会话不在 store 且不在名单 → false', () => {
  const lookup = (id) => (id === 'c1' ? { origin: 'subagent', parentSession: 'p-gone' } : null);
  assert.equal(sessionUnderArchivedLineage('c1', [], lookup), false);
});

test('lineage: fork（origin 非 subagent）不继承归档 → false', () => {
  assert.equal(sessionUnderArchivedLineage('f1', ['p1'], () => ({ parentSession: 'p1' })), false);
  assert.equal(sessionUnderArchivedLineage('f2', ['p1'], () => ({ origin: 'fork', parentSession: 'p1' })), false);
});

test('lineage: origin 是 subagent 但 parentSession 缺失/非法 → false', () => {
  assert.equal(sessionUnderArchivedLineage('s1', ['p1'], () => ({ origin: 'subagent' })), false);
  assert.equal(sessionUnderArchivedLineage('s2', ['p1'], () => ({ origin: 'subagent', parentSession: 42 })), false);
});

test('lineage: 环形 lineage 被 visited 防护终止（不死循环）', () => {
  const lookup = (id) => ({ origin: 'subagent', parentSession: id === 'a' ? 'b' : 'a' });
  assert.equal(sessionUnderArchivedLineage('a', ['zzz'], lookup), false);
});

test('lineage: id 非法 → false；archivedIds 传数组（未归一化）也能用', () => {
  assert.equal(sessionUnderArchivedLineage('', ['a'], null), false);
  assert.equal(sessionUnderArchivedLineage(42, ['a'], null), false);
  assert.equal(sessionUnderArchivedLineage('a', ['a'], null), true);
});

// ---- filterArchivedCandidates：候选过滤（形状与 filterExcludedCandidates 对齐） ----

const CANDS = [
  { id: 'direct', at: 3000 },
  { id: 'child', at: 2000 },
  { id: 'live', at: 1000 },
];
const HEADERS = { child: { origin: 'subagent', parentSession: 'p1' } };

test('filterArchivedCandidates: 直系归档 + subagent 后代剔除，kept 顺序保持', () => {
  const { kept, archived } = filterArchivedCandidates(
    CANDS,
    ['direct', 'p1'],
    (id) => HEADERS[id] ?? null,
  );
  assert.deepEqual(kept, [{ id: 'live', at: 1000 }]);
  assert.deepEqual(archived, [
    { id: 'direct', at: 3000 },
    { id: 'child', at: 2000 },
  ]);
});

test('filterArchivedCandidates: 名单为空（registry 缺失）→ 全部 kept 且零次 lookup', () => {
  const boom = () => {
    throw new Error('名单为空时不应触发任何 header lookup');
  };
  assert.deepEqual(filterArchivedCandidates(CANDS, [], boom), { kept: CANDS, archived: [] });
  assert.deepEqual(filterArchivedCandidates(CANDS, undefined, boom), { kept: CANDS, archived: [] });
});

test('filterArchivedCandidates: 拿不到 store（lookup null）→ 只查直系名单，后代不剔除', () => {
  const { kept, archived } = filterArchivedCandidates(CANDS, ['direct', 'p1'], null);
  assert.deepEqual(kept, [
    { id: 'child', at: 2000 },
    { id: 'live', at: 1000 },
  ]);
  assert.deepEqual(archived, [{ id: 'direct', at: 3000 }]);
});

test('filterArchivedCandidates: 非法输入按空处理，绝不抛错', () => {
  assert.deepEqual(filterArchivedCandidates('nope', ['a'], null), { kept: [], archived: [] });
  assert.deepEqual(filterArchivedCandidates(null, ['a'], null), { kept: [], archived: [] });
  assert.deepEqual(
    filterArchivedCandidates([{ id: 'a', at: 0 }], ['a'], null),
    { kept: [], archived: [{ id: 'a', at: 0 }] },
  );
});

// ---- classifyRestoreFallback：回退决策（archived 不触发 fallback） ----

test('classifyRestoreFallback: 有候选恢复成功 → 不回退', () => {
  assert.deepEqual(classifyRestoreFallback({ restored: true, keptCount: 1, archivedCount: 2 }), { fallback: false });
});

test('classifyRestoreFallback: 无可恢复候选且确有归档剔除 → 安静收尾不回退', () => {
  assert.deepEqual(classifyRestoreFallback({ restored: false, keptCount: 0, archivedCount: 2 }), {
    fallback: false,
    quiet: true,
  });
});

test('classifyRestoreFallback: 全部用户排除（无归档）→ 仍回退（既有行为不变）', () => {
  assert.deepEqual(classifyRestoreFallback({ restored: false, keptCount: 0, archivedCount: 0 }), { fallback: true });
  assert.deepEqual(classifyRestoreFallback({ restored: false }), { fallback: true });
});

test('classifyRestoreFallback: 可恢复候选失败 → 回退（含归档与可恢复并存的场景）', () => {
  assert.deepEqual(classifyRestoreFallback({ restored: false, keptCount: 2, archivedCount: 0 }), { fallback: true });
  assert.deepEqual(classifyRestoreFallback({ restored: false, keptCount: 1, archivedCount: 3 }), { fallback: true });
});

test('classifyRestoreFallback: 脏输入保守回退（通知是保证必达的兜底方向）', () => {
  assert.deepEqual(classifyRestoreFallback(undefined), { fallback: true });
  assert.deepEqual(classifyRestoreFallback({ restored: 'yes', keptCount: 'x', archivedCount: NaN }), { fallback: true });
});

// ---- 宿主接线层（mock ctx，不起服务、不发网络） ----

/** mock cordis ctx：webServer 捕获路由、agents 可注入、reflect 按服务名应答。 */
function buildCtx({ archivedIds, sessions, sessionProjections, agents, sessionController, reflectThrows = [] }) {
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
        if (reflectThrows.includes(name)) throw new Error(`service ${name} exploded`);
        if (name === 'workspaceRegistry') {
          return archivedIds ? { archivedSessionIds: archivedIds } : undefined;
        }
        if (name === 'sessions') return sessions ?? undefined;
        if (name === 'sessionProjections') return sessionProjections ?? undefined;
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

/** 读取 ndjson 文件全部条目（缺失/损坏返回空数组）。 */
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

// 场景数据：direct 在名单；child 是归档 p1 的 subagent 后代；live 正常可恢复。
const SCENARIO_SESSIONS = [
  { id: 'direct', at: 1_700_000_000_002, running: true },
  { id: 'child', at: 1_700_000_000_001, running: true },
  { id: 'live', at: 1_700_000_000_000, running: true },
];
const SCENARIO_HEADERS = { child: { origin: 'subagent', parentSession: 'p1' } };

test('宿主接线: /restart/info 候选数与恢复同口径剔除归档（含 subagent 后代）', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-archive-info-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, SCENARIO_SESSIONS);
    const fakeAgent = { id: 'primary-fake', followup() {}, inject() {} };
    const { ctx, captured } = buildCtx({
      archivedIds: ['direct', 'p1'],
      sessions: { get: (id) => (SCENARIO_HEADERS[id] ? { header: SCENARIO_HEADERS[id] } : undefined) },
      agents: { roots: () => [fakeAgent], list: () => [fakeAgent] },
    });
    apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 1 });
    assert.ok(captured.route, 'webServer 路由应已注册');
    const info = await callRoute(captured.route, '/restart/info');
    assert.equal(info.status, 200);
    // 0.13.0：候选明细为对象数组（真实 at/running）；direct（直系归档）与
    // child（归档后代）都被剔除、只留 live——归档剔除口径完全不变；
    // mock sessions 无 title（get 返回 { header }）→ 一律不带 title 字段
    assert.deepEqual(info.body.runningCandidates, [
      { id: 'live', at: new Date(1_700_000_000_000).toISOString(), running: true },
    ]);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('宿主接线: 候选全被归档剔除 → result archived 结算、安静收尾不 fallback', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-archive-quiet-'));
  process.env.DSH_HOME = dshHome;
  try {
    // 场景里没有可恢复候选：direct 与 child 都处于归档 lineage
    seedMarker(dshHome, SCENARIO_SESSIONS.filter((e) => e.id !== 'live'));
    let woken = false;
    const fakeAgent = { id: 'primary-fake', followup() { woken = true; }, inject() { woken = true; } };
    const { ctx } = buildCtx({
      archivedIds: ['direct', 'p1'],
      sessions: { get: (id) => (SCENARIO_HEADERS[id] ? { header: SCENARIO_HEADERS[id] } : undefined) },
      agents: { roots: () => [fakeAgent], list: () => [fakeAgent] },
    });
    apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 1 });
    await settle();
    assert.equal(woken, false, '全是归档会话 = 用户有意归档，不得唤醒主会话');
    const stateDir = join(dshHome, '.resume-on-restart');
    // wake.log：两条 archived 记录，绝无投递成功条目
    const wake = readNdjson(join(stateDir, 'wake.log'));
    assert.deepEqual(
      wake.map((e) => ({ deliveredTo: e.deliveredTo, ok: e.ok, error: e.error })).sort((a, b) => String(a.deliveredTo).localeCompare(String(b.deliveredTo))),
      [
        { deliveredTo: 'child', ok: false, error: 'session is archived' },
        { deliveredTo: 'direct', ok: false, error: 'session is archived' },
      ],
    );
    // 重启日志：restore 结算 union 新增 archived（不算 failed/resumed）
    const restarts = readNdjson(join(stateDir, 'restarts.ndjson'));
    const restoreEntries = restarts.filter((e) => e.type === 'restore');
    assert.deepEqual(
      restoreEntries.map((e) => ({ id: e.id, result: e.result })).sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 'child', result: 'archived' },
        { id: 'direct', result: 'archived' },
      ],
    );
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('宿主接线: workspaceRegistry 缺失 → 行为完全不变（候选照旧 + 回退通知照旧）', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-archive-legacy-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, SCENARIO_SESSIONS.filter((e) => e.id !== 'live'));
    let woken = false;
    const fakeAgent = { id: 'primary-fake', followup() { woken = true; }, inject() { woken = true; } };
    // 不提供 workspaceRegistry 与 sessions（老宿主/服务缺失形态）
    const { ctx, captured } = buildCtx({
      agents: { roots: () => [fakeAgent], list: () => [fakeAgent] },
    });
    apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 1 });
    await settle();
    // 候选口径不变：没有名单 → 不过滤（pickRestoreTargets 按 at 新 → 旧排序）；
    // 0.13.0 起为对象明细 [{ id, at, running }]（sessions/sessionProjections 服务
    // 全缺失 → title 读取链整体不可用，一律不带 title 字段，路由仍 200）
    const info = await callRoute(captured.route, '/restart/info');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.runningCandidates, [
      { id: 'direct', at: new Date(1_700_000_000_002).toISOString(), running: true },
      { id: 'child', at: new Date(1_700_000_000_001).toISOString(), running: true },
    ]);
    // 回退语义不变：sessionController 缺失 → 照旧 fallbackWake 通知主会话
    assert.equal(woken, true, 'registry 缺失时回退通知必须照旧（行为退化 = 现状）');
    const wake = readNdjson(join(dshHome, '.resume-on-restart', 'wake.log'));
    assert.ok(wake.some((e) => e.ok === true), 'wake.log 应有投递成功条目');
    assert.ok(!wake.some((e) => e.error === 'session is archived'), '不应出现 archived 结算');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 0.10.0 恢复口径（反转 0.4.0）：手动停止（running:false）的会话重启后同样恢复并显示开关 ----
// 接线层四件事同口径：播种沿用 marker 最后已知 running（未知回填 true）、
// boot 记录 runningSessions 如实取条目值、恢复候选循环含 running:false 会话、
// GET /state 的 restoreCandidates（顶栏开关显示门控）同样含它。

test('宿主接线: 手动停止(running:false)会话也是候选——播种沿用 running、boot 如实记录、恢复与显示同口径', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-resume-idle-'));
  process.env.DSH_HOME = dshHome;
  try {
    const idleAt = 1_700_000_000_002;
    const liveAt = 1_700_000_000_001;
    // idle 手动停止（running:false）、live 停止时仍运行、plain-old 纯字符串旧格式
    seedMarker(dshHome, [
      { id: 'idle', at: idleAt, running: false },
      { id: 'live', at: liveAt, running: true },
      'plain-old',
    ]);
    let woken = 0;
    const fakeAgent = { id: 'primary-fake', followup() { woken += 1; }, inject() {} };
    const { ctx, captured } = buildCtx({
      agents: { roots: () => [fakeAgent], list: () => [fakeAgent] },
      // sessionController 就绪：resolveAgent 一律成功 → 每个候选都真实走投递
      sessionController: { resolveAgent: async () => ({ agent: fakeAgent }) },
    });
    apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 50 });
    await settle();
    const stateDir = join(dshHome, '.resume-on-restart');
    const restarts = readNdjson(join(stateDir, 'restarts.ndjson'));
    // 1) boot 记录：runningSessions 含手动停止的 idle，running 如实取条目值
    //    （0.9.x 曾写死 true；纯字符串旧格式无该信息 → 回填 true）
    const boot = restarts.find((e) => e.type === 'boot');
    assert.deepEqual(boot.runningSessions, [
      { id: 'idle', at: new Date(idleAt).toISOString(), running: false },
      { id: 'live', at: new Date(liveAt).toISOString(), running: true },
      { id: 'plain-old', at: '', running: true },
    ]);
    // 2) 播种落盘：marker.recentSessions 沿用 marker 最后已知 running，不再一律回填 true
    const marker = JSON.parse(readFileSync(join(stateDir, 'marker.json'), 'utf8'));
    assert.deepEqual(
      marker.recentSessions.map((e) => ({ id: e.id, running: e.running })),
      [
        { id: 'idle', running: false },
        { id: 'live', running: true },
        { id: 'plain-old', running: true },
      ],
    );
    // 3) 恢复口径：idle（手动停止）与 live/plain-old 一样进入候选循环并投递成功
    //    （0.4.0 口径下 idle 根本不会成为候选）
    assert.deepEqual(
      restarts.filter((e) => e.type === 'restore').map((e) => ({ id: e.id, result: e.result })),
      [
        { id: 'idle', result: 'resumed' },
        { id: 'live', result: 'resumed' },
        { id: 'plain-old', result: 'resumed' },
      ],
    );
    assert.equal(woken, 3, '三个候选（含手动停止的 idle）都应投递恢复消息');
    // 4) 显示口径：GET /state 的 restoreCandidates 含手动停止的会话（顶栏开关对其渲染）
    const state = await callRoute(captured.route, '/state');
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.restoreCandidates, { idle: true, live: true, 'plain-old': true });
    // 5) 0.13.0 候选明细：/restart/info 携带真实 at（ISO，未知为 ''）与真实 running
    //    （手动停止的 idle 是 running:false；纯字符串旧格式无时间 → ''）
    const info = await callRoute(captured.route, '/restart/info');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.runningCandidates, [
      { id: 'idle', at: new Date(idleAt).toISOString(), running: false },
      { id: 'live', at: new Date(liveAt).toISOString(), running: true },
      { id: 'plain-old', at: '', running: true },
    ]);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

// ---- 0.13.0（修正）：候选明细的 title 读取链——session projection 优先、
//      record/header 回退；任何一层缺失/异常静默降级，绝不阻塞路由 ----

test('宿主接线: /restart/info 候选明细 title——sessionProjections.stateOf 首选，未落地回退 record.title/header.title', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-archive-title-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, [
      { id: 'projected', at: 1_700_000_000_003, running: true },
      { id: 'proj-null', at: 1_700_000_000_002, running: false },
      { id: 'recordtitle', at: 1_700_000_000_001, running: true },
      { id: 'notitle', at: 1_700_000_000_000, running: true },
    ]);
    const fakeAgent = { id: 'primary-fake', followup() {}, inject() {} };
    // sessions.get 返回活 Session 对象（DSH 真实形状：标题不在 header，在
    // session/title 投影）；store 里没有的 id（notitle）→ undefined
    const SESSIONS = {
      projected: { header: {} },
      'proj-null': { header: { title: 'header 回退标题' } },
      recordtitle: { title: 'record 回退标题' },
    };
    const PROJECTED = { projected: '投影会话标题' };
    let stateOfCalls = 0;
    const { ctx, captured } = buildCtx({
      agents: { roots: () => [fakeAgent], list: () => [fakeAgent] },
      sessions: { get: (id) => SESSIONS[id] ?? undefined },
      sessionProjections: {
        // 首选链路：stateOf(session, 'title') 的 last-wins 投影（null = title 未落地）
        stateOf(session, key) {
          stateOfCalls += 1;
          assert.equal(key, 'title');
          // stateOf 只接受 sessions store 的活 Session 对象——绝不能用 id/自造对象去调
          assert.equal(typeof session, 'object');
          assert.notEqual(session, null);
          const hit = Object.entries(SESSIONS).find(([, v]) => v === session);
          const id = hit ? hit[0] : null;
          return id !== null && PROJECTED[id] !== undefined ? PROJECTED[id] : null;
        },
      },
    });
    apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 1 });
    await settle();
    const info = await callRoute(captured.route, '/restart/info');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.runningCandidates, [
      { id: 'projected', at: new Date(1_700_000_000_003).toISOString(), running: true, title: '投影会话标题' },
      // 投影未落地（null）→ 回退 header.title
      { id: 'proj-null', at: new Date(1_700_000_000_002).toISOString(), running: false, title: 'header 回退标题' },
      // 投影未命中 → 回退 record.title
      { id: 'recordtitle', at: new Date(1_700_000_000_001).toISOString(), running: true, title: 'record 回退标题' },
      // store.get 为 undefined（未入 store/被逐出）→ 不造对象调 stateOf、不带 title
      { id: 'notitle', at: new Date(1_700_000_000_000).toISOString(), running: true },
    ]);
    assert.equal(stateOfCalls, 3, 'stateOf 只对拿到的活 Session 对象调用（notitle 不调）');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('宿主接线: sessions store 缺失 → sessionProjections 在也无活 Session 可调，一律不带 title 且路由 200', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-archive-title-nostore-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, [{ id: 'live', at: 1_700_000_000_000, running: true }]);
    const fakeAgent = { id: 'primary-fake', followup() {}, inject() {} };
    const { ctx, captured } = buildCtx({
      agents: { roots: () => [fakeAgent], list: () => [fakeAgent] },
      sessionProjections: {
        stateOf() { throw new Error('never called: 无 sessions store 就没有活 Session 对象'); },
      },
    });
    apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 1 });
    await settle();
    const info = await callRoute(captured.route, '/restart/info');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.runningCandidates, [
      { id: 'live', at: new Date(1_700_000_000_000).toISOString(), running: true },
    ]);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('宿主接线: sessionProjections 探测抛异常 → console 降级，record/header 回退照常', async () => {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-archive-title-projboom-'));
  process.env.DSH_HOME = dshHome;
  try {
    seedMarker(dshHome, [{ id: 'live', at: 1_700_000_000_000, running: true }]);
    const fakeAgent = { id: 'primary-fake', followup() {}, inject() {} };
    const { ctx, captured } = buildCtx({
      agents: { roots: () => [fakeAgent], list: () => [fakeAgent] },
      sessions: { get: (id) => (id === 'live' ? { header: { title: '回退标题' } } : undefined) },
      reflectThrows: ['sessionProjections'],
    });
    apply(ctx, { enabled: true, requireHumanPrompt: false, serviceWaitTimeoutMs: 1, restoreTimeoutMs: 1 });
    await settle();
    const info = await callRoute(captured.route, '/restart/info');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.runningCandidates, [
      { id: 'live', at: new Date(1_700_000_000_000).toISOString(), running: true, title: '回退标题' },
    ]);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});
