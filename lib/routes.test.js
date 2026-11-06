/**
 * 0.30.0「tab3 收敛本插件 / tab1 已登记待重启列表」的**宿主路由接线单测**
 * （node --test，无 e2e、不起任何服务、不联网）。
 *
 * 做法照 lib/apply.test.js：用普通对象假 ctx 跑 apply()，只 stub 宿主服务
 * （skills / sessions / workspaceRegistry / tools / commands）与 webServer
 * （捕获 `register({ kind:'prefix', path, handler })` 的 handler），然后直接
 * 调用 handler(fakeReq, fakeRes) 断言三个只读路由的**响应形状与过滤口径**：
 * 1. GET /skills/catalog：skills 只留本插件技能（别家 genui / 别家 runtime 技能
 *    都不出现）、同口径的聚合 usage（total/keys 只算本插件）、tools 字段下发
 *    两个模型工具（名称 + description 来自注册常量）；
 * 2. GET /skills/usage：entries/total 同口径过滤；
 * 3. GET /restart/registrations：只回 at 晚于最近一次 boot 的登记、at 倒序、
 *    title/workspacePath 补齐、activate:false 透传，lastBootAt 取 boot 记录；
 * 4. 浏览器信任围栏：不可信 Host → 403（与本前缀其余路由同口径）。
 *
 * DSH_HOME 每用例重定向到独立临时目录（状态文件由用例自己铺），绝不读写
 * 真实 ~/.dsh。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

/** 本插件自己的技能 summary（实测 provider/source 都是 'runtime'）。 */
const OWN_SKILL_SUMMARY = {
  name: 'register-restart-recovery',
  provider: 'runtime',
  source: 'runtime',
  description: '注册当前会话的重启恢复行为…',
  invocation: { modelInvocable: true, userInvocable: false },
};
/** 别家技能（bundled provider）+ 同为 runtime 层的别家技能（覆盖「provider 无法区分」的事实）。 */
const OTHER_SKILL_SUMMARIES = [
  { name: 'genui', provider: 'dsh-genui', source: 'bundled', description: 'g', invocation: { modelInvocable: true, userInvocable: true } },
  { name: 'ao-simple-daily-report', provider: 'runtime', source: 'runtime', description: 'a', invocation: { modelInvocable: true, userInvocable: true } },
];

/**
 * 建一套隔离 harness：临时 DSH_HOME + 铺给定状态文件 + 跑 apply() + 拿到路由 handler。
 * @param {{files?: Record<string, string>, skills?: object[]}} [options]
 *   files：相对 stateDir（`.resume-on-restart`）的文件名 → 内容；
 *   skills：skills 服务 list() 返回的 summary 列表（默认本插件 + 两个别家）
 */
function buildHarness({ files = {}, skills = [OWN_SKILL_SUMMARY, ...OTHER_SKILL_SUMMARIES] } = {}) {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-routes-'));
  process.env.DSH_HOME = dshHome;
  const stateDir = join(dshHome, '.resume-on-restart');
  mkdirSync(stateDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(stateDir, name), content);

  const captured = { handlers: [], routes: [] };
  const services = {
    skills: {
      list: async () => skills,
      get: async (name) => ({ content: `BODY:${name}` }),
      register: () => () => {},
    },
    sessions: {
      get: (id) => ({
        header: { cwd: '/code/www/my/github/dsh-resume-on-restart', title: `header-${id}` },
      }),
    },
    workspaceRegistry: {
      list: () => ([{ path: '/code/www/my/github/dsh-resume-on-restart', sessionIds: [] }]),
      resolveByPath: async (path) => ({ path }),
    },
    tools: { register: () => {} },
    commands: { register: () => {} },
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
    inject: (deps, cb) => { if (deps.includes('webServer')) cb({ webServer }); },
    reflect: { get: (name) => services[name] },
    get: (name) => services[name],
  };
  apply(ctx, { enabled: true });

  /**
   * 打一次路由：默认用回环可信 Host（127.0.0.1:3080，socket 回环）。
   * @param {string} path 本插件前缀之后的子路径（如 '/skills/catalog'）
   * @param {{headers?: Record<string, string>}} [options] 覆盖请求头（如不可信 Host）
   */
  const call = async (path, { headers } = {}) => {
    let status = 0;
    let body = '';
    const res = { writeHead: (code) => { status = code; }, end: (chunk) => { if (chunk) body += chunk; } };
    const req = {
      url: `/api/dsh-resume-on-restart${path}`,
      method: 'GET',
      headers: headers ?? { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    await captured.handlers[0](req, res);
    let parsed = body;
    try { parsed = JSON.parse(body); } catch { /* 非 JSON 响应保持原样（如 403 的纯文本围栏） */ }
    return { status, json: parsed };
  };

  return { call, cleanup: () => rmSync(dshHome, { recursive: true, force: true }) };
}

test('/skills/catalog: 技能/统计只扣本插件范围 + tools 字段下发两个模型工具', async () => {
  const harness = buildHarness({
    files: {
      'skill-usage.ndjson': [
        JSON.stringify({ at: '2026-11-06T06:00:00.000Z', skill: 'genui', sessionId: 's1', ok: true }),
        JSON.stringify({ at: '2026-11-06T06:01:00.000Z', skill: 'register-restart-recovery', sessionId: 's1', ok: true }),
        JSON.stringify({ at: '2026-11-06T06:02:00.000Z', skill: 'ao-simple-daily-report', sessionId: 's1', ok: false }),
      ].join('\n') + '\n',
    },
  });
  try {
    const { status, json } = await harness.call('/skills/catalog');
    assert.equal(status, 200);
    assert.deepEqual(json.skills.map((skill) => skill.name), ['register-restart-recovery']);
    // 别家技能 100% 不出现（含同为 provider 'runtime' 的别家技能）
    assert.equal(json.skills.some((skill) => skill.name === 'genui' || skill.name === 'ao-simple-daily-report'), false);
    // 聚合同口径：只算本插件技能的那 1 条
    assert.equal(json.usage.total, 1);
    assert.deepEqual(Object.keys(json.usage.skills), ['register-restart-recovery']);
    // tools：两个模型工具的名称 + 非空 description（来自注册常量）
    assert.deepEqual(json.tools.map((tool) => tool.name), ['restart_harness', 'register_restart_recovery']);
    for (const tool of json.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 20);
    }
  } finally {
    harness.cleanup();
  }
});

test('/skills/usage: entries/total 与聚合同口径（只回本插件技能条目）', async () => {
  const harness = buildHarness({
    files: {
      'skill-usage.ndjson': [
        JSON.stringify({ at: '2026-11-06T06:00:00.000Z', skill: 'genui', sessionId: 's1', ok: true }),
        JSON.stringify({ at: '2026-11-06T06:01:00.000Z', skill: 'register-restart-recovery', sessionId: 's1', ok: true }),
      ].join('\n') + '\n',
    },
  });
  try {
    const { status, json } = await harness.call('/skills/usage');
    assert.equal(status, 200);
    assert.equal(json.total, 1);
    assert.deepEqual(json.entries.map((entry) => entry.skill), ['register-restart-recovery']);
  } finally {
    harness.cleanup();
  }
});

test('/restart/registrations: 只回 at 晚于最近一次 boot 的登记、at 倒序、字段齐全', async () => {
  const harness = buildHarness({
    files: {
      'restarts.ndjson': [
        JSON.stringify({ type: 'boot', at: '2026-11-06T05:32:36.068Z' }),
        JSON.stringify({ type: 'restore', id: 'x', result: 'resumed', bootAt: '2026-11-06T05:32:36.068Z' }),
      ].join('\n') + '\n',
      'proactive-restore.json': JSON.stringify({
        'old-session': { at: '2026-11-06T04:00:00.000Z', title: '重启前登记' },
        'new-session': { at: '2026-11-06T06:00:00.000Z', title: '重启后登记' },
        'off-session': { at: '2026-11-06T06:30:00.000Z', activate: false },
      }),
    },
  });
  try {
    const { status, json } = await harness.call('/restart/registrations');
    assert.equal(status, 200);
    assert.equal(json.lastBootAt, '2026-11-06T05:32:36.068Z');
    // old-session（at 早于 boot = 已经历重启）被剔除；其余按 at 倒序
    assert.deepEqual(json.registrations.map((row) => row.sessionId), ['off-session', 'new-session']);
    const [off, fresh] = json.registrations;
    assert.equal(off.activate, false);
    assert.equal('activate' in fresh, false);
    // 标题：sessionTitleLookup 优先（投影/记录拿到才用），这里命中 header.title
    assert.equal(fresh.title, 'header-new-session');
    // workspacePath：会话 header.cwd → resolveByPath
    assert.equal(fresh.workspacePath, '/code/www/my/github/dsh-resume-on-restart');
  } finally {
    harness.cleanup();
  }
});

test('/restart/registrations: 无 boot 记录 → lastBootAt 空串、登记全部返回；不可信 Host → 403', async () => {
  const harness = buildHarness({
    files: {
      'proactive-restore.json': JSON.stringify({
        a: { at: '2026-11-06T04:00:00.000Z' },
        b: { at: '2026-11-06T06:00:00.000Z' },
      }),
    },
  });
  try {
    const { status, json } = await harness.call('/restart/registrations');
    assert.equal(status, 200);
    assert.equal(json.lastBootAt, '');
    assert.deepEqual(json.registrations.map((row) => row.sessionId), ['b', 'a']);
    // 浏览器信任围栏（与本前缀其余路由同口径）：不可信 Host 一律 403
    const denied = await harness.call('/restart/registrations', { headers: { host: 'evil.example:3080' } });
    assert.equal(denied.status, 403);
  } finally {
    harness.cleanup();
  }
});
