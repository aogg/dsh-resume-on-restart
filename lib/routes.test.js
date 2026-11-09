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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * @param {{files?: Record<string, string>, skills?: object[], archivedSessionIds?: string[]}} [options]
 *   files：相对 stateDir（`.resume-on-restart`）的文件名 → 内容；
 *   skills：skills 服务 list() 返回的 summary 列表（默认本插件 + 两个别家）；
 *   archivedSessionIds：workspaceRegistry.archivedSessionIds（0.36.0 快照 archived 字段）
 */
function buildHarness({
  files = {},
  skills = [OWN_SKILL_SUMMARY, ...OTHER_SKILL_SUMMARIES],
  archivedSessionIds = [],
} = {}) {
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
      // 0.36.0：归档集合（快照 archived 字段 + GET /state 的来源）
      archivedSessionIds,
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
   * @param {{headers?: Record<string, string>, method?: string, body?: unknown}} [options]
   *   覆盖请求头（如不可信 Host）；method 默认 GET；body 存在时按 JSON 请求体喂给
   *   宿主 readJsonBody 用的事件接口（data/end，0.36.0 起用于 POST /session-recovery）
   */
  const call = async (path, { headers, method = 'GET', body } = {}) => {
    let status = 0;
    let raw = '';
    const res = { writeHead: (code) => { status = code; }, end: (chunk) => { if (chunk) raw += chunk; } };
    const listeners = new Map();
    const req = {
      url: `/api/dsh-resume-on-restart${path}`,
      method,
      headers: headers ?? { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return req;
      },
      destroy() { /* readJsonBody 超限时调用；用例不触发 */ },
    };
    if (body !== undefined) {
      // readJsonBody 先同步注册 data/end 监听再等事件：nextTick 保证顺序（无真实网络）
      process.nextTick(() => {
        const chunk = Buffer.from(JSON.stringify(body), 'utf8');
        for (const handler of listeners.get('data') ?? []) handler(chunk);
        for (const handler of listeners.get('end') ?? []) handler();
      });
    }
    await captured.handlers[0](req, res);
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch { /* 非 JSON 响应保持原样（如 403 的纯文本围栏） */ }
    return { status, json: parsed };
  };

  return {
    call,
    stateDir,
    readStateFile: (name) => JSON.parse(readFileSync(join(stateDir, name), 'utf8')),
    cleanup: () => rmSync(dshHome, { recursive: true, force: true }),
  };
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

// ---- 0.32.0：GET /notice（tab3「技能展示」的提示词区块数据源） ----

test('/notice: 返回真实渲染的提示词样本 + 逐片段清单 + 投递方式', async () => {
  const harness = buildHarness({
    files: {
      // 最近一次 boot 里最后一条 resumed 记录 → 提示词出现「恢复行」
      'restarts.ndjson': [
        JSON.stringify({ type: 'boot', at: '2026-11-06T05:32:36.068Z' }),
        JSON.stringify({ type: 'restore', bootAt: '2026-11-06T05:32:36.068Z', id: 'session-a', result: 'failed' }),
        JSON.stringify({ type: 'restore', bootAt: '2026-11-06T05:32:36.068Z', id: 'session-b', result: 'resumed' }),
      ].join('\n') + '\n',
    },
  });
  try {
    const { status, json } = await harness.call('/notice');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    // 片段清单恒为白名单全量（未出现的 text 为 null，客户端据此显示「本次未出现」）
    assert.deepEqual(json.segments.map((segment) => segment.key), [
      'header', 'boot', 'downtime', 'lastSession', 'lastActive', 'restored', 'custom', 'tail',
    ]);
    const byKey = Object.fromEntries(json.segments.map((segment) => [segment.key, segment.text]));
    assert.equal(byKey.header, '[resume-on-restart] 检测到 DSH 服务已重启。');
    assert.equal(byKey.tail, '如需继续之前的工作，或启动新任务，请自主决定下一步。');
    // 本次无上次启动记录 → boot 片段走「本次于 X 启动。」
    assert.match(byKey.boot, /^本次于 .+ 启动。$/);
    // 恢复行取最近一次 boot 的最后一条 resumed（session-b）
    assert.equal(json.restoredSessionId, 'session-b');
    assert.match(byKey.restored, /已自动恢复重启前活跃的会话 session-b。/);
    // 样本 = 出现片段按顺序 join，与 deliver() 用的 buildNotice 同源
    assert.equal(json.sample.split('\n').length, json.segments.filter((segment) => segment.text !== null).length);
    // 投递方式与消息外壳
    assert.equal(json.delivery.method, 'followup');
    assert.equal(json.delivery.wakeup, true);
    assert.equal(json.delivery.customNotice, null);
    assert.equal(json.delivery.source.kind, 'dsh-resume-on-restart');
    assert.equal(json.delivery.source.form, 'notice');
    assert.match(json.delivery.source.summary, /^resume-on-restart: DSH restarted at /);
    // 围栏同口径
    const denied = await harness.call('/notice', { headers: { host: 'evil.example:3080' } });
    assert.equal(denied.status, 403);
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

// ---- 0.36.0：顶栏常驻开关的统一切换入口 POST /session-recovery ----

test('/session-recovery: want=true → 清排除 + 写 proactive 登记（title 取会话标题）、回 state:registered', async () => {
  const harness = buildHarness({
    files: {
      // 该会话此前被用户排除（典型场景：顶栏点过「不恢复」或待恢复列表里取消过）
      'excluded-sessions.json': JSON.stringify({
        sessions: { 'session-done': '2026-11-06T00:00:00.000Z' },
      }),
    },
  });
  try {
    const { status, json } = await harness.call('/session-recovery', {
      method: 'POST',
      body: { sessionId: 'session-done', want: true },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.sessionId, 'session-done');
    assert.equal(json.want, true);
    // 已不在候选、也不在排除 → 登记生效后就是 registered（不是 none）
    assert.equal(json.state, 'registered');
    // 1) 排除集合清空（want=true 必须一起清，否则排除在候选阶段优先生效）
    assert.deepEqual(harness.readStateFile('excluded-sessions.json'), { sessions: {} });
    // 2) proactive 登记写入 { at, title? }（title 走 sessionTitleLookup，
    //    harness 的 sessions.get 给了 header.title = `header-<id>`）
    const proactive = harness.readStateFile('proactive-restore.json');
    assert.deepEqual(Object.keys(proactive), ['session-done']);
    assert.match(proactive['session-done'].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(proactive['session-done'].title, 'header-session-done');
    // activate 不写（工具默认激活口径：true/缺失一律不落盘）
    assert.equal('activate' in proactive['session-done'], false);
  } finally {
    harness.cleanup();
  }
});

test('/session-recovery: want=false → 删 proactive 登记（保留其他条目）+ 写排除集合、回 state:excluded', async () => {
  const harness = buildHarness({
    files: {
      // 已登记重启恢复的会话（proactive-restore.json）——哪怕它已经结束，
      // 不取消的话下次重启仍会被拉起来；另一条登记必须原样保留
      'proactive-restore.json': JSON.stringify({
        'session-done': { at: '2026-11-06T00:00:00.000Z', title: '已完成的会话' },
        'session-other': { at: '2026-11-06T00:01:00.000Z', activate: false },
      }),
    },
  });
  try {
    const { status, json } = await harness.call('/session-recovery', {
      method: 'POST',
      body: { sessionId: 'session-done', want: false },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.want, false);
    // 既不在候选、登记也被删、只剩排除 → excluded
    assert.equal(json.state, 'excluded');
    const proactive = harness.readStateFile('proactive-restore.json');
    assert.deepEqual(Object.keys(proactive), ['session-other']);
    assert.equal(proactive['session-other'].activate, false);
    const excluded = harness.readStateFile('excluded-sessions.json');
    assert.deepEqual(Object.keys(excluded.sessions), ['session-done']);
    assert.match(excluded.sessions['session-done'], /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    harness.cleanup();
  }
});

test('/session-recovery: 参数校验（缺 want / want 非布尔 / 空 sessionId → 400）与浏览器信任围栏（403）', async () => {
  const harness = buildHarness();
  try {
    const noWant = await harness.call('/session-recovery', {
      method: 'POST',
      body: { sessionId: 'session-done' },
    });
    assert.equal(noWant.status, 400);
    assert.match(noWant.json.error, /want must be a boolean/);

    const stringWant = await harness.call('/session-recovery', {
      method: 'POST',
      body: { sessionId: 'session-done', want: 'true' },
    });
    assert.equal(stringWant.status, 400);

    const emptyId = await harness.call('/session-recovery', {
      method: 'POST',
      body: { sessionId: '', want: true },
    });
    assert.equal(emptyId.status, 400);
    assert.match(emptyId.json.error, /sessionId must be a non-empty string/);

    // 不可信 Host：与本前缀其余路由同口径的 403，且不写任何状态文件
    const denied = await harness.call('/session-recovery', {
      method: 'POST',
      headers: { host: 'evil.example:3080' },
      body: { sessionId: 'session-done', want: true },
    });
    assert.equal(denied.status, 403);
    assert.throws(() => harness.readStateFile('proactive-restore.json'), /ENOENT/);
  } finally {
    harness.cleanup();
  }
});

test('/state: 0.36.0 起同响应带 registered/archived 两个集合（ids 过滤，ws 快照同源）', async () => {
  const harness = buildHarness({
    archivedSessionIds: ['session-archived'],
    files: {
      'proactive-restore.json': JSON.stringify({
        'session-done': { at: '2026-11-06T00:00:00.000Z' },
        'session-noactivate': { at: '2026-11-06T00:01:00.000Z', activate: false },
        // 同时被用户排除的登记：恢复流程里排除优先，快照不报 registered
        'session-both': { at: '2026-11-06T00:02:00.000Z' },
      }),
      'excluded-sessions.json': JSON.stringify({
        sessions: { 'session-both': '2026-11-06T00:03:00.000Z' },
      }),
    },
  });
  try {
    // 全量（缺 ids）：registered 带 at/activate，archived 是 { id: true }
    const all = await harness.call('/state');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.registered, {
      'session-done': { at: '2026-11-06T00:00:00.000Z' },
      'session-noactivate': { at: '2026-11-06T00:01:00.000Z', activate: false },
    });
    assert.deepEqual(all.json.archived, { 'session-archived': true });

    // 带 ids（顶栏首帧查询的形状）：只回命中的 key，查不到就是空对象
    const one = await harness.call('/state?ids=session-done,session-archived,session-ghost');
    assert.deepEqual(one.json.registered, { 'session-done': { at: '2026-11-06T00:00:00.000Z' } });
    assert.deepEqual(one.json.archived, { 'session-archived': true });

    const none = await harness.call('/state?ids=session-ghost');
    assert.deepEqual(none.json.registered, {});
    assert.deepEqual(none.json.archived, {});
  } finally {
    harness.cleanup();
  }
});

test('GET /restarts: 0.37.0 下发前对缺 title 的 restore 记录惰性补齐（唯一出口），已有 title / 非 restore 原样透传', async () => {
  const bootAt = '2026-11-08T03:00:00.000Z';
  const harness = buildHarness({
    files: {
      'restarts.ndjson': [
        JSON.stringify({ type: 'boot', at: bootAt, runningSessions: [] }),
        JSON.stringify({ type: 'restore', bootAt, id: 'session-a', result: 'resumed', error: null, at: '2026-11-08T03:00:05.000Z' }),
        JSON.stringify({ type: 'restore', bootAt, id: 'session-b', result: 'failed', error: 'x', at: '2026-11-08T03:00:06.000Z', title: '已有标题' }),
        JSON.stringify({ type: 'restore', bootAt, id: 'session-a', result: 'resumed', error: null, at: '2026-11-08T03:00:07.000Z' }),
      ].join('\n') + '\n',
    },
  });
  try {
    const { status, json } = await harness.call('/restarts');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const [, a, b, aAgain] = json.entries;
    // 缺 title 的 restore 记录补齐（假 sessions 服务 header-title = header-<id>）
    assert.equal(a.title, 'header-session-a');
    // 同 id 多条只解析一次，两条都补上
    assert.equal(aAgain.title, 'header-session-a');
    // 已有 title 的原样保留（不覆盖）
    assert.equal(b.title, '已有标题');
    // 非 restore 条目（boot）原样透传、不新增字段
    assert.equal('title' in json.entries[0], false);
  } finally {
    harness.cleanup();
  }
});
