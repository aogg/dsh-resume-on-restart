/**
 * 0.35.0「dsh-im 通知兼容」的单元测试
 * （node --test，无 e2e、不起服务、不联网）。
 *
 * 覆盖：
 * - resolveImNotification 各分支（会话级命中取消/不命中 null、宿主级 shutdown
 *   两种口径、crash 不碰、脏输入 fail-open）；
 * - buildImNotificationProvider 描述符形状（id 正则、events 订阅面、resolve 委托）；
 * - 进程内候选集合的写入/替换/清理与快照只读性；
 * - dsh-im 缺失/旧版完全降级（不注册、不抛错）；
 * - 注册 happy path 与 disposer、重复注册 notification-provider-exists 的可见降级、
 *   其它错误原样上抛；
 * - wireImNotificationProvider 的动态注入接线（inject(['dshIm']) + scope.effect 挂
 *   内层 fiber，dsh-im 重载即摘除）。
 *
 * dshIm 服务面按 dsh-im 仓库 docs/被扩展说明.md 的接口形状模拟：
 * { notificationVersion: 1, registerNotificationProvider(provider) → disposer }。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCEL_REASON_HOST_SHUTDOWN,
  CANCEL_REASON_SESSION,
  IM_NOTIFY_EVENTS,
  IM_PROVIDER_ID,
  buildImNotificationProvider,
  clearPendingRestoreCandidates,
  markPendingRestoreCandidates,
  pendingRestoreCandidateSnapshot,
  registerImNotificationProvider,
  resolveImNotification,
  wireImNotificationProvider,
} from './im-notify.js';

/** 构造一个极简 dshIm 服务面（capture 收到描述符；disposer 可注入自定义行为）。 */
function fakeDshIm({ version = 1, disposer = () => {}, onRegister = null, throwOnRegister = null } = {}) {
  const calls = { providers: [], disposed: 0 };
  return {
    calls,
    dshIm: {
      notificationVersion: version,
      registerNotificationProvider(provider) {
        if (throwOnRegister) throw throwOnRegister;
        calls.providers.push(provider);
        onRegister?.(provider);
        return () => { calls.disposed += 1; disposer(); };
      },
      listNotificationProviders() {
        return calls.providers.map((p) => ({ id: p.id, events: p.events }));
      },
    },
  };
}

test('常量：provider id 符合 dsh-im 的 /^[a-z][a-z0-9-]{1,31}$/，事件订阅面 = 4 个且不含 crash/startup', () => {
  assert.match(IM_PROVIDER_ID, /^[a-z][a-z0-9-]{1,31}$/);
  assert.deepEqual([...IM_NOTIFY_EVENTS], ['completed', 'failed', 'timeout', 'shutdown']);
  assert.ok(Object.isFrozen(IM_NOTIFY_EVENTS), '事件常量应冻结');
  assert.equal(IM_NOTIFY_EVENTS.includes('crash'), false);
  assert.equal(IM_NOTIFY_EVENTS.includes('startup'), false);
});

test('resolve：会话级命中候选集合 → cancel，reason 逐字固定（completed/failed/timeout 都命中）', () => {
  const candidates = new Set(['s-1', 's-2']);
  for (const event of ['completed', 'failed', 'timeout', 'shutdown']) {
    assert.deepEqual(
      resolveImNotification({ event, sessionId: 's-1' }, candidates),
      { cancel: true, reason: CANCEL_REASON_SESSION },
      `event=${event} 的候选会话通知应被取消`,
    );
  }
  assert.equal(CANCEL_REASON_SESSION, 'session will be auto-restored after restart by dsh-resume-on-restart');
});

test('resolve：会话级不命中候选集合 → null（没意见，fail-open）', () => {
  const candidates = new Set(['s-1']);
  assert.equal(resolveImNotification({ event: 'completed', sessionId: 'other' }, candidates), null);
  assert.equal(resolveImNotification({ event: 'failed', sessionId: 'other' }, candidates), null);
});

test('resolve：宿主级（sessionId 为空）shutdown 且候选集合非空 → 取消', () => {
  const candidates = new Set(['s-1']);
  assert.deepEqual(
    resolveImNotification({ event: 'shutdown', sessionId: null }, candidates),
    { cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN },
  );
  assert.deepEqual(
    resolveImNotification({ event: 'shutdown', sessionId: undefined }, candidates),
    { cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN },
  );
  assert.deepEqual(
    resolveImNotification({ event: 'shutdown', sessionId: '' }, candidates),
    { cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN },
  );
});

test('resolve：宿主级 shutdown 但候选集合为空 → 不取消（没有会话会被恢复，停机通知有信息量）', () => {
  assert.equal(resolveImNotification({ event: 'shutdown', sessionId: null }, new Set()), null);
});

test('resolve：宿主级非 shutdown（startup 等）即使候选集合非空也不取消', () => {
  const candidates = new Set(['s-1']);
  assert.equal(resolveImNotification({ event: 'startup', sessionId: null }, candidates), null);
});

test('resolve：crash 一律不碰——会话在候选集合内、宿主级集合非空都不取消', () => {
  const candidates = new Set(['s-1']);
  assert.equal(resolveImNotification({ event: 'crash', sessionId: 's-1' }, candidates), null);
  assert.equal(resolveImNotification({ event: 'crash', sessionId: null }, candidates), null);
});

test('resolve：脏输入 fail-open——context 非对象返回 null；sessionId 非字符串按宿主级口径', () => {
  const candidates = new Set(['s-1']);
  assert.equal(resolveImNotification(null, candidates), null);
  assert.equal(resolveImNotification(undefined, candidates), null);
  assert.equal(resolveImNotification('shutdown', candidates), null);
  assert.equal(resolveImNotification(42, candidates), null);
  // 非字符串 sessionId（契约外形状）→ 宿主级口径：shutdown + 非空集合才取消
  assert.equal(resolveImNotification({ event: 'completed', sessionId: 123 }, candidates), null);
  assert.deepEqual(
    resolveImNotification({ event: 'shutdown', sessionId: 123 }, candidates),
    { cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN },
  );
});

test('描述符：id/events/resolve 形状对齐 dsh-im 契约；events 是副本；resolve 委托同一逻辑', () => {
  const a = buildImNotificationProvider();
  const b = buildImNotificationProvider();
  assert.notEqual(a.events, b.events, 'events 必须是每次新建的副本，不与常量共享引用');
  assert.notEqual(a.events, IM_NOTIFY_EVENTS);
  assert.deepEqual(a.events, [...IM_NOTIFY_EVENTS]);
  // resolve 委托 resolveImNotification、默认读同一份进程内集合（结果逐字一致）
  try {
    markPendingRestoreCandidates(['s-1']);
    assert.deepEqual(a.resolve({ event: 'completed', sessionId: 's-1' }), resolveImNotification({ event: 'completed', sessionId: 's-1' }));
    assert.deepEqual(a.resolve({ event: 'completed', sessionId: 's-1' }), { cancel: true, reason: CANCEL_REASON_SESSION });
    assert.deepEqual(a.resolve({ event: 'shutdown', sessionId: null }), { cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN });
    clearPendingRestoreCandidates();
    assert.equal(a.resolve({ event: 'completed', sessionId: 's-1' }), resolveImNotification({ event: 'completed', sessionId: 's-1' }));
    assert.equal(a.resolve({ event: 'completed', sessionId: 's-1' }), null, '集合为空 → 没意见');
    assert.equal(a.resolve({ event: 'shutdown', sessionId: null }), null, '集合为空不取消宿主级 shutdown');
  } finally {
    clearPendingRestoreCandidates();
  }
});

test('进程内候选集合：mark 整体替换、过滤脏条目；快照是冻结副本；clear 清空', () => {
  try {
    markPendingRestoreCandidates(['a', 'b', '', null, 42, 'a']);
    assert.deepEqual(pendingRestoreCandidateSnapshot(), ['a', 'b']);
    const snapshot = pendingRestoreCandidateSnapshot();
    assert.ok(Object.isFrozen(snapshot), '快照应冻结');
    markPendingRestoreCandidates(['c']);
    assert.deepEqual(pendingRestoreCandidateSnapshot(), ['c'], 'mark 是替换不是合并');
    markPendingRestoreCandidates('not-an-array');
    assert.deepEqual(pendingRestoreCandidateSnapshot(), [], '非数组输入按清空处理');
    markPendingRestoreCandidates(['x']);
    clearPendingRestoreCandidates();
    assert.deepEqual(pendingRestoreCandidateSnapshot(), []);
  } finally {
    clearPendingRestoreCandidates();
  }
});

test('resolve 默认读进程内集合：mark 后命中取消，clear 后回到 null（不依赖注入参数）', () => {
  try {
    markPendingRestoreCandidates(['live-1']);
    assert.deepEqual(
      resolveImNotification({ event: 'timeout', sessionId: 'live-1' }),
      { cancel: true, reason: CANCEL_REASON_SESSION },
    );
    assert.deepEqual(
      resolveImNotification({ event: 'shutdown', sessionId: null }),
      { cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN },
    );
    clearPendingRestoreCandidates();
    assert.equal(resolveImNotification({ event: 'timeout', sessionId: 'live-1' }), null);
    assert.equal(resolveImNotification({ event: 'shutdown', sessionId: null }), null);
  } finally {
    clearPendingRestoreCandidates();
  }
});

test('降级：dsh-im 缺失（undefined/无成员）→ 不注册、返回 null、不抛错', () => {
  const { calls } = fakeDshIm();
  assert.equal(registerImNotificationProvider(undefined), null);
  assert.equal(registerImNotificationProvider({}), null);
  assert.equal(registerImNotificationProvider({ dshIm: undefined }), null);
  assert.equal(registerImNotificationProvider({ dshIm: {} }), null);
  assert.equal(calls.providers.length, 0, '不应调用 registerNotificationProvider');
});

test('降级：旧版 dsh-im（notificationVersion 非 1 / 无该成员）→ 不注册、零日志噪音', () => {
  let warned = 0;
  const originalWarn = console.warn;
  console.warn = () => { warned += 1; };
  try {
    for (const version of [0, 2, '1', null]) {
      const fake = fakeDshIm({ version });
      assert.equal(registerImNotificationProvider({ dshIm: fake.dshIm }), null);
      assert.equal(fake.calls.providers.length, 0, `version=${String(version)} 不应注册`);
    }
    // 没有 notificationVersion 成员的旧版（5.8.17 之前）：显式去掉成员再试
    const fake = fakeDshIm();
    const legacy = { ...fake.dshIm };
    delete legacy.notificationVersion;
    assert.equal(registerImNotificationProvider({ dshIm: legacy }), null);
    assert.equal(fake.calls.providers.length, 0, '无 notificationVersion 成员不应注册');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned, 0, '旧版降级应静默，不打日志');
});

test('降级：dshIm 形状不完整（缺 registerNotificationProvider）→ null', () => {
  assert.equal(registerImNotificationProvider({ dshIm: { notificationVersion: 1 } }), null);
  assert.equal(registerImNotificationProvider({ dshIm: { notificationVersion: 1, registerNotificationProvider: 'nope' } }), null);
});

test('注册 happy path：描述符上交、返回 dsh-im 的 disposer 本体', () => {
  const fake = fakeDshIm();
  const disposer = registerImNotificationProvider({ dshIm: fake.dshIm });
  assert.equal(typeof disposer, 'function');
  assert.equal(fake.calls.providers.length, 1);
  const descriptor = fake.calls.providers[0];
  assert.equal(descriptor.id, IM_PROVIDER_ID);
  assert.deepEqual(descriptor.events, ['completed', 'failed', 'timeout', 'shutdown']);
  assert.equal(typeof descriptor.resolve, 'function');
  assert.equal(fake.calls.disposed, 0);
  disposer();
  assert.equal(fake.calls.disposed, 1, 'disposer 应是 dsh-im 返回的那个');
});

test('重复注册（notification-provider-exists）→ 可见降级：warn 一条、返回 null、不抛错', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => { warnings.push(String(line)); };
  try {
    const error = new Error('duplicated');
    error.code = 'notification-provider-exists';
    const { dshIm } = fakeDshIm({ throwOnRegister: error });
    assert.equal(registerImNotificationProvider({ dshIm }), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, '必须 warn 一条（禁止静默吞异常）');
  assert.ok(warnings[0].includes(IM_PROVIDER_ID), 'warn 应带 provider id 便于定位');
  assert.ok(warnings[0].includes('already registered'), 'warn 应说明是重复注册');
});

test('注册期其它错误原样上抛（绝不吞异常）', () => {
  const error = new Error('boom');
  const { dshIm } = fakeDshIm({ throwOnRegister: error });
  assert.throws(() => registerImNotificationProvider({ dshIm }), /boom/);
});

test('wire：宿主无 ctx.inject → 返回 null、零动作', () => {
  assert.equal(wireImNotificationProvider(undefined), null);
  assert.equal(wireImNotificationProvider({}), null);
  assert.equal(wireImNotificationProvider({ inject: 'not-a-function' }), null);
});

test('wire：动态注入 ctx.inject([\'dshIm\'])，回调里注册并把 disposer 挂 scope.effect（label 固定）', () => {
  const fake = fakeDshIm();
  const effects = [];
  const scope = {
    dshIm: fake.dshIm,
    effect(execute, label) { effects.push({ execute, label }); },
  };
  let injectedNames = null;
  const ctx = {
    inject(names, callback) {
      injectedNames = names;
      callback(scope);
      return { kind: 'fiber' };
    },
  };
  const fiber = wireImNotificationProvider(ctx);
  assert.deepEqual(injectedNames, ['dshIm']);
  assert.equal(fiber && fiber.kind, 'fiber', 'ctx.inject 的返回值原样透传');
  assert.equal(fake.calls.providers.length, 1, '回调内完成注册');
  assert.equal(effects.length, 1, 'disposer 经 scope.effect 挂内层 fiber');
  assert.equal(effects[0].label, 'resume-on-restart: dsh-im notification provider');
  const disposer = effects[0].execute();
  assert.equal(typeof disposer, 'function', 'effect 的 execute 返回 dsh-im disposer');
  disposer();
  assert.equal(fake.calls.disposed, 1);
});

test('wire：scope 里是旧版 dsh-im → 不注册也不挂 effect（完全降级）', () => {
  const fake = fakeDshIm({ version: 0 });
  const effects = [];
  const scope = {
    dshIm: fake.dshIm,
    effect(execute, label) { effects.push({ execute, label }); },
  };
  wireImNotificationProvider({
    inject(names, callback) {
      callback(scope);
      return null;
    },
  });
  assert.equal(fake.calls.providers.length, 0);
  assert.equal(effects.length, 0);
});
