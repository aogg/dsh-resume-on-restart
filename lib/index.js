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
 * 兼容性：本插件只依赖 cordis ctx 提供的 `agents` 服务与事件，不 import 任何
 * `@deepseek-ai/dsh-*` 内部包；sessionController 只在运行时防御式探测
 * （ctx.reflect.get 非阻塞读取；绝不直接读取未在 inject 声明的服务属性——
 * cordis 上下文代理对此必抛）；webServer 经动态 ctx.inject(['webServer'], ...)
 * 等服务激活后再注册路由，不加入插件 inject、不阻塞加载，缺失/异常即降级，
 * 因此可在 DSH Desktop 打包环境（app.asar）下运行，
 * 且其缺失绝不阻断插件加载与既有通知路径。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildNotice, collectRestoreCandidateIds, computeProcessStartAtMs, createNoticeMessage, detectRestart, filterExcludedCandidates, pickRestoreTargets } from './detect.js';

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
  // 最多恢复的会话数（按活跃时间新 → 旧取前 N 个候选）
  restoreMax: 1,
  // 恢复（resume 候选）的总预算（ms）；超时放弃恢复并回退通知主会话
  restoreTimeoutMs: 30000,
};

/** 回退路径（通知主会话）轮询等待 agent 出现的最长时间（ms），与 0.2.0 保持一致。 */
const FALLBACK_MAX_WAIT_MS = 20000;
const FALLBACK_POLL_MS = 500;

// ---- 0.4.0 新增：web 会话顶栏开关的状态路由与排除集合 ----
/** 插件自有 API 前缀（比宿主 `/api` 长，不会经过宿主围栏，需自带信任判断）。 */
const HTTP_BASE = '/api/dsh-resume-on-restart';
/** 单个 sessionId 的长度上限（超出直接 400）。 */
const MAX_SESSION_ID_LEN = 200;
/** 排除集合条目上限，超出丢最旧（按 excludedAt 时间）。 */
const MAX_EXCLUSIONS = 1000;
/** POST body 大小上限（字节），防止异常客户端撑内存。 */
const MAX_BODY_BYTES = 64 * 1024;

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
  const restoreMax = toPositiveInt(config.restoreMax, DEFAULTS.restoreMax);
  const restoreTimeoutMs = toPositiveInt(config.restoreTimeoutMs, DEFAULTS.restoreTimeoutMs);

  // 当前进程的启动时刻（epoch 毫秒）：写入 marker 供下次启动对比。
  // Docker 容器内 DSH 恒为 PID 1，pid 无法区分两次运行，只能靠它判断重启。
  const startAtMs = computeProcessStartAtMs();

  const markerDir = join(resolveDshHome(), config.stateDir);
  const markerPath = join(markerDir, 'marker.json');
  // 0.4.0：用户排除集合（web 顶栏开关写入），重启后仍生效
  const exclusionsFile = exclusionsPathOf(markerDir);

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
    try {
      // 取消尚未触发的节流定时器，同步写盘后重发信号走原有退出流程
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      writeState({ when: new Date().toISOString() });
    } catch (e) {
      console.warn('[resume-on-restart] shutdown flush failed:', e);
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

          return json(res, 404, { ok: false, error: `no dsh-resume-on-restart endpoint ${sub}` });
        } catch (err) {
          return json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    }), 'dsh-resume-on-restart: http state routes');
  });

  // 6. 若发生重启：先尝试自动恢复重启前活跃的会话，全部失败再回退旧行为
  if (wasRestart) {
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
         * 且要求其具备 resolveAgent 方法；拿不到即降级。
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
         * 失败（含超时/缺失/异常/意外形状）一律 throw，由调用方记录并继续下一个候选。
         */
        const resumeSession = async (sessionId) => {
          const controller = getSessionController();
          if (!controller) throw new Error('sessionController service unavailable');
          const result = await withTimeout(
            controller.resolveAgent(sessionId),
            Math.max(1, remainingMs()),
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

        /** 投递通知；restored 非空时文案命中"已自动恢复"。返回是否成功。 */
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
            return true;
          } catch (err) {
            console.warn('[resume-on-restart] deliver failed:', err);
            writeWakeLog(markerDir, String(target.id), false, String(err));
            return false;
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

        // 自动恢复候选：已 live 直接投递；未 live 经 sessionController 恢复后投递
        const restoreCandidates = async (candidates) => {
          for (const candidate of candidates) {
            if (remainingMs() <= 0) {
              console.warn('[resume-on-restart] restore budget exhausted, skip remaining candidates');
              return false;
            }
            let agent = null;
            try {
              agent = scope.agents.get?.(candidate.id) ?? null;
            } catch (err) {
              console.warn('[resume-on-restart] live lookup failed for session', candidate.id, ':', err);
            }
            if (!agent) {
              try {
                agent = await resumeSession(candidate.id);
                console.log('[resume-on-restart] session resumed via sessionController:', candidate.id);
              } catch (err) {
                const reason = err?.message ?? String(err);
                console.warn('[resume-on-restart] resume session', candidate.id, 'failed:', reason);
                writeWakeLog(markerDir, candidate.id, false, `resume failed: ${reason}`);
                continue;
              }
            }
            // 投递结果（成功/失败）由 deliver 内部记录 wake.log
            if (deliver(agent, candidate)) return true;
          }
          return false;
        };

        // 全程异步化：恢复失败/异常都回退到 fallbackWake，不阻塞插件与事件循环
        (async () => {
          try {
            if (config.restoreSessions !== false) {
              // 0.4.0：候选先按用户排除集合过滤（web 顶栏开关写入的"重启后不自动恢复"），
              // 被排除的候选不参与恢复，但记入 wake.log 便于排查。
              const picked = pickRestoreTargets(marker, restoreMax);
              const { kept, excluded } = filterExcludedCandidates(picked, readExclusions(exclusionsFile));
              for (const candidate of excluded) {
                writeWakeLog(markerDir, candidate.id, false, 'excluded by user');
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
