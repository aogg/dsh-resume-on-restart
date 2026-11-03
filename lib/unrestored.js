/**
 * dsh-resume-on-restart 0.26.0：「上次重启无法恢复」集合（unrestored.json）的纯函数。
 *
 * 背景：0.7.0 起等待 sessionController 就绪超时会整批放弃全部恢复候选
 * （连逐条 restore 结算都没有）。0.26.0 起超时先回退 fallbackWake（旧行为不变），
 * 同时起后台「逐级递增续等」任务——总预算（serviceWaitMaxMs，默认 10 分钟）内
 * 服务就绪则补跑候选循环；续等也到上限才放弃：对每个剩余候选逐条结算
 * `result:'skipped-service-timeout'` 并登记进本 store，供设置弹窗
 * 「上次重启无法恢复」列表展示与手动恢复（POST /unrestored/restore）。
 *
 * 数据持久化在 `<stateDir>/unrestored.json`，格式（数组、新条目在前）：
 *   { sessions: [ { id, at: ISO（登记时刻）, bootAt?: ISO, title?: string,
 *                   workspace?: string, error?: string } ] }
 * 条目各字段含义：
 *   - id        会话 id（必填，非空字符串）
 *   - at        登记时刻（ISO 字符串，必填）
 *   - bootAt    触发登记的那次重启的 bootAt（可选，非空字符串才带）
 *   - title     会话标题（可选，登记时防御式探测，拿不到省略）
 *   - workspace 会话所属工作区完整路径（可选，登记时防御式探测，拿不到省略）
 *   - error     放弃原因（可选，非空字符串才带）
 *
 * 维护规则（宿主 lib/index.js 接线，纯函数在此可单测）：
 *   - cap 100 条、新在前（超出丢最旧 = 数组尾部）；
 *   - 同 id 重复登记 = 原位更新不新增（upsertUnrestored）；
 *   - 恢复成功某会话时移除同 id 条目（removeUnrestoredIds）。
 *
 * 本模块只放可单测的纯函数（读取/写入/归一化/裁剪/upsert/移除），全部防御式：
 * 绝不抛错、best-effort 写盘（失败 console.warn 不炸插件）。风格照
 * lib/proactive-restore.js。单测（test 角色负责）可直接 import 断言。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 「无法恢复」条目上限：超出丢最旧（数组尾部的旧条目）。 */
export const MAX_UNRESTORED = 100;

/**
 * 把任意解析结果归一化为条目数组（新在前）：
 * - 接受 `{ sessions: [...] }`（落盘格式）或直接一个数组（容忍手写文件）；
 * - 条目必须是非空字符串 id + 非空字符串 at（登记时刻）才保留；
 * - bootAt / title / workspace / error 非空字符串才带（「拿到才带」防御风格，
 *   同 proactive-restore 的 title 口径）；
 * - 同 id 保留先出现的条目（调用方保证先出现的更新）；非数组/损坏形状一律 []，
 *   绝不抛错。
 * @param {unknown} raw 任意解析结果（JSON.parse 的输出）
 * @returns {Array<{id: string, at: string, bootAt?: string, title?: string, workspace?: string, error?: string}>}
 */
export function normalizeUnrestored(raw) {
  const list = raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.sessions)
    ? raw.sessions
    : (Array.isArray(raw) ? raw : []);
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    if (typeof entry.at !== 'string' || !entry.at) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const item = { id: entry.id, at: entry.at };
    if (typeof entry.bootAt === 'string' && entry.bootAt) item.bootAt = entry.bootAt;
    if (typeof entry.title === 'string' && entry.title) item.title = entry.title;
    if (typeof entry.workspace === 'string' && entry.workspace) item.workspace = entry.workspace;
    if (typeof entry.error === 'string' && entry.error) item.error = entry.error;
    out.push(item);
  }
  return out;
}

/**
 * 读取「无法恢复」集合（防御式）：文件缺失/损坏/形状不对一律返回 []，
 * 绝不抛错（风格同 readProactiveRestore）；条目经 normalizeUnrestored 归一化。
 * @param {string} file unrestored.json 的绝对路径
 * @returns {Array<{id: string, at: string, bootAt?: string, title?: string, workspace?: string, error?: string}>}
 */
export function readUnrestored(file) {
  try {
    return normalizeUnrestored(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

/**
 * 写入「无法恢复」集合（best-effort）：写失败 console.warn 不炸插件，返回是否
 * 写成功。写入前经 normalizeUnrestored 归一化（丢弃脏条目，绝不写坏数据）；
 * 落盘形状固定为 `{ sessions: [...] }`。
 * @param {string} file unrestored.json 的绝对路径
 * @param {unknown} data 待写入数据（条目数组或 { sessions: [...] } 或任意形状）
 * @returns {boolean} 写盘成功
 */
export function writeUnrestored(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ sessions: normalizeUnrestored(data) }, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn('[resume-on-restart] could not write unrestored.json:', err);
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
 * 按登记时刻裁剪「无法恢复」集合（纯函数）：超出 max 丢最旧（at 旧的先丢、
 * 无法解析按 0 = 最先丢）。返回新数组、不改入参；max 非正/非法 → 不裁剪
 * （原样返回归一化新数组）；数组顺序即展示顺序（新在前）。
 * @param {unknown} data 「无法恢复」集合
 * @param {number} max 上限（MAX_UNRESTORED）
 * @returns {Array<{id: string, at: string, bootAt?: string, title?: string, workspace?: string, error?: string}>}
 */
export function capUnrestored(data, max) {
  const normalized = normalizeUnrestored(data);
  const limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? Math.floor(max) : Infinity;
  if (normalized.length <= limit) return normalized;
  // 稳定排序（at 相等保持原次序），保留最新的前 limit 条（新在前语义不变）
  return [...normalized]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (atMsOf(b.entry.at) - atMsOf(a.entry.at)) || (a.index - b.index))
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * 登记/更新一条「无法恢复」条目（纯函数，upsert）：同 id 已存在 = 原位更新
 * （位置不变、字段整体替换），不存在 = 插入到最前（新在前）。返回新数组、
 * 不改入参；entry 非对象/缺 id 或 at 的非法条目原样返回旧数组。
 * @param {Array<{id: string, at: string, bootAt?: string, title?: string, workspace?: string, error?: string}>|unknown} rows 现有条目数组
 * @param {{id: string, at: string, bootAt?: string, title?: string, workspace?: string, error?: string}|unknown} entry 新条目
 * @returns {Array<object>}
 */
export function upsertUnrestored(rows, entry) {
  const list = Array.isArray(rows) ? rows : [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return list;
  if (typeof entry.id !== 'string' || !entry.id) return list;
  if (typeof entry.at !== 'string' || !entry.at) return list;
  const index = list.findIndex((row) => row !== null && typeof row === 'object' && row.id === entry.id);
  if (index < 0) return [entry, ...list];
  const next = [...list];
  next[index] = entry;
  return next;
}

/**
 * 从「无法恢复」集合移除指定会话（纯函数）：ids 命中的条目剔除、其余原序保留，
 * 返回新数组、不改入参。ids 支持单个字符串或字符串数组；非法输入原样返回。
 * @param {Array<{id: string}>|unknown} rows 现有条目数组
 * @param {string|string[]|unknown} ids 要移除的会话 id
 * @returns {Array<object>}
 */
export function removeUnrestoredIds(rows, ids) {
  const list = Array.isArray(rows) ? rows : [];
  const wanted = typeof ids === 'string' && ids ? [ids] : (Array.isArray(ids) ? ids : []);
  const wantedSet = new Set(wanted.filter((id) => typeof id === 'string' && id));
  if (wantedSet.size === 0) return list;
  return list.filter((row) => !(row !== null && typeof row === 'object' && wantedSet.has(row.id)));
}
