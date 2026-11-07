import { randomUUID } from 'node:crypto';

/**
 * 重启检测、重启日志（restarts.ndjson）与消息构建的纯函数（无 ctx/agent 依赖，便于单元测试）。
 * 0.17.0 起另含恢复候选的"正常结束门"（classifyCompletedRestoreGate /
 * filterCompletedCandidates）：正常结束（会话日志最后一条真实 turn/end
 * kind === 'completed'）的会话重启后不再自动恢复，判定不了保守恢复。
 * 0.22.0 起 filterCompletedCandidates 增第三参 bypassIds：命中的候选免扫描
 * 直接恢复（主动注册 = 用户显式要求总是恢复，绕过正常结束门；缺省 = 现行为）；
 * shutdownReasonOf 另识 origin.kind==='auto' 的守门自动重启（'auto-restart'）。
 * 0.23.0 起 classifyRestoreFallback 增 skippedNoActivateCount：无可恢复候选且
 * 全部为「注册但不激活」（result:'no-activate'）结算 → 同样安静收尾不回退
 * （故意不激活的重启不需要继续，不吵主会话）；缺省 0 = 输出与现状一致。
 */

/**
 * 将中断时长格式化为可读文本（如 "1 小时 5 分"）。
 * @param {number} ms 毫秒数
 * @returns {string}
 */
export function humanizeDowntime(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} 小时${m > 0 ? ` ${m} 分` : ''}`;
  if (m > 0) return `${m} 分${s > 0 ? ` ${s} 秒` : ''}`;
  return `${s} 秒`;
}

/** pid 相同（容器内恒为 PID 1）时，判定"同一进程"允许的启动时间偏差（ms）。 */
const START_AT_TOLERANCE_MS = 2000;

/**
 * 计算当前进程的启动时刻（epoch 毫秒）。
 * @param {number} nowMs 当前时间戳（默认 Date.now()）
 * @param {number} uptimeSec 当前进程已运行的秒数（默认 process.uptime()）
 * @returns {number} 当前进程的启动时刻（epoch 毫秒）
 */
export function computeProcessStartAtMs(nowMs = Date.now(), uptimeSec = process.uptime()) {
  return Math.round(nowMs - uptimeSec * 1000);
}

/**
 * 从 marker 判断是否发生了重启。
 * @param {object|null} marker 上次写入的 marker（含 lastBootAt/pid，新版另含 startAt）
 * @param {number} nowMs 当前时间戳
 * @param {number} pid 当前进程 pid
 * @param {number} [startAtMs] 当前进程启动时刻（epoch 毫秒，computeProcessStartAtMs 的结果）
 * @returns {{wasRestart: boolean, downtimeMs: number}}
 */
export function detectRestart(marker, nowMs, pid, startAtMs) {
  if (!marker || typeof marker.lastBootAt !== 'string' || typeof marker.pid !== 'number') {
    return { wasRestart: false, downtimeMs: 0 };
  }
  // 中断时长始终从上次启动时间（lastBootAt）计算
  const prev = Date.parse(marker.lastBootAt);
  const downtimeOf = () => (Number.isFinite(prev) && prev > 0 ? Math.max(0, nowMs - prev) : 0);
  // pid 不同 = 发生了重启（旧判定，保持不变）
  if (marker.pid !== pid) return { wasRestart: true, downtimeMs: downtimeOf() };
  // pid 相同（Docker 容器内 DSH 恒为 PID 1 的场景）：改用进程启动时间对比，
  // 双向比较——无论时钟前移还是后移，偏差超过容差都视为重启。
  // 旧格式 marker 没有 startAt 时回退用 lastBootAt，读到 v0.1.0 旧 marker 也能正确判定重启。
  const markerStart = typeof marker.startAt === 'number' ? marker.startAt : Date.parse(marker.lastBootAt);
  if (!Number.isFinite(markerStart) || !Number.isFinite(startAtMs)) {
    return { wasRestart: false, downtimeMs: 0 }; // 启动时间不可用时保守判非重启
  }
  if (Math.abs(startAtMs - markerStart) > START_AT_TOLERANCE_MS) {
    return { wasRestart: true, downtimeMs: downtimeOf() };
  }
  return { wasRestart: false, downtimeMs: 0 };
}

/**
 * 将候选条目的活跃时间归一化为 epoch 毫秒。
 * 数字直接用；字符串按 ISO 日期解析；其余（含解析失败）按 0（未知）处理。
 * @param {unknown} value
 * @returns {number}
 */
function normalizeActiveAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * 从 marker 挑选重启后要恢复的会话候选（纯函数，便于单元测试）。
 *
 * 精确语义：
 * 1. 候选来源：`marker.recentSessions`（`[{id, at, running?}]`，约定最新在前）。
 *    有效条目：`{id}` 为非空字符串的对象，`at` 经 normalizeActiveAt 归一化；
 *    纯字符串条目兼容为 `{id, at: 0}`；其余条目忽略。
 *    0.10.0 恢复口径（反转 0.4.0）：所有有效条目都是候选——手动停止
 *    （DSH 停止那一刻 idle，`running === false`）的会话重启后同样恢复
 *    （回归 0.3.x 的覆盖行为）；`running` 字段不再参与候选过滤，仅作为
 *    记录保留（供重启日志与旧版本兼容）。
 * 2. recentSessions 含有效条目时，只使用它（不与旧字段混用）；
 *    否则兼容只有旧字段的 marker：`lastSessionId` 为非空字符串时，
 *    回退为唯一候选 `{id: lastSessionId, at: normalizeActiveAt(lastActiveAt)}`。
 * 3. 按 id 去重，保留首次出现的一条（输入约定最新在前，故即保留较新的一条）。
 * 4. 按 at 新 → 旧排序（at 相同保持原相对顺序，排序稳定）。
 * 5. 截断到前 max 条；返回 `[{id, at}]`（at 为 epoch 毫秒，未知为 0）。
 * 6. marker 非对象 / 无有效候选 / max 不是正有限数字 → 返回 `[]`。
 *
 * @param {object|null} marker 上次持久化的 marker
 * @param {number} max 最多返回的候选数
 * @returns {Array<{id: string, at: number}>}
 */
export function pickRestoreTargets(marker, max) {
  if (!Number.isFinite(max) || max <= 0) return [];
  if (!marker || typeof marker !== 'object') return [];
  let candidates = [];
  let hasRecentEntries = false;
  if (Array.isArray(marker.recentSessions)) {
    for (const entry of marker.recentSessions) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
        hasRecentEntries = true;
        // 0.10.0 口径反转：running 不再过滤候选——手动停止（idle/running:false）
        // 的会话与停止时仍运行中的会话同样恢复
        candidates.push({ id: entry.id, at: normalizeActiveAt(entry.at) });
      } else if (typeof entry === 'string' && entry) {
        hasRecentEntries = true;
        candidates.push({ id: entry, at: 0 });
      }
    }
  }
  // 旧格式回退：仅当 recentSessions 没有有效条目时才走 lastSessionId
  // （有列表就整表接管，不与旧字段混用）
  if (!hasRecentEntries && typeof marker.lastSessionId === 'string' && marker.lastSessionId) {
    candidates.push({ id: marker.lastSessionId, at: normalizeActiveAt(marker.lastActiveAt) });
  }
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    deduped.push(candidate);
  }
  deduped.sort((a, b) => b.at - a.at);
  return deduped.slice(0, Math.floor(max));
}

/**
 * 收集内存态最近活跃列表中的恢复候选 id（纯函数，便于单测与 GET /state 输出）。
 *
 * 与 pickRestoreTargets 的过滤口径一致（0.10.0 起 running 不再是过滤条件，
 * 恢复候选 = 显示候选）：所有 id 为非空字符串的对象条目都是候选
 * （含手动停止/正常结束的会话）；非对象条目 / id 非非空字符串的条目忽略。
 * 非数组输入返回空 Set，绝不抛错。
 *
 * @param {Array<{id: string, at?: number|string, running?: boolean>}|unknown} recentSessions
 * @returns {Set<string>}
 */
export function collectRestoreCandidateIds(recentSessions) {
  const ids = new Set();
  if (!Array.isArray(recentSessions)) return ids;
  for (const entry of recentSessions) {
    if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
      ids.add(entry.id);
    }
  }
  return ids;
}

/**
 * 按用户排除集合过滤恢复候选（纯函数，便于单元测试）。
 *
 * 语义：
 * 1. `excludedMap` 是 `{ [sessionId]: excludedAtISO }` 形状的排除集合
 *    （宿主 half 持久化的 excluded-sessions.json 的 `sessions` 字段）。
 * 2. 候选 `id` 命中排除集合（own property 且值为字符串）→ 进入 `excluded`；
 *    其余（含全部非法输入）原样进入 `kept`，两数组都保持输入相对顺序。
 * 3. candidates 非数组 / excludedMap 非对象 → 视为空，返回
 *    `{ kept: 数组本身或 [], excluded: [] }`，绝不抛错。
 *
 * @param {Array<{id: string, at: number}>} candidates pickRestoreTargets 的输出
 * @param {Record<string, string>} excludedMap 排除集合（id → 排除时间 ISO）
 * @returns {{kept: Array<{id: string, at: number}>, excluded: Array<{id: string, at: number}>}}
 */
export function filterExcludedCandidates(candidates, excludedMap) {
  const list = Array.isArray(candidates) ? candidates : [];
  const map = excludedMap !== null && typeof excludedMap === 'object' && !Array.isArray(excludedMap)
    ? excludedMap
    : {};
  const kept = [];
  const excluded = [];
  for (const candidate of list) {
    const id = candidate && typeof candidate === 'object' ? candidate.id : undefined;
    const hit = typeof id === 'string'
      && Object.prototype.hasOwnProperty.call(map, id)
      && typeof map[id] === 'string';
    (hit ? excluded : kept).push(candidate);
  }
  return { kept, excluded };
}

// ---- 0.5.0 新增：重启日志（restarts.ndjson）、停机归因与全量恢复的纯函数 ----

/**
 * 重启检测依据（boot 记录的 detectBasis 字段）。
 * 与 detectRestart 的判定分支一一对应，仅在 wasRestart === true 时消费：
 * - pid 不同 → 'bootAt-diff'（旧判定；中断时长本就取自 lastBootAt）
 * - pid 相同、marker 带 startAt → 'startAt-diff'（容器 PID 1 场景的进程启动时间对比）
 * - pid 相同、旧格式 marker（无 startAt）→ 'bootAt-diff'（markerStart 回退用 lastBootAt 对比）
 * - marker 非法 → null（此时 detectRestart 不可能判定为重启）
 * @param {object|null} marker 上次写入的 marker
 * @param {number} pid 当前进程 pid
 * @returns {'bootAt-diff'|'startAt-diff'|null}
 */
export function detectBasisOf(marker, pid) {
  if (!marker || typeof marker.lastBootAt !== 'string' || typeof marker.pid !== 'number') return null;
  if (marker.pid !== pid) return 'bootAt-diff';
  return typeof marker.startAt === 'number' ? 'startAt-diff' : 'bootAt-diff';
}

/**
 * restoreMax 配置归一化：0/缺失/非法 → 不限（全量恢复）；
 * 正数 → floor 后的候选数上限。返回值可直接传 pickRestoreTargets
 * （其要求有限正数，故"不限"用最大安全整数表达而非 Infinity）。
 * @param {unknown} value 配置值
 * @returns {number}
 */
export function normalizeRestoreMax(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return Number.MAX_SAFE_INTEGER;
  return n;
}

/**
 * 归因上次停机方式（boot 记录的 shutdown 字段）。
 * 优先 pending-shutdown.json 的解析结果（本插件 SIGTERM/SIGINT 兜底 flush 时写入）；
 * 没有则回退旧版 flushOnShutdown 写进 marker 的 when 字段（兼容 0.4.x marker）；
 * 两者都没有 → seen: false，即崩溃 / 强杀 / 容器重启。
 * @param {unknown} pending pending-shutdown.json 的 JSON.parse 结果（宿主读取，可能为 null）
 * @param {unknown} markerWhen 旧 marker 的 when 字段
 * @returns {{seen: boolean, signal: string|null, at: string|null}}
 */
export function attributeShutdown(pending, markerWhen) {
  if (
    pending !== null && typeof pending === 'object' && !Array.isArray(pending)
    && typeof pending.signal === 'string' && pending.signal
    && typeof pending.at === 'string' && pending.at
  ) {
    return { seen: true, signal: pending.signal, at: pending.at };
  }
  if (typeof markerWhen === 'string' && markerWhen) {
    return { seen: true, signal: null, at: markerWhen };
  }
  return { seen: false, signal: null, at: null };
}

/**
 * 停机原因标签（boot 记录的 reason 字段）：
 * - restart-button：origin.source 是本插件（0.8.0 起设置弹窗按钮/命令/模型工具发起的重启）
 * - auto-restart：origin.kind 是 'auto'（0.22.0 起插件守门自动重启——
 *   register_restart_recovery 注册后全部会话完成时自动触发的那次重启；优先于
 *   source 判定，auto origin 同样来自本插件写入的 ror-*.status.json）
 * - power-button：有其他 origin（本次重启由 power-restart 流程发起，如 dsh-power-button）
 * - signal：无 origin 但确认经过正常停机流程（pending-shutdown / marker.when）
 * - crash：两者皆无（崩溃 / 强杀 / 容器重启）
 * - unknown：输入形状异常时的兜底
 * @param {{seen?: boolean}|null|undefined} shutdown attributeShutdown 的结果
 * @param {object|null} origin 命中的 origin（宿主已整形，无则 null）
 * @returns {'restart-button'|'auto-restart'|'power-button'|'signal'|'crash'|'unknown'}
 */
export function shutdownReasonOf(shutdown, origin) {
  if (origin !== null && typeof origin === 'object') {
    // 0.22.0：守门自动重启单独归因（origin.kind === 'auto' 优先于 source 判定）
    if (origin.kind === 'auto') return 'auto-restart';
    return origin.source === 'dsh-resume-on-restart' ? 'restart-button' : 'power-button';
  }
  if (shutdown !== null && typeof shutdown === 'object' && shutdown.seen === true) return 'signal';
  if (shutdown !== null && typeof shutdown === 'object' && shutdown.seen === false) return 'crash';
  return 'unknown';
}

/**
 * 从 power-restart 的 status 记录中挑出本次重启的发起方（origin 匹配）。
 * 取 committedAt 落在 [prevBootMs, bootMs]（闭区间）内的记录中 committedAt
 * 最近的一条（同刻并列取扫描到的后一条）；没有命中 → null（原因归 shutdown 侧）。
 * @param {unknown[]} records 已解析的 <restartId>.status.json 对象数组（损坏文件已被宿主丢弃）
 * @param {number|null} prevBootMs 上次启动时刻（epoch ms；不可用视为无下界）
 * @param {number} bootMs 本次启动时刻（epoch ms）
 * @returns {object|null} 命中的 status 记录
 */
export function pickOriginRecord(records, prevBootMs, bootMs) {
  if (!Array.isArray(records) || !Number.isFinite(bootMs)) return null;
  const from = Number.isFinite(prevBootMs) ? prevBootMs : Number.NEGATIVE_INFINITY;
  let picked = null;
  let pickedAt = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const committed = Date.parse(record.committedAt);
    if (!Number.isFinite(committed)) continue;
    if (committed < from || committed > bootMs) continue;
    if (committed >= pickedAt) {
      picked = record;
      pickedAt = committed;
    }
  }
  return picked;
}

/**
 * 解析 ndjson 文本为对象数组：逐行 JSON.parse，空行与损坏行跳过
 * （规划要求的容错口径：单行损坏不得丢掉整份日志）。
 * @param {unknown} text 文件全文
 * @returns {object[]} 解析成功的条目（顺序与文件一致）
 */
export function parseNdjson(text) {
  if (typeof text !== 'string') return [];
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // 日志条目约定为 JSON 对象；非对象行（如手改成的数字/数组）同样按损坏行跳过
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed);
    } catch {
      // 损坏行跳过：文件可能被截断/手改，跳过该行即可，不影响其余行
    }
  }
  return entries;
}

/** 把条目数组序列化为 ndjson 文本（每行一条 JSON，末尾带换行；非数组按空处理）。 */
export function serializeNdjson(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

/** ndjson 条目裁剪：保留最后 max 条（超出丢最旧）；max 非法/非正 → 空数组。 */
export function capNdjsonEntries(entries, max) {
  if (!Number.isFinite(max) || max <= 0) return [];
  const list = Array.isArray(entries) ? entries : [];
  const limit = Math.floor(max);
  return list.slice(Math.max(0, list.length - limit));
}

/**
 * 压缩 ndjson 文本：解析（跳过损坏行）→ 保留最后 max 条 → 重新序列化。
 * 返回 `{ text, kept }`，kept 为重写后的条数（宿主用它延续内存计数）。
 * @param {string} text 文件全文
 * @param {number} max 条目上限
 * @returns {{text: string, kept: number}}
 */
export function compactNdjson(text, max) {
  const kept = capNdjsonEntries(parseNdjson(text), max);
  return { text: serializeNdjson(kept), kept: kept.length };
}

/**
 * 提示词片段 key 清单（0.32.0 新增，供设置弹窗「技能展示」tab 逐行解释用：
 * 客户端按 key 查 i18n 的「出现条件」文案，因此 key 增删必须同步
 * lib/client.js 的 notice.when.* 文案，lib/notice.test.js 会校验两边一致）。
 */
export const NOTICE_SEGMENT_KEYS = Object.freeze([
  'header',
  'boot',
  'downtime',
  'lastSession',
  'lastActive',
  'restored',
  'custom',
  'tail',
]);

/**
 * 构建信息性提示文本的**分段结果**（0.32.0 从 buildNotice 抽出，纯函数）：
 * 按投递顺序返回 `[{ key, text }]`，空行（条件不满足的片段）不出现。
 *
 * buildNotice 等价于本函数 `map(seg => seg.text).join('\n')`——拆分只为让
 * 「提示词是怎么写的」这件事可展示/可测试，输出与 0.31.x 逐字一致
 * （lib/detect.test.js 的逐字断言仍在守护）。
 *
 * 片段顺序与含义：
 * 1. header         固定首行（[resume-on-restart] 检测到 DSH 服务已重启。）
 * 2. boot           有上次启动时刻 → 「上次运行于 X，本次于 Y 重启完成。」；否则「本次于 Y 启动。」
 * 3. downtime       停机时长 > 0 才有（中断约 N）
 * 4. lastSession    上次有最近活跃会话才有
 * 5. lastActive     且该会话有最后活跃时刻才有
 * 6. restored       本次确实恢复了某个会话才追加（带/不带括号内的最后活跃时刻两种形态）
 * 7. custom         config.notice 非空才追加（用户自定义文案）
 * 8. tail           固定末行（如需继续之前的工作，或启动新任务，请自主决定下一步。）
 *
 * @param {object} opts 与 buildNotice 同参
 * @returns {Array<{key: string, text: string}>}
 */
export function noticeSegments({
  bootAt,
  prevBootAt,
  downtimeMs,
  lastSessionId,
  lastActiveAt,
  customNotice,
  restoredSessionId,
  restoredActiveAt,
} = {}) {
  const segments = [];
  const push = (key, text) => { segments.push({ key, text }); };
  push('header', `[resume-on-restart] 检测到 DSH 服务已重启。`);
  if (prevBootAt) {
    push('boot', `上次运行于 ${prevBootAt}，本次于 ${bootAt} 重启完成。`);
  } else {
    push('boot', `本次于 ${bootAt} 启动。`);
  }
  if (downtimeMs > 0) {
    push('downtime', `中断约 ${humanizeDowntime(downtimeMs)}。`);
  }
  if (lastSessionId) {
    push('lastSession', `重启前最近活跃的会话：${lastSessionId}`);
    if (lastActiveAt) push('lastActive', `该会话最后活跃于 ${lastActiveAt}。`);
  }
  if (restoredSessionId) {
    push('restored', restoredActiveAt
      ? `已自动恢复重启前活跃的会话 ${restoredSessionId}（最后活跃于 ${restoredActiveAt}）。`
      : `已自动恢复重启前活跃的会话 ${restoredSessionId}。`);
  }
  if (customNotice) {
    push('custom', String(customNotice));
  }
  push('tail', `如需继续之前的工作，或启动新任务，请自主决定下一步。`);
  return segments;
}

/**
 * 构建信息性提示文本（由 agent 自主决定下一步）。
 * 命中自动恢复时传入 restoredSessionId/restoredActiveAt，输出恢复说明；
 * 旧调用不传时文案不变。
 * @param {object} opts
 * @returns {string}
 */
export function buildNotice(opts = {}) {
  return noticeSegments(opts).map((segment) => segment.text).join('\n');
}

/**
 * 构造投递给 agent 的通知消息对象（等价于 @deepseek-ai/dsh-llm 的 createUserMessage，
 * 0.3.1 起抽成纯函数便于单测，deliver() 改为调用本函数）。
 *
 * source 用 producer-owned kind（裸插件名），不能用已废弃的 v3 写法
 * `{ kind: 'plugin', plugin: ... }`：DSH 会话格式 v4 的 source() 校验要求
 * `source.kind` 为非空字符串且 `!== 'plugin'`，旧写法会让会话采纳消息时抛
 * SessionFormatError("format v4 message requires a producer-owned source kind")，
 * 导致重启后的通知投递（含用户重试）一直失败。
 * 裸插件名作 kind 与本环境同类第三方插件 dsh-rules-auto 一致，
 * 已在 v4 会话日志中验证可正常持久化。
 *
 * @param {object} opts
 * @param {string} opts.text 通知正文（buildNotice 的输出）
 * @param {string} opts.bootAt 本次启动时间（ISO），用于 source.summary
 * @returns {{role: string, content: Array<{type: string, text: string}>, source: {kind: string, form: string, summary: string}, id: string}}
 */
export function createNoticeMessage({ text, bootAt }) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-resume-on-restart',
      form: 'notice',
      summary: `resume-on-restart: DSH restarted at ${bootAt}`,
    },
    id: randomUUID(),
  };
}

// ---- 0.6.0 新增：无用户提示词的会话不自动激活（扫描结果 → 是否投递的判定） ----

/**
 * 把 scanSessionHasHumanPrompt 的扫描结果判定为"是否允许投递"（纯函数，便于单元测试）。
 *
 * 口径（fail-closed：判定不了同样拦截）：
 * 1. `requireHumanPrompt` 为 false → 关闭守卫，完全旧行为 `{ deliver: true }`；
 * 2. `status: 'human'` → 有过真实人工输入，放行 `{ deliver: true }`；
 * 3. `status: 'none'` → 拦截 `{ deliver: false, result: 'skipped-no-human-prompt',
 *    error: 'no human prompt in session' }`；
 * 4. `status: 'unknown'` → 拦截，error 带上扫描失败原因
 *    `human-prompt scan failed: <reason>`（文件缺失/zstd 不支持/扫描异常都不投递）。
 * scan 形状异常按 unknown 兜底（reason 记 unexpected-scan-shape），同样拦截。
 *
 * @param {{status: 'human'}|{status: 'none'}|{status: 'unknown', reason: string}|unknown} scan
 *        scanSessionHasHumanPrompt 的返回值
 * @param {boolean} requireHumanPrompt 守卫开关（config.requireHumanPrompt 归一化后的布尔值）
 * @returns {{deliver: true}|{deliver: false, result: 'skipped-no-human-prompt', error: string}}
 */
export function classifyHumanPromptGuard(scan, requireHumanPrompt) {
  if (requireHumanPrompt === false) return { deliver: true };
  const status = scan !== null && typeof scan === 'object' && !Array.isArray(scan) ? scan.status : undefined;
  if (status === 'human') return { deliver: true };
  if (status === 'none') {
    return { deliver: false, result: 'skipped-no-human-prompt', error: 'no human prompt in session' };
  }
  const reason = status === 'unknown' && typeof scan.reason === 'string' && scan.reason
    ? scan.reason
    : 'unexpected-scan-shape';
  return { deliver: false, result: 'skipped-no-human-prompt', error: `human-prompt scan failed: ${reason}` };
}

// ---- 0.9.0 新增：恢复候选的归档会话过滤（与 DSH ArchivedSessionGate 同口径） ----

/**
 * 归一化 workspaceRegistry.archivedSessionIds 为 Set<string>（纯函数，防御式）：
 * 非数组输入 / 数组内非字符串与空串元素一律忽略；重复 id 自然去重。
 * 任何非法输入都返回空 Set——调用方（filterArchivedCandidates）据此不过滤
 * 任何候选，行为退化为现状（workspaceRegistry 缺失 = 维持现口径）。
 * @param {unknown} raw ctx.workspaceRegistry.archivedSessionIds（readonly SessionId[]）
 * @returns {Set<string>}
 */
export function normalizeArchivedSessionIds(raw) {
  const ids = new Set();
  if (!Array.isArray(raw)) return ids;
  for (const id of raw) {
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

/**
 * 会话是否处于归档 lineage 之下（0.9.0，与 DSH dsh-api-session-controller 的
 * ArchivedSessionGate underArchivedSession 同规则，纯函数版）：
 * 1. 会话自身 id 在归档名单 → true；
 * 2. 否则沿 header 向上走——仅当 `header.origin === 'subagent'` 且
 *    `header.parentSession` 存在时才继续（fork 出的会话是独立会话，
 *    不继承归档），任一祖先命中名单 → true；
 * 3. 祖先会话不在 session store → 直接查该祖先 id 是否在名单后终止
 *    （gate 对缺失父会话的同款处理）；
 * 4. `lookupHeader` 传 null / 非函数（拿不到 session store）→ 只能判第 1 条
 *    （直系名单）。
 * visited 集合防环（与 gate 一致）。本函数不捕获 lookupHeader 的异常：
 * 防御式包裹由宿主（index.js 的 sessionHeaderLookup）负责，detect.js 保持纯函数。
 * @param {unknown} id 会话 id
 * @param {readonly string[]|Set<string>|unknown} archivedIds 归档名单（原样或已归一化）
 * @param {((id: string) => {origin?: unknown, parentSession?: unknown}|null|undefined)|null} lookupHeader
 *        session store 的 header 读取器（缺失传 null）
 * @returns {boolean}
 */
export function sessionUnderArchivedLineage(id, archivedIds, lookupHeader) {
  const archivedSet = archivedIds instanceof Set ? archivedIds : normalizeArchivedSessionIds(archivedIds);
  const startId = typeof id === 'string' ? id : '';
  if (!startId) return false;
  const visited = new Set();
  let currentId = startId;
  while (!visited.has(currentId)) {
    if (archivedSet.has(currentId)) return true;
    visited.add(currentId);
    if (typeof lookupHeader !== 'function') return false;
    const header = lookupHeader(currentId);
    if (header === null || typeof header !== 'object') return false;
    if (header.origin !== 'subagent' || typeof header.parentSession !== 'string' || !header.parentSession) return false;
    currentId = header.parentSession;
  }
  return false;
}

/**
 * 按归档名单过滤恢复候选（0.9.0，纯函数；形状与 filterExcludedCandidates 对齐）：
 * - 候选 id 命中归档名单、或其 subagent lineage 上有归档祖先 → 进 `archived`；
 * - 其余原样进 `kept`，两数组都保持输入相对顺序；
 * - 名单为空（workspaceRegistry 缺失/为空）→ 全部进 kept、零次 header lookup
 *   （现口径，store 也不探测）；
 * - `lookupHeader` 为 null（拿不到 session store）→ 只查直系名单。
 * 非法输入按空处理，绝不抛错。
 * @param {Array<{id: string, at: number}>} candidates pickRestoreTargets 的输出
 * @param {readonly string[]|Set<string>|unknown} archivedIds 归档名单
 * @param {((id: string) => {origin?: unknown, parentSession?: unknown}|null|undefined)|null} lookupHeader
 * @returns {{kept: Array<{id: string, at: number}>, archived: Array<{id: string, at: number}>}}
 */
export function filterArchivedCandidates(candidates, archivedIds, lookupHeader) {
  const list = Array.isArray(candidates) ? candidates : [];
  const archivedSet = archivedIds instanceof Set ? archivedIds : normalizeArchivedSessionIds(archivedIds);
  if (archivedSet.size === 0) return { kept: [...list], archived: [] };
  const kept = [];
  const archived = [];
  for (const candidate of list) {
    const id = candidate && typeof candidate === 'object' ? candidate.id : undefined;
    const hit = typeof id === 'string' && sessionUnderArchivedLineage(id, archivedSet, lookupHeader);
    (hit ? archived : kept).push(candidate);
  }
  return { kept, archived };
}

/**
 * 恢复阶段结束后的回退决策（0.9.0，0.17.0/0.23.0 扩展，纯函数；fallbackWake 的唯一开关）：
 * - 有候选恢复成功（restored）→ 不回退；
 * - 没有任何可恢复候选、且确有候选被归档剔除（archived）或被"正常结束门"跳过
 *   （0.17.0 起，skippedCompleted）→ 不回退（quiet）：全是归档会话 = 用户有意
 *   归档、全是正常收工的会话 = 无需继续——重启后保持安静，不吵主会话；
 *   0.23.0 起确有候选为「注册但不激活」结算（skippedNoActivateCount）→ 同样
 *   不回退（quiet）：故意不激活的重启本就不需要继续，绝不为它们吵醒主会话；
 * - 其余情况 → 回退（无任何候选、全部用户排除、可恢复候选全部失败——既有行为
 *   完全不变）。脏输入保守回退（true）：回退通知是"保证必达"的兜底方向。
 * @param {{restored?: boolean, keptCount?: number, archivedCount?: number,
 *          skippedCompletedCount?: number, skippedNoActivateCount?: number}} input
 * @returns {{fallback: true}|{fallback: false, quiet?: true}}
 */
export function classifyRestoreFallback({ restored, keptCount, archivedCount, skippedCompletedCount, skippedNoActivateCount } = {}) {
  if (restored === true) return { fallback: false };
  const kept = typeof keptCount === 'number' && Number.isFinite(keptCount) ? keptCount : 0;
  const archived = typeof archivedCount === 'number' && Number.isFinite(archivedCount) ? archivedCount : 0;
  // 0.17.0：候选全被"正常结束门"跳过（skipped-completed）时同样安静收尾——
  // 正常收工的会话无需继续，重启后保持安静，不为它们吵主会话
  const skippedCompleted = typeof skippedCompletedCount === 'number' && Number.isFinite(skippedCompletedCount)
    ? skippedCompletedCount
    : 0;
  // 0.23.0：候选全部「注册但不激活」（no-activate）结算时安静收尾——故意不激活
  // 的重启无需继续，与 archived/skippedCompleted 同口径；缺省 0 = 输出与现状一致
  const skippedNoActivate = typeof skippedNoActivateCount === 'number' && Number.isFinite(skippedNoActivateCount)
    ? skippedNoActivateCount
    : 0;
  if (kept <= 0 && (archived > 0 || skippedCompleted > 0 || skippedNoActivate > 0)) return { fallback: false, quiet: true };
  return { fallback: true };
}

// ---- 0.9.1 新增：subagent routing 持有会话的候选处理（经主会话祖先代理恢复） ----

/**
 * 会话 header 是否为 subagent routing 持有的子代理会话（0.9.1，纯函数，防御式）。
 * 与宿主 dsh-api-session-controller 的 hasApiSessionSubagentOwner 冷会话判定同口径：
 * `header.origin === 'subagent'` 即被 subagent routing 持有（其 runtime 归属分支
 * 需要 live agent，开机恢复场景不存在）；sessionController.resolveAgent 对这类
 * 会话一律拒绝（RemoteError `is owned by subagent routing`），不能直接恢复。
 * 非法输入返回 false。
 * @param {unknown} header session.header（sessionHeaderLookup 的返回）
 * @returns {boolean}
 */
export function isSubagentSessionHeader(header) {
  return header !== null && typeof header === 'object' && !Array.isArray(header) && header.origin === 'subagent';
}

/**
 * 沿 header.parentSession 向上找最近的非 subagent 主会话祖先（0.9.1，纯函数）：
 * subagent 会话的工作上下文由其主会话（lead）承载，主会话祖先是它唯一合法的
 * 代理恢复目标。语义：
 * 1. 自身 header 不是 subagent（含 lookup 返回 null，无法判定）→ 返回自身 id
 *    （按可尝试解析处理）；
 * 2. subagent 会话 → 逐级上溯，返回首个非 subagent 的祖先 id；祖先 header 拿不到
 *    （不在 store）也返回该祖先 id（是否可恢复交给 resolveAgent 判定）；
 * 3. parentSession 缺失/非法 → null（找不到可代理的主会话）；
 * 4. lineage 成环 → null（visited 防护，与 ArchivedSessionGate 同款）；
 * 5. lookupHeader 为 null/非函数（store 缺失）→ 返回自身 id。
 * 任何非法输入不抛错。
 * @param {unknown} id 会话 id
 * @param {((id: string) => {origin?: unknown, parentSession?: unknown}|null|undefined)|null} lookupHeader
 * @returns {string|null}
 */
export function mainAncestorSessionId(id, lookupHeader) {
  const startId = typeof id === 'string' ? id : '';
  if (!startId) return null;
  if (typeof lookupHeader !== 'function') return startId;
  const visited = new Set();
  let currentId = startId;
  while (!visited.has(currentId)) {
    visited.add(currentId);
    const header = lookupHeader(currentId);
    if (header === null || typeof header !== 'object') return currentId;
    if (!isSubagentSessionHeader(header)) return currentId;
    const parent = header.parentSession;
    if (typeof parent !== 'string' || !parent) return null;
    currentId = parent;
  }
  return null;
}

/**
 * 把恢复候选拆成"主会话候选"与"subagent routing 持有的候选"（0.9.1，纯函数；
 * 形状与 filterArchivedCandidates 对齐）：
 * - subagent 候选进 `subagent`（条目 `{ candidate, ancestorId }`，ancestorId 为
 *   最近主会话祖先 id，可能为 null——调用方据此决定代理恢复或安静结算）；
 * - 其余原样进 `kept`，两数组都保持输入相对顺序；
 * - `lookupHeader` 为 null/非函数（拿不到 session store）→ 无法识别，全部进 kept
 *   （行为退化 = 现状，由 resolveAgent 的 subagent ownership RemoteError 兜底结算）。
 * 非法输入按空处理，绝不抛错。
 * @param {Array<{id: string, at: number}>} candidates pickRestoreTargets 的输出
 * @param {((id: string) => {origin?: unknown, parentSession?: unknown}|null|undefined)|null} lookupHeader
 * @returns {{kept: Array<{id: string, at: number}>, subagent: Array<{candidate: {id: string, at: number}, ancestorId: string|null}>}}
 */
export function partitionSubagentCandidates(candidates, lookupHeader) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (typeof lookupHeader !== 'function') return { kept: [...list], subagent: [] };
  const kept = [];
  const subagent = [];
  for (const candidate of list) {
    const id = candidate && typeof candidate === 'object' ? candidate.id : undefined;
    const header = typeof id === 'string' ? lookupHeader(id) : null;
    if (isSubagentSessionHeader(header)) {
      subagent.push({ candidate, ancestorId: mainAncestorSessionId(id, lookupHeader) });
    } else {
      kept.push(candidate);
    }
  }
  return { kept, subagent };
}

// ---- 0.15.0 新增：暂停所有会话（pause-all）的候选并集与运行中枚举（纯函数） ----

/**
 * 两个 id 集合的并集去重（0.15.0，纯函数，防御式）：
 * `ids` 顺序在前、`extraIds` 中未出现过的 id 按原顺序缀后；重复 id 只保留首条。
 * 非字符串/空串元素一律丢弃；非数组也非 Set 的输入按空集合处理，绝不抛错。
 * 用于把暂停集合（paused-sessions）并入恢复候选可见口径（GET /state、ws 快照、
 * /restart/info 候选池）。
 * @param {Iterable<string>|unknown} ids 基础 id 集合（数组或 Set）
 * @param {Iterable<string>|unknown} extraIds 追加 id 集合（数组或 Set）
 * @returns {string[]}
 */
export function unionRestoreCandidateIds(ids, extraIds) {
  const listOf = (value) => {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    return [];
  };
  const out = [];
  const seen = new Set();
  for (const list of [listOf(ids), listOf(extraIds)]) {
    for (const id of list) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 把暂停会话条目并入恢复候选（0.15.0，纯函数，防御式）：
 * - `picked` / `pausedEntries` 均为 `{ id, at, running }` 条目数组（at 为 epoch 毫秒，
 *   非法/缺失按 0；pausedEntries 约定 running:false——暂停即已停止）；
 * - 按 id 去重、picked 优先（同 id 只保留 picked 条目的 at/running——内存
 *   recentSessions 的数据比持久化的暂停时刻更新）；
 * - 按 at 新 → 旧排序（at 相同保持原相对顺序，排序稳定）；
 * - `restoreMax > 0`（有限数字）时截断到前 N 条，否则不截断；
 * - 输出为归一化的新对象 `{ id, at, running }`（不改写任何入参条目）；
 *   非数组输入按空处理，缺 id/空串 id 的条目丢弃，绝不抛错。
 * @param {Array<{id: string, at: number, running?: boolean}>|unknown} picked
 *        pickRestoreTargets 的输出
 * @param {Array<{id: string, at: number, running?: boolean}>|unknown} pausedEntries
 *        paused-sessions 的内存条目
 * @param {number} restoreMax 候选数上限（>0 才截断）
 * @returns {Array<{id: string, at: number, running: boolean}>}
 */
export function mergePausedCandidates(picked, pausedEntries, restoreMax) {
  const normalize = (list) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      const at = typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 0
        ? entry.at
        : 0;
      out.push({ id: entry.id, at, running: entry.running === true });
    }
    return out;
  };
  const seen = new Set();
  const merged = [];
  for (const entry of [...normalize(picked), ...normalize(pausedEntries)]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  merged.sort((a, b) => b.at - a.at);
  const limit = typeof restoreMax === 'number' && Number.isFinite(restoreMax) && restoreMax > 0
    ? Math.floor(restoreMax)
    : Infinity;
  return merged.slice(0, limit);
}

/**
 * 从 agent 形状对象数组里挑出「运行中且不被忽略前缀排除」的会话 id（0.15.0，
 * 纯函数，防御式）：条目需为对象且 id 为非空字符串、status === 'running'；
 * id 命中 ignoredPrefixes 任一前缀（非数组按不过滤）的丢弃。
 * 非数组输入返回空数组，脏条目忽略，绝不抛错——pause-all 的枚举口径。
 * @param {Array<{id: string, status: string}>|unknown} list agents.list() 的结果
 * @param {string[]|unknown} ignoredPrefixes config.ignoredSessionPrefixes
 * @returns {string[]}
 */
export function selectRunningAgentIds(list, ignoredPrefixes) {
  if (!Array.isArray(list)) return [];
  const prefixes = Array.isArray(ignoredPrefixes) ? ignoredPrefixes : [];
  const ids = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    if (entry.status !== 'running') continue;
    if (prefixes.some((p) => typeof p === 'string' && entry.id.startsWith(p))) continue;
    ids.push(entry.id);
  }
  return ids;
}

// ---- 0.17.0 新增：正常结束的会话不再自动恢复（恢复候选的最后已知状态门） ----
//
// 背景：0.10.0 口径反转后最近活跃窗口内全部会话（含正常结束的）重启后都恢复，
// 用户明确不要恢复"正常收工"的会话。0.17.0 起恢复候选 = 最近活跃窗口内且
// **最后已知状态不是「正常结束」**：判定主判据用会话日志扫描（lib/session-scan.js
// 的 scanSessionLastTurnState，最后一条真实 turn/end kind === 'completed' 即
// 正常结束），事件内存态会因崩溃丢失，扫描在重启后做、日志已完整，是真源。
// marker.recentSessions 的 lastTurnEndKind 只是记录性字段，过滤绝不依赖它。

/**
 * 把 scanSessionLastTurnState 的扫描结果判定为"是否允许恢复"（纯函数，便于单元测试；
 * 与 classifyHumanPromptGuard 同款的"扫描结果 → 决定"分层）。
 *
 * 口径（保守方向：判定不了一律恢复，避免漏恢复正在干活的会话）：
 * 1. `status: 'completed'` → 最后一条真实 turn/end 正常结束，拦截
 *    `{ restore: false, result: 'skipped-completed', error: null }`；
 * 2. 其余一律放行 `{ restore: true }`——`open-turn`（turn 开着被崩溃/重启打断）、
 *    `ended`（aborted/blocked/error/max-tokens/interrupted/forked 及插件扩展的
 *    未知 variant）、`no-turns`（从未跑过 turn）、`unknown`（文件缺失/zstd 不支持/
 *    扫描异常，维持旧行为）、以及任何畸形输入。
 *
 * @param {{status: 'completed'|'ended'|'open-turn'|'no-turns'|'unknown', kind?: string, reason?: string}|unknown} scan
 *        scanSessionLastTurnState 的返回值
 * @returns {{restore: true}|{restore: false, result: 'skipped-completed', error: null}}
 */
export function classifyCompletedRestoreGate(scan) {
  const status = scan !== null && typeof scan === 'object' && !Array.isArray(scan) ? scan.status : undefined;
  if (status === 'completed') {
    return { restore: false, result: 'skipped-completed', error: null };
  }
  return { restore: true };
}

/**
 * 按"最后已知 turn 状态"过滤恢复候选（0.17.0，纯函数；形状与
 * filterArchivedCandidates 对齐：两数组都保持输入相对顺序、对象引用不变）：
 * - `bypassIds`（0.22.0 第三参，Set/数组，**缺省或空 = 现行为逐字节不变**，
 *   向后兼容）命中的候选**免扫描直接 kept**——主动注册 = 用户显式要求总是恢复，
 *   绕过 0.17.0 正常结束门（提问中的会话 turn 开着本就放行，与该门原语义一致）；
 * - `candidate.running === true`（重启时最后已知仍在运行）→ 免扫描直接 kept——
 *   turn 开着被重启打断，必然不是正常结束（marker 的 running 虽也可能因崩溃
 *   过期，但它只会让候选**多恢复**，不会错误跳过；真正的过滤判据是日志扫描）；
 * - 其余（running:false 及未知）→ `scanLastTurnState(id)` 经
 *   classifyCompletedRestoreGate 判定：completed 进 `skipped`，其余进 `kept`；
 * - 缺 id/空串 id 的条目原样 kept（交给既有流程结算）；
 * - `scanLastTurnState` 非函数（调用方拿不到扫描器）→ 无法判定，全部进 kept
 *   （退化 = 现状）。
 * 非法输入按空处理，绝不抛错。
 * @param {Array<{id: string, at: number, running?: boolean}>|unknown} candidates
 *        恢复候选（mergePausedCandidates / partitionSubagentCandidates 的输出）
 * @param {((id: string) => {status: string, kind?: string, reason?: string})|null} scanLastTurnState
 *        会话最后已知 turn 状态扫描器（scanSessionLastTurnState 或其 memoized 包装）
 * @param {Set<string>|string[]|unknown} [bypassIds] 免扫描直通的候选 id 集合
 *        （0.22.0：主动注册重启恢复的会话；缺省/空 = 维持 0.17.0 现行为）
 * @returns {{kept: Array<object>, skipped: Array<object>}}
 */
export function filterCompletedCandidates(candidates, scanLastTurnState, bypassIds) {
  const list = Array.isArray(candidates) ? candidates : [];
  // bypassIds 归一化：Set 原样；数组只收非空字符串；其余（含缺省）按空集 =
  // 完全不启用 bypass（分支判定带 size > 0，缺省路径与 0.17.x 逐字节一致）
  const bypass = bypassIds instanceof Set
    ? bypassIds
    : (Array.isArray(bypassIds)
      ? new Set(bypassIds.filter((id) => typeof id === 'string' && id))
      : new Set());
  if (typeof scanLastTurnState !== 'function') return { kept: [...list], skipped: [] };
  const kept = [];
  const skipped = [];
  for (const candidate of list) {
    const id = candidate && typeof candidate === 'object' ? candidate.id : undefined;
    // 0.22.0：主动注册（bypassIds 命中）免扫描直接 kept（用户显式要求总是恢复）
    if (bypass.size > 0 && typeof id === 'string' && bypass.has(id)) {
      kept.push(candidate);
      continue;
    }
    if (candidate && typeof candidate === 'object' && candidate.running === true) {
      kept.push(candidate);
      continue;
    }
    if (typeof id !== 'string' || !id) {
      kept.push(candidate);
      continue;
    }
    const verdict = classifyCompletedRestoreGate(scanLastTurnState(id));
    (verdict.restore ? kept : skipped).push(candidate);
  }
  return { kept, skipped };
}
