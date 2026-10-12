import { randomUUID } from 'node:crypto';

/**
 * 重启检测与消息构建的纯函数（无 ctx/agent 依赖，便于单元测试）。
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
 * 1. 候选来源：`marker.recentSessions`（`[{id, at}]`，约定最新在前）。
 *    有效条目：`{id}` 为非空字符串的对象，`at` 经 normalizeActiveAt 归一化；
 *    纯字符串条目兼容为 `{id, at: 0}`；其余条目忽略。
 * 2. recentSessions 产出至少一个候选时，只使用它（不与旧字段混用）；
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
  if (Array.isArray(marker.recentSessions)) {
    for (const entry of marker.recentSessions) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
        candidates.push({ id: entry.id, at: normalizeActiveAt(entry.at) });
      } else if (typeof entry === 'string' && entry) {
        candidates.push({ id: entry, at: 0 });
      }
    }
  }
  if (candidates.length === 0 && typeof marker.lastSessionId === 'string' && marker.lastSessionId) {
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

/**
 * 构建信息性提示文本（由 agent 自主决定下一步）。
 * 命中自动恢复时传入 restoredSessionId/restoredActiveAt，输出恢复说明；
 * 旧调用不传时文案不变。
 * @param {object} opts
 * @returns {string}
 */
export function buildNotice({
  bootAt,
  prevBootAt,
  downtimeMs,
  lastSessionId,
  lastActiveAt,
  customNotice,
  restoredSessionId,
  restoredActiveAt,
}) {
  const lines = [];
  lines.push(`[resume-on-restart] 检测到 DSH 服务已重启。`);
  if (prevBootAt) {
    lines.push(`上次运行于 ${prevBootAt}，本次于 ${bootAt} 重启完成。`);
  } else {
    lines.push(`本次于 ${bootAt} 启动。`);
  }
  if (downtimeMs > 0) {
    lines.push(`中断约 ${humanizeDowntime(downtimeMs)}。`);
  }
  if (lastSessionId) {
    lines.push(`重启前最近活跃的会话：${lastSessionId}`);
    if (lastActiveAt) lines.push(`该会话最后活跃于 ${lastActiveAt}。`);
  }
  if (restoredSessionId) {
    lines.push(restoredActiveAt
      ? `已自动恢复重启前活跃的会话 ${restoredSessionId}（最后活跃于 ${restoredActiveAt}）。`
      : `已自动恢复重启前活跃的会话 ${restoredSessionId}。`);
  }
  if (customNotice) {
    lines.push(String(customNotice));
  }
  lines.push(`如需继续之前的工作，或启动新任务，请自主决定下一步。`);
  return lines.join('\n');
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
