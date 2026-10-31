/**
 * dsh-resume-on-restart 0.22.0：注册后守门自动重启（pending-auto-restart.json）的纯函数。
 *
 * `register_restart_recovery` 模型工具 action=add 登记成功后，插件武装一次
 * 「所有会话完成后自动触发 DSH 重启」的守门器：所有会话都不在 running
 * （正在向用户提问等待回答的会话也算完成）即排定一次重启，重启后武装文件被
 * 开机一次性消费（防重启死循环），会话恢复交给既有开机恢复流程。武装状态
 * 持久化在 `<stateDir>/pending-auto-restart.json`，格式：
 *   { schemaVersion: 1, armedAt: ISO 字符串（最早武装时刻）, by: sessionId（最新注册者） }
 *
 * 本模块只放可单测的纯函数（归一化/读取/写入/幂等合并/完成判定），全部防御式：
 * 绝不抛错、best-effort 写盘（失败 console.warn 返回 false，风格同
 * lib/proactive-restore.js：绝不抛、损坏当缺失）。宿主半边（lib/index.js）在
 * 工具 execute 里武装/解除，在运行期守门器里消费 classifyAutoRestartGate 的
 * 判定结果；单测直接 import 断言。
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 武装文件的 schema 版本（形状不兼容时升版；旧版文件按非法 = 未武装处理）。 */
export const AUTO_RESTART_SCHEMA_VERSION = 1;

/**
 * 把任意解析结果归一化为武装状态：非对象 / schemaVersion !== 1 / armedAt 或 by
 * 不是非空字符串 → null（非法 = 未武装）。绝不抛错。
 * @param {unknown} raw JSON.parse 的输出（任意形状）
 * @returns {{schemaVersion: number, armedAt: string, by: string}|null}
 */
export function normalizeAutoRestartArm(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.schemaVersion !== AUTO_RESTART_SCHEMA_VERSION) return null;
  if (typeof raw.armedAt !== 'string' || !raw.armedAt) return null;
  if (typeof raw.by !== 'string' || !raw.by) return null;
  return { schemaVersion: AUTO_RESTART_SCHEMA_VERSION, armedAt: raw.armedAt, by: raw.by };
}

/**
 * 读取武装状态（防御式）：文件缺失/损坏/形状不对一律返回 null（= 未武装），
 * 绝不抛错（风格同 readProactiveRestore / readExclusions）。
 * @param {string} file pending-auto-restart.json 的绝对路径
 * @returns {{schemaVersion: number, armedAt: string, by: string}|null}
 */
export function readAutoRestartArm(file) {
  try {
    return normalizeAutoRestartArm(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * 写入武装状态（best-effort）：写失败 console.warn 返回 false，绝不炸插件；
 * state 非法同样返回 false（先经 normalizeAutoRestartArm 归一化，绝不写坏数据）。
 * @param {string} file pending-auto-restart.json 的绝对路径
 * @param {unknown} state 待写入的武装状态
 * @returns {boolean} 写盘成功
 */
export function writeAutoRestartArm(file, state) {
  const normalized = normalizeAutoRestartArm(state);
  if (!normalized) {
    console.warn('[resume-on-restart] could not write pending-auto-restart.json: invalid arm state');
    return false;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn('[resume-on-restart] could not write pending-auto-restart.json:', err);
    return false;
  }
}

/**
 * 删除武装文件（开机一次性消费 / 工具 remove 解除武装）：ENOENT（本来就没武装）
 * 静默按成功；其余失败 console.warn 返回 false。返回是否已确保文件不存在。
 * @param {string} file pending-auto-restart.json 的绝对路径
 * @returns {boolean}
 */
export function removeAutoRestartArm(file) {
  try {
    unlinkSync(file);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    console.warn('[resume-on-restart] could not remove pending-auto-restart.json:', err);
    return false;
  }
}

/**
 * 武装幂等合并（纯函数）：已武装时保留**最早** armedAt（多次注册不把时刻越推越
 * 晚，开机归因永远指向第一次决定）、by 更新为**最新注册者**（排障时看最后是谁
 * 续的武装）。入参先各自过 normalizeAutoRestartArm：
 * existing 非法 → next（首次武装）；next 非法 → existing；两者都非法 → null。
 * 不改写任何入参。
 * @param {unknown} existing 文件里的现存武装状态（可能为 null）
 * @param {unknown} next 本次要写入的武装状态
 * @returns {{schemaVersion: number, armedAt: string, by: string}|null}
 */
export function mergeAutoRestartArm(existing, next) {
  const prev = normalizeAutoRestartArm(existing);
  const nextArm = normalizeAutoRestartArm(next);
  if (!prev) return nextArm;
  if (!nextArm) return prev;
  // 最早 armedAt：解析失败的 ISO 视为 +Infinity（让位给可解析的一方；都解析
  // 失败则保留 prev 原文，不臆造时刻）
  const msOf = (iso) => {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  const armedAt = msOf(prev.armedAt) <= msOf(nextArm.armedAt) ? prev.armedAt : nextArm.armedAt;
  return { schemaVersion: AUTO_RESTART_SCHEMA_VERSION, armedAt, by: nextArm.by };
}

/**
 * 自动重启的「全部会话完成」判定（纯函数，守门器每次评估的收口）：
 * - `runningEntries` 为空（没有会话在 running）→ `{ done: true }`；
 * - running 条目**全部**命中 `pendingQuestionIds`（正在向用户提问等待回答——
 *   提问中亦算完成）→ `{ done: true }`；
 * - 否则 → `{ done: false, running: [未命中的 id] }`（还有会话在干活，继续等）。
 * `runningEntries` 元素兼容 id 字符串与 `{ id }` 对象条目（脏条目丢弃）；
 * `pendingQuestionIds` 接受 Set 或数组（非字符串/空串元素忽略）；非数组输入按空
 * 处理；绝不抛错。
 * @param {Array<string|{id?: unknown}>|unknown} runningEntries 运行中会话条目
 *        （selectRunningAgentIds 的输出）
 * @param {Set<string>|string[]|unknown} pendingQuestionIds 提问中会话 id 集合
 * @returns {{done: true}|{done: false, running: string[]}}
 */
export function classifyAutoRestartGate(runningEntries, pendingQuestionIds) {
  const idOf = (entry) =>
    (typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? entry.id : undefined);
  const running = [];
  if (Array.isArray(runningEntries)) {
    for (const entry of runningEntries) {
      const id = idOf(entry);
      if (typeof id === 'string' && id) running.push(id);
    }
  }
  const asking = new Set();
  if (Array.isArray(pendingQuestionIds)) {
    for (const id of pendingQuestionIds) {
      if (typeof id === 'string' && id) asking.add(id);
    }
  } else if (pendingQuestionIds instanceof Set) {
    for (const id of pendingQuestionIds) {
      if (typeof id === 'string' && id) asking.add(id);
    }
  }
  if (running.length === 0) return { done: true };
  const blocked = running.filter((id) => !asking.has(id));
  if (blocked.length === 0) return { done: true };
  return { done: false, running: blocked };
}
