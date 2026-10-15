/**
 * 手动冒烟（不进 npm test）：验证 0.8.0 宿主接线。
 * 1) mock cordis ctx 启动插件 → GET /restart/info、GET /restart/health、404 开关
 * 2) 子进程内直接调 restartDsh 的 pid1-exit 分支（stub appExit）→ 验证记录写盘
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { restartDsh } from '../lib/restart.js';

// 关键：apply 之前重定向 DSH_HOME（resolveDshHome 读该 env），
// 否则冒烟会读写真实的 ~/.dsh
const dshHome = mkdtempSync(join(tmpdir(), 'ror-smoke-'));
process.env.DSH_HOME = dshHome;
let capturedRoute = null;
const effects = [];
const ctx = {
  on() { return () => {}; },
  inject(deps, cb) {
    if (deps.includes('webServer')) cb({ webServer: { host: '127.0.0.1', register(route) { capturedRoute = route; }, server: { address: () => ({ port: 3080 }) } } });
    if (deps.includes('agents')) cb({ agents: { roots: () => [], list: () => [] } });
  },
  effect(fn, label) { effects.push(label); try { fn(); } catch { /* 注册失败忽略 */ } },
  reflect: { get() { return undefined; } },
  get() { return undefined; },
};
apply(ctx, {
  enabled: true,
  stateDir: '.resume-on-restart',
  serviceWaitTimeoutMs: 1,
  requireHumanPrompt: false,
});

const call = (method, sub, body) => new Promise((resolve) => {
  const req = { method, url: `/api/dsh-resume-on-restart${sub}`, headers: { host: '127.0.0.1:3080' }, on() {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    writeHead(status, headers) { this.status = status; },
    end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }); },
  };
  capturedRoute.handler(req, res);
});

const info = await call('GET', '/restart/info');
console.log('info:', JSON.stringify(info.body));
if (info.body?.ok !== true || info.body?.mode !== 'helper') throw new Error('info 应返回 ok + helper 模式');
if (!Array.isArray(info.body.runningCandidates)) throw new Error('info 应带 runningCandidates');

const health = await call('GET', '/restart/health');
console.log('health:', JSON.stringify(health.body));
if (health.body?.ok !== true || typeof health.body?.instanceId !== 'string') throw new Error('health 应带 instanceId');
if (health.body?.restart) throw new Error('无身份记录时 health 不应有 restart 块');

console.log('effects:', effects.join(' | '));

// pid1-exit 分支端到端（stub appExit，exit 定时器 1.2s 后触发但 stub 只记录）
const appExitCalls = [];
const stateDir = join(dshHome, '.resume-on-restart');
const result = await restartDsh(
  { get: (k) => (k === 'appExit' ? (code) => appExitCalls.push(code) : undefined) },
  {
    mode: 'pid1-exit',
    delayMs: 1200,
    exitCode: 7,
    origin: { kind: 'settings-ui' },
    oldInstanceId: 'instance-old',
    port: 3080,
    paths: {
      stateDir,
      powerRestartDir: join(dshHome, 'power-restart'),
      helperFile: join(stateDir, 'h.cjs'),
      logFile: join(stateDir, 'h.log'),
      lastStatusFile: join(stateDir, 'last.json'),
      identityFile: join(stateDir, 'restart-identity.json'),
      pendingShutdownFile: join(stateDir, 'pending-shutdown.json'),
      serverLog: join(stateDir, 'relaunch.log'),
      sessionsRoot: join(dshHome, 'sessions'),
      healthPath: '/api/dsh-resume-on-restart/restart/health',
    },
    flushMarkerState: () => {},
    writePendingShutdown: () => {},
  },
);
console.log('restart result:', JSON.stringify(result));
if (result.ok !== true || result.mode !== 'pid1-exit') throw new Error('pid1-exit 应 ok');

const statusRec = JSON.parse(readFileSync(join(dshHome, 'power-restart', `ror-${result.restartId}.status.json`), 'utf8'));
const identityRec = JSON.parse(readFileSync(join(stateDir, 'restart-identity.json'), 'utf8'));
console.log('status.committedAt 存在:', typeof statusRec.committedAt === 'string', '| identity.fromInstanceId:', identityRec.fromInstanceId);
if (typeof statusRec.committedAt !== 'string') throw new Error('status 应带 committedAt（origin 扫描依据）');
if (identityRec.fromInstanceId !== 'instance-old') throw new Error('身份记录应带 fromInstanceId');

// 等退出定时器触发（stub appExit 被调用、看门狗 unref 不阻塞进程退出）
await new Promise((r) => setTimeout(r, 2000));
if (JSON.stringify(appExitCalls) !== '[7]') throw new Error(`appExit 应以退出码 7 被调用一次，实际 ${JSON.stringify(appExitCalls)}`);
console.log('appExit called with exitCode 7 ✓');
console.log('SMOKE OK');
process.exit(0);
