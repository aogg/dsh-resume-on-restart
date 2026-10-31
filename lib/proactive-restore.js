/**
 * dsh-resume-on-restart 0.19.0：主动注册重启恢复（proactive-restore.json）的纯函数。
 *
 * 会话经 `register_restart_recovery` 模型工具（技能正文指导模型调用）主动登记
 * 「重启后自动恢复」资格：即使会话后来不再活跃、甚至结束后，下一次 DSH 重启
 * 仍会恢复它。数据持久化在
 * `<stateDir>/proactive-restore.json`，格式：
 *   { [sessionId]: { at: ISO 字符串（注册时间）, title?: string } }
 *
 * 本模块只放可单测的纯函数（读取/写入/裁剪/候选池合并），全部防御式：
 * 绝不抛错、best-effort 写盘（失败 console.warn 不炸插件）。宿主半边
 * （lib/index.js）在 apply 里读入内存 Map、变更时写回；单测
 * （lib/proactive-restore.test.js）直接 import 断言。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 主动注册条目上限：超出丢最旧（按注册时间 at）。 */
export const MAX_PROACTIVE_RESTORE = 100;

/**
 * 把任意解析结果归一化为 `{ [sessionId]: { at: string, title?: string } }`：
 * 非对象按空对象；id 非空字符串、entry 为对象、at 非空字符串才保留；
 * title 非空字符串才带（与排除/暂停集合的「拿到才带」同款防御风格）；
 * 绝不抛错。
 * @param {unknown} raw 任意解析结果（JSON.parse 的输出）
 * @returns {Record<string, {at: string, title?: string}>}
 */
export function normalizeProactiveRestore(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof id !== 'string' || !id) continue;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.at !== 'string' || !entry.at) continue;
    const item = { at: entry.at };
    if (typeof entry.title === 'string' && entry.title) item.title = entry.title;
    out[id] = item;
  }
  return out;
}

/**
 * 读取主动注册集合（0.19.0，防御式）：文件缺失/损坏/形状不对一律返回 {}，
 * 绝不抛错（风格同 readExclusions / readPausedSessions）。
 * @param {string} file proactive-restore.json 的绝对路径
 * @returns {Record<string, {at: string, title?: string}>}
 */
export function readProactiveRestore(file) {
  try {
    return normalizeProactiveRestore(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/**
 * 写入主动注册集合（0.19.0，best-effort）：写失败 console.warn 不炸插件，
 * 返回是否写成功（调用方可据此决定是否回滚内存态）。写入前经
 * normalizeProactiveRestore 归一化（丢弃脏条目，绝不写坏数据）。
 * @param {string} file proactive-restore.json 的绝对路径
 * @param {unknown} data 待写入数据（Record<id, {at, title?}> 或任意形状）
 * @returns {boolean} 写盘成功
 */
export function writeProactiveRestore(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(normalizeProactiveRestore(data), null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn('[resume-on-restart] could not write proactive-restore.json:', err);
    return false;
  }
}

/** 解析 ISO at 为 epoch 毫秒（非法/缺失按 0）。 */
function atMsOf(at) {
  if (typeof at !== 'string' || !at) return 0;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 按注册时间裁剪主动注册集合（0.19.0，纯函数）：超出 max 丢最旧（按 at 升序
 * 剔除；at 无法解析按 0 = 最早先丢）。返回新对象、不改入参；
 * max 非正/非法 → 不裁剪（原样返回归一化新对象）。
 * @param {unknown} data 主动注册集合
 * @param {number} max 上限（MAX_PROACTIVE_RESTORE）
 * @returns {Record<string, {at: string, title?: string}>}
 */
export function capProactiveRestore(data, max) {
  const normalized = normalizeProactiveRestore(data);
  const limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
  if (Object.keys(normalized).length <= limit) return normalized;
  const entries = Object.entries(normalized).sort((a, b) => atMsOf(a[1].at) - atMsOf(b[1].at));
  const out = {};
  for (const [id, entry] of entries.slice(entries.length - limit)) out[id] = entry;
  return out;
}

/**
 * 合并 /restart/info 候选池（0.19.0，纯函数，防御式）：
 * 候选池 = 自动候选（visibleRestoreCandidateIds，at=0 占位，真实 at 由调用方
 * 回查 recentSessions / pausedSessions）∪ 主动注册候选（at = 注册时间）。
 * - **自动候选维持现状**：全部保留、原顺序在前（visibleRestoreCandidateIds
 *   不过滤用户排除——客户端经 mergePendingRows 把被排除会话显示为已取消）；
 * - **主动注册优先去重**：同 id 只保留主动注册条目（source='skill'、at=注册时间，
 *   位置不动——该会话已作为自动候选出现，只换身份）；仅主动注册的会话追加在
 *   自动候选之后（「主动注册会话总是出现在候选里」）；
 * - 主动注册候选命中用户排除（excludedIds）→ 丢弃主动注册身份（「除非被用户
 *   排除」；该会话若同时是自动候选，仍以自动候选身份出现——用户排除经客户端
 *   显示为已取消）；
 * - 输出归一化 `{ id, at, source }`（at epoch 毫秒，source ∈ 'skill' | 'auto'）；
 * - 非数组输入按空处理，脏条目丢弃，绝不抛错。
 * @param {Array<{id: string, at?: number}>|unknown} autoCandidates
 *        自动候选（visibleRestoreCandidateIds 的输出）
 * @param {Array<{id: string, at?: number}>|unknown} proactiveCandidates
 *        主动注册候选（proactiveRestore 的内存条目）
 * @param {Record<string, unknown>|string[]|unknown} excludedIds
 *        用户排除集合（readExclusions 的返回 Record，或 id 数组）
 * @returns {Array<{id: string, at: number, source: 'skill'|'auto'}>}
 */
export function mergeProactiveCandidatePool(autoCandidates, proactiveCandidates, excludedIds) {
  const normalize = (list, source) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      const at = typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 0 ? entry.at : 0;
      out.push({ id: entry.id, at, source });
    }
    return out;
  };
  const excluded = new Set();
  if (Array.isArray(excludedIds)) {
    for (const id of excludedIds) if (typeof id === 'string' && id) excluded.add(id);
  } else if (excludedIds && typeof excludedIds === 'object') {
    for (const id of Object.keys(excludedIds)) if (typeof id === 'string' && id) excluded.add(id);
  }
  // 主动注册候选：命中排除丢弃；其余保留（去重时优先）
  const proactiveById = new Map();
  for (const entry of normalize(proactiveCandidates, 'skill')) {
    if (excluded.has(entry.id)) continue; // 用户排除 → 丢弃主动注册身份
    proactiveById.set(entry.id, entry);
  }
  const byId = new Map();
  const order = [];
  // 自动候选在前、原顺序（维持现状）
  for (const entry of normalize(autoCandidates, 'auto')) {
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    order.push(entry.id);
  }
  // 主动注册优先去重：同 id 覆盖为主动注册条目（source/at 用主动注册的，位置不动）；
  // 仅主动注册的会话追加在自动候选之后（总是出现）
  for (const [id, entry] of proactiveById) {
    if (byId.has(id)) {
      byId.set(id, entry);
    } else {
      byId.set(id, entry);
      order.push(id);
    }
  }
  return order.map((id) => byId.get(id));
}

/**
 * 把主动注册会话并入恢复候选池（0.19.0，纯函数；mergePausedCandidates 的
 * 三列表扩展）：
 * - `picked`（recentSessions）/ `pausedEntries`（暂停集合）/ `proactiveEntries`
 *   （主动注册集合）均为 `{ id, at, running }` 条目数组（at epoch 毫秒，非法按 0）；
 * - 按 id 去重、优先级 picked > paused > proactive（同 id 保留最先出现的条目——
 *   recentSessions 的真实 at 优先、暂停时刻次之、注册时间最后；满足「主动注册会话
 *   如果被暂停集合覆盖，用暂停集合的 at」与「不在 recentSessions 的主动注册会话
 *   才需要并入」）；
 * - 按 at 新 → 旧排序（at 相同保持原相对顺序，排序稳定）；
 * - `restoreMax > 0`（有限数字）时截断到前 N 条；**主动注册条目不受截断**——
 *   「主动注册会话总是恢复」：恢复预算只作用于自动/暂停候选（与
 *   mergePausedCandidates 口径完全一致），主动注册条目在预算之外追加、
 *   绝不因预算被截掉；否则不截断；
 * - 输出归一化新对象 `{ id, at, running }`（不改写任何入参条目）；
 *   非数组输入按空处理，缺 id/空串 id 的条目丢弃，绝不抛错。
 * @param {Array<{id: string, at: number, running?: boolean}>|unknown} picked
 *        pickRestoreTargets 的输出
 * @param {Array<{id: string, at: number, running?: boolean}>|unknown} pausedEntries
 *        paused-sessions 的内存条目
 * @param {Array<{id: string, at: number, running?: boolean}>|unknown} proactiveEntries
 *        proactive-restore 的内存条目
 * @param {number} restoreMax 候选数上限（>0 才截断自动/暂停条目；主动注册豁免）
 * @returns {Array<{id: string, at: number, running: boolean}>}
 */
export function mergeProactiveRestoreCandidates(picked, pausedEntries, proactiveEntries, restoreMax) {
  const normalize = (list) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      const at = typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 0 ? entry.at : 0;
      out.push({ id: entry.id, at, running: entry.running === true });
    }
    return out;
  };
  const pickedN = normalize(picked);
  const pausedN = normalize(pausedEntries);
  const proactiveN = normalize(proactiveEntries);
  const byId = new Map();
  const order = [];
  for (const list of [pickedN, pausedN, proactiveN]) {
    for (const entry of list) {
      if (byId.has(entry.id)) continue;
      byId.set(entry.id, entry);
      order.push(entry.id);
    }
  }
  const merged = order.map((id) => byId.get(id));
  merged.sort((a, b) => b.at - a.at);
  const limit = typeof restoreMax === 'number' && Number.isFinite(restoreMax) && restoreMax > 0
    ? Math.floor(restoreMax)
    : Infinity;
  if (!Number.isFinite(limit) || merged.length <= limit) return merged;
  // 主动注册条目不受 restoreMax 截断（总是恢复）：预算只截自动/暂停条目（与
  // mergePausedCandidates 口径一致），主动注册条目在预算之外全量保留
  const proactiveIds = new Set(proactiveN.map((entry) => entry.id));
  const autoBudgetIds = new Set(
    merged.filter((entry) => !proactiveIds.has(entry.id)).slice(0, limit).map((entry) => entry.id),
  );
  return merged.filter((entry) => proactiveIds.has(entry.id) || autoBudgetIds.has(entry.id));
}
