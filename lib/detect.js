/**
 * 重启检测与消息构建的纯函数（无 ctx/agent 依赖，便于单元测试）。
 */

/**
 * 从 marker 判断是否发生了重启。
 * @param {object|null} marker 上次写入的 marker（含 lastBootAt/pid）
 * @param {number} nowMs 当前时间戳
 * @param {number} pid 当前进程 pid
 * @returns {{wasRestart: boolean, downtimeMs: number}}
 */
export function detectRestart(marker, nowMs, pid) {
  if (!marker || typeof marker.lastBootAt !== 'string' || typeof marker.pid !== 'number') {
    return { wasRestart: false, downtimeMs: 0 };
  }
  // pid 相同 = 同一进程（不是重启）；pid 不同 = 发生了重启
  if (marker.pid === pid) return { wasRestart: false, downtimeMs: 0 };
  const prev = Date.parse(marker.lastBootAt);
  const downtimeMs = Number.isFinite(prev) && prev > 0 ? Math.max(0, nowMs - prev) : 0;
  return { wasRestart: true, downtimeMs };
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
    const sec = Math.max(1, Math.round(downtimeMs / 1000));
    lines.push(`中断约 ${sec} 秒。`);
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
