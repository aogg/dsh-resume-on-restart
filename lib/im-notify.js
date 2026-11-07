/**
 * dsh-resume-on-restart × dsh-im 通知兼容（0.35.0 新增）。
 *
 * ## 本插件在这里是什么角色
 *
 * **消费方**。dsh-im（≥ 5.8.17）向 Cordis 提供 `dshIm` 服务并开放「发送前通知
 * 提供者」扩展点（契约：dsh-im 仓库 `docs/被扩展说明.md`）；本插件向它注册一个
 * 通知提供者，在 dsh-im 把自动事件通知真正发出去**之前**发表意见：
 *
 * - 一个会话**马上要被本插件自动恢复**（本次重启的待恢复候选），它因重启被打断
 *   而触发的 `completed` / `failed` / `timeout` 通知、以及计划内停机的宿主级
 *   `shutdown` 通知，都是噪音 → `Decision = { cancel: true }` 取消，不发；
 * - 其余一律 `return null`（没意见，fail-open），dsh-im 照常发送。
 *
 * 候选集合的写入时机在 lib/index.js 的 `performRestart`：`before-restart` 扩展点
 * 钩子全部通过、重启工件开写之前，把本次将恢复的候选 id 快照进本模块的进程内
 * 集合。进程退出集合自然消失——重启后新进程里「恢复工作的结果汇报」（completed
 * 通知）不受任何影响；重启失败（进程继续活着）时立刻清空，避免误杀正常通知。
 *
 * ## dsh-im 不存在 / 旧版时必须完全降级（规范硬性要求）
 *
 * - **缺失**：本插件**不把 `dshIm` 声明进静态 `inject`**（`['agents', 'tools']`）。
 *   依据：cordis 4.x 的 inject 声明全部是必须依赖——Fiber 对每个声明项做
 *   `_checkImpl`，`_refresh` 里任何一项没有 impl 就把 epoch 置 INACTIVE、apply
 *   永不执行（见 @deepseek-ai/cordis lib/index.js 的 Fiber 实现）。声明了 dshIm
 *   而宿主没装 dsh-im，本插件整个就不会加载，违反「零行为差异」。改用与既有
 *   webServer 接线同一模式的**动态注入** `ctx.inject(['dshIm'], callback)`：
 *   dsh-im 存在且激活后回调才执行；不存在则回调永不执行、零注册、零日志、
 *   本插件其余功能照常。
 * - **旧版**：`ctx.dshIm?.notificationVersion !== 1`（`notificationVersion` 是
 *   dsh-im 5.8.17 新增的能力版本标记）→ 不注册、不打日志噪音，直接返回。
 * - 注入方式没有臆造 API：动态 `ctx.inject` 与 `ctx.effect(() => dispose, label)`
 *   均为 cordis 4.x 公开能力，前者本仓库 lib/index.js 已有 webServer 先例
 *   （0.14.0 起，含 inject.test.js 对静态声明的守卫），后者是 dsh-im 契约文档
 *   给消费方的官方写法。
 *
 * ## 幂等与卸载
 *
 * - 卸载走 `scope.effect(() => dispose, 'resume-on-restart: dsh-im notification
 *   provider')`，挂在 inject 内层 fiber 上：dsh-im 服务重载时提供者先摘除再
 *   重新注册，本插件卸载时内层 fiber 随之销毁、disposer 必然执行。
 * - dsh-im 对重复 id 注册抛 `Error(code = 'notification-provider-exists')`；
 *   这里捕获该错误并 console.warn 可见降级（不静默、不吞栈），其它错误原样上抛。
 *
 * 全部逻辑纯函数化（`resolveImNotification` / `buildImNotificationProvider` /
 * 集合读写），单测见 lib/im-notify.test.js（node --test，无 e2e、不联网）。
 *
 * @module dsh-resume-on-restart/im-notify
 */

/** 通知提供者 id：全进程唯一，须匹配 dsh-im 的 /^[a-z][a-z0-9-]{1,31}$/。 */
export const IM_PROVIDER_ID = 'resume-on-restart';

/**
 * 订阅的事件：只挑「重启前窗口内会变成噪音」的四类。
 * - `completed` / `failed` / `timeout`：候选会话因重启被打断时的回合级通知；
 * - `shutdown`：计划内停机的宿主级通知（SIGTERM/SIGINT）。
 * `startup` 不订阅（它发生在重启之后，是恢复流程的同伴而非噪音）；
 * `crash` 不订阅也不取消——上次宿主异常退出与本次计划内重启无关。
 */
export const IM_NOTIFY_EVENTS = Object.freeze(['completed', 'failed', 'timeout', 'shutdown']);

/** 会话级取消的 reason（只进 dsh-im 的 host 日志，逐字固定便于排障检索）。 */
export const CANCEL_REASON_SESSION = 'session will be auto-restored after restart by dsh-resume-on-restart';

/** 宿主级 shutdown 取消的 reason（同上）。 */
export const CANCEL_REASON_HOST_SHUTDOWN = 'planned restart with sessions pending auto-restore by dsh-resume-on-restart';

// ---- 待恢复候选集合（进程内模块级状态；进程退出自然消失） ----

/** 本次重启「将自动恢复的候选 sessionId」集合。空 = 没有任何将恢复的会话。 */
const pendingRestoreIds = new Set();

/**
 * 用一份新快照整体替换候选集合（不是合并：每次重启请求都以最新口径为准）。
 * 非数组输入按清空处理；条目只收非空字符串，其余忽略。
 * @param {readonly string[]} ids 候选 sessionId 列表
 */
export function markPendingRestoreCandidates(ids) {
  pendingRestoreIds.clear();
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id === 'string' && id !== '') pendingRestoreIds.add(id);
  }
}

/** 清空候选集合（重启失败 / 测试收尾用）。 */
export function clearPendingRestoreCandidates() {
  pendingRestoreIds.clear();
}

/**
 * 候选集合的只读快照（诊断与测试观察用；返回冻结副本，不暴露内部 Set）。
 * @returns {readonly string[]}
 */
export function pendingRestoreCandidateSnapshot() {
  return Object.freeze([...pendingRestoreIds]);
}

/**
 * 通知提供者的 resolve 逻辑（纯函数；`candidates` 缺省读进程内集合）。
 *
 * 取消口径（与 docs/支持插件说明.md 一一对应）：
 *
 * | 输入 | 返回 |
 * | --- | --- |
 * | 会话级：`context.sessionId` 非空且在候选集合内 | `{ cancel: true, reason: CANCEL_REASON_SESSION }` |
 * | 宿主级：`sessionId` 为空、`event === 'shutdown'`、候选集合非空 | `{ cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN }` |
 * | 宿主级 `shutdown` 但候选集合为空 | `null`（没有会话会被恢复，停机通知有信息量） |
 * | 其余一切（不命中、`startup`、`crash`、脏输入） | `null`（没意见，fail-open） |
 *
 * `crash` 显式不碰：描述符 `events` 不含它（dsh-im 不会把 crash 派给本提供者），
 * 这里再挡一层是防御性的意图声明——就算未来事件清单变化，计划内重启也永远
 * 不取消「上次异常退出」的通知。
 *
 * @param {object|null} [context] dsh-im 冻结的 resolve 入参（`event`/`sessionId` 等）
 * @param {ReadonlySet<string>} [candidates=pendingRestoreIds] 候选集合（测试可注入）
 * @returns {{cancel: true, reason: string}|null} Decision 或 null（没意见）
 */
export function resolveImNotification(context, candidates = pendingRestoreIds) {
  if (context === null || typeof context !== 'object') return null;
  const event = context.event;
  if (event === 'crash') return null;
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId : '';
  // 会话级：这个会话将被自动恢复，它因重启而触发的通知是噪音（不限事件名，
  // 订阅面已经只剩 completed/failed/timeout/shutdown 四种）。
  if (sessionId !== '') {
    return candidates.has(sessionId)
      ? { cancel: true, reason: CANCEL_REASON_SESSION }
      : null;
  }
  // 宿主级（sessionId 为空）：只有计划内 shutdown 且确实存在将被恢复的会话
  // 才取消；非字符串 sessionId 按宿主级口径处理（dsh-im 契约里宿主事件恒为 null）。
  if (event === 'shutdown' && candidates.size > 0) {
    return { cancel: true, reason: CANCEL_REASON_HOST_SHUTDOWN };
  }
  return null;
}

/**
 * 构造 dsh-im 的通知提供者描述符（纯函数；形状对齐 dsh-im 契约 4.1）。
 * `workspaces` / `priority` 缺省 = 全部工作区、默认优先级 100——取消是全局意图，
 * 不按工作区收窄；`events` 传副本，避免调用方（dsh-im）与模块常量共享可变引用。
 * @returns {{id: string, events: string[], resolve(context: object): {cancel: true, reason: string}|null}}
 */
export function buildImNotificationProvider() {
  return {
    id: IM_PROVIDER_ID,
    events: [...IM_NOTIFY_EVENTS],
    resolve(context) {
      return resolveImNotification(context);
    },
  };
}

/**
 * 在「已注入 dshIm 的上下文」上注册通知提供者（wire 的内层实现，单独导出以便单测）。
 *
 * 降级门与 dsh-im 契约文档的官方写法逐字一致：
 * `ctx.dshIm?.notificationVersion !== 1` → 直接返回 null（缺失或旧版都走这里，
 * 不注册、不打日志噪音、不抛错）。
 *
 * @param {object} imCtx 内层 inject fiber 的上下文（属性访问 `dshIm` 已被 inject 声明放行）
 * @returns {(() => void)|null} dsh-im 返回的幂等 disposer；降级或重复注册时 null
 */
export function registerImNotificationProvider(imCtx) {
  const dshIm = imCtx?.dshIm;
  // 能力门：dsh-im 缺失（undefined）或旧版（notificationVersion !== 1）都静默降级
  if (dshIm?.notificationVersion !== 1) return null;
  if (typeof dshIm.registerNotificationProvider !== 'function') return null;
  let dispose;
  try {
    dispose = dshIm.registerNotificationProvider(buildImNotificationProvider());
  } catch (error) {
    // 重复注册（另一份本插件实例先注册过同 id）：dsh-im 契约抛
    // code='notification-provider-exists'。可见降级不静默，warn 一条后放弃本次
    // 注册（不影响本插件其余功能）；其它错误原样上抛，绝不吞异常。
    if (error?.code === 'notification-provider-exists') {
      console.warn(`[resume-on-restart] dsh-im notification provider "${IM_PROVIDER_ID}" already registered elsewhere; skipping duplicate registration`);
      return null;
    }
    throw error;
  }
  return typeof dispose === 'function' ? dispose : null;
}

/**
 * 把本插件接上 dsh-im 的通知扩展点（lib/index.js 的 apply 里调用一次）。
 *
 * 用动态注入而不是静态 inject 声明（理由见模块头「完全降级」一节）：dsh-im
 * 缺失时回调永不执行——零注册、零日志、零行为差异；存在时等服务激活后才注册，
 * 不阻塞、不受插件加载顺序影响。
 *
 * @param {object} ctx 插件上下文（需支持 cordis 的 `ctx.inject`）
 * @returns {unknown} ctx.inject 返回的 fiber（cordis 原样返回；宿主不支持 inject 时 null）
 */
export function wireImNotificationProvider(ctx) {
  if (typeof ctx?.inject !== 'function') return null;
  return ctx.inject(['dshIm'], (scope) => {
    const dispose = registerImNotificationProvider(scope);
    if (dispose === null) return;
    // effect 挂在内层 inject fiber 上：dsh-im 服务重载 → 内层 fiber 卸载 →
    // disposer 摘下提供者，重载完成后再注册新的；本插件卸载时内层 fiber 一并
    // 销毁。不挂外层 apply fiber：那样 dsh-im 重载后会出现新旧两份注册。
    scope.effect(() => dispose, 'resume-on-restart: dsh-im notification provider');
  });
}
