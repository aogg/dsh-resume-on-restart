/**
 * dsh-resume-on-restart 0.36.0：会话顶栏「重启时恢复」开关的状态机纯函数。
 *
 * 背景（用户需求）：顶栏开关此前只为「自动恢复候选」渲染，且只有
 * 「正常 / 已排除」两态——已完成的会话根本不出现按钮，没法给它补设
 * 「重启后恢复」。0.36.0 起按钮**常驻**（每个会话都显示），显示态由本文件的
 * `recoveryStateOf` 按优先级从四份数据推导：
 *
 *   1. archived   ：会话已归档（宿主 workspaceRegistry.archivedSessionIds）——
 *                   归档会话不参与恢复，按钮灰显禁用、点击无效；
 *   2. registered ：会话在 proactive-restore.json 的有效登记集合里（主动注册，
 *                   即使已结束重启后也会恢复）→ 点击取消登记；
 *   3. excluded   ：会话在 excluded-sessions.json 里（用户排除）→ 点击改为恢复；
 *   4. auto       ：会话在自动恢复候选（最近活跃/运行中，快照 restoreCandidates
 *                   命中）→ 点击改为不恢复；
 *   5. none       ：其余（典型 = 已完成、早已不在候选窗口的普通会话）→ 点击
 *                   登记恢复（用户要的「给已完成会话补设恢复」）。
 *
 * 优先级固定为 archived > registered > excluded > auto > none：归档压过一切
 * （用户有意归档，任何登记都不该绕过），登记压过排除——两侧写入互斥
 * （POST /session-recovery 的 want=true 会删排除、want=false 会删登记），出现
 * 两者同时命中的只可能是并发/手改文件的脏态，登记代表更明确的「要恢复」意图。
 *
 * 与恢复流程的既有语义完全一致（本文件只做展示与点击意图推导，不参与恢复）：
 * - 主动注册会话并入候选池（lib/proactive-restore.js 的
 *   mergeProactiveRestoreCandidates，不受 restoreMax 截断）；
 * - 用户排除在候选阶段剔除（detect.js 的 filterExcludedCandidates，先于归档过滤）；
 * - 归档过滤再剔除（filterArchivedRestoreCandidates）——归档优先于两者。
 *
 * 客户端（lib/client.js）是浏览器手写 bundle、无法 import 本模块，因此同名的
 * 两个纯函数在客户端侧**照抄一份**（lib/client.js 的 recoveryStateOf /
 * recoveryWantOf / recoveryButtonView）；两侧口径由 lib/recovery-state.test.js
 * 的「host ↔ client 对齐」用例逐态断言，防漂移。
 */

/**
 * 五种显示态，按优先级从高到低排列（顺序即判定顺序，供单测与文档引用）。
 * @type {readonly ['archived','registered','excluded','auto','none']}
 */
export const RECOVERY_STATES = Object.freeze(['archived', 'registered', 'excluded', 'auto', 'none']);

/**
 * 从四份布尔标记推出显示态（0.36.0，纯函数、绝不抛错）。
 *
 * 只认严格 `true`：字段缺失/非布尔/快照形状异常一律按 false（防御式，与
 * 客户端 stateOfSession 的「字段缺失按 false」口径一致）。四者全 false →
 * `'none'`（普通已完成会话，点击即可登记恢复）。
 * @param {{archived?: boolean, registered?: boolean, excluded?: boolean, candidate?: boolean}|unknown} flags
 *        快照派生的四态布尔（candidate = 自动恢复候选命中）
 * @returns {'archived'|'registered'|'excluded'|'auto'|'none'}
 */
export function recoveryStateOf(flags) {
  const f = flags !== null && typeof flags === 'object' ? flags : {};
  if (f.archived === true) return 'archived';
  if (f.registered === true) return 'registered';
  if (f.excluded === true) return 'excluded';
  if (f.candidate === true) return 'auto';
  return 'none';
}

/**
 * 点击开关时的目标意图（0.36.0，纯函数）：`true` = 登记重启恢复
 * （POST /session-recovery body `{ want: true }`），`false` = 取消恢复
 * （`{ want: false }`），`null` = 不请求（归档态按钮禁用）。
 *
 * 映射：none / excluded → true（登记恢复）；registered / auto → false（取消）；
 * archived → null；未知态按 null（不请求，绝不误写状态文件）。
 * @param {string} state recoveryStateOf 的返回值
 * @returns {boolean|null}
 */
export function recoveryWantOf(state) {
  if (state === 'archived') return null;
  if (state === 'registered' || state === 'auto') return false;
  if (state === 'none' || state === 'excluded') return true;
  return null;
}

/**
 * 构造 ws 快照 / GET /state 的 `registered` 字段（0.36.0，纯函数）：
 * 主动注册集合 `{ [sessionId]: { at, title?, activate?: false } }`（Record）、
 * Map 或 `{ id, at, activate? }` 条目数组 → `{ [sessionId]: { at, activate? } }`。
 *
 * 只下发客户端判定显示态所需的最小字段（`at`/`activate`，不带 title——标题由
 * 设置弹窗的登记列表按需读取）；`at` 非空字符串才带（脏条目只剩 activate 时不带，
 * 仍算有效登记：内存 Map 里的条目是 readProactiveRestore 归一化过的，正常都有 at）。
 * 空 id / 非对象条目丢弃，绝不抛错。
 *
 * **「有效」= 同时没被用户排除**（可选 `excluded` 参数）：恢复流程里排除优先于
 * 主动登记（mergeProactiveCandidatePool / filterExcludedCandidates 的既有口径），
 * 若把「已登记但被排除」也报成 registered，顶栏会显示「✓ 重启时恢复（已登记）」
 * 而实际不会恢复——快照直接不报它，按钮稳定落在 excluded，显示与真实行为一致。
 * （register_restart_recovery 工具登记时不碰排除集合，所以这种重叠确实可能出现。）
 * @param {Map<string, object>|Record<string, object>|Array<object>|unknown} entries
 * @param {Record<string, unknown>|Set<string>|string[]|unknown} [excluded] 用户排除集合
 * @returns {Record<string, {at?: string, activate?: false}>}
 */
export function buildRegisteredSnapshot(entries, excluded) {
  const excludedIds = new Set();
  if (excluded instanceof Set) {
    for (const id of excluded) if (typeof id === 'string' && id) excludedIds.add(id);
  } else if (Array.isArray(excluded)) {
    for (const id of excluded) if (typeof id === 'string' && id) excludedIds.add(id);
  } else if (excluded !== null && typeof excluded === 'object') {
    for (const id of Object.keys(excluded)) if (id) excludedIds.add(id);
  }
  const out = {};
  const add = (id, entry) => {
    if (typeof id !== 'string' || !id) return;
    if (excludedIds.has(id)) return;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
    const item = {};
    if (typeof entry.at === 'string' && entry.at) item.at = entry.at;
    if (entry.activate === false) item.activate = false;
    out[id] = item;
  };
  if (entries instanceof Map) {
    for (const [id, entry] of entries) add(id, entry);
  } else if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry !== null && typeof entry === 'object') add(entry.id, entry);
    }
  } else if (entries !== null && typeof entries === 'object') {
    for (const [id, entry] of Object.entries(entries)) add(id, entry);
  }
  return out;
}

/**
 * 构造 ws 快照 / GET /state 的 `archived` 字段（0.36.0，纯函数）：
 * 归档 id 集合（Set / 数组 / 任意可迭代）→ `{ [sessionId]: true }`。
 * 空白/非字符串 id 丢弃，绝不抛错（读归档名单失败时调用方传空 Set 即可）。
 * @param {Iterable<string>|unknown} ids 归档会话 id 集合
 * @returns {Record<string, true>}
 */
export function buildArchivedSnapshot(ids) {
  const out = {};
  if (!ids || typeof ids[Symbol.iterator] !== 'function') return out;
  for (const id of ids) {
    if (typeof id === 'string' && id) out[id] = true;
  }
  return out;
}
