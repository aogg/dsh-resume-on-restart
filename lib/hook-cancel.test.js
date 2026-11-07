/**
 * 0.32.0：扩展点（before-restart / before-resume）在 apply() 里的**接线单测**
 * （node --test，无 e2e、不起服务、不联网、绝不真的重启）。
 *
 * lib/hooks.test.js 只测派发原语；这里测「接到本插件流程里的效果」：
 * 1. before-restart 取消 → POST /restart 回 409（不是 500），响应带
 *    cancelled/by/reason，且**不产生任何重启工件**（不 spawn helper、无身份记录）；
 * 2. before-resume 取消 → 开机恢复流程整体跳过：restarts.ndjson 只有 boot +
 *    resume-cancel 一条，没有任何逐会话 restore 结算，wake.log 留痕。
 *
 * DSH_HOME 每用例重定向到独立临时目录，绝不读写真实 ~/.dsh。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';
import { parseNdjson } from './detect.js';

/**
 * 建隔离 harness 并跑 apply()。
 *
 * @param {object} options
 * @param {Record<string, string>} [options.files] 相对 stateDir 的状态文件（用例自己铺）
 * @param {(event: string, payload: object) => unknown} [options.serial]
 *   ctx.serial 的实现（模拟其它插件的处理器链）：返回取消值即取消本次行为
 */
function buildHarness({ files = {}, serial } = {}) {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-hook-'));
  process.env.DSH_HOME = dshHome;
  const stateDir = join(dshHome, '.resume-on-restart');
  mkdirSync(stateDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(stateDir, name), content);

  const captured = { handlers: [], serialCalls: [], routes: [] };
  const services = {
    agents: {
      roots: () => [],
      list: () => [],
      get: () => null,
    },
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {}, list: async () => [], get: async () => null },
  };
  const webServer = {
    host: '127.0.0.1',
    register(route) {
      captured.routes.push(route);
      captured.handlers.push(route.handler);
      return () => {};
    },
  };
  const ctx = {
    on: () => () => {},
    effect: (fn) => {
      const disposer = fn();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
    // 两个服务（webServer 与 agents）都立即"激活"，把开机恢复流程真正跑起来
    inject: (deps, cb) => {
      if (deps.includes('webServer')) cb({ webServer });
      else if (deps.includes('agents')) cb({ agents: services.agents });
    },
    serial: async (event, payload) => {
      captured.serialCalls.push([event, payload]);
      return typeof serial === 'function' ? serial(event, payload) : undefined;
    },
    reflect: { get: (name) => services[name] },
    get: (name) => services[name],
  };
  apply(ctx, { enabled: true });

  /** 打一次本插件前缀下的路由（GET/POST）。 */
  const call = async (path, { method = 'GET', headers } = {}) => {
    let status = 0;
    let body = '';
    const res = { writeHead: (code) => { status = code; }, end: (chunk) => { if (chunk) body += chunk; } };
    const req = {
      url: `/api/dsh-resume-on-restart${path}`,
      method,
      headers: headers ?? { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    await captured.handlers[0](req, res);
    let parsed = body;
    try { parsed = JSON.parse(body); } catch { /* 非 JSON 保持原样 */ }
    return { status, json: parsed };
  };

  return {
    call,
    captured,
    dshHome,
    stateDir,
    cleanup: () => rmSync(dshHome, { recursive: true, force: true }),
  };
}

/** 轮询等待条件成立（上限 ~3s）；只在单测里等文件落地，不 sleep 固定时长。 */
async function waitFor(check, timeoutMs = 3000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 读 stateDir 下的 ndjson（缺失 → []）。 */
function readNdjsonFile(stateDir, name) {
  try {
    return parseNdjson(readFileSync(join(stateDir, name), 'utf8'));
  } catch {
    return [];
  }
}

// ---- 1. before-restart：取消重启 ----

test('before-restart 取消：POST /restart → 409 + cancelled/by/reason，且不产生重启工件', async () => {
  const harness = buildHarness({
    serial: (event, payload) => {
      if (event !== 'resume-on-restart/before-restart') return undefined;
      assert.equal(payload.phase, 'before-restart');
      return { cancel: true, by: 'dsh-backup', reason: '正在备份，先别重启' };
    },
  });
  try {
    const { status, json } = await harness.call('/restart', { method: 'POST' });
    // 取消是"冲突"而非服务端错误
    assert.equal(status, 409);
    assert.equal(json.ok, false);
    assert.equal(json.cancelled, true);
    assert.equal(json.by, 'dsh-backup');
    assert.equal(json.reason, '正在备份，先别重启');
    assert.match(json.error, /cancelled by plugin "dsh-backup": 正在备份/);
    // 派发了事件、拿到了候选快照字段
    assert.equal(harness.captured.serialCalls.length, 1);
    assert.equal(harness.captured.serialCalls[0][1].plugin, 'dsh-resume-on-restart');
    // 没有留下任何重启工件：helper 脚本 / 身份记录都不存在
    const artifacts = readdirSync(harness.stateDir);
    assert.equal(artifacts.some((name) => name.startsWith('restart-helper-')), false);
    assert.equal(artifacts.includes('restart-identity.json'), false);
    // wake.log 留痕（排障能看见"为什么没重启"）
    const wake = readFileSync(join(harness.stateDir, 'wake.log'), 'utf8');
    assert.match(wake, /restart cancelled: cancelled by plugin/);
    assert.match(wake, /dsh-backup/);
  } finally {
    harness.cleanup();
  }
});

// ---- 2. before-resume：取消开机自动恢复 ----

/**
 * 铺一个「确实发生过重启」的 marker：pid 不同（当前进程 pid 必然 !== 424242）+
 * 上次启动时刻更早，detectRestart 必判 wasRestart。
 */
function restartMarker() {
  const prevBootAt = new Date(Date.now() - 60_000).toISOString();
  return JSON.stringify({
    lastBootAt: prevBootAt,
    lastActiveAt: prevBootAt,
    lastSessionId: 'session-old',
    pid: 424242,
    startAt: Date.now() - 120_000,
    recentSessions: [{ id: 'session-old', at: Date.now() - 60_000, running: true }],
  });
}

test('before-resume 取消：只落 boot + resume-cancel，不产生逐会话恢复结算', async () => {
  const harness = buildHarness({
    files: { 'marker.json': restartMarker() },
    serial: (event) => {
      if (event !== 'resume-on-restart/before-resume') return undefined;
      return { cancel: true, by: 'dsh-maintenance', reason: '维护窗口，本次不恢复会话' };
    },
  });
  try {
    // 开机恢复流程是异步 IIFE，等 resume-cancel 落地
    const cancel = await waitFor(() => readNdjsonFile(harness.stateDir, 'restarts.ndjson')
      .find((entry) => entry.type === 'resume-cancel'));
    assert.ok(cancel, '未等到 resume-cancel 记录');
    assert.equal(cancel.by, 'dsh-maintenance');
    assert.equal(cancel.reason, '维护窗口，本次不恢复会话');
    assert.match(cancel.detail, /cancelled by plugin "dsh-maintenance"/);
    // 主回复：payload 带上了本次将恢复的候选快照
    const payload = harness.captured.serialCalls.find(([, entry]) => entry.phase === 'before-resume')?.[1];
    assert.ok(payload);
    assert.deepEqual(payload.candidates.map((candidate) => candidate.id), ['session-old']);
    assert.equal(payload.wasRestart, undefined); // 形状固定：用的是 phase/bootAt 而非旧字段
    assert.equal(typeof payload.bootAt, 'string');
    // 没有任何逐会话 restore 结算（取消发生在候选挑选与恢复之前）
    const restores = readNdjsonFile(harness.stateDir, 'restarts.ndjson').filter((entry) => entry.type === 'restore');
    assert.deepEqual(restores, []);
    // wake.log 留痕
    const wake = readFileSync(join(harness.stateDir, 'wake.log'), 'utf8');
    assert.match(wake, /resume cancelled: cancelled by plugin/);
    assert.match(wake, /dsh-maintenance/);
  } finally {
    harness.cleanup();
  }
});

test('before-resume 抛错：按取消处理（fail-closed），日志标 hookError', async () => {
  const harness = buildHarness({
    files: { 'marker.json': restartMarker() },
    serial: () => { throw new Error('boom'); },
  });
  try {
    const cancel = await waitFor(() => readNdjsonFile(harness.stateDir, 'restarts.ndjson')
      .find((entry) => entry.type === 'resume-cancel'));
    assert.ok(cancel, '处理器抛错时应按取消落地');
    assert.equal(cancel.hookError, true);
    assert.match(cancel.detail, /before-resume hook error: boom/);
  } finally {
    harness.cleanup();
  }
});

test('before-resume 放行：不写 resume-cancel（走原有恢复流程）', async () => {
  const harness = buildHarness({
    files: { 'marker.json': restartMarker() },
    serial: () => undefined,
  });
  try {
    // 原有流程会先写 boot 记录；等 boot 落地后再确认没有 resume-cancel
    const boot = await waitFor(() => readNdjsonFile(harness.stateDir, 'restarts.ndjson')
      .find((entry) => entry.type === 'boot'));
    assert.ok(boot, '未等到 boot 记录');
    // 给取消路径留出与 boot 相同的写盘窗口
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancels = readNdjsonFile(harness.stateDir, 'restarts.ndjson').filter((entry) => entry.type === 'resume-cancel');
    assert.deepEqual(cancels, []);
    // 事件确实派发过（放行 = 返回 null，继续原逻辑）
    assert.ok(harness.captured.serialCalls.some(([, entry]) => entry.phase === 'before-resume'));
  } finally {
    harness.cleanup();
  }
});
