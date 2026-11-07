/**
 * 0.32.1「待重启恢复列表的运行徽标取实时状态」的宿主接线单测
 * （node --test，无 e2e、不起任何服务、不联网）。
 *
 * 背景（实测症状）：marker.recentSessions 的 `running` 是「最后已知」快照，只在
 * agent/status 事件到来时更新。会话被重启打断（turn 开着被 kill）、之后恢复又
 * 失败（宿主以 `owned by subagent routing` 拒绝 subagent 会话即实例）时，该会话
 * 此后再没有任何状态事件 → 标记永久停在 true，设置弹窗「待重启恢复会话列表」
 * 就把一个早已不在运行的会话显示成「● 运行中」。本文件钉住修复后的口径：
 *
 * 1. `/restart/info` 候选明细的 `running` 取**活 agent 的实时 status**
 *    （agents.list() → status==='running'，与 pause-all / 守门自动重启同一个
 *    selectRunningAgentIds）：marker 说 true 但活 agent 是 idle / 根本不在名单里
 *    → `running:false`；反过来 marker 说 false 但活 agent 正在跑 → `running:true`；
 * 2. agents 服务探不到（`ctx.get('agents')` 缺失 / list() 抛错 / 返回值不是数组）
 *    → **回退** 0.13.0 口径（marker 最后已知值），降级行为逐字不变、路由照旧 200；
 * 3. `agents.list()` 返回空数组是**有效数据**（此刻没有会话在运行），不是不可用
 *    → 一律 `running:false`，绝不回退到陈旧的 marker 值；
 * 4. 候选集合、at/workspace/source 等其余字段口径完全不变（本修复只改 running）。
 *
 * 做法照 lib/archive.test.js：普通对象假 ctx 跑 apply()，捕获 prefix 路由 handler
 * 后直接调用（无真实 HTTP），marker 铺在独立临时 DSH_HOME 下（绝不读写真实
 * ~/.dsh）。`restoreSessions:false` 关掉开机恢复异步流程，让断言只观测
 * /restart/info 的展示口径（本修复不触碰恢复流程）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from './index.js';

/** marker 里两个候选：陈旧运行标记（真实已 idle/不在名单）与反向场景（真实在跑）。 */
const STALE_ID = 'stale-running-marked-true';
const BUSY_ID = 'busy-marked-false';

/**
 * 建一套隔离 harness：临时 DSH_HOME + 播种 marker（pid/时刻都不同 → 判定为重启，
 * 于是 Apply 时按重启流程读取候选）+ 跑 apply() + 拿到路由 handler。
 *
 * @param {{agents?: unknown, agentsThrows?: boolean, restoreSessions?: boolean}} [options]
 *   agents：`ctx.get('agents')` 返回的假 agents 服务（缺省 = 服务不可用）；
 *   agentsThrows：`agents.list()` 抛错（模拟服务内部炸掉）；
 *   restoreSessions：0.32.1 的用例全部传 false（关掉开机恢复异步流程）。
 */
function buildHarness({ agents, agentsThrows = false, restoreSessions = false } = {}) {
  const dshHome = mkdtempSync(join(tmpdir(), 'ror-running-badge-'));
  process.env.DSH_HOME = dshHome;
  const stateDir = join(dshHome, '.resume-on-restart');
  mkdirSync(stateDir, { recursive: true });
  // 注意：这里刻意**不**伪造重启（pid 与本进程相同 + lastBootAt 就是现在）——
  // 判非重启后 apply() 不会起开机恢复/回退唤醒的异步流程（那是 20s+ 的等待与
  // 投递循环），用例只观测 /restart/info 的展示口径；recentSessions 的播种与
  // 重启判定无关（启动即从 marker 读取），候选列表照旧可用。
  const seededAt = new Date().toISOString();
  writeFileSync(join(stateDir, 'marker.json'), JSON.stringify({
    lastBootAt: seededAt,
    pid: process.pid,
    recentSessions: [
      // marker 说「运行中」
      { id: STALE_ID, at: new Date(Date.now() - 1_000).toISOString(), running: true },
      // marker 说「没在运行」
      { id: BUSY_ID, at: new Date(Date.now() - 2_000).toISOString(), running: false },
    ],
  }, null, 2));

  const captured = { route: null };
  const liveAgents = agentsThrows
    ? { list() { throw new Error('agents registry exploded'); } }
    : agents;
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
      if (deps.includes('agents')) cb({ agents: liveAgents ?? { roots: () => [], list: () => [] } });
    },
    effect(fn) { fn(); },
    get(name) { return name === 'agents' ? liveAgents : undefined; },
    // 其余服务一律缺失：workspace/subagent/标题 全部走降级分支（不影响 running）
    reflect: { get() { return undefined; } },
  };
  apply(ctx, { enabled: true, restoreSessions });

  /** 直接调用捕获的 prefix 路由 handler（同 lib/archive.test.js 的 callRoute）。 */
  const callRoute = (sub) => new Promise((resolve) => {
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
    captured.route.handler(req, res);
  });

  return { callRoute, cleanup: () => rmSync(dshHome, { recursive: true, force: true }) };
}

/** 取候选明细里某个 id 的行（缺失返回 null）。 */
const rowOf = (body, id) => (body?.runningCandidates ?? []).find((row) => row.id === id) ?? null;

test('运行徽标取活 agent 实时状态：marker 说运行中但真实 idle → false；marker 说 false 但真实在跑 → true', async () => {
  const harness = buildHarness({
    agents: {
      roots: () => [],
      list: () => [
        { id: STALE_ID, status: 'idle' },      // 陈旧 true 的真实状态：没在运行
        { id: BUSY_ID, status: 'running' },    // 反向场景：真实在运行
        { id: 'head-ignored', status: 'running' }, // 不在候选池，不影响断言
      ],
    },
  });
  try {
    const { status, body } = await harness.callRoute('/restart/info');
    assert.equal(status, 200);
    assert.equal(rowOf(body, STALE_ID)?.running, false, 'marker 的陈旧 true 必须被实时状态覆盖');
    assert.equal(rowOf(body, BUSY_ID)?.running, true, 'marker 是 false 但活 agent 在跑 → true');
    // 只改 running：id/at/workspace/source 口径不变
    const stale = rowOf(body, STALE_ID);
    assert.equal(stale.workspace, '', '未知工作区仍为空串');
    assert.equal(stale.source, 'auto');
  } finally {
    harness.cleanup();
  }
});

test('活 agent 不在名单里（会话根本没有活 agent）→ 运行徽标熄灭', async () => {
  const harness = buildHarness({
    agents: { roots: () => [], list: () => [] },
  });
  try {
    const { status, body } = await harness.callRoute('/restart/info');
    assert.equal(status, 200);
    // 空数组是有效数据（此刻没人运行），不是「服务不可用」→ 不得回退 marker
    assert.equal(rowOf(body, STALE_ID)?.running, false);
    assert.equal(rowOf(body, BUSY_ID)?.running, false);
  } finally {
    harness.cleanup();
  }
});

test('agents 服务不可用（ctx.get 拿不到）→ 回退 marker 最后已知值（0.13.0 口径不变）', async () => {
  const harness = buildHarness({ agents: undefined });
  try {
    const { status, body } = await harness.callRoute('/restart/info');
    assert.equal(status, 200);
    assert.equal(rowOf(body, STALE_ID)?.running, true, '降级路径：照旧取 marker');
    assert.equal(rowOf(body, BUSY_ID)?.running, false);
  } finally {
    harness.cleanup();
  }
});

test('agents.list() 抛错 → 回退 marker 最后已知值且路由照旧 200（不 500、不空列表）', async () => {
  const harness = buildHarness({ agentsThrows: true });
  try {
    const { status, body } = await harness.callRoute('/restart/info');
    assert.equal(status, 200);
    assert.equal(rowOf(body, STALE_ID)?.running, true);
    assert.equal(rowOf(body, BUSY_ID)?.running, false);
  } finally {
    harness.cleanup();
  }
});

test('agents 服务只有 roots 没有 list（形状不合）→ 同样回退 marker（绝不同步抛错）', async () => {
  const harness = buildHarness({ agents: { roots: () => [] } });
  try {
    const { status, body } = await harness.callRoute('/restart/info');
    assert.equal(status, 200);
    assert.equal(rowOf(body, STALE_ID)?.running, true);
  } finally {
    harness.cleanup();
  }
});
