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
 * 0.6.0 起新增"无用户提示词的会话不自动激活"守卫（lib/session-scan.js）：
 * 恢复候选投递与 fallbackWake 回退唤醒都在投递前扫描目标会话的记录文件
 * （`<DSH_HOME>/sessions/<项目目录>/[session-]<id>/session.v4.jsonl[.zstd]`），
 * 判定其是否有过真实人工输入（存在 `type === 'user/message'` 且消息对象
 * `source.kind === 'user'` 的记录，插件/规则注入消息的 kind 不算）；没有、或
 * 文件缺失/zstd 不支持/扫描失败（fail-closed）就跳过投递并记日志——不再把
 * "请自主决定下一步"的通知灌进从未有用户输入的空会话导致模型无人指示自主
 * 干活。`requireHumanPrompt: false` 可关闭守卫（完全恢复旧行为）。
 *
 * 0.7.0 修复"等服务挤占候选预算"（0.5.2 的后续）：等待 sessionController 就绪
 * 从候选预算切片中拆出——restoreCandidates() 进入候选循环前用独立预算
 * serviceWaitTimeoutMs（默认 30s，与 restoreTimeoutMs 互不挤占）一次性全局轮询
 * 等待，结果与耗时记入 wake.log；就绪后候选阶段不再等服务（resumeSession 退化
 * 为一次防御式即时检查，resolveAgent 仍按候选剩余预算 withTimeout 封顶），
 * restoreTimeoutMs 只作为候选阶段总预算、自服务就绪起算；等待超时则不逐候选
 * 空转，wake.log 记 service-wait-timeout 后直接回退 fallbackWake 降级通知。
 *
 * 0.8.0 起新增"重启引擎"（lib/restart.js，设计参考 dsh-power-button）：设置弹窗
 * 新增左侧「重启」选项（二次确认后才重启），并提供 /restart 命令与
 * restart_harness 模型工具（名称已被其他插件注册时自动让位）。重启分两种模式：
 * - helper（普通进程）：真 .cjs detach helper 经 ARM→COMMIT→ACK 握手接管拉起，
 *   等旧 pid 退出、端口释放、会话文件静默后以原 argv+cwd（端口 pin）拉起新进程；
 * - pid1-exit（容器内 PID=1）：PID 1 退出即容器销毁、helper 必死，因此退出前把
 *   origin status（power-restart/ror-<id>.status.json）、重启身份记录
 *   （restart-identity.json）、检测 marker 兜底 flush、停机归因存根全部写盘后
 *   优雅退出，由容器重启策略/手动 docker start 拉起。
 * 两种模式都被既有链路完整消化：开机 detectRestart 判定重启（pid1 靠 startAt
 * 差异）→ origin 扫描命中 ror-*.status.json → boot 记录 reason=restart-button →
 * 自动恢复运行中的会话 → /restart/health 暴露重启身份，客户端轮询 instanceId
 * 变更后自动刷新并弹「已重启」toast（POST /restart/ack 消费）。
 * 检测 marker.json 绝不被重启流程覆写（recentSessions 是恢复的唯一数据源）。
 *
 * 兼容性：本插件只依赖 cordis ctx 提供的 `agents` 服务与事件，不 import 任何
 * `@deepseek-ai/dsh-*` 内部包；sessionController 只在运行时防御式探测
 * （ctx.reflect.get 非阻塞读取；绝不直接读取未在 inject 声明的服务属性——
 * cordis 上下文代理对此必抛）；webServer 经动态 ctx.inject(['webServer'], ...)
 * 等服务激活后再注册路由，不加入插件 inject、不阻塞加载，缺失/异常即降级，
 * 因此可在 DSH Desktop 打包环境（app.asar）下运行，
 * 且其缺失绝不阻断插件加载与既有通知路径。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  attributeShutdown,
  buildNotice,
  classifyHumanPromptGuard,
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
import { scanSessionHasHumanPrompt } from './session-scan.js';
import {
  LAUNCH_TOKEN_ENV,
  SOURCE,
  buildOriginRecord,
  clampModelDelayMs,
  createTransitionLatch,
  matchRestartIdentity,
  resolveRestartMode,
  restartDsh,
} from './restart.js';

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
  // 恢复（resume 候选）阶段的总预算（ms）；0.5.0 起按候选数平摊（每候选最低 5s），
  // 超出预算的候选记 skipped-budget 而不是静默放弃。0.7.0 起语义收窄为
  // "候选阶段总预算"：等 sessionController 就绪不占它（等待用 serviceWaitTimeoutMs），
  // 预算自服务就绪、进入候选循环前起算
  restoreTimeoutMs: 30000,
  // ---- 0.7.0 新增 ----
  // 进入候选循环前全局等待 sessionController 就绪的独立预算（ms）：服务按依赖序
  // 晚于 agents 激活，等待总量不再按候选数平摊挤占恢复预算；轮询间隔沿用
  // SERVICE_POLL_MS。超时则跳过全部候选直接回退 fallbackWake 降级通知
  // （wake.log 记 service-wait-timeout）
  serviceWaitTimeoutMs: 30000,
  // ---- 0.6.0 新增 ----
  // 投递前是否要求目标会话有过真实人工输入（0.6.0 守卫）：恢复候选与 fallback
  // 回退目标都先经 lib/session-scan.js 扫描会话记录判定，没有（或文件缺失/
  // 解压不支持/扫描失败，fail-closed）就跳过投递并记日志，避免把"自主决定
  // 下一步"的通知灌进空会话导致模型无人指示自主干活
  requireHumanPrompt: true,
  // ---- 0.8.0 新增：重启引擎（lib/restart.js） ----
  // 设置弹窗「重启」按钮 + /restart 命令 + /restart/* 路由的总开关
  enableRestart: true,
  // restart_harness 模型工具开关（名称冲突时无论如何都会自动让位）
  enableModelTool: true,
  // 响应返回后、请求退出前的延迟（ms）：给 HTTP 回包与会话 flush 留时间
  restartDelayMs: 1500,
  // 模型工具 delayMs 参数的上限（有效下限 1000ms，模型不能在自己的 turn
  // 结算前杀掉进程）
  maxDelayMs: 5000,
  // pid1-exit 模式的退出码：--restart=on-failure 策略只在非 0 退出时拉起容器；
  // always/unless-stopped 策略保持默认 0 即可
  pid1ExitCode: 0,
};

/** 回退路径（通知主会话）轮询等待 agent 出现的最长时间（ms），与 0.2.0 保持一致。 */
const FALLBACK_MAX_WAIT_MS = 20000;
const FALLBACK_POLL_MS = 500;

// ---- 0.5.2 新增：sessionController 就绪等待 ----
/** 等待 sessionController 服务就绪的轮询间隔（ms）：服务按依赖序晚于 agents 激活。
 *  0.7.0 起只用于 restoreCandidates 进入候选循环前的全局等待（serviceWaitTimeoutMs）。 */
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
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 0.8.0：带上来源文件名——origin.source 据此区分本插件（ror- 前缀）与
        // dsh-power-button 的记录（reason 标签 restart-button vs power-button）
        records.push({ ...parsed, _file: name });
      }
    } catch (e) {
      console.warn(`[resume-on-restart] could not read power-restart status ${name}:`, e);
    }
  }
  return records;
}

/**
 * 从命中的 origin status 记录推导 source（0.8.0）：
 * 记录自带 source 字段（本插件写入）优先；否则按文件名前缀 ror- 判定为本插件；
 * 其余（无前缀、dsh-power-button 旧记录）归 power-button。
 * @param {object} record pickOriginRecord 命中的记录（含 _file）
 * @returns {string}
 */
function originSourceOf(record) {
  if (typeof record?.source === 'string' && record.source) return record.source;
  if (typeof record?._file === 'string' && record._file.startsWith('ror-')) return SOURCE;
  return 'power-button';
}

/**
 * 启动时清理本插件的重启工件（0.8.0，best-effort，照抄 power-button 的 7 天窗）：
 * helper 脚本（内嵌 relaunch argv）与其日志、ror-*.commit.json、power-restart 下的
 * ror-*.status.json。只清理本插件前缀，不碰 power-button 的记录；rolling 的
 * last-restart-status.json 与 restart-identity.json（启动即消费）不在清理范围。
 */
function pruneRestartArtifacts(markerDir, powerRestartDir, maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  const prune = (dir, claim) => {
    let entryNames;
    try {
      entryNames = readdirSync(dir);
    } catch {
      return;
    }
    for (const entryName of entryNames) {
      if (!claim(entryName)) continue;
      const full = join(dir, entryName);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch { /* 单个文件清理失败不影响其余 */ }
    }
  };
  prune(markerDir, (n) =>
    (n.startsWith('restart-helper-') && (n.endsWith('.log') || n.endsWith('.cjs')))
    || (n.startsWith('ror-') && n.endsWith('.commit.json')));
  prune(powerRestartDir, (n) => n.startsWith('ror-') && n.endsWith('.status.json'));
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
  // 0.7.0：等服务就绪的独立预算（与 restoreTimeoutMs 互不挤占）
  const serviceWaitTimeoutMs = toPositiveInt(config.serviceWaitTimeoutMs, DEFAULTS.serviceWaitTimeoutMs);
  // 0.6.0：requireHumanPrompt 布尔归一化——只有显式 false 才关闭守卫，
  // 其余（含缺失/脏值）一律开启（fail-closed 方向）
  const requireHumanPrompt = config.requireHumanPrompt !== false;
  // 0.8.0：重启引擎配置归一化——布尔开关只有显式 false 才关闭；
  // delay 皆为正整数回退默认；pid1ExitCode 取 0-255 整数，非法回退 0
  const enableRestart = config.enableRestart !== false;
  const enableModelTool = config.enableModelTool !== false;
  const restartDelayMs = toPositiveInt(config.restartDelayMs, DEFAULTS.restartDelayMs);
  const maxDelayMs = toPositiveInt(config.maxDelayMs, DEFAULTS.maxDelayMs);
  const pid1ExitCodeRaw = Math.floor(Number(config.pid1ExitCode));
  const pid1ExitCode = Number.isFinite(pid1ExitCodeRaw) && pid1ExitCodeRaw >= 0 && pid1ExitCodeRaw <= 255
    ? pid1ExitCodeRaw
    : DEFAULTS.pid1ExitCode;

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

  // ---- 0.8.0：重启引擎（lib/restart.js）的启动接线 ----

  // 3.1 本进程 instanceId（每次启动随机）：/restart/health 的身份锚点。helper
  //     等新进程就绪、客户端判断"确实换了个实例"都靠它必须**变更**。
  const instanceId = randomUUID();
  // 3.2 重启模式：PID=1（容器标准形态）走 pid1-exit；否则走 detach helper。
  const restartMode = resolveRestartMode();
  // 3.3 防重入闩：重启会终结本进程，命令/按钮/工具并发触发只允许第一个生效。
  const restartLatch = createTransitionLatch();

  // 3.4 启动即消费重启身份记录：读 env 启动令牌（读后即删，不泄漏给 MCP 子进程），
  //     与 restart-identity.json 匹配才认领"本进程就是那次重启的产物"。
  //     记录无论是否认领都删除：身份只属于一次启动。认领结果供 /restart/health
  //     暴露（helper 就绪门控 + 客户端「已重启」toast），不参与 detectRestart。
  const restartIdentityFile = join(markerDir, 'restart-identity.json');
  const launchToken = process.env[LAUNCH_TOKEN_ENV];
  delete process.env[LAUNCH_TOKEN_ENV];
  const restartIdentity = matchRestartIdentity(
    readJsonFileIfExists(restartIdentityFile),
    launchToken,
    instanceId,
  );
  removeFileBestEffort(restartIdentityFile);
  // toast 标记与身份分离：ack 只清标记，身份保留整个进程生命周期
  let restartNoticePending = restartIdentity !== null;

  // 3.5 启动 housekeeping：清理 7 天前的重启工件（helper 脚本/日志、commit、
  //     本插件的 ror-*.status.json），不碰 power-button 的记录
  pruneRestartArtifacts(markerDir, powerRestartDir);

  // 3.6 端口解析：优先 webServer 实际绑定地址，回退 --port argv，再回退 3080
  //    （防御式 reflect 探测，服务缺失/形状变化一律回退，绝不抛错）。
  const resolveWebPort = () => {
    try {
      const bound = ctx.reflect?.get?.('webServer')?.server?.address?.();
      if (bound && typeof bound === 'object' && typeof bound.port === 'number' && bound.port > 0) return bound.port;
    } catch { /* 服务缺失属预期 */ }
    const argv = process.argv;
    const portIndex = argv.indexOf('--port');
    if (portIndex >= 0 && portIndex + 1 < argv.length) {
      const port = Number(argv[portIndex + 1]);
      if (Number.isFinite(port) && port > 0) return port;
    }
    return 3080;
  };

  // 3.7 退出前的持久化兜底（两种重启模式共用，由 restartDsh 在安排退出前调用）：
  //     同步固化检测 marker（recentSessions/running 标记是恢复流程的唯一数据源）+
  //     写停机归因存根（合成 signal 'restart-exit'：区分 crash，又诚实于"主动退出"）。
  const writeRestartShutdownStub = () => {
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(pendingShutdownFile, `${JSON.stringify({ signal: 'restart-exit', at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    } catch (e) {
      console.warn('[resume-on-restart] could not write pending-shutdown.json:', e);
    }
  };
  const flushMarkerState = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    writeState();
  };

  // 3.8 重启路径 helper 脚本与日志（每次重启唯一名，7 天后由 housekeeping 清理）
  const restartHelperFile = join(markerDir, `restart-helper-${process.pid}-${Date.now()}.cjs`);
  const restartHelperLogFile = join(markerDir, `restart-helper-${process.pid}.log`);
  const restartRelaunchLog = join(markerDir, 'restart-relaunch.log');
  const lastRestartStatusFile = join(markerDir, 'last-restart-status.json');

  /**
   * 组装一次重启的 deps（origin 由入口决定：按钮 settings-ui / 命令 command /
   * 模型工具 model-tool；GUI 点击没有因果会话，sessionId 为空）。
   * @param {{kind: string, sessionId?: string}|undefined} origin
   * @param {number|undefined} [delayMsOverride] 模型工具的延迟参数（已 clamp）
   */
  const buildRestartDeps = (origin, delayMsOverride) => ({
    mode: restartMode,
    delayMs: delayMsOverride ?? restartDelayMs,
    exitCode: pid1ExitCode,
    origin,
    oldInstanceId: instanceId,
    port: resolveWebPort(),
    paths: {
      stateDir: markerDir,
      powerRestartDir,
      helperFile: restartHelperFile,
      logFile: restartHelperLogFile,
      lastStatusFile: lastRestartStatusFile,
      identityFile: restartIdentityFile,
      pendingShutdownFile,
      serverLog: restartRelaunchLog,
      sessionsRoot: join(dshHome, 'sessions'),
      healthPath: `${HTTP_BASE}/restart/health`,
    },
    flushMarkerState,
    writePendingShutdown: writeRestartShutdownStub,
  });

  /** 幂等执行一次重启；返回统一结果（HTTP/命令/工具三个入口共用）。 */
  const performRestart = async (origin, delayMsOverride) => {
    return restartDsh(ctx, buildRestartDeps(origin, delayMsOverride));
  };

  // 3.9 /restart/health 的响应体：身份块（helper 就绪门控依据）与 toast 标记
  const appExitState = () => {
    try {
      return typeof ctx?.get?.('appExit') === 'function' ? 'available' : 'missing';
    } catch {
      return 'missing';
    }
  };
  const restartHealthPayload = () => {
    const body = {
      ok: true,
      instanceId,
      pid: process.pid,
      mode: restartMode,
      lifecycle: restartLatch.current() ?? 'ready',
      appExit: appExitState(),
    };
    if (restartIdentity !== null) {
      body.restart = {
        restartId: restartIdentity.restartId,
        fromInstanceId: restartIdentity.fromInstanceId,
      };
      if (restartNoticePending) {
        body.restarted = true;
        body.fromInstanceId = restartIdentity.fromInstanceId;
      }
    }
    return body;
  };

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

          // ---- 0.8.0：重启引擎路由（enableRestart=false 时整体不存在） ----
          if (enableRestart && sub === '/restart/info' && method === 'GET') {
            // 供设置弹窗「重启」section 展示：模式（helper / pid1-exit）、
            // 优雅退出通道是否可用、重启后将自动恢复的会话数（与顶栏开关同口径）
            return json(res, 200, {
              ok: true,
              mode: restartMode,
              pid: process.pid,
              instanceId,
              appExit: appExitState(),
              isContainer: existsSync('/.dockerenv'),
              restartDelayMs,
              pid1ExitCode,
              runningCandidates: [...collectRestoreCandidateIds(recentSessions)],
            });
          }

          if (enableRestart && sub === '/restart/health' && method === 'GET') {
            // helper 的就绪门控（instanceId 变更 + restartId 匹配）与客户端
            // 重启回执轮询都打这里；无需任何参数，围栏与本前缀其余路由一致
            return json(res, 200, restartHealthPayload());
          }

          if (enableRestart && sub === '/restart' && method === 'POST') {
            // 二次确认在客户端（默认焦点「取消」的确认框）；服务端只负责
            // 防重入与围栏。幂等入口：按钮、命令、模型工具共用一个闩。
            if (!restartLatch.claim('restart')) {
              return json(res, 409, { ok: false, error: 'restart already in progress' });
            }
            const result = await performRestart(buildOriginRecord('settings-ui'));
            if (!result.ok) restartLatch.release();
            return json(res, result.ok ? 200 : 500, result);
          }

          if (enableRestart && sub === '/restart/ack' && method === 'POST') {
            // 客户端展示「已重启」toast 后回执：只清 toast 标记，
            // /restart/health 的 restart 身份块保留整个进程生命周期
            restartNoticePending = false;
            return json(res, 200, { ok: true, action: 'ack' });
          }

          return json(res, 404, { ok: false, error: `no dsh-resume-on-restart endpoint ${sub}` });
        } catch (err) {
          return json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    }), 'dsh-resume-on-restart: http state routes');
  });

  // 5.5 /restart 命令（0.8.0，对齐 dsh-power-button 的入口集合）：与按钮共用
  //     同一个防重入闩，命令与按钮点击不会各自起一次重启。因果会话取发起命令
  //     的 agent（origin.kind='command'），重启日志因此能标注来源。名称冲突
  //     （其他插件已注册 restart）记日志让位，不影响本插件其余能力。
  if (enableRestart) {
    ctx.effect(() => {
      if (typeof ctx.commands?.register !== 'function') return;
      try {
        ctx.commands.register({
          name: 'restart',
          description: '重启 DeepSeek Harness（重载插件与配置；会话将在重启后自动恢复）',
          recordInput: false,
          async handler(invocation) {
            if (!restartLatch.claim('restart')) {
              return { kind: 'error', text: '重启已在进行中，请勿重复触发' };
            }
            const sessionId = invocation?.agent?.session?.id;
            const result = await performRestart(buildOriginRecord('command', sessionId));
            if (!result.ok) restartLatch.release();
            return result.ok
              ? { kind: 'success', text: result.note ?? 'DeepSeek Harness 正在重启' }
              : { kind: 'error', text: result.error ?? '重启失败' };
          },
        });
      } catch (error) {
        if (!String(error).includes('already registered')) throw error;
        console.log('[resume-on-restart] command "restart" already registered by another plugin, skip');
      }
    }, 'dsh-resume-on-restart: restart command');

    // 5.6 restart_harness 模型工具（0.8.0，名称与 dsh-power-button / anweat/dsh-restart
    //     一致，先到先得；被占用即让位）。delayMs 下限 1000ms：模型绝不能在自身
    //     turn 结算前杀掉进程。因果会话取 exec.agent（origin.kind='model-tool'）。
    if (enableModelTool) {
      ctx.effect(() => {
        if (typeof ctx.tools?.register !== 'function') return;
        try {
          ctx.tools.register({
            name: 'restart_harness',
            description: '重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。'
              + '由 dsh-resume-on-restart 提供：普通进程经 detach helper 握手后原命令行原端口拉起；'
              + '容器内 PID=1 时进程优雅退出、由容器重启策略拉起。'
              + '触发后当前连接短暂中断，网页轮询到新实例后自动刷新；重启前运行中的会话会被本插件自动恢复。'
              + '返回 ok 与说明文本。',
            parameters: {
              type: 'object',
              properties: {
                delayMs: {
                  type: 'number',
                  description: `旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 ${restartDelayMs}，上限 ${maxDelayMs}。`,
                },
              },
            },
            output: {
              // 空 schema（仅注解）：raw register 会把 schema 直接交给
              // assertSupportedJsonSchema，它不认识 'json' 这类作者侧标记值
              schema: {},
              render(_args, value) {
                return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
              },
            },
            async execute(args, exec) {
              const clamped = clampModelDelayMs(Number(args?.delayMs), maxDelayMs);
              if (!restartLatch.claim('restart')) {
                return { ok: false, error: 'restart already in progress' };
              }
              const sessionId = exec?.agent?.session?.id;
              const result = await performRestart(buildOriginRecord('model-tool', sessionId), clamped);
              if (!result.ok) restartLatch.release();
              return result;
            },
          });
        } catch (error) {
          if (!String(error).includes('already registered')) throw error;
          console.log('[resume-on-restart] tool "restart_harness" already registered by another plugin, skip');
        }
      }, 'dsh-resume-on-restart: restart_harness tool');
    }
  }

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
      // 0.8.0：source 由记录本身决定（本插件 ror- 前缀 → restart-button 标签；
      // 其余 → 既有 power-button 标签），detect.shutdownReasonOf 据此区分
      source: originSourceOf(originRecord),
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
        // 恢复候选阶段的总预算：0.7.0 起在 sessionController 就绪后才起算
        // （restoreCandidates 进入候选循环前先做全局等待，等待耗时不占本预算）。
        // deadline 为 0 表示候选阶段尚未开始，此时 remainingMs 恒为 0
        let deadline = 0;
        const remainingMs = () => Math.max(0, deadline - Date.now());

        // 0.6.0：会话记录根目录（<DSH_HOME>/sessions，dshHome 即 resolveDshHome()），
        // 恢复候选与 fallback 回退的 human-prompt 守卫扫描共用，局部构造一次不重复计算
        const sessionsRoot = join(dshHome, 'sessions');

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
         * 且要求其具备 resolveAgent 方法；拿不到由 restoreCandidates 的全局等待轮询
         * （0.7.0，serviceWaitTimeoutMs 预算），resumeSession 只做即时检查兜底。
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
         * 全局等待 sessionController 服务就绪（0.7.0）：restoreCandidates 进入候选
         * 循环前一次性调用，预算独立（serviceWaitTimeoutMs），不占候选恢复预算；
         * 每 SERVICE_POLL_MS 轮询一次。返回 `{ controller, waitedMs }`——
         * controller 为 null 表示预算内始终未就绪（调用方记日志后放弃全部候选）。
         */
        const waitForSessionController = async (budgetMs) => {
          const startedAt = Date.now();
          const waitDeadline = startedAt + Math.max(1, budgetMs);
          let controller = getSessionController();
          while (!controller) {
            const waitLeftMs = waitDeadline - Date.now();
            if (waitLeftMs <= 0) break;
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, Math.min(SERVICE_POLL_MS, waitLeftMs));
              timer.unref?.();
            });
            controller = getSessionController();
          }
          return { controller, waitedMs: Date.now() - startedAt };
        };

        /**
         * 通过 sessionController.resolveAgent(sessionId) 恢复会话为 live Agent。
         * 返回判别：成功 `{ agent }` / 失败 `{ error }`（stable failure union）。
         * budgetMs 为该候选的预算切片（ms，>0 时与候选阶段剩余总预算取更小者），
         * 只用于给 resolveAgent 调用套 withTimeout；失败（超时/异常/意外形状）
         * 一律 throw，由调用方记录并继续下一个候选。
         *
         * 0.7.0：等服务已上移到 restoreCandidates 的全局等待（serviceWaitTimeoutMs），
         * 这里只做一次防御式即时检查——立即取到服务就用，取不到不再轮询等待。
         */
        const resumeSession = async (sessionId, budgetMs = 0) => {
          const controller = getSessionController();
          if (!controller) throw new Error('sessionController service unavailable');
          const limitMs = budgetMs > 0
            ? Math.max(1, Math.min(budgetMs, remainingMs()))
            : Math.max(1, remainingMs());
          const result = await withTimeout(
            controller.resolveAgent(sessionId),
            limitMs,
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

        // 回退：现有行为（config.target 解析 roots[0]，轮询等待最长 20 秒），保证不劣化。
        // 0.6.0：回退目标（roots[0]）可能是一个从未有过用户输入的空会话——向它投递
        // "自主决定下一步"的通知会让模型无人指示自主干活（0.5.x 事故）。因此 deliver
        // 前加门槛：目标会话必须有过真实人工输入，没有（或扫描失败，fail-closed）就
        // 不投递、本轮回退就此收尾，不向 roots 更深处找补。
        const fallbackWake = () => {
          // 轮询期间目标不变就一直拦：被拦目标记住 id，不再重复扫描
          let blockedId = null;
          /** deliver 前的门槛；被拦时记 wake.log + console.warn，返回 false。 */
          const passesHumanPromptGuard = (target) => {
            if (!requireHumanPrompt) return true;
            const id = String(target.id);
            if (id === blockedId) return false;
            const guard = classifyHumanPromptGuard(
              scanSessionHasHumanPrompt(sessionsRoot, target.id),
              requireHumanPrompt,
            );
            if (guard.deliver) return true;
            blockedId = id;
            writeWakeLog(markerDir, id, false, guard.error);
            console.warn(`[resume-on-restart] fallback wake skipped for session ${id}: ${guard.error}`);
            return false;
          };

          let target = findTarget();
          if (target) {
            if (passesHumanPromptGuard(target)) deliver(target);
            return;
          }
          let waited = 0;
          const timer = setInterval(() => {
            waited += FALLBACK_POLL_MS;
            target = findTarget();
            if (target) {
              clearInterval(timer);
              if (passesHumanPromptGuard(target)) deliver(target);
              // 被门槛拦下：本轮不投递，轮询按既有收尾结束（不换目标、不向更深处找补）
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
        // 0.7.0：进入候选循环前先全局等 sessionController 就绪（独立预算
        // serviceWaitTimeoutMs，不占 restoreTimeoutMs），结果与耗时记入 wake.log；
        // 服务始终未就绪则不逐候选空转，直接返回 false 交由调用方回退 fallbackWake。
        const restoreCandidates = async (candidates) => {
          const wait = await waitForSessionController(serviceWaitTimeoutMs);
          writeWakeLog(
            markerDir,
            null,
            wait.controller !== null,
            wait.controller
              ? `sessionController ready after ${wait.waitedMs}ms`
              : `service-wait-timeout: sessionController not ready within ${serviceWaitTimeoutMs}ms`,
          );
          if (!wait.controller) {
            console.warn('[resume-on-restart] sessionController not ready within', serviceWaitTimeoutMs, 'ms, skip all restore candidates');
            return false;
          }
          // 服务已就绪：候选阶段总预算自此起算（全局等待已耗时间不占候选预算）
          deadline = Date.now() + restoreTimeoutMs;
          for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            // 0.6.0 守卫（最前面，先于 agents.get / resumeSession）：候选会话必须有过
            // 真实人工输入才允许自动激活；没有（或扫描失败，fail-closed）就跳过并
            // 记日志，避免把通知灌进从未有用户输入的空会话。
            if (requireHumanPrompt) {
              const guard = classifyHumanPromptGuard(
                scanSessionHasHumanPrompt(sessionsRoot, candidate.id),
                requireHumanPrompt,
              );
              if (!guard.deliver) {
                console.warn('[resume-on-restart] skip restore candidate without human prompt:', candidate.id, guard.error);
                writeWakeLog(markerDir, candidate.id, false, guard.error);
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'skipped-no-human-prompt',
                  error: guard.error,
                  at: new Date().toISOString(),
                });
                continue;
              }
            }
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
