/**
 * dsh-resume-on-restart 重启引擎（0.8.0 新增）。
 *
 * 参考 dsh-power-button（MIT，https://github.com/keyiadiannao/dsh-power-button）
 * 的"detached helper relaunch"设计独立实现，并针对本插件的两个现实约束做了改写：
 *
 * 1. **绝不碰检测 marker**：power-button 的 helper 会覆写它自己的 marker 文件；
 *    本插件的 `<stateDir>/marker.json` 承载 `recentSessions`（重启后恢复会话的
 *    唯一数据源），覆写即丢恢复上下文。因此 helper 的 v2 身份记录写到**独立的**
 *    `<stateDir>/restart-identity.json`，由新实例在启动时消费。
 * 2. **Docker PID=1 场景**（本插件的目标部署正是容器内 PID 1 跑 DSH）：PID 1
 *    退出时内核会销毁整个 PID namespace，detach 的 helper 也随之被杀，helper
 *    方案在结构上不可能工作。因此 `resolveRestartMode` 判定 PID=1 时走
 *    `pid1-exit` 模式：退出前把全部持久化记录写盘（origin status、身份记录、
 *    marker 兜底 flush、pending-shutdown 存根），然后优雅退出，由容器重启策略
 *    （--restart=always/unless-stopped，或 on-failure 配合 pid1ExitCode）或手动
 *    `docker start` 把进程拉起来。该模式下身份记录没有环境令牌可继承（新进程
 *    由容器运行时拉起，env 固定），改用"requestedAt 时效窗口"防陈旧认领。
 *
 * 握手协议（helper 模式，与 power-button 同构）：
 *   host: 写 helper .cjs（内嵌 relaunch argv，0600）→ spawn（detached）
 *   helper: ARM   → status { stage:'armed', armedAt }
 *   host:   等 ARMED → 写 COMMIT 文件（本 restartId）
 *   helper: ACK   → status { stage:'committed', committedAt }   ← 此刻才有 committedAt
 *   host:   等 ACK → unref → flush → 延迟请求退出（appExit 优先，看门狗兜底）
 *   helper: 等旧 pid 退出（预算由 host 退出预算派生）→ 等端口释放 → 等会话文件
 *           静默 → 写身份记录 → 用原 argv+cwd（端口 pin）拉起新进程（env 带
 *           DSH_ROR_RESTART_ID 令牌）→ 轮询 /health 直到 instanceId 变更且
 *           restartId 匹配 → 自删
 *
 * origin 归因集成：helper 的握手 status 文件写到 `~/.dsh/power-restart/` 目录
 * （文件名 `ror-<restartId>.status.json`，前缀与 power-button 区分），其中
 * `committedAt` 落在 [上次启动, 本次启动] 窗口内——本插件 0.5.0 起的 origin
 * 扫描（detect.pickOriginRecord）无需任何改动即可命中，重启日志因此能标注
 * 本次重启由谁发起（settings-ui / command / model-tool / http）。
 *
 * @module dsh-resume-on-restart/restart
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 启动令牌的环境变量名：新实例凭它与身份记录匹配才认领重启身份（helper 模式）。 */
export const LAUNCH_TOKEN_ENV = 'DSH_ROR_RESTART_ID';

/** 本插件 status/身份记录的 source 标识（重启日志 reason 标签据此区分）。 */
export const SOURCE = 'dsh-resume-on-restart';

// ---- 握手与退出预算常量（口径照抄 power-button，见其 README 的派生关系说明） ----

/** 请求退出后的看门狗：优雅退出（appExit/自发信号）迟迟不落地则硬退出。 */
export const APP_EXIT_WATCHDOG_MS = 15_000;
/** pid1-exit 模式下自发 SIGTERM 的看门狗：容器场景 Docker stop 宽限通常 10s，取 8s。 */
export const PID1_EXIT_WATCHDOG_MS = 8_000;
/** 退出前会话 flush 的硬上限：flush 卡死不能拖住退出（appExit 兜底才是权威）。 */
export const PRE_EXIT_FLUSH_CAP_MS = 5_000;
/** host 等待 helper 创建 + ARM 的时限。 */
export const HELPER_ARM_TIMEOUT_MS = 5_000;
/** host 等待 helper ACK（读到 COMMIT）的时限。 */
export const HELPER_COMMIT_TIMEOUT_MS = 5_000;
/** helper 等待 host COMMIT 的时限（超时即放弃，不留悬空 helper）。 */
export const HELPER_COMMIT_WAIT_MS = 30_000;
/** helper 等待新进程 /health 就绪的时限。 */
export const HELPER_READY_WAIT_MS = 60_000;
/** helper 对旧 pid 的耐心在 host 退出预算之外追加的调度余量。 */
export const HELPER_OLD_PID_MARGIN_MS = 15_000;
/** 握手 status/身份记录的 schema 版本。 */
export const RESTART_SCHEMA_VERSION = 2;
/** helper 拉起新进程的尝试次数（仅在"根本没创建出进程"时重试）。 */
export const HELPER_RELAUNCH_RETRIES = 3;

/**
 * pid1-exit 模式身份记录的时效窗口（ms）：该模式没有启动令牌可验证，仅凭
 * "存在身份记录 + fromInstanceId 不同"认领会误吸收"点了重启但容器策略没拉起、
 * 之后才手动启动"的场景；超过窗口的身份记录视为陈旧，不再认领。
 */
export const IDENTITY_TTL_MS = 15 * 60 * 1000;

/** 合法的 origin.kind：重启由谁发起（幂等记录，只影响展示与归因）。 */
export const ORIGIN_KINDS = ['settings-ui', 'command', 'model-tool', 'http'];

/**
 * 解析重启模式：
 * - `pid1-exit`：进程是 PID 1（容器内 DSH 的标准形态）。PID 1 退出即容器销毁，
 *   detached helper 也活不下来，唯一可行方案是"优雅退出 + 外部拉起"。
 * - `helper`：普通进程（桌面 / 容器内有 init 或 tini 的形态），走完整握手。
 * @param {number} [pid] 进程 pid（默认 process.pid，测试可注入）
 * @returns {'pid1-exit'|'helper'}
 */
export function resolveRestartMode(pid = process.pid) {
  return pid === 1 ? 'pid1-exit' : 'helper';
}

/**
 * 本进程从 helper COMMIT 到真正退出的最坏耗时预算：
 * 有界 flush + 退出延迟 + 优雅退出看门狗。
 * @param {number} delayMs 退出前延迟
 * @returns {number}
 */
export function preExitBudgetMs(delayMs) {
  return PRE_EXIT_FLUSH_CAP_MS + Math.max(0, delayMs) + APP_EXIT_WATCHDOG_MS;
}

/**
 * helper 等待旧 pid 退出的时限 = host 自身退出预算 + 余量。
 * 派生而非独立常量：helper 若比 host 先放弃，就会出现"没人拉起"的最坏结局。
 * @param {number} delayMs 退出前延迟
 * @returns {number}
 */
export function helperOldPidWaitMs(delayMs) {
  return preExitBudgetMs(delayMs) + HELPER_OLD_PID_MARGIN_MS;
}

/**
 * 把 relaunch argv 里的端口 pin 成本进程实际绑定的端口。
 * `--port 0` 逐字重放会让后继进程绑到另一个端口，helper 就会等错端口直到
 * health-timeout。没有 --port 的 argv 原样返回（端口来自配置，后继进程会以
 * 同样的方式读到，擅自加 flag 反而可能引入应用不认识的选项）。
 * @param {readonly string[]} argv 入口脚本之后的参数
 * @param {number} actualPort 本进程实际监听的端口
 * @returns {string[]}
 */
export function pinRelaunchPort(argv, actualPort) {
  const pinned = [...argv];
  for (let i = 0; i < pinned.length; i += 1) {
    const arg = pinned[i];
    if (arg === '--port' && i + 1 < pinned.length) {
      pinned[i + 1] = String(actualPort);
      return pinned;
    }
    if (typeof arg === 'string' && arg.startsWith('--port=')) {
      pinned[i] = `--port=${String(actualPort)}`;
      return pinned;
    }
  }
  return pinned;
}

/**
 * 归一化 origin（重启发起方）：kind 必须在白名单内；sessionId 非空字符串才保留。
 * @param {unknown} raw 任意解析结果
 * @returns {{kind: string, sessionId?: string}|undefined}
 */
export function normalizeOrigin(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !ORIGIN_KINDS.includes(kind)) return undefined;
  const sessionId = raw.sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0
    ? { kind, sessionId }
    : { kind };
}

/**
 * 构造一次重启的 origin 记录。
 * @param {'settings-ui'|'command'|'model-tool'|'http'} kind 发起来源
 * @param {unknown} sessionId 因果会话 id（GUI 点击为空；命令/模型工具取其会话）
 * @returns {{kind: string, sessionId?: string}|undefined} 无 kind 时 undefined
 */
export function buildOriginRecord(kind, sessionId) {
  if (typeof kind !== 'string' || !ORIGIN_KINDS.includes(kind)) return undefined;
  return typeof sessionId === 'string' && sessionId.length > 0
    ? { kind, sessionId }
    : { kind };
}

/**
 * 新实例启动时消费身份记录（纯函数；文件删除由调用方负责）。
 *
 * 两种接受路径：
 * - **v2 + 启动令牌**（helper 模式）：身份记录由 helper 在拉起新进程**之前**
 *   写好，新进程凭 env 里匹配的 `DSH_ROR_RESTART_ID` 认领——手动启动永远
 *   无法冒领（没有令牌），快速启动也读得到"已有记录"（记录先于进程存在）。
 * - **无令牌 + 时效窗口**（pid1-exit 模式）：容器运行时拉起的新进程继承不了
 *   注入的 env，只能凭"记录存在 + fromInstanceId 不同 + requestedAt 未过期"
 *   认领；窗口关闭陈旧记录（点了重启但策略没拉起、很久后才手动启动）的冒领。
 *
 * fromInstanceId 等于当前 instanceId（自指）或形状非法 → 一律拒绝。
 * @param {unknown} record restart-identity.json 的解析结果
 * @param {string|undefined} envToken 本次启动读到的环境令牌（读后即删）
 * @param {string} instanceId 当前进程 instanceId
 * @param {number} [nowMs] 当前时刻（测试可注入）
 * @returns {{fromInstanceId: string, restartId: string|null, origin: {kind: string, sessionId?: string}|null}|null}
 */
export function matchRestartIdentity(record, envToken, instanceId, nowMs = Date.now()) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const fromInstanceId = record.fromInstanceId;
  if (typeof fromInstanceId !== 'string' || fromInstanceId.length === 0) return null;
  if (fromInstanceId === instanceId) return null;
  const origin = normalizeOrigin(record.origin) ?? null;
  const restartId = typeof record.restartId === 'string' && record.restartId ? record.restartId : null;
  if (record.schemaVersion === 2 && restartId !== null) {
    if (typeof envToken === 'string' && envToken === restartId) {
      return { fromInstanceId, restartId, origin };
    }
    // 无令牌的 v2 记录只可能来自 pid1-exit（helper 模式必有令牌）：
    // 用 requestedAt 时效窗口防陈旧冒领。
    if (envToken === undefined) {
      const requestedAt = Date.parse(record.requestedAt);
      if (Number.isFinite(requestedAt) && nowMs - requestedAt >= 0 && nowMs - requestedAt <= IDENTITY_TTL_MS) {
        return { fromInstanceId, restartId, origin };
      }
    }
    return null;
  }
  return null;
}

/**
 * 生成 detach 的重启 helper（真 .cjs 文件，不用 node -e：Windows 的
 * CreateProcess 会把多行 -e 脚本搅碎成静默的 SyntaxError）。
 * 纯函数：输出只由 payload 决定，单测对产物字符串断言关键协议点。
 *
 * @param {object} p
 * @param {readonly string[]} p.relaunch 完整 relaunch 命令（execPath + execArgv + argv，端口已 pin）
 * @param {string} p.cwd 工作目录
 * @param {number} p.port 本进程实际绑定的端口
 * @param {number} p.oldPid 旧进程 pid
 * @param {string} p.oldInstanceId 旧进程 instanceId
 * @param {string} p.restartId 本次重启 id
 * @param {string} p.identityFile 身份记录文件（**不是**检测 marker.json）
 * @param {string} p.statusFile 握手 status 文件（power-restart/ror-<id>.status.json）
 * @param {string} p.lastStatusFile 滚动的最近一次重启 status（诊断用）
 * @param {string} p.commitFile host 写 COMMIT 的文件
 * @param {string} p.logFile helper 日志
 * @param {string} p.serverLog 新进程 stdout/stderr 追加目标
 * @param {string} p.sessionsRoot 会话记录根目录（静默检测用）
 * @param {string} p.healthPath /health 路径（插件自有前缀路由）
 * @param {number} p.commitWaitMs helper 等 COMMIT 的时限
 * @param {number} p.readyWaitMs helper 等新进程就绪的时限
 * @param {number} p.oldPidWaitMs helper 等旧 pid 退出的时限（由 host 预算派生）
 * @param {string} p.requestedAt 重启请求时刻（ISO）
 * @param {{kind: string, sessionId?: string}|undefined} [p.origin] 发起方
 * @returns {string} 可直接以 `node <file>` 执行的 CJS 脚本
 */
export function buildRestartHelper(p) {
  return `
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const nodePath = require('node:path');
const relaunch = ${JSON.stringify(p.relaunch)};
const cwd = ${JSON.stringify(p.cwd)};
const PORT = ${p.port};
const OLD_PID = ${p.oldPid};
const OLD_INSTANCE = ${JSON.stringify(p.oldInstanceId)};
const RESTART_ID = ${JSON.stringify(p.restartId)};
const IDENTITY = ${JSON.stringify(p.identityFile)};
const STATUS = ${JSON.stringify(p.statusFile)};
const LAST_STATUS = ${JSON.stringify(p.lastStatusFile)};
const COMMIT = ${JSON.stringify(p.commitFile)};
const LOG = ${JSON.stringify(p.logFile)};
const SERVER_LOG = ${JSON.stringify(p.serverLog)};
const SESSIONS_ROOT = ${JSON.stringify(p.sessionsRoot)};
const HEALTH = ${JSON.stringify(p.healthPath)};
const COMMIT_WAIT_MS = ${p.commitWaitMs};
const READY_WAIT_MS = ${p.readyWaitMs};
const OLD_PID_WAIT_MS = ${p.oldPidWaitMs};
const RELAUNCH_RETRIES = ${HELPER_RELAUNCH_RETRIES};
const SCHEMA_VERSION = ${RESTART_SCHEMA_VERSION};
const SOURCE = ${JSON.stringify(SOURCE)};
const LAUNCH_TOKEN_ENV = ${JSON.stringify(LAUNCH_TOKEN_ENV)};
const REQUESTED_AT = ${JSON.stringify(p.requestedAt)};
const ORIGIN = ${JSON.stringify(p.origin ?? null)};
function log(m) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\\n'); } catch {}
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: p });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}
// 持久写静默检测：旧进程主循环退出后，会话 write-behind 缓冲可能仍在落盘。
// 过早拉起新进程，新实例会读到仍在被追加的文件，并把自己更陈旧的 seq 写到
// 同一份日志上——这正是反复损坏会话的窗口。旧 pid 消失、端口释放之后，轮询
// 每个会话记录文件的 (size, mtimeMs)，连续两次采样一致才算静默。
// 有界（~15s）：不被卡死的写入方无限期拖住重启。覆盖 session.jsonl、
// session.v4.jsonl 及其 .zstd（多帧拼接）形态。
function sessionsQuiescent(maxWaitMs) {
  const wanted = (name) => name.startsWith('session')
    && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd'));
  const walk = (dir, out) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = dir + nodePath.sep + e.name;
      if (e.isDirectory()) walk(p, out);
      else if (wanted(e.name)) {
        try {
          const s = fs.statSync(p);
          out.push(p + ':' + s.size + ':' + Math.floor(s.mtimeMs));
        } catch {}
      }
    }
  };
  const stamp = () => { const out = []; walk(SESSIONS_ROOT, out); return out.sort().join('|'); };
  const deadline = Date.now() + maxWaitMs;
  let prev = stamp();
  return new Promise((resolve) => {
    const tick = () => {
      setTimeout(() => {
        if (Date.now() >= deadline) return resolve(false);
        const cur = stamp();
        if (cur === prev) return resolve(true);
        prev = cur;
        tick();
      }, 400);
    };
    tick();
  });
}
(function () {
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function cleanup() { try { fs.unlinkSync(__filename); } catch {} }
  function writeJsonAtomic(file, value) {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  let status = {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    mode: 'helper',
    restartId: RESTART_ID,
    port: PORT,
    oldPid: OLD_PID,
    fromInstanceId: OLD_INSTANCE,
    origin: ORIGIN,
    requestedAt: REQUESTED_AT,
  };
  function patchStatus(patch) {
    status = Object.assign({}, status, patch, { updatedAt: new Date().toISOString() });
    // status 记录是 host 读取的唯一通道，写失败不能静默：否则 host 眼里
    // 这个 helper 永远不会 ARM。
    try { writeJsonAtomic(STATUS, status); } catch (e) { log('status write failed: ' + e); }
    try { writeJsonAtomic(LAST_STATUS, status); } catch {}
  }
  function fail(code, message) {
    patchStatus({ stage: 'failed', failure: { code: code, message: message } });
    log('failed: ' + code + ' - ' + message);
    cleanup();
  }
  // host 只在确认本 helper 已 ARM 之后才写 COMMIT；读到它才被授权拉起。
  // 没有它说明 host 还活着、还拥有这次重启，贸然拉起会和 host 抢端口。
  async function waitForCommit() {
    const deadline = Date.now() + COMMIT_WAIT_MS;
    while (Date.now() < deadline) {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(COMMIT, 'utf8')); } catch {}
      if (data && data.restartId === RESTART_ID) return true;
      await sleep(50);
    }
    return false;
  }
  function getHealth() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: HEALTH, timeout: 2000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
  // spawn 成功只证明 OS 进程存在，不证明 DSH 启动了：坏配置会在 spawn 之后
  // 很久才崩溃。必须等到 /health 的身份块满足本次重启的启动令牌：应答进程
  // (a) instanceId 不同且 (b) restart.restartId === 本次 id——端口投机者或
  // 别的重启拉起的实例都冒充不了。
  async function waitForReady(child) {
    const deadline = Date.now() + READY_WAIT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return null;
      const health = await getHealth();
      if (health && health.ok === true
        && typeof health.instanceId === 'string'
        && health.instanceId !== OLD_INSTANCE
        && health.restart && health.restart.restartId === RESTART_ID) return health;
      await sleep(250);
    }
    return null;
  }
  async function trySpawnOnce(attempt) {
    patchStatus({ stage: 'launching', attempt: attempt });
    const out = fs.openSync(SERVER_LOG, 'a');
    const child = spawn(relaunch[0], relaunch.slice(1), {
      cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true,
      env: Object.assign({}, process.env, { [LAUNCH_TOKEN_ENV]: RESTART_ID }),
    });
    const spawned = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!spawned) return null;
    child.unref();
    log('spawned pid ' + child.pid + ' (attempt ' + attempt + ')');
    patchStatus({ stage: 'spawned', newPid: child.pid, spawnedAt: new Date().toISOString() });
    return child;
  }
  (async () => {
    // 先 ARM：host 被告知本 helper 活着并接手之前，什么都不要做。host 拿不到
    // ARM 就绝不让旧进程退出——这正是全部保证所在。
    patchStatus({ stage: 'armed', helperPid: process.pid, armedAt: new Date().toISOString() });
    log('helper up: old pid ' + OLD_PID + ', waiting for COMMIT');
    if (!(await waitForCommit())) {
      fail('commit-timeout', 'host never committed the restart handoff');
      return;
    }
    patchStatus({ stage: 'committed', committedAt: new Date().toISOString() });
    log('handoff committed by host, waiting for old pid to exit');
    patchStatus({ stage: 'waiting-old-exit' });
    let gone = false;
    // 等 host 自己退出预算（由 host 派生传入）耗尽为止：host 还在退出途中
    // 就放弃 = 没人拉起，是 UI 唯一无法恢复的结局。
    const oldPidDeadline = Date.now() + OLD_PID_WAIT_MS;
    while (Date.now() < oldPidDeadline) {
      if (pidGone(OLD_PID)) { gone = true; break; }
      await sleep(500);
    }
    if (!gone) { fail('old-process-still-alive', 'old process did not exit within ' + OLD_PID_WAIT_MS + 'ms'); return; }
    patchStatus({ stage: 'waiting-port', oldExitedAt: new Date().toISOString() });
    log('old pid gone, waiting for port ' + PORT + ' to free');
    let freed = false;
    for (let i = 0; i < 60; i++) {
      if (await portFree(PORT)) { freed = true; break; }
      await sleep(500);
    }
    if (!freed) { fail('port-never-freed', 'port ' + PORT + ' stayed busy'); return; }
    await sleep(500); // 收尾：让 socket 彻底释放
    patchStatus({ stage: 'quiescing', portFreedAt: new Date().toISOString() });
    const quiescent = await sessionsQuiescent(15000);
    patchStatus({ sessionQuiescent: quiescent });
    log(quiescent ? 'session logs quiescent' : 'session logs still moving after 15s - proceeding anyway');
    // 拉起前先绑定本次重启：身份记录带 restartId，子进程 env 继承启动令牌，
    // 新进程无论多早启动都能认领（旧协议在子进程 spawn 之后才确认——启动
    // 太快会读成"还没有记录"而错过）。
    try {
      fs.writeFileSync(IDENTITY, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        source: SOURCE,
        mode: 'helper',
        restartId: RESTART_ID,
        fromInstanceId: OLD_INSTANCE,
        origin: ORIGIN,
        requestedAt: REQUESTED_AT,
      }), 'utf8');
    } catch (e) { log('identity write failed: ' + e); }
    // 只在"根本没创建出进程"时重试；一旦有进程存在，再起一个就会和它抢端口。
    let child = null;
    for (let attempt = 1; attempt <= RELAUNCH_RETRIES; attempt++) {
      child = await trySpawnOnce(attempt);
      if (child !== null) break;
      log('spawn error on attempt ' + attempt);
      if (attempt < RELAUNCH_RETRIES) await sleep(attempt * 800);
    }
    if (child === null) {
      fail('relaunch-failed', 'no new process after ' + RELAUNCH_RETRIES + ' spawn attempts');
      return;
    }
    const health = await waitForReady(child);
    if (health === null) {
      fail('health-timeout', 'new process did not answer /health within ' + READY_WAIT_MS + 'ms');
      return;
    }
    patchStatus({ stage: 'ready', toInstanceId: health.instanceId, readyAt: new Date().toISOString() });
    log('new process ready: instance ' + health.instanceId);
    cleanup();
  })().catch((e) => { fail('helper-crashed', e && e.message ? e.message : String(e)); });
})();
`;
}

// ---- 运行期编排（有 IO；路径与依赖由 index.js 注入，便于测试） ----

/** sleep；定时器 unref，绝不反过来拖住进程退出。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 读取并解析 JSON 文件；任何失败返回 null（握手轮询把 null 当"尚未"）。 */
function readJsonOrNull(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 临时文件 + rename 的原子写，读方永远见不到半截记录。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* rename 已失败，临时文件是次要问题 */ }
    throw error;
  }
}

/** 等待 helper 进程被 OS 创建。Node 把多种启动失败异步报在 'error' 上而非从 spawn 抛出。 */
function waitForHelperSpawn(helper) {
  return new Promise((resolve, reject) => {
    helper.once('spawn', () => resolve());
    helper.once('error', (error) => reject(error));
  });
}

/**
 * 轮询 helper 的 status 记录直到 predicate 成立。同时匹配 restartId 与 helper
 * pid：早前一次尝试的陈旧记录满足不了后来的握手；helper 死了就立刻中止等待。
 */
async function waitForHelperStatus(helper, statusFile, restartId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = readJsonOrNull(statusFile);
    if (
      status !== null
      && status.restartId === restartId
      && status.helperPid === helper.pid
      && predicate(status)
    ) return status;
    if (helper.exitCode !== null || helper.signalCode !== null) {
      throw new Error(`restart helper exited before completing the handshake (code=${String(helper.exitCode)})`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`restart helper did not complete the handshake within ${String(timeoutMs)}ms`);
    }
    await sleep(50);
  }
}

/**
 * 有界 flush 会话服务（防御式探测，缺失/异常一律跳过）：
 * 退出前的 durability 只是锦上添花——`ctx.appExit` 的树销毁才是权威；
 * 无界的 flush 反而是安全洞（helper 会在预算内放弃没人接手的进程）。
 */
export async function flushSessionsBounded(ctx, capMs) {
  try {
    const reflect = ctx?.reflect;
    let sessions = null;
    for (const serviceName of ['sessions', 'session']) {
      try {
        const candidate = reflect?.get?.(serviceName);
        if (candidate && typeof candidate.flush === 'function') { sessions = candidate; break; }
      } catch { /* 服务缺失属预期 */ }
    }
    const live = typeof sessions?.list === 'function' ? sessions.list() : [];
    if (!Array.isArray(live) || live.length === 0) return;
    const flushing = Promise.allSettled(live.map((session) => sessions.flush(session)));
    await Promise.race([flushing, sleep(capMs)]);
  } catch { /* flush 抛错不构成不退出的理由 */ }
}

/**
 * 请求本进程退出：优先 launcher 提供的 `ctx.get('appExit')`（优雅树销毁：
 * 会话、watcher、子进程、端口释放），缺失时自发 SIGTERM（走 DSH/插件自身的
 * 优雅信号路径，比硬退出保留更多收尾机会）；两种路径都挂 unref 看门狗兜底
 * 硬退出。注意必须经 `ctx.get` 读取——appExit 是可选宿主值，本插件不声明
 * 在 inject 里，属性代理读取恒为 undefined（power-button 踩过的坑）。
 * @param {object} ctx 插件上下文
 * @param {number} exitCode 退出码
 */
export function requestRestartExit(ctx, exitCode = 0) {
  let appExit = null;
  try { appExit = ctx?.get?.('appExit'); } catch { /* 无 cordis store 的嵌入 */ }
  if (typeof appExit === 'function') {
    appExit(exitCode);
    const watchdog = setTimeout(() => { try { process.exit(exitCode); } catch { /* ignore */ } }, APP_EXIT_WATCHDOG_MS);
    watchdog.unref?.();
    return 'appExit';
  }
  try { process.kill(process.pid, 'SIGTERM'); } catch { /* 进程已死 */ }
  const watchdog = setTimeout(() => { try { process.exit(exitCode); } catch { /* ignore */ } }, PID1_EXIT_WATCHDOG_MS);
  watchdog.unref?.();
  return 'signal';
}

/**
 * 破坏性电源操作的 at-most-once 闩（工厂）：重启会终结当前进程，第二个并发
 * POST（重复标签页、命令与按钮竞态、客户端重试）绝不能再起第二个 helper
 * 或二次退出。首次领取成功；同步失败可释放（成功路径进程即将退出，无需释放）。
 * @returns {{claim(action: string): boolean, release(): void, current(): string|null}}
 */
export function createTransitionLatch() {
  let current = null;
  return {
    claim(action) {
      if (current !== null) return false;
      current = action;
      return true;
    },
    release() { current = null; },
    current: () => current,
  };
}

/**
 * 解析本进程的 relaunch 命令（可移植重放当前调用，无硬编码路径）：
 * execArgv 携带 node flags（如 --import tsx/esm），argv 是入口脚本 + 应用参数；
 * 子进程继承 env，NODE_OPTIONS 天然保留；端口 pin 到本进程实际绑定的端口。
 * @param {number} actualPort
 * @returns {string[]}
 */
export function buildRelaunchArgs(actualPort) {
  return [
    process.execPath,
    ...process.execArgv,
    ...pinRelaunchPort(process.argv.slice(1), actualPort),
  ];
}

/**
 * 模型工具 delayMs 的夹取：有效下限 1000ms——模型绝不能在自身 turn 的
 * tool/result 与 turn 边界结算之前杀掉进程；上限由配置 maxDelayMs 给出。
 * @param {unknown} raw 原始参数值
 * @param {number} maxDelayMs 配置上限
 * @returns {number} 夹取后的毫秒数
 */
export function clampModelDelayMs(raw, maxDelayMs) {
  const value = Math.floor(Number(raw));
  const upper = Math.max(1000, Math.floor(Number(maxDelayMs)) || 5000);
  if (!Number.isFinite(value)) return 1500;
  return Math.min(upper, Math.max(1000, value));
}

/**
 * 编排一次重启（helper 模式与 pid1-exit 模式的公共入口）。
 *
 * 调用方（index.js）负责：闩（防重入）、围栏（HTTP）、因果会话提取。
 * 本函数保证：任何"成功返回"都意味着重启必然推进（helper 已接手 / pid1 已
 * 写齐全部记录）；任何失败都让旧进程继续活着——"退出了却没人拉起"是 UI
 * 唯一无法恢复的结局。
 *
 * @param {object} deps
 * @param {'helper'|'pid1-exit'} deps.mode 重启模式（resolveRestartMode 的结果）
 * @param {number} [deps.delayMs=1500] 响应返回后、请求退出前的延迟
 * @param {{kind: string, sessionId?: string}|undefined} [deps.origin] 发起方
 * @param {number} [deps.exitCode=0] pid1-exit 模式的退出码（on-failure 策略用）
 * @param {number} deps.port 本进程实际绑定的端口
 * @param {object} deps.paths 全部绝对路径：
 *   stateDir / powerRestartDir（status 与 commit 文件按 restartId 推导）/
 *   helperFile / logFile / lastStatusFile / identityFile / pendingShutdownFile /
 *   serverLog / sessionsRoot / healthPath
 * @param {() => void} deps.flushMarkerState 兜底 flush 检测 marker（固化 recentSessions）
 * @param {(signal: string) => void} deps.writePendingShutdown 写停机归因存根
 * @param {object} ctx 插件上下文（appExit / sessions 服务）
 * @returns {Promise<{ok: boolean, mode: string, restartId: string, note?: string, error?: string}>}
 */
export async function restartDsh(ctx, deps) {
  const mode = deps.mode;
  const delayMs = Math.max(0, Math.floor(Number(deps.delayMs ?? 1500)));
  const exitCode = Number.isInteger(deps.exitCode) ? deps.exitCode : 0;
  const restartId = randomUUID();
  const requestedAt = new Date().toISOString();
  const paths = deps.paths;
  // 握手 status 文件落在 power-restart 目录（origin 扫描的数据源，文件名
  // ror- 前缀与 power-button 区分；committedAt 在窗口内命中即完成归因）；
  // COMMIT 文件留在 stateDir（扫描只认 *.status.json，互不干扰）。
  const statusFile = join(paths.powerRestartDir, `ror-${restartId}.status.json`);
  const commitFile = join(paths.stateDir, `ror-${restartId}.commit.json`);

  // pid1-exit 模式：没有 helper，host 自己把全部持久化记录写齐，然后优雅退出。
  // 顺序即正确性：先写齐磁盘记录（归因/身份/兜底 flush），再安排退出——
  // 任何一步失败都返回 ok:false，进程继续活着，UI 能如实报告失败。
  if (mode === 'pid1-exit') {
    try {
      writeJsonAtomic(statusFile, {
        schemaVersion: RESTART_SCHEMA_VERSION,
        source: SOURCE,
        mode: 'pid1-exit',
        restartId,
        oldPid: process.pid,
        origin: deps.origin ?? null,
        requestedAt,
        committedAt: new Date().toISOString(),
      });
      writeJsonAtomic(paths.identityFile, {
        schemaVersion: RESTART_SCHEMA_VERSION,
        source: SOURCE,
        mode: 'pid1-exit',
        restartId,
        fromInstanceId: deps.oldInstanceId,
        origin: deps.origin ?? null,
        requestedAt,
      });
      deps.flushMarkerState();
      deps.writePendingShutdown('restart-exit');
      const scheduleExit = () => {
        setTimeout(() => { requestRestartExit(ctx, exitCode); }, delayMs);
      };
      void flushSessionsBounded(ctx, PRE_EXIT_FLUSH_CAP_MS).then(scheduleExit);
      return {
        ok: true,
        mode,
        restartId,
        note: 'PID=1：进程将优雅退出，等待容器重启策略拉起（--restart=always/unless-stopped 或手动 docker start）',
      };
    } catch (error) {
      return { ok: false, mode, restartId, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // helper 模式：写 helper → spawn → ARM → COMMIT → ACK，全部确认后才安排退出。
  let helper;
  try {
    const helperScript = buildRestartHelper({
      relaunch: buildRelaunchArgs(deps.port),
      cwd: process.cwd(),
      port: deps.port,
      oldPid: process.pid,
      oldInstanceId: deps.oldInstanceId,
      restartId,
      identityFile: paths.identityFile,
      statusFile,
      lastStatusFile: paths.lastStatusFile,
      commitFile,
      logFile: paths.logFile,
      serverLog: paths.serverLog,
      sessionsRoot: paths.sessionsRoot,
      healthPath: paths.healthPath,
      commitWaitMs: HELPER_COMMIT_WAIT_MS,
      readyWaitMs: HELPER_READY_WAIT_MS,
      oldPidWaitMs: helperOldPidWaitMs(delayMs),
      requestedAt,
      ...(deps.origin !== undefined ? { origin: deps.origin } : {}),
    });
    mkdirSync(dirname(paths.helperFile), { recursive: true, mode: 0o700 });
    // 0600：helper 内嵌完整 relaunch argv，可能带凭据（如插件 CLI 的 --api-key）。
    writeFileSync(paths.helperFile, helperScript, { encoding: 'utf8', mode: 0o600 });
    helper = spawn(process.execPath, [paths.helperFile], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // 没有 'error' 监听的 ChildProcess 会在异步 spawn 失败时抛出未捕获异常；
    // waitForHelperSpawn 的 once('error') 覆盖启动窗口，这个监听兜住更晚的错误。
    helper.on('error', () => { /* 由握手超时与状态文件反映，不在退出路径外炸进程 */ });
    // (1) OS 确实创建了进程；(2) helper 自己的 JS 跑到了 ARM。
    await waitForHelperSpawn(helper);
    await waitForHelperStatus(helper, statusFile, restartId, (s) => typeof s.armedAt === 'string', HELPER_ARM_TIMEOUT_MS);
    // 交接所有权：此刻起 helper 才允许等待本进程退出。
    writeJsonAtomic(commitFile, {
      schemaVersion: RESTART_SCHEMA_VERSION,
      restartId,
      committedAt: new Date().toISOString(),
    });
    // (3) helper ACK 了交接。走到这里，已有一个活进程对接手拉起负责。
    await waitForHelperStatus(helper, statusFile, restartId, (s) => typeof s.committedAt === 'string', HELPER_COMMIT_TIMEOUT_MS);
    helper.unref();

    // 退出前的尽力持久化检查点：先把检测 marker（recentSessions）与停机归因
    // 存根写死，再开退出定时器——恢复流程的数据不能依赖"信号处理器恰好来得及"。
    deps.flushMarkerState();
    deps.writePendingShutdown('restart-exit');
    const scheduleExit = () => {
      setTimeout(() => { requestRestartExit(ctx, 0); }, delayMs);
    };
    void flushSessionsBounded(ctx, PRE_EXIT_FLUSH_CAP_MS).then(scheduleExit);
    return { ok: true, mode, restartId, note: 'DeepSeek Harness 正在重启' };
  } catch (error) {
    // 握手未完成前绝不能结束本进程；同时停掉半 armed 的 helper，
    // 并删除内嵌 argv 的 helper 脚本（它没有走到自己的 cleanup）。
    if (helper !== undefined) {
      try { helper.kill(); } catch { /* 已退出，无需停止 */ }
    }
    try { unlinkSync(paths.helperFile); } catch { /* 已自删或从未写成 */ }
    return { ok: false, mode, restartId, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 供 index.js 复用的原子 JSON 写（origin status 等宿主侧记录）。 */
export { writeJsonAtomic };
