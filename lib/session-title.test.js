/**
 * 0.37.0 会话标题扩展点（lib/hooks.js 的 session-title 链）单测。
 *
 * 覆盖：
 * 1. normalizeSessionTitleOverride：`{ title: '非空字符串' }` 才生效，其余
 *    （undefined/null/{title:''}/裸字符串/数组）一律不覆盖；
 * 2. buildSessionTitlePayload：形状固定 { event, plugin, phase, id, title }、整体冻结；
 * 3. runSessionTitleChain：默认值透传、单个覆盖、链式覆盖（后者拿到前者结果、
 *    后者覆盖前者）、空返回不覆盖、title 为空的兜底（全链没人给 → ''）、处理器
 *    抛错/超时 fail-open（warn 后按不覆盖继续）、极旧宿主无 ctx → 原值返回、
 *    无 ctx.events.dispatch 时回退 ctx.serial 的 bail 语义；
 * 4. 包根 re-export（SESSION_TITLE_HOOK / HOOK_EVENTS 与 hooks.js 同源）。
 *
 * ctx 桩：模拟 cordis 的 EventsService.dispatch(type, args)——原地把 args 里的
 * thisArg 与事件名 shift 掉、返回按注册顺序排列的回调数组（fiber 生命周期过滤
 * 在真实宿主内完成，桩里直接给数组）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  SESSION_TITLE_HOOK,
  buildSessionTitlePayload,
  normalizeSessionTitleOverride,
  runSessionTitleChain,
} from './hooks.js';
import { SESSION_TITLE_HOOK as ROOT_SESSION_TITLE_HOOK, HOOK_EVENTS as ROOT_HOOK_EVENTS } from './index.js';

/** 构造假 ctx：events.dispatch 返回给定监听器数组（原样模拟 cordis 派发协议）。 */
function fakeCtx(listeners) {
  const calls = [];
  return {
    calls,
    events: {
      dispatch(type, args) {
        // cordis 真实协议：args[0] 是事件名字符串（非对象/函数）→ thisArg 不 shift
        // 保持 null，只把事件名 shift 掉，返回按注册顺序排列的回调数组
        calls.push({ type, event: args[0] });
        args.shift(); // 事件名
        return listeners.slice();
      },
    },
  };
}

// ---- 1. 覆盖值归一化 ----

test('normalizeSessionTitleOverride: {title 非空字符串} 才生效', () => {
  assert.equal(normalizeSessionTitleOverride({ title: '新标题' }), '新标题');
});

test('normalizeSessionTitleOverride: 空/undefined/其它形状一律不覆盖', () => {
  assert.equal(normalizeSessionTitleOverride(undefined), null);
  assert.equal(normalizeSessionTitleOverride(null), null);
  assert.equal(normalizeSessionTitleOverride({}), null);
  assert.equal(normalizeSessionTitleOverride({ title: '' }), null);
  assert.equal(normalizeSessionTitleOverride({ title: 123 }), null);
  assert.equal(normalizeSessionTitleOverride({ title: null }), null);
  assert.equal(normalizeSessionTitleOverride('裸字符串不认'), null);
  assert.equal(normalizeSessionTitleOverride(['数组']), null);
  assert.equal(normalizeSessionTitleOverride(42), null);
});

// ---- 2. payload 形状 ----

test('buildSessionTitlePayload: 形状固定 + 整体冻结', () => {
  const payload = buildSessionTitlePayload({ id: 'session-1', title: '默认标题', phase: 'restore-record' });
  assert.deepEqual(payload, {
    event: 'resume-on-restart/session-title',
    plugin: 'dsh-resume-on-restart',
    phase: 'restore-record',
    id: 'session-1',
    title: '默认标题',
  });
  assert.equal(payload.event, SESSION_TITLE_HOOK);
  assert.equal(Object.isFrozen(payload), true);
  // 非法/缺失输入的兜底：title 缺省归 ''、phase 缺省归 ''
  const bare = buildSessionTitlePayload({ id: 'session-1' });
  assert.equal(bare.title, '');
  assert.equal(bare.phase, '');
  const dirty = buildSessionTitlePayload({ id: 'session-1', title: 42, phase: 7 });
  assert.equal(dirty.title, '');
  assert.equal(dirty.phase, '');
});

// ---- 3. 链式派发语义 ----

test('runSessionTitleChain: 无监听器 → 默认标题透传', async () => {
  const ctx = fakeCtx([]);
  const out = await runSessionTitleChain(ctx, buildSessionTitlePayload({ id: 's1', title: '默认', phase: '' }));
  assert.equal(out, '默认');
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].type, 'emit');
});

test('runSessionTitleChain: 单个处理器覆盖默认标题', async () => {
  const seen = [];
  const ctx = fakeCtx([
    async (payload) => {
      seen.push(payload.title);
      return { title: '插件标题' };
    },
  ]);
  const out = await runSessionTitleChain(ctx, buildSessionTitlePayload({ id: 's1', title: '默认', phase: 'settle-backfill' }));
  assert.equal(out, '插件标题');
  assert.deepEqual(seen, ['默认']); // 处理器拿到的是默认值
});

test('runSessionTitleChain: 链式覆盖——后者拿到前者结果并覆盖前者（按注册顺序）', async () => {
  const seen = [];
  const ctx = fakeCtx([
    (payload) => {
      seen.push(`A:${payload.title}`);
      return { title: 'A 标题' };
    },
    async (payload) => {
      seen.push(`B:${payload.title}`);
      return { title: 'B 标题' };
    },
    (payload) => {
      seen.push(`C:${payload.title}`);
      return undefined; // 不覆盖
    },
  ]);
  const out = await runSessionTitleChain(ctx, buildSessionTitlePayload({ id: 's1', title: '默认' }));
  assert.equal(out, 'B 标题'); // 后者覆盖前者
  assert.deepEqual(seen, ['A:默认', 'B:A 标题', 'C:B 标题']);
});

test('runSessionTitleChain: 空返回 / {title:\'\'} 不覆盖，title 为空时兜底为 \'\'', async () => {
  const ctx = fakeCtx([
    (payload) => ({ title: '' }), // 空字符串 = 不覆盖
    () => undefined,
    () => null,
    () => ({}),
  ]);
  assert.equal(await runSessionTitleChain(ctx, buildSessionTitlePayload({ id: 's1', title: '默认' })), '默认');
  // 全链没人给标题：默认就是 '' → 最终 ''
  const empty = fakeCtx([() => ({ title: '' }), () => undefined]);
  assert.equal(await runSessionTitleChain(empty, buildSessionTitlePayload({ id: 's1', title: '' })), '');
});

test('runSessionTitleChain: 处理器抛错 → fail-open（warn 后按不覆盖继续跑下一个）', async () => {
  const ctx = fakeCtx([
    () => {
      throw new Error('第三方插件炸了');
    },
    (payload) => ({ title: `兜底:${payload.title}` }),
  ]);
  const out = await runSessionTitleChain(ctx, buildSessionTitlePayload({ id: 's1', title: '默认' }));
  assert.equal(out, '兜底:默认'); // 抛错的处理器被跳过，链继续
});

test('runSessionTitleChain: 处理器超时 → fail-open（不永久挂住），非法 timeoutMs 回退默认', async () => {
  const ctx = fakeCtx([
    () => new Promise(() => {}), // 永不 resolve → 超时
    (payload) => ({ title: `after:${payload.title}` }),
  ]);
  const out = await runSessionTitleChain(ctx, buildSessionTitlePayload({ id: 's1', title: '默认' }), { timeoutMs: 30 });
  assert.equal(out, 'after:默认');
  // 非法 timeoutMs 回退默认常量（不会变成 0ms 立即超时）
  const ok = fakeCtx([
    () => new Promise((resolve) => setTimeout(() => resolve({ title: '慢但快于默认上限' }), 10)),
  ]);
  assert.equal(
    await runSessionTitleChain(ok, buildSessionTitlePayload({ id: 's1', title: '' }), { timeoutMs: Number.NaN }),
    '慢但快于默认上限',
  );
  assert.equal(DEFAULT_HOOK_TIMEOUT_MS > 0, true);
});

test('runSessionTitleChain: 宿主无 ctx（null / 空对象）→ 原值返回，绝不抛错', async () => {
  assert.equal(await runSessionTitleChain(null, buildSessionTitlePayload({ id: 's1', title: '默认' })), '默认');
  assert.equal(await runSessionTitleChain({}, buildSessionTitlePayload({ id: 's1', title: '' })), '');
});

test('runSessionTitleChain: 无 ctx.events.dispatch 时回退 ctx.serial 的 bail 语义（降级）', async () => {
  // serial 桩：第一个覆盖值生效（bail 即停——降级语义，文档已注明）
  const serialCtx = {
    serial: async (event, payload) => {
      assert.equal(event, SESSION_TITLE_HOOK);
      return { title: `serial:${payload.title}` };
    },
  };
  assert.equal(
    await runSessionTitleChain(serialCtx, buildSessionTitlePayload({ id: 's1', title: '默认' })),
    'serial:默认',
  );
  // serial 返回 undefined（没人覆盖）→ 默认值
  const quietCtx = { serial: async () => undefined };
  assert.equal(await runSessionTitleChain(quietCtx, buildSessionTitlePayload({ id: 's1', title: '默认' })), '默认');
  // dispatch 抛错也降级到 serial，不炸调用方
  const brokenThenSerial = {
    events: {
      dispatch() {
        throw new Error('dispatch unavailable');
      },
    },
    serial: async () => ({ title: 'serial 兜底' }),
  };
  assert.equal(
    await runSessionTitleChain(brokenThenSerial, buildSessionTitlePayload({ id: 's1', title: '' })),
    'serial 兜底',
  );
});

test('runSessionTitleChain: 每步 payload 冻结且 id/phase 原样透传', async () => {
  const seen = [];
  const ctx = fakeCtx([
    (payload) => {
      seen.push(payload);
      return { title: 'X' };
    },
    (payload) => {
      seen.push(payload);
      return undefined;
    },
  ]);
  await runSessionTitleChain(ctx, buildSessionTitlePayload({ id: 'session-9', title: 'D', phase: 'restore-record' }));
  assert.equal(seen.length, 2);
  for (const payload of seen) {
    assert.equal(Object.isFrozen(payload), true);
    assert.equal(payload.id, 'session-9');
    assert.equal(payload.phase, 'restore-record');
    assert.equal(payload.event, SESSION_TITLE_HOOK);
  }
  assert.equal(seen[0].title, 'D');
  assert.equal(seen[1].title, 'X'); // 后者拿到前者结果
});

// ---- 4. 常量与包根 re-export ----

test('SESSION_TITLE_HOOK 常量与 HOOK_EVENTS.sessionTitle、包根 re-export 同源', () => {
  assert.equal(SESSION_TITLE_HOOK, 'resume-on-restart/session-title');
  assert.equal(HOOK_EVENTS.sessionTitle, SESSION_TITLE_HOOK);
  assert.equal(HOOK_EVENTS.beforeRestart, 'resume-on-restart/before-restart');
  assert.equal(HOOK_EVENTS.beforeResume, 'resume-on-restart/before-resume');
  assert.equal(ROOT_SESSION_TITLE_HOOK, SESSION_TITLE_HOOK);
  assert.equal(ROOT_HOOK_EVENTS.sessionTitle, SESSION_TITLE_HOOK);
  assert.equal(Object.isFrozen(HOOK_EVENTS), true);
});
