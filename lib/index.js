/**
 * dsh-resume-on-restart host half.
 *
 * 检测 DSH 服务是否发生重启：启动时读取上次运行留下的 marker 文件，
 * 若 pid/启动时间与本次不同则判定为一次重启。
 *
 * 0.3.0 起重启后的行为：
 * 1. 优先"自动恢复重启前活跃的会话"——按 marker.recentSessions 候选逐个尝试：
 *    已 live 直接投递；未 live 通过 ctx 上的 sessionController 服务（resolveAgent）
 *    把会话恢复成 live Agent 再投递，让"重启前正在干活的会话"自己收到通知并继续。
 * 2. 所有候选都失败（或 sessionController 缺失/超时）→ 回退旧行为：
 *    向主 agent（config.target 解析 roots[0]）投递通知，由其自主决定下一步。
 *
 * 运行期间通过 cordis 真实事件（agent/status、agent/inbox/inserted、
 * agent/assistant-stream，payload 均含 agent；agent/status 另带 status）持续追踪
 * 最近活跃的会话列表（条目含最后已知是否运行中的 running 标记），
 * 活动时节流落盘（默认 5 秒合并一次），SIGTERM/SIGINT 兜底 flush，
 * 使重启后能恢复"之前在哪工作"的上下文。
 *
 * 0.4.0 起新增 web 会话顶栏开关（lib/client.js）的宿主 half：
 * 1. 注册 prefix 路由 `/api/dsh-resume-on-restart/state`（GET 查询 / POST 标记），
 *    排除集合持久化在 `<stateDir>/excluded-sessions.json`，重启后仍生效。
 * 2. 恢复流程在逐个尝试候选前用排除集合过滤，被排除的候选记入 wake.log
 *    （error: "excluded by user"）。
 * 3. 本插件路由比宿主 `/api` 更长，不会经过宿主的浏览器信任围栏，
 *    因此自带最小围栏（同 Host、Origin 同源、拒绝 sec-fetch-site: cross-site、
 *    未认证 401）；webServer 经动态 ctx.inject(['webServer'], ...) 等服务激活后
 *    注册，不加入插件 inject、不阻塞加载。
 * 4. 恢复与顶栏开关显示同一口径：只有 DSH 停止那一刻仍 running 的会话才是
 *    恢复候选（marker.recentSessions 条目的 running 字段，由 agent/status 维护；
 *    字段缺失视为候选，兼容旧 marker），顶栏开关只对候选会话渲染。
 *
 * 0.5.0 起新增重启日志与全量恢复：
 * 1. 重启日志 `<stateDir>/restarts.ndjson`（追加写、一行一条 JSON、上限 200 条
 *    超出丢最旧、损坏行跳过）：开机 detectRestart === true 时先写一条 boot 记录
 *    （含停机归因 shutdown、origin 匹配、原因标签 reason、候选会话列表），
 *    恢复流程每结算一个候选再写一条 restore 记录（resumed/failed/excluded/
 *    skipped-budget）；wake.log 保留不动。设置弹窗（lib/client.js）经
 *    `GET /api/dsh-resume-on-restart/restarts` 只读展示。
 * 2. 停机归因：SIGTERM/SIGINT 兜底 flush 时写 `<stateDir>/pending-shutdown.json`
 *    （`{ signal, at }`），下次开机读取归因后删除；读不到 = 崩溃 / 强杀 /
 *    容器重启（reason=crash；回退兼容旧 marker 的 when 字段，reason=signal）。
 * 3. origin 匹配：扫描 `~/.dsh/power-restart/*.status.json`，取 committedAt 落在
 *    [上次启动, 本次启动] 的最近一条作为重启发起方；没有 → origin: null。
 * 4. 全量恢复：restoreMax 默认 0 = 不限（遍历全部 running !== false 候选，仍尊重
 *    排除名单与 ignoredSessionPrefixes）；restoreTimeoutMs 总预算按候选数平摊，
 *    每候选最低 5s，超出预算的候选记 skipped-budget；失败继续下一个。
 *
 * 0.5.2 修复"重启后恢复候选全部失败"：sessionController 服务静态依赖 agents 等
 * 11 个服务，按依赖序必然晚于 agents 激活；恢复流程原先在 ctx.inject(['agents'])
 * 回调里立即非阻塞探测，开机百毫秒内必然扑空、逐候选立即失败。现改为在候选的
 * 预算切片内每 500ms 轮询等待服务就绪，就绪即恢复；切片耗尽才判失败（error
 * 文案区分"等待服务超时"），仍走既有的 fallbackWake 降级路径。
 *
 * 兼容性：本插件只依赖 cordis ctx 提供的 `agents` 服务与事件，不 import 任何
 * `@deepseek-ai/dsh-*` 内部包；sessionController 只在运行时防御式探测
 * （ctx.reflect.get 非阻塞读取；绝不直接读取未在 inject 声明的服务属性——
 * cordis 上下文代理对此必抛）；webServer 经动态 ctx.inject(['webServer'], ...)
 * 等服务激活后再注册路由，不加入插件 inject、不阻塞加载，缺失/异常即降级，
 * 因此可在 DSH Desktop 打包环境（app.asar）下运行，
 * 且其缺失绝不阻断插件加载与既有通知路径。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  attributeShutdown,
  buildNotice,
  collectRestoreCandidateIds,
  compactNdjson,
  computeProcessStartAtMs,
  createNoticeMessage,
  detectBasisOf,
  detectRestart,
  filterExcludedCandidates,
  normalizeRestoreMax,
  parseNdjson,
  pickOriginRecord,
  pickRestoreTargets,
  shutdownReasonOf,
} from './detect.js';

const name = 'dsh-resume-on-restart';

/** 需要的注入服务：agents（列出/访问 agent）。sessionController 不注入，运行时防御式探测。 */
const inject = ['agents'];

const DEFAULTS = {
  enabled: true,
  stateDir: '.resume-on-restart',
  target: 'primary',
  wakeup: true,
  notice: '',
  // 关闭前"活跃即视为与任务相关"的宽限窗口（ms）
  shutdownGraceMs: 600000,
  // 活动追踪时忽略的会话 id 前缀（如多代理团队的根会话）
  ignoredSessionPrefixes: ['head-'],
  // ---- 0.3.0 新增 ----
  // 最近活跃会话列表长度上限
  trackMax: 5,
  // 活动时节流落盘的间隔（ms）：窗口内只写一次盘，用 setTimeout 合并
  persistThrottleMs: 5000,
  // 重启后是否自动恢复重启前活跃的会话
  restoreSessions: true,
  // 最多恢复的会话数；0.5.0 起默认 0 = 不限（遍历全部 running !== false 候选，
  // 仍尊重排除名单与 ignoredSessionPrefixes），正整数 = 按活跃时间新 → 旧取前 N 个
  restoreMax: 0,
  // 恢复（resume 候选）的总预算（ms）；0.5.0 起按候选数平摊（每候选最低 5s），
  // 超出预算的候选记 skipped-budget 而不是静默放弃
  restoreTimeoutMs: 30000,
};

/** 回退路径（通知主会话）轮询等待 agent 出现的最长时间（ms），与 0.2.0 保持一致。 */
const FALLBACK_MAX_WAIT_MS = 20000;
const FALLBACK_POLL_MS = 500;

// ---- 0.5.2 新增：sessionController 就绪等待 ----
/** 等待 sessionController 服务就绪的轮询间隔（ms）：服务按依赖序晚于 agents 激活。 */
const SERVICE_POLL_MS = 500;

// ---- 0.4.0 新增：web 会话顶栏开关的状态路由与排除集合 ----
/** 插件自有 API 前缀（比宿主 `/api` 长，不会经过宿主围栏，需自带信任判断）。 */
const HTTP_BASE = '/api/dsh-resume-on-restart';
/** 单个 sessionId 的长度上限（超出直接 400）。 */
const MAX_SESSION_ID_LEN = 200;
/** 排除集合条目上限，超出丢最旧（按 excludedAt 时间）。 */
const MAX_EXCLUSIONS = 1000;
/** POST body 大小上限（字节），防止异常客户端撑内存。 */
const MAX_BODY_BYTES = 64 * 1024;

// ---- 0.5.0 新增：重启日志与全量恢复 ----
/** restarts.ndjson 条目上限，超出丢最旧（重写时顺带剔除损坏行）。 */
const MAX_RESTART_LOG_ENTRIES = 200;
/** 恢复预算平摊时单个候选的最低时长（ms）：预算再紧也保证单候选可用下限。 */
const MIN_RESTORE_CANDIDATE_MS = 5000;

/** 解析 DSH_HOME：优先环境变量，回退到用户主目录下的 .dsh。 */
function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 会话 id 是否以给定前缀开头（用于排除不需要追踪的会话）。 */
function ignoredByPrefix(sessionId, prefixes) {
  return (prefixes || []).some((p) => String(sessionId).startsWith(p));
}

/** 配置数值归一化：非正/非法值回退默认值。 */
function toPositiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 记录唤醒/投递/恢复结果到 markerDir/wake.log（追加，一行一条 JSON）。 */
function writeWakeLog(markerDir, deliveredTo, ok, error) {
  try {
    mkdirSync(markerDir, { recursive: true });
    appendFileSync(join(markerDir, 'wake.log'), `${JSON.stringify({
      deliveredTo, ok, error: error ?? null, at: new Date().toISOString(),
    })}\n`, 'utf8');
  } catch (e) {
    console.warn('[resume-on-restart] could not write wake.log:', e);
  }
}

// ---- 0.5.0：重启日志（restarts.ndjson）、停机归因与 origin 扫描 ----

/** 重启日志文件路径：`<stateDir>/restarts.ndjson`。 */
function restartsPathOf(markerDir) {
  return join(markerDir, 'restarts.ndjson');
}

/** 停机归因存根路径：`<stateDir>/pending-shutdown.json`。 */
function pendingShutdownPathOf(markerDir) {
  return join(markerDir, 'pending-shutdown.json');
}

/**
 * 创建 restarts.ndjson 追加写入器：热路径 appendFileSync，一行一条 JSON；
 * 条数超上限时整文件重写为最近 max 条（重写顺带剔除损坏行）。
 * 返回 `(entry) => void`；写失败只告警——日志缺失绝不影响恢复流程本身。
 */
function createRestartLogWriter(file, max = MAX_RESTART_LOG_ENTRIES) {
  // 启动时数一次非空行数（含损坏行，保证裁剪时机正确）；文件不存在 = 首次使用
  let lines = 0;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    lines = 0; // ENOENT 属预期（首次部署）
  }
  return (entry) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
      lines += 1;
      if (lines > max) {
        const compacted = compactNdjson(readFileSync(file, 'utf8'), max);
        writeFileSync(file, compacted.text, 'utf8');
        lines = compacted.kept;
      }
    } catch (e) {
      console.warn('[resume-on-restart] could not append restarts.ndjson:', e);
    }
  };
}

/** 读取 restarts.ndjson 全部条目（跳过损坏行；文件尚不存在 = 空数组属预期）。 */
function readRestarts(file) {
  try {
    return parseNdjson(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn('[resume-on-restart] could not read restarts.ndjson:', e);
    return [];
  }
}

/**
 * 读取并解析 JSON 文件（容忍缺失/损坏）。缺失（ENOENT）属预期不打日志；
 * 存在但损坏才 warn（此时也返回 null，由调用方回退归因）。
 */
function readJsonFileIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[resume-on-restart] could not read ${basename(file)}:`, e);
    return null;
  }
}

/** 尽力删除文件（ENOENT 静默；其余 warn——删除失败只影响下次归因，不阻断启动）。 */
function removeFileBestEffort(file) {
  try {
    unlinkSync(file);
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[resume-on-restart] could not remove ${basename(file)}:`, e);
  }
}

/**
 * 扫描 `~/.dsh/power-restart/*.status.json` 并解析为对象数组。
 * 目录不存在（从未经 power-button 重启过）属预期返回 []；
 * 单个文件缺失/损坏只丢该文件（外部数据源，规划要求容错扫描），不丢其它记录。
 */
function readPowerRestartRecords(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn('[resume-on-restart] could not list power-restart dir:', e);
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.status.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
    } catch (e) {
      console.warn(`[resume-on-restart] could not read power-restart status ${name}:`, e);
    }
  }
  return records;
}

// ---- 0.4.0：web 会话顶栏开关的宿主 half ----

/** 排除集合文件路径：`<stateDir>/excluded-sessions.json`。 */
function exclusionsPathOf(markerDir) {
  return join(markerDir, 'excluded-sessions.json');
}

/**
 * 把任意解析结果归一化为 `{ [sessionId]: excludedAtISO }`：
 * 非对象/键为空串/值非字符串的条目一律丢弃；损坏文件按空集合处理。
 * @param {unknown} raw JSON.parse 的结果
 * @returns {Record<string, string>}
 */
function normalizeExclusions(raw) {
  const sessions = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.sessions : null;
  const out = {};
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return out;
  for (const [id, at] of Object.entries(sessions)) {
    if (typeof id === 'string' && id && typeof at === 'string') out[id] = at;
  }
  return out;
}

/** 读取排除集合（容忍文件缺失/损坏，绝不抛错）。 */
function readExclusions(file) {
  try {
    return normalizeExclusions(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/** 写入排除集合（风格与 marker.json 一致：mkdir + writeFileSync；失败只告警）。 */
function writeExclusions(file, sessions) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn('[resume-on-restart] could not write excluded-sessions.json:', e);
    return false;
  }
}

/** 输出 JSON 响应（no-store：开关状态必须实时）。 */
function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/** 读取并解析 JSON body（有大小上限；非法/超限返回 null）。 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/** 渲染请求头值用于日志：去掉控制字符防伪行，并截断。 */
function logSafeHeader(value) {
  if (typeof value !== 'string') return '<absent>';
  return value.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 120);
}

/** 宿主声明的可信 authority（--trusted-host），经 webStartup 读取；缺失为空数组。 */
function declaredTrustedHosts(ctx) {
  const list = ctx?.get?.('webStartup')?.trustedHosts;
  return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : [];
}

/** 本服务监听地址：仅当宿主明确绑定 127.0.0.1 时才认为不存在跨机来源。
 *  接收动态注入回调拿到的服务对象，绝不直接读 ctx（避免注入管控抛错）。 */
function boundHostOf(webServer) {
  return webServer?.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
}

/**
 * 宿主连接围栏（认证等）。本插件路由比宿主 `/api` 长、不会自动经过宿主围栏，
 * 因此显式借用宿主 `connection.requestRejection` 的裁决：
 * 返回 401/403（拒绝原因）、undefined（放行）或 null（宿主未提供该服务）。
 */
function connectionRejection(ctx, req) {
  const connection = ctx?.get?.('connection');
  if (typeof connection?.requestRejection !== 'function') return null;
  try {
    const rejection = connection.requestRejection({ headers: req.headers });
    if (rejection === 401 || rejection === 403) return rejection;
    return rejection === undefined ? undefined : null;
  } catch {
    return null;
  }
}

/** 本围栏接受的 loopback 主机名（与 DSH 自身的窄集合一致）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * 最小浏览器信任围栏（范式复制自 dsh-power-button，规则与 DSH 官方一致）：
 * Host 必须是 loopback 或宿主 --trusted-host 声明的 authority（防 DNS rebinding）；
 * 全接口绑定时要求来源 socket 在本机；拒绝 sec-fetch-site: cross-site；
 * 带 Origin 时必须与 Host 同源。返回 `{ trusted }` 或 `{ trusted: false, reason }`。
 */
function explainStateRequestTrust(req, trustedHosts = [], boundHost = '0.0.0.0') {
  const { host, origin, 'sec-fetch-site': secFetchSite } = req.headers ?? {};
  if (typeof host !== 'string') return { trusted: false, reason: 'host-missing' };
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return { trusted: false, reason: 'host-unparseable' };
  }
  const loopbackHost = LOOPBACK_HOSTNAMES.has(hostUrl.hostname);
  if (!loopbackHost && !matchesTrustedAuthority(hostUrl, trustedHosts)) {
    return { trusted: false, reason: 'host-untrusted' };
  }
  if (loopbackHost && boundHost === '0.0.0.0') {
    const address = req.socket?.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
      return { trusted: false, reason: 'socket-not-loopback' };
    }
  }
  if (typeof secFetchSite === 'string' && secFetchSite === 'cross-site') {
    return { trusted: false, reason: 'cross-site' };
  }
  if (origin === undefined) return { trusted: true };
  if (typeof origin !== 'string' || origin === 'null') return { trusted: false, reason: 'origin-null' };
  try {
    return new URL(origin).host === hostUrl.host ? { trusted: true } : { trusted: false, reason: 'origin-mismatch' };
  } catch {
    return { trusted: false, reason: 'origin-mismatch' };
  }
}

/** Host authority 是否命中宿主声明的可信项（带端口精确匹配，不带端口匹配主机名）。 */
function matchesTrustedAuthority(hostUrl, trustedHosts) {
  for (const entry of trustedHosts) {
    let entryUrl;
    try {
      entryUrl = new URL(`http://${entry}`);
    } catch {
      continue;
    }
    if (entryUrl.port !== '' ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname) return true;
  }
  return false;
}

function apply(ctx, cfg = {}) {
  const config = { ...DEFAULTS, ...cfg };
  if (!config.enabled) return;

  const trackMax = toPositiveInt(config.trackMax, DEFAULTS.trackMax);
  const persistThrottleMs = toPositiveInt(config.persistThrottleMs, DEFAULTS.persistThrottleMs);
  // 0.5.0：restoreMax=0（默认）= 不限；正整数 = 上限（normalizeRestoreMax 保证 pickRestoreTargets 可用）
  const restoreMax = normalizeRestoreMax(config.restoreMax);
  const restoreTimeoutMs = toPositiveInt(config.restoreTimeoutMs, DEFAULTS.restoreTimeoutMs);

  // 当前进程的启动时刻（epoch 毫秒）：写入 marker 供下次启动对比。
  // Docker 容器内 DSH 恒为 PID 1，pid 无法区分两次运行，只能靠它判断重启。
  const startAtMs = computeProcessStartAtMs();

  const dshHome = resolveDshHome();
  const markerDir = join(dshHome, config.stateDir);
  const markerPath = join(markerDir, 'marker.json');
  // 0.4.0：用户排除集合（web 顶栏开关写入），重启后仍生效
  const exclusionsFile = exclusionsPathOf(markerDir);
  // 0.5.0：重启日志与停机归因存根
  const restartsFile = restartsPathOf(markerDir);
  const pendingShutdownFile = pendingShutdownPathOf(markerDir);
  const powerRestartDir = join(dshHome, 'power-restart');
  // 重启日志追加写入器（boot/restore 记录共用；上限 200 条超出丢最旧）
  const appendRestartLog = createRestartLogWriter(restartsFile);

  // 1. 读取上次 marker（容忍缺失/损坏）
  let marker = null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'));
    // lastBootAt/pid 必须存在；startAt 是 0.2.0 新增的可选字段，
    // 旧版 marker 没有它时不丢弃整个 marker（detectRestart 会回退用 lastBootAt 对比）
    if (raw && typeof raw.lastBootAt === 'string' && typeof raw.pid === 'number') {
      marker = raw;
    }
  } catch {
    marker = null; // 首次启动或损坏
  }

  const bootAt = new Date().toISOString();
  const { wasRestart, downtimeMs } = detectRestart(marker, Date.now(), process.pid, startAtMs);
  const prevBootAt = marker?.lastBootAt ?? null;
  // 上次启动时刻（epoch ms）：origin 匹配时间窗的下界；缺失/不可解析 → null（视为无下界）
  const prevBootMs = typeof prevBootAt === 'string' && prevBootAt ? Date.parse(prevBootAt) : null;
  const lastSessionId = marker?.lastSessionId ?? null;
  const lastActiveAt = marker?.lastActiveAt ?? null;

  // 2. 活动追踪：内存维护最近活跃列表 [{id, at(epoch ms), running}]，最新在前。
  //    启动时用上次 marker 播种（兼容 ISO/毫秒时间；pickRestoreTargets 已按 running
  //    过滤，留下的正是上次停止时仍运行中的候选），延续旧上下文，避免启动即用
  //    空列表覆盖掉上一进程留下的记录。
  //    播种条目回填 running: true——不回填会被序列化成 false，造成
  //    "本进程 GET 显示候选、下次重启却不恢复"的口径分裂；此后该标记只由
  //    agent/status 事件更新。
  const recentSessions = pickRestoreTargets(marker, trackMax).map((e) => ({ ...e, running: true }));

  // 3. 持久化状态：启动写一次 + 活动时节流写 + 关闭兜底写
  const writeState = (extra = {}) => {
    try {
      mkdirSync(markerDir, { recursive: true });
      const latest = recentSessions[0] ?? null;
      const doc = {
        lastBootAt: bootAt,
        pid: process.pid,
        // 当前进程启动时刻（epoch 毫秒）：容器内 pid 恒为 1 时靠它判定重启
        startAt: startAtMs,
        // 兼容旧字段语义：列表第一个即"最近活跃会话"
        lastSessionId: latest?.id ?? marker?.lastSessionId ?? null,
        lastActiveAt: latest && latest.at > 0
          ? new Date(latest.at).toISOString()
          : marker?.lastActiveAt ?? null,
        // 0.3.0 新增：最近活跃会话列表（最新在前；at 为 ISO，未知为 ''）。
        // 0.4.0 新增：running 记录条目最后已知是否运行中（boolean；缺失写 false），
        // 重启后只有 running !== false 的条目才是恢复候选
        recentSessions: recentSessions.map((e) => ({
          id: e.id,
          at: e.at > 0 ? new Date(e.at).toISOString() : '',
          running: e.running === true,
        })),
        ...extra,
      };
      writeFileSync(markerPath, JSON.stringify(doc, null, 2));
    } catch (err) {
      console.warn('[resume-on-restart] could not write marker:', err);
    }
  };
  writeState();

  // 活动节流落盘：窗口内的多次活动合并为一次写盘，不再只靠 SIGTERM
  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeState();
    }, persistThrottleMs);
    // 不因待落盘的定时器阻止进程退出
    persistTimer.unref?.();
  };

  /**
   * 记录活动并维护最近活跃列表（同 id 去重挪到最前，截断 trackMax）。
   * agent/status 事件额外传 status：'running' → running:true、'idle' → running:false
   * （即"DSH 停止那一刻是否运行中"的恢复/显示口径）；其余事件不带 status，
   * 沿用同 id 条目已有值；新条目缺省 false。
   */
  const recordActivity = (agent, status) => {
    const sid = String(agent?.id ?? '');
    if (!sid || ignoredByPrefix(sid, config.ignoredSessionPrefixes)) return;
    const idx = recentSessions.findIndex((e) => e.id === sid);
    const prev = idx >= 0 ? recentSessions[idx] : null;
    if (idx >= 0) recentSessions.splice(idx, 1);
    const running = status === 'running' ? true : status === 'idle' ? false : prev?.running === true;
    recentSessions.unshift({ id: sid, at: Date.now(), running });
    if (recentSessions.length > trackMax) recentSessions.length = trackMax;
    schedulePersist();
  };

  // 正常关闭（SIGTERM/SIGINT）时兜底 flush 最近活跃列表，供下次重启参考
  const flushOnShutdown = (signal) => {
    const at = new Date().toISOString();
    try {
      // 取消尚未触发的节流定时器，同步写盘后重发信号走原有退出流程
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // when 字段保留：0.5.0 前版本的停机归因回退依据（marker 里读到即视为 signal）
      writeState({ when: at });
    } catch (e) {
      console.warn('[resume-on-restart] shutdown flush failed:', e);
    }
    // 0.5.0：停机归因存根——下次开机读取归因后删除，用于区分 signal 与 crash。
    // 独立于 marker：marker 在下次启动即被覆盖，when 字段不足以长期承载归因。
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(pendingShutdownFile, `${JSON.stringify({ signal, at }, null, 2)}\n`, 'utf8');
    } catch (e) {
      console.warn('[resume-on-restart] could not write pending-shutdown.json:', e);
    }
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.kill(process.pid, signal);
  };
  const onSigterm = () => flushOnShutdown('SIGTERM');
  const onSigint = () => flushOnShutdown('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  // 4. 监听真实存在的 agent 活动事件（0.2.0 监听的 agent/session-start、
  //    agent/pre-step 在 DSH 中不存在，导致追踪从未生效）：
  //    - agent/status：生命周期 idle⇄running 翻转（payload { agent, status }，
  //      status ∈ 'idle' | 'running'；用它维护条目的 running 标记）
  //    - agent/inbox/inserted：有新消息进入收件箱
  //    - agent/assistant-stream：模型流式输出进行中
  //    三者 payload 均被 dsh-agent 的 dispatcher 融合进 agent 对象。
  ctx.on('agent/status', (payload) => recordActivity(payload?.agent, payload?.status));
  ctx.on('agent/inbox/inserted', (payload) => recordActivity(payload?.agent));
  ctx.on('agent/assistant-stream', (payload) => recordActivity(payload?.agent));

  // 5. web 会话顶栏开关（lib/client.js）的状态路由：
  //    GET  /state?ids=a,b — 查询排除状态与恢复候选（缺 ids 时返回全部，条目有上限）
  //    POST /state         — body { sessionId, excluded: boolean } 标记/取消
  //    GET  /restarts      — 0.5.0：只读重启日志（restarts.ndjson 条目 + 上限）
  //    本路由前缀比宿主 `/api` 长，宿主的浏览器围栏不会覆盖它，因此自带：
  //    先借用宿主 connection.requestRejection（未认证 401 等），宿主未提供
  //    该服务时回退到本插件复刻的最小围栏（同 Host、Origin 同源、拒绝 cross-site）。
  //    webServer 经动态 ctx.inject(['webServer'], ...) 等服务激活后再注册
  //    （与第 6 节 agents 的动态注入模式一致）：apply 执行时 webServer 服务往往
  //    尚未激活，静态探测必拿不到；不把 webServer 加入插件 inject（不阻塞加载），
  //    服务不可用则回调不执行、路由不注册，插件加载与恢复流程不受影响。
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope?.webServer;
    if (!webServer || typeof webServer.register !== 'function') return;
    // 服务已激活，注册状态路由；effect 回调用闭包里的 webServer，不读 ctx.webServer
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: HTTP_BASE,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.local');
        const sub = url.pathname.slice(HTTP_BASE.length).replace(/\/+$/, '') || '/';
        const method = req.method ?? 'GET';

        /** 拒绝并说明原因（reason 供客户端/排查定位是哪条规则拦的）。 */
        const refuse = (reason, status) => json(res, status, {
          ok: false,
          error: 'forbidden: untrusted state request',
          reason,
        });

        // 浏览器信任围栏（对 GET/POST 一视同仁，与宿主 /api 的整体口径一致）
        const hostRejection = connectionRejection(ctx, req);
        if (hostRejection === null) {
          const verdict = explainStateRequestTrust(req, declaredTrustedHosts(ctx), boundHostOf(webServer));
          if (!verdict.trusted) return refuse(verdict.reason, 403);
        } else if (hostRejection !== undefined) {
          return refuse(hostRejection === 401 ? 'not-authenticated' : 'host-fence', hostRejection);
        }

        try {
          if (sub === '/state' && method === 'GET') {
            const sessions = readExclusions(exclusionsFile);
            const ids = (url.searchParams.get('ids') ?? '')
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
              .slice(0, MAX_EXCLUSIONS);
            const excluded = {};
            if (ids.length === 0) {
              Object.assign(excluded, sessions);
            } else {
              for (const id of ids) {
                if (Object.prototype.hasOwnProperty.call(sessions, id)) excluded[id] = sessions[id];
              }
            }
            return json(res, 200, {
              ok: true,
              excluded,
              // 0.4.0：内存视图的恢复候选（running !== false），顶栏开关只对这些会话渲染；
              // 不看排除集合——被排除但仍是候选的会话仍要显示灰色开关
              restoreCandidates: Object.fromEntries(
                [...collectRestoreCandidateIds(recentSessions)].map((id) => [id, true]),
              ),
            });
          }

          if (sub === '/state' && method === 'POST') {
            const body = await readJsonBody(req, MAX_BODY_BYTES);
            const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
            if (!sessionId || sessionId.length > MAX_SESSION_ID_LEN) {
              return json(res, 400, { ok: false, error: `sessionId must be a non-empty string of at most ${MAX_SESSION_ID_LEN} chars` });
            }
            if (!body || typeof body.excluded !== 'boolean') {
              return json(res, 400, { ok: false, error: 'excluded must be a boolean' });
            }
            const sessions = readExclusions(exclusionsFile);
            let excludedAt = null;
            if (body.excluded) {
              excludedAt = new Date().toISOString();
              sessions[sessionId] = excludedAt;
              // 上限裁剪：超出丢最旧（excludedAt 解析失败按 0，即最早）
              const ids = Object.keys(sessions);
              if (ids.length > MAX_EXCLUSIONS) {
                ids.sort((a, b) => (Date.parse(sessions[a]) || 0) - (Date.parse(sessions[b]) || 0));
                for (const id of ids.slice(0, ids.length - MAX_EXCLUSIONS)) delete sessions[id];
              }
            } else {
              delete sessions[sessionId];
            }
            if (!writeExclusions(exclusionsFile, sessions)) {
              return json(res, 500, { ok: false, error: 'could not persist excluded-sessions.json' });
            }
            return json(res, 200, { ok: true, sessionId, excluded: body.excluded, excludedAt });
          }

          if (sub === '/restarts' && method === 'GET') {
            // 0.5.0：只读重启日志（时间正序返回，客户端自行倒序展示）
            return json(res, 200, { ok: true, entries: readRestarts(restartsFile), max: MAX_RESTART_LOG_ENTRIES });
          }

          return json(res, 404, { ok: false, error: `no dsh-resume-on-restart endpoint ${sub}` });
        } catch (err) {
          return json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    }), 'dsh-resume-on-restart: http state routes');
  });

  // 6. 若发生重启：先写一条 boot 记录（重启日志），再尝试自动恢复重启前活跃的
  //    会话（每个候选结算时追加 restore 记录），全部失败再回退旧行为
  if (wasRestart) {
    // 6a. 停机归因：读 pending-shutdown.json（本插件 SIGTERM/SIGINT 兜底 flush 时写入），
    //     读不到回退旧 marker 的 when 字段（0.4.x 兼容），都没有 = crash / 强杀 / 容器重启。
    //     文件读后即删：归因只消费一次，避免遗留存根把后续 crash 误归因为 signal。
    const pendingShutdown = readJsonFileIfExists(pendingShutdownFile);
    const shutdown = attributeShutdown(pendingShutdown, marker?.when);
    removeFileBestEffort(pendingShutdownFile);
    // 6b. origin 匹配：committedAt 落在 [上次启动, 本次启动] 的最近一条 power-restart 记录；
    //     没有命中 → null（原因归 shutdown 侧：signal / crash）
    const originRecord = pickOriginRecord(readPowerRestartRecords(powerRestartDir), prevBootMs, Date.parse(bootAt));
    const origin = originRecord ? {
      source: 'power-button',
      restartId: typeof originRecord.restartId === 'string' ? originRecord.restartId : null,
      kind: typeof originRecord.origin?.kind === 'string' ? originRecord.origin.kind : null,
      sessionId: typeof originRecord.origin?.sessionId === 'string' ? originRecord.origin.sessionId : null,
      requestedAt: typeof originRecord.requestedAt === 'string' ? originRecord.requestedAt : null,
    } : null;
    // 6c. boot 记录先落盘，restore 记录才会紧随其后（设置弹窗按此顺序分组展示）
    appendRestartLog({
      type: 'boot',
      at: bootAt,
      prevBootAt,
      downtimeMs,
      pid: process.pid,
      prevPid: marker?.pid ?? null,
      startAt: startAtMs,
      prevStartAt: typeof marker?.startAt === 'number' ? marker.startAt : null,
      detectBasis: detectBasisOf(marker, process.pid),
      reason: shutdownReasonOf(shutdown, origin),
      shutdown,
      origin,
      // 本次参与恢复的候选（播种自上次 marker 的 running !== false 条目）
      runningSessions: recentSessions.map((e) => ({
        id: e.id,
        at: e.at > 0 ? new Date(e.at).toISOString() : '',
        running: true,
      })),
    });
    ctx.inject(['agents'], (scope) => {
      ctx.effect(() => {
        // 恢复阶段的总预算：超时放弃恢复并回退
        const deadline = Date.now() + restoreTimeoutMs;
        const remainingMs = () => Math.max(0, deadline - Date.now());

        /** 给 promise 套超时；无论谁先完成都清掉定时器。 */
        const withTimeout = (promise, ms, label) => {
          let timer = null;
          return Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
              timer.unref?.();
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
        };

        /**
         * 防御式探测 sessionController 服务：
         * 用 ctx.reflect.get 非阻塞读取（未提供/未激活返回 undefined，不触发启动、不阻塞加载），
         * 且要求其具备 resolveAgent 方法；拿不到由 resumeSession 在预算切片内轮询等待。
         */
        const getSessionController = () => {
          try {
            const controller = ctx.reflect?.get?.('sessionController');
            return controller && typeof controller.resolveAgent === 'function' ? controller : null;
          } catch (err) {
            console.warn('[resume-on-restart] sessionController probe failed:', err);
            return null;
          }
        };

        /**
         * 通过 sessionController.resolveAgent(sessionId) 恢复会话为 live Agent。
         * 返回判别：成功 `{ agent }` / 失败 `{ error }`（stable failure union）。
         * budgetMs 为该候选的预算切片（ms，>0 时与总预算取更小者）；失败
         * （含超时/缺失/异常/意外形状）一律 throw，由调用方记录并继续下一个候选。
         *
         * 0.5.2：sessionController 静态依赖 agents 等 11 个服务，按依赖序必然晚于
         * agents 激活，探测扑空不再立即失败——在预算切片内每 SERVICE_POLL_MS 轮询，
         * 服务就绪即用；切片耗尽才判失败（error 区分"等待服务超时"）。
         */
        const resumeSession = async (sessionId, budgetMs = 0) => {
          const limitMs = budgetMs > 0
            ? Math.max(1, Math.min(budgetMs, remainingMs()))
            : Math.max(1, remainingMs());
          const sliceDeadline = Date.now() + limitMs;
          let controller = getSessionController();
          while (!controller) {
            const waitLeftMs = sliceDeadline - Date.now();
            if (waitLeftMs <= 0) {
              throw new Error(`sessionController service not ready within ${limitMs}ms`);
            }
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, Math.min(SERVICE_POLL_MS, waitLeftMs));
              timer.unref?.();
            });
            controller = getSessionController();
          }
          const result = await withTimeout(
            controller.resolveAgent(sessionId),
            Math.max(1, sliceDeadline - Date.now()),
            `resolveAgent(${sessionId})`,
          );
          if (result && typeof result === 'object' && result.agent) return result.agent;
          const reason = result && typeof result === 'object' && 'error' in result
            ? String(result.error)
            : 'unexpected resolveAgent result';
          throw new Error(reason);
        };

        const findTarget = () => {
          try {
            const roots = scope.agents.roots?.() ?? [];
            if (config.target === 'primary') {
              return roots[0] ?? scope.agents.list?.()[0] ?? null;
            }
            return scope.agents.get?.(config.target) ?? null;
          } catch (err) {
            console.warn('[resume-on-restart] agent lookup failed:', err);
            return null;
          }
        };

        /** 投递通知；restored 非空时文案命中"已自动恢复"。返回 `{ ok, error }`（stable union）。 */
        const deliver = (target, restored = null) => {
          const text = buildNotice({
            bootAt,
            prevBootAt,
            downtimeMs,
            lastSessionId,
            lastActiveAt,
            customNotice: config.notice,
            restoredSessionId: restored?.id ?? undefined,
            restoredActiveAt: restored && restored.at > 0
              ? new Date(restored.at).toISOString()
              : undefined,
          });
          // 0.3.1：source 用 producer-owned kind（裸插件名），替代已废弃的 v3 写法
          // `{ kind: 'plugin', plugin: ... }`——后者会被 DSH 会话格式 v4 校验拒绝
          // （SessionFormatError: format v4 message requires a producer-owned source kind）。
          const msg = createNoticeMessage({ text, bootAt });
          try {
            if (config.wakeup !== false) {
              target.followup(msg);
            } else {
              target.inject(msg);
            }
            console.log('[resume-on-restart] notice delivered to', String(target.id));
            writeWakeLog(markerDir, String(target.id), true, null);
            return { ok: true, error: null };
          } catch (err) {
            console.warn('[resume-on-restart] deliver failed:', err);
            const reason = String(err);
            writeWakeLog(markerDir, String(target.id), false, reason);
            return { ok: false, error: reason };
          }
        };

        // 回退：现有行为（config.target 解析 roots[0]，轮询等待最长 20 秒），保证不劣化
        const fallbackWake = () => {
          let target = findTarget();
          if (target) { deliver(target); return; }
          let waited = 0;
          const timer = setInterval(() => {
            waited += FALLBACK_POLL_MS;
            target = findTarget();
            if (target) {
              clearInterval(timer);
              deliver(target);
            } else if (waited >= FALLBACK_MAX_WAIT_MS) {
              clearInterval(timer);
              console.log('[resume-on-restart] no target agent found after wait, skip wake');
              writeWakeLog(markerDir, null, false, 'no target agent after wait');
            }
          }, FALLBACK_POLL_MS);
        };

        // 自动恢复候选：已 live 直接投递；未 live 经 sessionController 恢复后投递。
        // 0.5.0：总预算按候选数平摊（剩余预算 / 剩余候选数，每候选最低 5s）；
        // 超出预算的候选不再静默丢弃，逐个记 skipped-budget；失败继续下一个。
        const restoreCandidates = async (candidates) => {
          for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            const remainingMsNow = remainingMs();
            if (remainingMsNow <= 0) {
              console.warn('[resume-on-restart] restore budget exhausted, skip session', candidate.id);
              appendRestartLog({
                type: 'restore',
                bootAt,
                id: candidate.id,
                result: 'skipped-budget',
                error: 'restore budget exhausted',
                at: new Date().toISOString(),
              });
              continue;
            }
            const candidateBudgetMs = Math.max(
              MIN_RESTORE_CANDIDATE_MS,
              Math.floor(remainingMsNow / (candidates.length - index)),
            );
            let agent = null;
            try {
              agent = scope.agents.get?.(candidate.id) ?? null;
            } catch (err) {
              console.warn('[resume-on-restart] live lookup failed for session', candidate.id, ':', err);
            }
            if (!agent) {
              try {
                agent = await resumeSession(candidate.id, candidateBudgetMs);
                console.log('[resume-on-restart] session resumed via sessionController:', candidate.id);
              } catch (err) {
                const reason = err?.message ?? String(err);
                console.warn('[resume-on-restart] resume session', candidate.id, 'failed:', reason);
                writeWakeLog(markerDir, candidate.id, false, `resume failed: ${reason}`);
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'failed',
                  error: `resume failed: ${reason}`,
                  at: new Date().toISOString(),
                });
                continue;
              }
            }
            // 投递结果（成功/失败）由 deliver 内部记录 wake.log
            const outcome = deliver(agent, candidate);
            appendRestartLog({
              type: 'restore',
              bootAt,
              id: candidate.id,
              result: outcome.ok ? 'resumed' : 'failed',
              error: outcome.error,
              at: new Date().toISOString(),
            });
            if (outcome.ok) return true;
          }
          return false;
        };

        // 全程异步化：恢复失败/异常都回退到 fallbackWake，不阻塞插件与事件循环
        (async () => {
          try {
            if (config.restoreSessions !== false) {
              // 0.4.0：候选先按用户排除集合过滤（web 顶栏开关写入的"重启后不自动恢复"），
              // 被排除的候选不参与恢复，但记入 wake.log 便于排查。
              // 0.5.0：同时记入重启日志（result: excluded），设置弹窗可见。
              const picked = pickRestoreTargets(marker, restoreMax);
              const { kept, excluded } = filterExcludedCandidates(picked, readExclusions(exclusionsFile));
              for (const candidate of excluded) {
                writeWakeLog(markerDir, candidate.id, false, 'excluded by user');
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'excluded',
                  error: 'excluded by user',
                  at: new Date().toISOString(),
                });
              }
              if (kept.length > 0 && await restoreCandidates(kept)) return;
              if (kept.length > 0) {
                console.warn('[resume-on-restart] no restore candidate succeeded, fall back to primary target');
              } else if (excluded.length > 0) {
                console.warn('[resume-on-restart] all restore candidates excluded by user, fall back to primary target');
              }
            }
          } catch (err) {
            console.warn('[resume-on-restart] restore flow error:', err);
          }
          fallbackWake();
        })();
      });
    });
  } else {
    console.log('[resume-on-restart] no restart detected, boot normal');
  }
}

export { apply, inject, name };
