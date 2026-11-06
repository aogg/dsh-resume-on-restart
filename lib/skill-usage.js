/**
 * 0.29.0：技能调用统计（host 侧独立模块，便于 node --test 单测）。
 *
 * 数据流：lib/index.js 监听宿主 tools/result 事件过滤 skill 工具调用 → 逐条
 * 追加写入 `<stateDir>/skill-usage.ndjson`（本模块的写入器）→ GET /skills/catalog
 * /skills/usage 路由读取并用本模块的聚合函数产出统计。
 *
 * 写入器照 lib/index.js 的 restarts.ndjson 写入器（0.5.0）同款模式与容错口径：
 * 热路径 appendFileSync 一行一条 JSON；条数超上限时整文件重写为最近 max 条
 * （重写顺带剔除损坏行）；任何写失败只 console.warn——统计缺失绝不影响
 * 工具调用与恢复流程本身。
 *
 * 条目形状：`{ at, skill, sessionId, sessionTitle?, workspacePath?, cwd, ok }`
 * （at=ISO 时刻，skill=技能名，sessionId=发起会话 id，sessionTitle=会话标题
 * （投影拿到才带），workspacePath=工作区 canonical 路径（resolveByPath 拿到
 * 才带），cwd=会话工作目录，ok=调用是否成功）。
 *
 * 聚合形状（aggregateSkillUsage 返回）：
 * ```
 * {
 *   total,                     // 有效条目总数
 *   firstAt, lastAt,           // 最早/最近一次调用时刻（ISO；无有效时刻为 null）
 *   skills: {
 *     [name]: {
 *       count, okCount, lastAt,
 *       byWorkspace: { [path]: count },                  // 按工作区次数（空路径不计）
 *       bySession: [{ id, title?, count, lastAt }],      // 按次数降序取前 10
 *       daily7: [{ date, count }],                       // 最近 7 天（UTC 日期，旧→新，含空槽）
 *     },
 *   },
 * }
 * ```
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compactNdjson, parseNdjson } from './detect.js';

/** skill-usage.ndjson 条数上限：超出丢最旧（整文件重写顺带剔除损坏行）。 */
export const MAX_SKILL_USAGE_ENTRIES = 1000;

/** GET /skills/usage 返回的尾部条数上限。 */
export const SKILL_USAGE_TAIL = 200;

/** bySession 聚合保留的会话数（按次数降序取前 10）。 */
export const SKILL_USAGE_BY_SESSION_LIMIT = 10;

/** daily7 聚合窗口天数（含今天，旧 → 新）。 */
export const SKILL_USAGE_DAILY_WINDOW = 7;

/** 一天的毫秒数（daily7 日期槽推算用）。 */
const DAY_MS = 86_400_000;

/** 技能调用统计文件路径：`<stateDir>/skill-usage.ndjson`。 */
export function skillUsagePathOf(markerDir) {
  return join(markerDir, 'skill-usage.ndjson');
}

/**
 * 创建 skill-usage.ndjson 追加写入器：热路径 appendFileSync，一行一条 JSON；
 * 条数超上限时整文件重写为最近 max 条（重写顺带剔除损坏行）。
 * 返回 `(entry) => void`；写失败只告警——统计缺失绝不影响调用方流程。
 */
export function createSkillUsageWriter(file, max = MAX_SKILL_USAGE_ENTRIES) {
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
      console.warn('[resume-on-restart] could not append skill-usage.ndjson:', e);
    }
  };
}

/** 读取 skill-usage.ndjson 全部条目（跳过损坏行；文件尚不存在 = 空数组属预期）。 */
export function readSkillUsage(file) {
  try {
    return parseNdjson(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn('[resume-on-restart] could not read skill-usage.ndjson:', e);
    return [];
  }
}

/**
 * 防御式取条目的 ISO 时刻：at 非空字符串且可解析为有限时间才返回毫秒值，
 * 否则 NaN（调用方按「无有效时刻」跳过 min/max 与 daily7 归槽）。
 */
function entryAtMs(entry) {
  const at = typeof entry.at === 'string' ? entry.at : '';
  if (!at) return NaN;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 聚合全部条目 → 统计对象（形状见文件头注释）。
 * 防御式：非对象条目、缺 skill 名的条目直接跳过；at 不可解析的条目计入
 * count/okCount/byWorkspace/bySession 但不参与时间维度（firstAt/lastAt/daily7）。
 * @param {unknown[]} entries readSkillUsage 读出的条目数组（容忍任意脏输入）
 * @param {Date} [now] 「今天」锚（daily7 窗口用；默认当前时刻，单测传固定值）
 */
export function aggregateSkillUsage(entries, now = new Date()) {
  const list = Array.isArray(entries) ? entries : [];
  // 最近 7 天日期槽（UTC 日期字符串 YYYY-MM-DD，旧 → 新，含 today；固定 7 槽，
  // 无调用的日期 count=0，客户端直接逐槽展示无需补齐）
  const anchorMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = [];
  for (let i = SKILL_USAGE_DAILY_WINDOW - 1; i >= 0; i -= 1) {
    days.push(new Date(anchorMs - i * DAY_MS).toISOString().slice(0, 10));
  }

  let total = 0;
  let firstAt = null;
  let lastAt = null;
  const skills = new Map();

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const skill = typeof entry.skill === 'string' ? entry.skill.trim() : '';
    if (!skill) continue;
    total += 1;
    const atMs = entryAtMs(entry);
    const at = Number.isFinite(atMs) ? entry.at : null;
    if (Number.isFinite(atMs)) {
      if (firstAt === null || atMs < Date.parse(firstAt)) firstAt = entry.at;
      if (lastAt === null || atMs > Date.parse(lastAt)) lastAt = entry.at;
    }

    let bucket = skills.get(skill);
    if (bucket === undefined) {
      bucket = {
        count: 0,
        okCount: 0,
        lastAt: null,
        byWorkspace: {},
        bySession: [],
        daily7: days.map((date) => ({ date, count: 0 })),
      };
      skills.set(skill, bucket);
    }
    bucket.count += 1;
    if (entry.ok === true) bucket.okCount += 1;
    if (Number.isFinite(atMs) && (bucket.lastAt === null || atMs > Date.parse(bucket.lastAt))) {
      bucket.lastAt = entry.at;
    }

    // 按工作区：workspacePath 非空字符串才计入（拿不到工作区的条目不留空 key）
    const workspacePath = typeof entry.workspacePath === 'string' && entry.workspacePath
      ? entry.workspacePath
      : '';
    if (workspacePath) {
      bucket.byWorkspace[workspacePath] = (bucket.byWorkspace[workspacePath] ?? 0) + 1;
    }

    // 按会话：sessionId 非空才计入（同 id 累加并保留最新时刻；标题取首次出现时的值，
    // 会话改名以首见标题为准——统计口径只求展示用，不做投影回填）
    const sessionId = typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : '';
    if (sessionId) {
      const found = bucket.bySession.find((row) => row.id === sessionId);
      if (found !== undefined) {
        found.count += 1;
        if (Number.isFinite(atMs) && (found.lastAt === null || atMs > Date.parse(found.lastAt))) {
          found.lastAt = entry.at;
        }
      } else {
        const row = { id: sessionId, count: 1, lastAt: Number.isFinite(atMs) ? entry.at : null };
        if (typeof entry.sessionTitle === 'string' && entry.sessionTitle) row.title = entry.sessionTitle;
        bucket.bySession.push(row);
      }
    }

    // 最近 7 天：按 UTC 日期归槽；窗口外的旧条目自然落不进任何槽
    if (Number.isFinite(atMs)) {
      const date = new Date(atMs).toISOString().slice(0, 10);
      const slot = bucket.daily7.find((day) => day.date === date);
      if (slot !== undefined) slot.count += 1;
    }
  }

  // bySession 收尾：按次数降序（平手按最近调用新在前），取前 10
  for (const bucket of skills.values()) {
    bucket.bySession.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const la = Date.parse(a.lastAt ?? '') || 0;
      const lb = Date.parse(b.lastAt ?? '') || 0;
      return lb - la;
    });
    bucket.bySession = bucket.bySession.slice(0, SKILL_USAGE_BY_SESSION_LIMIT);
  }

  return {
    total,
    firstAt,
    lastAt,
    skills: Object.fromEntries(skills),
  };
}
