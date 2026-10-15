/**
 * lib/restart.js 的单元测试（0.8.0）：重启引擎的纯函数部分。
 * 覆盖：模式判定、端口 pin、退出预算派生、origin 归一化、身份认领
 * （v2 令牌 / pid1 无令牌时效窗口 / 陈旧与自指拒绝）、防重入闩、
 * delayMs 夹取、helper 脚本产物的关键协议点断言。
 * 不依赖 DSH 运行时，不产生网络/进程副作用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IDENTITY_TTL_MS,
  buildOriginRecord,
  buildRelaunchArgs,
  buildRestartHelper,
  clampModelDelayMs,
  createTransitionLatch,
  helperOldPidWaitMs,
  matchRestartIdentity,
  normalizeOrigin,
  pinRelaunchPort,
  preExitBudgetMs,
  resolveRestartMode,
} from './restart.js';

// ---- resolveRestartMode：PID=1 容器场景是本插件的现实部署形态 ----

test('resolveRestartMode: pid 1 → pid1-exit（helper 在 PID namespace 销毁时必死）', () => {
  assert.equal(resolveRestartMode(1), 'pid1-exit');
});

test('resolveRestartMode: 普通进程 → helper', () => {
  assert.equal(resolveRestartMode(42), 'helper');
  assert.equal(resolveRestartMode(3080), 'helper');
});

// ---- pinRelaunchPort：--port 0 逐字重放会让后继进程绑错端口 ----

test('pinRelaunchPort: --port N 空格形式被替换', () => {
  assert.deepEqual(
    pinRelaunchPort(['bin.js', '--port', '0', '--profile', 'web'], 3080),
    ['bin.js', '--port', '3080', '--profile', 'web'],
  );
});

test('pinRelaunchPort: --port=N 形式被替换', () => {
  assert.deepEqual(pinRelaunchPort(['--port=0'], 3080), ['--port=3080']);
});

test('pinRelaunchPort: 无 --port 原样返回（端口来自配置，不得擅自加 flag）', () => {
  const argv = ['bin.js', '--profile', 'web'];
  assert.deepEqual(pinRelaunchPort(argv, 3080), argv);
});

test('pinRelaunchPort: 只替换第一个 --port，不改其它参数', () => {
  assert.deepEqual(
    pinRelaunchPort(['--retry-port', '9', '--port', '7777'], 1234),
    ['--retry-port', '9', '--port', '1234'],
  );
});

// ---- 预算派生：helper 的耐心必须严格大于 host 自身退出预算 ----

test('preExitBudgetMs / helperOldPidWaitMs: 派生关系与余量', () => {
  assert.equal(preExitBudgetMs(1500), 5000 + 1500 + 15000);
  assert.equal(helperOldPidWaitMs(1500), preExitBudgetMs(1500) + 15000);
  assert.equal(preExitBudgetMs(0), 20000); // 负 delay 被夹为 0
});

// ---- origin 归一化 ----

test('normalizeOrigin: 白名单 kind + 可选 sessionId', () => {
  assert.deepEqual(normalizeOrigin({ kind: 'settings-ui' }), { kind: 'settings-ui' });
  assert.deepEqual(normalizeOrigin({ kind: 'model-tool', sessionId: 's1' }), { kind: 'model-tool', sessionId: 's1' });
  assert.equal(normalizeOrigin({ kind: 'nope' }), undefined);
  assert.equal(normalizeOrigin(null), undefined);
  // sessionId 非字符串 → 丢弃但不弃整个 origin
  assert.deepEqual(normalizeOrigin({ kind: 'command', sessionId: 42 }), { kind: 'command' });
});

test('buildOriginRecord: 非法 kind 返回 undefined', () => {
  assert.deepEqual(buildOriginRecord('settings-ui', ''), { kind: 'settings-ui' });
  assert.equal(buildOriginRecord('bogus'), undefined);
});

// ---- 身份认领：v2 令牌 / pid1 时效窗口 / 拒绝路径 ----

const IDENTITY_BASE = {
  schemaVersion: 2,
  source: 'dsh-resume-on-restart',
  restartId: 'rid-1',
  fromInstanceId: 'instance-old',
  origin: { kind: 'settings-ui' },
  requestedAt: '2026-10-15T01:00:00.000Z',
};

test('matchRestartIdentity: v2 + 匹配令牌 → 认领（helper 模式）', () => {
  const now = Date.parse('2026-10-15T01:00:30.000Z');
  assert.deepEqual(
    matchRestartIdentity(IDENTITY_BASE, 'rid-1', 'instance-new', now),
    { fromInstanceId: 'instance-old', restartId: 'rid-1', origin: { kind: 'settings-ui' } },
  );
});

test('matchRestartIdentity: 令牌不匹配 → 拒绝（手动启动不能冒领）', () => {
  const now = Date.parse('2026-10-15T01:00:30.000Z');
  assert.equal(matchRestartIdentity(IDENTITY_BASE, 'other-token', 'instance-new', now), null);
});

test('matchRestartIdentity: 无令牌 + 窗口内 → pid1-exit 认领', () => {
  const now = Date.parse('2026-10-15T01:09:00.000Z'); // 9 分钟 < IDENTITY_TTL_MS
  const claimed = matchRestartIdentity(IDENTITY_BASE, undefined, 'instance-new', now);
  assert.equal(claimed?.restartId, 'rid-1');
});

test('matchRestartIdentity: 无令牌 + 超窗口 → 拒绝（陈旧记录）', () => {
  const now = Date.parse('2026-10-15T01:00:00.000Z') + IDENTITY_TTL_MS + 1;
  assert.equal(matchRestartIdentity(IDENTITY_BASE, undefined, 'instance-new', now), null);
});

test('matchRestartIdentity: 无令牌 + requestedAt 在未来（时钟偏移超容差语义）→ 拒绝', () => {
  const now = Date.parse('2026-10-15T00:59:00.000Z'); // 早于 requestedAt
  assert.equal(matchRestartIdentity(IDENTITY_BASE, undefined, 'instance-new', now), null);
});

test('matchRestartIdentity: fromInstanceId 自指 / 形状非法 → 拒绝', () => {
  const now = Date.parse('2026-10-15T01:00:30.000Z');
  assert.equal(matchRestartIdentity({ ...IDENTITY_BASE, fromInstanceId: 'instance-new' }, 'rid-1', 'instance-new', now), null);
  assert.equal(matchRestartIdentity(null, 'rid-1', 'instance-new', now), null);
  assert.equal(matchRestartIdentity({ restartId: 'x' }, 'rid-1', 'instance-new', now), null);
  // schema v2 但缺 restartId → 形状不完整，拒绝
  assert.equal(
    matchRestartIdentity({ ...IDENTITY_BASE, restartId: null }, undefined, 'instance-new', now),
    null,
  );
});

// ---- 防重入闩 ----

test('createTransitionLatch: 首次领取成功，随后 409，失败可释放', () => {
  const latch = createTransitionLatch();
  assert.equal(latch.claim('restart'), true);
  assert.equal(latch.claim('restart'), false);
  assert.equal(latch.current(), 'restart');
  latch.release();
  assert.equal(latch.current(), null);
  assert.equal(latch.claim('restart'), true);
});

// ---- clampModelDelayMs：下限 1000ms，模型不能抢在自己 turn 结算前杀进程 ----

test('clampModelDelayMs: 下限/上限/非法值', () => {
  assert.equal(clampModelDelayMs(50, 5000), 1000);
  assert.equal(clampModelDelayMs(99999, 5000), 5000);
  assert.equal(clampModelDelayMs(2000, 5000), 2000);
  assert.equal(clampModelDelayMs(undefined, 5000), 1500);
  assert.equal(clampModelDelayMs('bad', 5000), 1500);
  // 上限被配置得比下限还小（脏配置）→ 有效区间塌缩到下限 1000，不会放行更小值
  assert.equal(clampModelDelayMs(2000, 10), 1000);
});

// ---- helper 脚本产物：对关键协议点做字符串断言（真实进程级验收见 power-button 范式） ----

test('buildRestartHelper: 产物内嵌握手常量、身份文件（非检测 marker）与启动令牌', () => {
  const script = buildRestartHelper({
    relaunch: ['/usr/local/bin/node', 'bin.js', '--port', '3080'],
    cwd: '/srv/dsh',
    port: 3080,
    oldPid: 1234,
    oldInstanceId: 'instance-old',
    restartId: 'rid-1',
    identityFile: '/home/u/.dsh/.resume-on-restart/restart-identity.json',
    statusFile: '/home/u/.dsh/power-restart/ror-rid-1.status.json',
    lastStatusFile: '/home/u/.dsh/.resume-on-restart/last-restart-status.json',
    commitFile: '/home/u/.dsh/.resume-on-restart/ror-rid-1.commit.json',
    logFile: '/home/u/.dsh/.resume-on-restart/restart-helper-1234.log',
    serverLog: '/home/u/.dsh/.resume-on-restart/restart-relaunch.log',
    sessionsRoot: '/home/u/.dsh/sessions',
    healthPath: '/api/dsh-resume-on-restart/restart/health',
    commitWaitMs: 30000,
    readyWaitMs: 60000,
    oldPidWaitMs: 36500,
    requestedAt: '2026-10-15T01:00:00.000Z',
    origin: { kind: 'settings-ui' },
  });
  // CJS 形态（node -e 的多行脚本会被 Windows CreateProcess 搅碎）
  assert.match(script, /require\('node:child_process'\)/);
  // 身份记录写到独立文件，绝不覆写检测 marker.json
  assert.match(script, /restart-identity\.json/);
  assert.doesNotMatch(script, /marker\.json/);
  // v2 协议三要素：先写身份再 spawn、env 启动令牌、健康门控双条件
  assert.match(script, /const SCHEMA_VERSION = 2/);
  assert.match(script, /schemaVersion: SCHEMA_VERSION/);
  assert.match(script, /DSH_ROR_RESTART_ID/);
  assert.match(script, /health\.instanceId !== OLD_INSTANCE/);
  assert.match(script, /health\.restart\.restartId === RESTART_ID/);
  // ARM → COMMIT → ACK 三段握手与静默检测
  assert.match(script, /stage: 'armed'/);
  assert.match(script, /waitForCommit/);
  assert.match(script, /stage: 'committed'/);
  assert.match(script, /sessionsQuiescent/);
  // 会话静默检测覆盖 session.v4.jsonl 与 .zstd 形态（power-button 的正则漏掉 v4）
  assert.match(script, /\.jsonl\.zstd/);
  // 重启次数上限与旧 pid 耐心来自 host 预算派生
  assert.match(script, /RELAUNCH_RETRIES = 3/);
  assert.match(script, /OLD_PID_WAIT_MS = 36500/);
  // origin 与 source 随 payload 进 status 记录（重启日志归因数据源）
  assert.match(script, /"settings-ui"/);
  assert.match(script, /dsh-resume-on-restart/);
});

test('buildRelaunchArgs: execPath + execArgv + argv（端口 pin），env/NODE_OPTIONS 由子进程自然继承', () => {
  const args = buildRelaunchArgs(4321);
  assert.equal(args[0], process.execPath);
  assert.deepEqual(args.slice(1 + process.execArgv.length), pinRelaunchPort(process.argv.slice(1), 4321));
});

// ---- 端到端：helper 脚本作为真实进程执行（对齐 power-button 的验收思路，迷你版） ----

test('helper 端到端：COMMIT 前不出手；host COMMIT 后写身份记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ror-helper-'));
  try {
    const statusFile = join(dir, 'ror-t.status.json');
    const commitFile = join(dir, 'ror-t.commit.json');
    const identityFile = join(dir, 'restart-identity.json');
    // 目标脚本：模拟旧进程——立即退出（oldPid 用一个必然不存在的 pid 会立即通过，
    // 这里反过来用一个"马上退出的真实子进程"，保证 pidGone 轮询真的工作）
    const targetScript = join(dir, 'target.cjs');
    writeFileSync(targetScript, 'setTimeout(() => process.exit(0), 300);\n', 'utf8');
    const { spawn } = await import('node:child_process');
    const target = spawn(process.execPath, [targetScript], { stdio: 'ignore' });
    const targetPid = target.pid;
    const helperScriptPath = join(dir, 'helper.cjs');
    writeFileSync(helperScriptPath, buildRestartHelper({
      relaunch: [process.execPath, '-e', 'process.exit(0)'],
      cwd: dir,
      port: 1, // 端口检测：1 端口几乎必然 free（无服务监听 → error → free）
      oldPid: targetPid,
      oldInstanceId: 'instance-old',
      restartId: 'rid-e2e',
      identityFile,
      statusFile,
      lastStatusFile: join(dir, 'last.json'),
      commitFile,
      logFile: join(dir, 'helper.log'),
      serverLog: join(dir, 'server.log'),
      sessionsRoot: join(dir, 'sessions'), // 不存在 → 静默检测立即通过
      healthPath: '/health',
      commitWaitMs: 5000,
      readyWaitMs: 5000,
      oldPidWaitMs: 10000,
      requestedAt: new Date().toISOString(),
      origin: { kind: 'settings-ui' },
    }), 'utf8');
    const helper = spawn(process.execPath, [helperScriptPath], { stdio: 'ignore' });
    // 等 ARM（status 文件出现 armedAt）
    let armed = null;
    for (let i = 0; i < 100 && !armed; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const s = JSON.parse(readFileSync(statusFile, 'utf8'));
        if (s.armedAt) armed = s;
      } catch { /* 尚未写入 */ }
    }
    assert.ok(armed, 'helper 应在 10s 内 ARM');
    assert.equal(armed.stage, 'armed');
    assert.equal(armed.restartId, 'rid-e2e');
    // COMMIT 前不给授权：身份记录不应存在（helper 未出手）
    assert.equal(matchRestartIdentity(readIdentity(identityFile), 'rid-e2e', 'instance-new'), null);
    // 写 COMMIT → helper ACK → 等旧 pid 退出 → 写身份记录 → 拉起 -e 目标（立即退出）→
    // health 门控最终 health-timeout 失败，但身份记录必须已经写好（v2 协议先写后 spawn）
    writeFileSync(commitFile, JSON.stringify({ restartId: 'rid-e2e', committedAt: new Date().toISOString() }), 'utf8');
    let identityShown = false;
    for (let i = 0; i < 200 && !identityShown; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      identityShown = matchRestartIdentity(readIdentity(identityFile), 'rid-e2e', 'instance-new') !== null;
    }
    assert.ok(identityShown, 'COMMIT 后 helper 必须先写身份记录（v2 先写后 spawn）');
    // helper 最终因 health-timeout 结束（拉起的是立即退出的假目标），status 记录 failed
    let failed = false;
    for (let i = 0; i < 150 && !failed; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const s = JSON.parse(readFileSync(statusFile, 'utf8'));
        failed = s.stage === 'failed' && s.failure?.code === 'health-timeout';
      } catch { /* 继续 */ }
    }
    assert.ok(failed, '假目标无法通过 health 门控 → 应以 health-timeout 收场而非假成功');
    helper.kill();
    target.kill();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, { timeout: 60000 });

/** 读取身份记录并解析（缺失/损坏返回 undefined，由 matchRestartIdentity 拒绝）。 */
function readIdentity(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
