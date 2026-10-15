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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

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
    registered: { commands: [], tools: [] },
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
    assert.deepEqual(captured.events, ['agent/status', 'agent/inbox/inserted', 'agent/assistant-stream']);
    assert.ok(captured.injected.some((deps) => deps.includes('webServer')), 'webServer 动态注入应已发起');
  } finally {
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test('strict ctx: commands/tools 经 reflect 可用 → 照常注册，入口不丢', () => {
  const dshHome = useTempDshHome('ror-strict-present-');
  try {
    const services = {
      commands: { register: (entry) => captured.registered.commands.push(entry) },
      tools: { register: (entry) => captured.registered.tools.push(entry) },
    };
    const { ctx, captured } = buildStrictCtx({ services });
    assert.doesNotThrow(() => apply(ctx, { enabled: true }));
    assert.equal(captured.registered.commands.length, 1);
    assert.equal(captured.registered.commands[0].name, 'restart');
    assert.equal(typeof captured.registered.commands[0].handler, 'function');
    assert.equal(captured.registered.tools.length, 1);
    assert.equal(captured.registered.tools[0].name, 'restart_harness');
    assert.equal(typeof captured.registered.tools[0].execute, 'function');
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
