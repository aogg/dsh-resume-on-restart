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
 * 构建信息性提示文本（由 agent 自主决定下一步）。
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
  if (customNotice) {
    lines.push(String(customNotice));
  }
  lines.push(`如需继续之前的工作，或启动新任务，请自主决定下一步。`);
  return lines.join('\n');
}
