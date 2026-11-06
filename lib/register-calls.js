/**
 * 0.31.0：登记调用留痕与重启周期统计（host 侧独立模块，便于 node --test 单测）。
 *
 * 问题：设置弹窗「重启日志」的 boot 记录原本只含 downtimeMs（上次 boot 到本次
 * boot 的间隔，含正常运行时间），用户把它读成「停机 2h 46m」；也无法回答
 * 「本周期第一次登记是什么时候 / 登记了几次 / 重启耗时多久」。
 *
 * 数据流：lib/index.js 的 register_restart_recovery 工具 handler 在
 * **action=add 成功**时逐条追加 `<stateDir>/register-calls.ndjson`
 * （本模块写入器）→ 下次开机写 boot 记录时用 cycleRegistrations 统计
 * 「上次 boot → 本次重启发起时刻」这一周期内的登记调用，把
 * registrationFirstAt / registrationFirstSessionId / registrationCount /
 * restartMs 落进 boot 条目 → GET /restarts 原样下发（新字段自然带出，
 * 旧条目形状不变，历史条目没有这些字段时前端显示「—」）。
 *
 * 写入器照 restarts.ndjson / skill-usage.ndjson 的写入器同款模式与容错口径：
 * 热路径 appendFileSync 一行一条 JSON；条数超上限时整文件重写为最近 max 条
 * （重写顺带剔除损坏行）；任何写失败只 console.warn——留痕缺失绝不影响登记
 * 与自动重启流程本身。
 *
 * 条目形状：`{ at, sessionId, activate? }`（at=登记成功时刻 ISO；
 * sessionId=发起登记的会话 id；activate 仅在注册但不激活（false）时写入）。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compactNdjson, parseNdjson } from './detect.js';

/** register-calls.ndjson 条数上限：超出丢最旧（整文件重写顺带剔除损坏行）。 */
export const MAX_REGISTER_CALL_ENTRIES = 200;

/** 登记调用留痕文件路径：`<stateDir>/register-calls.ndjson`。 */
export function registerCallsPathOf(markerDir) {
  return join(markerDir, 'register-calls.ndjson');
}

/**
 * 创建 register-calls.ndjson 追加写入器：热路径 appendFileSync，一行一条 JSON；
 * 条数超上限时整文件重写为最近 max 条（重写顺带剔除损坏行）。
 * 返回 `(entry) => void`；写失败只告警——留痕缺失绝不影响登记结果。
 */
export function createRegisterCallWriter(file, max = MAX_REGISTER_CALL_ENTRIES) {
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
      console.warn('[resume-on-restart] could not append register-calls.ndjson:', e);
    }
  };
}

/** 读取 register-calls.ndjson 全部条目（跳过损坏行；文件尚不存在 = 空数组属预期）。 */
export function readRegisterCalls(file) {
  try {
    return parseNdjson(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn('[resume-on-restart] could not read register-calls.ndjson:', e);
    return [];
  }
}

/** ISO 时刻 → epoch 毫秒；缺失/非字符串/不可解析 → NaN（调用方按「无边界」处理）。 */
function parseAtMs(value) {
  if (typeof value !== 'string' || value === '') return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 统计「本重启周期」内的登记调用（纯函数，防御式）：
 * 周期窗口 = `[prevBootAt, requestedAt]`（**两端闭区间**）——
 * `prevBootAt` = 上次启动时刻（上次 boot 记录/marker），
 * `requestedAt` = 本次重启的发起时刻（boot.origin.requestedAt）。
 * 边界不可解析时按「该侧无边界」处理（左：-Infinity，右：+Infinity），
 * 这样 crash 等没有 origin 的周期仍能统计「自上次启动以来的登记次数」。
 *
 * 脏输入口径：非对象/数组条目、at 缺失或不可解析的条目一律跳过（不计次数）。
 * 同一毫秒多条时取遍历顺序里的第一条（写入顺序即调用顺序）。
 *
 * @param {unknown} records readRegisterCalls 的输出（容忍任意脏输入）
 * @param {{prevBootAt?: unknown, requestedAt?: unknown}} [window]
 * @returns {{registrationCount: number, registrationFirstAt: string|null,
 *   registrationFirstSessionId: string|null}} 周期内登记次数与首条登记信息
 *   （无匹配条目时 firstAt/FirstSessionId 为 null、count 为 0）
 */
export function cycleRegistrations(records, window = {}) {
  const list = Array.isArray(records) ? records : [];
  const lowerRaw = parseAtMs(window?.prevBootAt);
  const upperRaw = parseAtMs(window?.requestedAt);
  const lowerMs = Number.isFinite(lowerRaw) ? lowerRaw : -Infinity;
  const upperMs = Number.isFinite(upperRaw) ? upperRaw : Infinity;

  let registrationCount = 0;
  let firstMs = Infinity;
  let firstAt = null;
  let firstSessionId = null;
  for (const record of list) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const at = typeof record.at === 'string' ? record.at : '';
    const atMs = parseAtMs(at);
    if (!Number.isFinite(atMs)) continue;
    if (atMs < lowerMs || atMs > upperMs) continue;
    registrationCount += 1;
    if (atMs < firstMs) {
      firstMs = atMs;
      firstAt = at;
      firstSessionId = typeof record.sessionId === 'string' && record.sessionId
        ? record.sessionId
        : null;
    }
  }
  return {
    registrationCount,
    registrationFirstAt: firstAt,
    registrationFirstSessionId: firstSessionId,
  };
}
