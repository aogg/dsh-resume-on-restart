/**
 * cordis v4 严格注入管控下的 apply() 回归测试（node --test，无 e2e、不起任何服务）。
 *
 * 背景（0.8.0 启动崩溃 bug）：重启引擎在 ctx.effect 回调里裸读 ctx.commands /
 * ctx.tools，而插件静态 inject = ['agents']。cordis v4 对未在 inject 声明的服务
 * 属性访问必抛（Error: cannot get property "commands" without inject，不是返回
 * undefined），异常把 apply 炸断，导致重启日志/自动恢复流程没跑、HTTP 路由没注册
 * （设置弹窗"重启"按钮 404）、活动追踪监听器被作用域回滚带掉。
 *
 * 普通对象假 ctx 复现不了：其 ctx.commands 是 undefined，typeof 分支直接 return。
 * 这里用 Proxy 模拟 cordis 真实行为——读取上下文自身 API（on/effect/inject/reflect/get）
 * 以外的任何属性即 throw，证明：
 * 1. commands/tools 服务缺失时 apply 不再抛、优雅跳过注册，后续接线（事件监听等）存活；
 * 2. commands/tools 服务可用（reflect.get 能拿到）时照常注册，入口不丢。
 *
 * DSH_HOME 重定向到临时目录，绝不读写真实 ~/.dsh。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';
import { readRegisterCalls } from './register-calls.js';

/** cordis v4 对未注入服务的报错文案（与宿主启动崩溃日志逐字一致）。 */
const injectError = (prop) => new Error(`cannot get property "${prop}" without inject`);

/**
 * 模拟 cordis v4 严格注入管控的 ctx：
 * - 上下文自身 API（on/effect/inject/reflect/get）允许访问；
 * - 其它任何属性（ctx.commands / ctx.tools / …）的读取必抛——与真实 cordis 对
 *   未在静态 inject 声明的服务属性的行为一致；
 * - effect 同步执行回调（异常向上传播，复现"炸断 apply"的路径）；
 * - inject 只记录依赖、不回调（模拟服务未激活，webServer 可选提供）；
 * - reflect.get(name) 返回 services[name]（服务缺失/未激活 → undefined）。
 */
function buildStrictCtx({ services = {}, webServer } = {}) {
  const captured = {
    events: [],
    effects: [],
    injected: [],
    registered: { commands: [], tools: [], skills: [] },
  };
  const selfApi = {
    on(event) {
      captured.events.push(event);
      return () => {};
    },
    effect(fn, label) {
      captured.effects.push(label ?? '');
      fn();
    },
    inject(deps, cb) {
      captured.injected.push([...deps]);
      if (webServer && deps.includes('webServer')) cb({ webServer });
    },
    reflect: { get: (serviceName) => services[serviceName] },
    get: (serviceName) => services[serviceName],
  };
  const allowed = new Set(Object.keys(selfApi));
  const ctx = new Proxy(selfApi, {
    get(target, prop) {
      if (allowed.has(prop)) return target[prop];
      throw injectError(String(prop));
    },
  });
  return { ctx, captured };
}

/** 隔离的临时 DSH_HOME：无 marker → 本次判定非重启，只走 4/5/5.5/5.6 接线段。 */
function useTempDshHome(prefix) {
  const dshHome = mkdtempSync(join(tmpdir(), prefix));
  process.env.DSH_HOME = dshHome;
  return dshHome;
}

test('strict ctx: commands/tools 服务缺失 → apply 不抛、优雅跳过注册、后续接线存活', () => {
  const dshHome = useTempDshHome('ror-strict-missing-');
  try {
    const { ctx, captured } = buildStrictCtx({ services: {} });
    // 修复前：effect 回调裸读 ctx.commands / ctx.tools 在此必抛
    // （cannot get property "commands"/"tools" without inject），apply 中途炸断
    assert.doesNotThrow(() => apply(ctx, { enabled: true }));
    // 两个 effect 回调都执行到了（没被异常截断）
    assert.ok(
      captured.effects.includes('dsh-resume-on-restart: restart command'),
      '/restart 命令的 effect 回调应已执行并优雅跳过',
    );
    assert.ok(
      captured.effects.includes('dsh-resume-on-restart: restart_harness tool'),
      'restart_harness 工具的 effect 回调应已执行并优雅跳过',
    );
    // 服务缺失 → 不注册（typeof 守卫语义保持）
    assert.equal(captured.registered.commands.length, 0);
    assert.equal(captured.registered.tools.length, 0);
    // apply 没被炸断的证据：活动追踪监听器已挂上、webServer 注入已发起
    // （0.17.0 起 session/event 订阅同批挂上——turn 事件维护 lastTurnEndKind
    // 记录字段与运行期 completedSessions 集合；0.29.0 起 tools/result 订阅同批
    // 挂上——skill 工具调用统计）
    assert.deepEqual(captured.events, [
      'agent/status',
      'agent/inbox/inserted',
      'agent/assistant-stream',
      'session/event',
      'tools/result',
    ]);
    assert.ok(captured.injected.some((deps) => deps.includes('webServer')), 'webServer 动态注入应已发起');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('strict ctx: commands/tools/skills 经 reflect 可用 → 照常注册，入口不丢', () => {
  const dshHome = useTempDshHome('ror-strict-present-');
  try {
    const services = {
      commands: { register: (entry) => captured.registered.commands.push(entry) },
      tools: { register: (entry) => captured.registered.tools.push(entry) },
      skills: { register: (entry) => captured.registered.skills.push(entry) },
    };
    const { ctx, captured } = buildStrictCtx({ services });
    assert.doesNotThrow(() => apply(ctx, { enabled: true }));
    assert.equal(captured.registered.commands.length, 1);
    assert.equal(captured.registered.commands[0].name, 'restart');
    assert.equal(typeof captured.registered.commands[0].handler, 'function');
    // 0.19.0：模型工具两个（restart_harness + register_restart_recovery）
    assert.equal(captured.registered.tools.length, 2);
    assert.equal(captured.registered.tools[0].name, 'restart_harness');
    assert.equal(typeof captured.registered.tools[0].execute, 'function');
    assert.equal(captured.registered.tools[1].name, 'register_restart_recovery');
    assert.equal(typeof captured.registered.tools[1].execute, 'function');
    // 0.19.0：ctx.skills.register 可用时注册 register-restart-recovery 技能
    assert.equal(captured.registered.skills.length, 1);
    assert.equal(captured.registered.skills[0].name, 'register-restart-recovery');
    assert.equal(typeof captured.registered.skills[0].content, 'string');
    // 0.19.1：技能补 source（dsh-skill 强制字符串）+ userInvocable=false（仅模型可用）
    assert.equal(captured.registered.skills[0].source, 'runtime');
    assert.deepEqual(captured.registered.skills[0].invocation, { modelInvocable: true, userInvocable: false });
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('strict ctx 探针自检: 读未注入服务属性必抛（对齐宿主崩溃日志文案）', () => {
  const { ctx } = buildStrictCtx({ services: {} });
  assert.throws(() => ctx.commands, injectError('commands'));
  assert.throws(() => ctx.tools, injectError('tools'));
  assert.throws(() => ctx.sessionController, injectError('sessionController'));
  assert.throws(
    () => ctx.commands,
    (err) => err.message === 'cannot get property "commands" without inject',
  );
});


test('0.31.0: register_restart_recovery action=add 成功 → register-calls.ndjson 留痕（remove 不留）', async () => {
  const dshHome = useTempDshHome('ror-register-calls-');
  try {
    const captured = { registered: { tools: [], skills: [] } };
    const services = {
      tools: { register: (entry) => captured.registered.tools.push(entry) },
      skills: { register: (entry) => captured.registered.skills.push(entry) },
    };
    const { ctx } = buildStrictCtx({ services });
    assert.doesNotThrow(() => apply(ctx, { enabled: true }));
    const tool = captured.registered.tools.find((entry) => entry.name === 'register_restart_recovery');
    assert.ok(tool, 'register_restart_recovery tool registered');
    const file = join(dshHome, '.resume-on-restart', 'register-calls.ndjson');

    const added = await tool.execute({}, { agent: { session: { id: 'sess-a' } } });
    assert.equal(added.ok, true);
    let calls = readRegisterCalls(file);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, 'sess-a');
    assert.equal(typeof calls[0].at, 'string');
    assert.ok(Number.isFinite(Date.parse(calls[0].at)), 'at 应为可解析 ISO 时刻');
    assert.equal(Object.hasOwn(calls[0], 'activate'), false, 'activate=true（默认）不写字段');

    const addedNoActivate = await tool.execute({ activate: false }, { agent: { session: { id: 'sess-b' } } });
    assert.equal(addedNoActivate.ok, true);
    calls = readRegisterCalls(file);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].sessionId, 'sess-b');
    assert.equal(calls[1].activate, false);

    // remove 不是登记调用：不留痕
    const removed = await tool.execute({ action: 'remove' }, { agent: { session: { id: 'sess-a' } } });
    assert.equal(removed.ok, true);
    assert.equal(readRegisterCalls(file).length, 2);

    // 无会话上下文（add 失败）同样不留痕
    const failed = await tool.execute({}, {});
    assert.equal(failed.ok, false);
    assert.equal(readRegisterCalls(file).length, 2);
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});


test('0.31.0: boot 记录补登记周期统计与 restartMs（周期 = prevBootAt → requestedAt 闭区间）', () => {
  const dshHome = useTempDshHome('ror-boot-fields-');
  try {
    const stateDir = join(dshHome, '.resume-on-restart');
    mkdirSync(stateDir, { recursive: true });
    // 上次 boot 05:00、pid 不同 → 本次判定为重启
    writeFileSync(join(stateDir, 'marker.json'), JSON.stringify({
      lastBootAt: '2026-11-06T05:00:00.000Z',
      pid: process.pid + 4321,
    }), 'utf8');
    // 登记留痕：窗口前 1 条 / 窗口内 2 条 / 晚于发起时刻 1 条
    writeFileSync(join(stateDir, 'register-calls.ndjson'), [
      JSON.stringify({ at: '2026-11-06T04:00:00.000Z', sessionId: 'too-old' }),
      JSON.stringify({ at: '2026-11-06T06:10:00.000Z', sessionId: 'first' }),
      JSON.stringify({ at: '2026-11-06T07:00:00.000Z', sessionId: 'second', activate: false }),
      JSON.stringify({ at: '2026-11-06T08:00:00.000Z', sessionId: 'after-request' }),
    ].join('\n') + '\n', 'utf8');
    // 重启来源记录：committedAt 落在 [上次 boot, 本次 boot]，requestedAt 即发起时刻
    const powerDir = join(dshHome, 'power-restart');
    mkdirSync(powerDir, { recursive: true });
    writeFileSync(join(powerDir, 'ror-test.status.json'), JSON.stringify({
      restartId: 'ror-test',
      committedAt: '2026-11-06T07:59:50.000Z',
      requestedAt: '2026-11-06T07:59:47.000Z',
      source: 'dsh-resume-on-restart',
      origin: { kind: 'auto' },
    }), 'utf8');

    const { ctx } = buildStrictCtx({ services: {} });
    assert.doesNotThrow(() => apply(ctx, { enabled: true }));

    const boot = readFileSync(join(stateDir, 'restarts.ndjson'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === 'boot');
    assert.ok(boot, 'boot 记录应已写入');
    assert.equal(boot.reason, 'auto-restart');
    assert.equal(boot.registrationCount, 2);
    assert.equal(boot.registrationFirstAt, '2026-11-06T06:10:00.000Z');
    assert.equal(boot.registrationFirstSessionId, 'first');
    assert.equal(boot.restartMs, Date.parse(boot.at) - Date.parse('2026-11-06T07:59:47.000Z'));
    assert.ok(boot.restartMs > 0, 'restartMs 应为正的重启耗时');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});
