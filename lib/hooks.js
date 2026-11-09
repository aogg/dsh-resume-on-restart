/**
 * dsh-resume-on-restart 对外扩展点（0.32.0 新增）：
 * 其他插件在「重启真正发生之前」与「重启完成后、恢复会话之前」注册事件，
 * 同步等待它们跑完再继续本插件的原有逻辑；任何一个可以取消本次行为。
 *
 * ## 为什么是 cordis 事件而不是自造注册表
 *
 * 宿主与所有插件共享同一套 cordis 事件总线（`ctx.on` / `ctx.serial` /
 * `ctx.waterfall` …），事件监听器的生命周期自动跟随注册它的插件 fiber
 * （插件卸载/禁用即自动摘除，不会留下悬挂回调）。所以本插件把扩展点直接做成
 * 两个**串行**事件（`ctx.serial`），其它插件用一行 `ctx.on(事件名, 处理器)`
 * 注册，无需 inject 本插件、无需依赖本包：
 *
 * - `resume-on-restart/before-restart`：**重启被调用之后、真正开始重启之前**
 *   触发（设置弹窗「重启」按钮 / `/restart` 命令 / `restart_harness` 模型工具 /
 *   注册后守门自动重启 四个入口共用同一处，见 lib/index.js 的 performRestart）。
 * - `resume-on-restart/before-resume`：**重启完成（检测到 wasRestart、算出停机
 *   归因并落 boot 记录）之后、恢复候选会话之前**触发；每次开机只触发一次
 *   （续等补跑不再重复触发）。
 * - `resume-on-restart/session-title`（0.37.0 新增）：本插件解析会话标题的
 *   **唯一出口**（写 restore 记录与下发对账数据补齐共用）上触发，处理器可返回
 *   `{ title: '新标题' }` 链式覆盖标题（按注册顺序归约、后者拿到前者结果并覆盖
 *   前者）；fail-open（抛错/超时只 warn、按「不覆盖」继续），详见文末函数与
 *   `docs/被扩展说明.md`。
 *
 * ## 「同步」的准确含义
 *
 * 宿主侧用 `ctx.serial(event, payload)` 派发：按监听器注册顺序**逐个 await**，
 * 前一个处理器 resolve 之后才调下一个；全部 resolve 且都没有取消，才继续本插件
 * 的原有逻辑（重启 / 恢复）。处理器可以是 async 函数，宿主会等它跑完。
 *
 * ## 取消约定
 *
 * 处理器返回值决定是否取消（口径取自 cordis `isBailed`，与本插件所有事件
 * 派发口径一致）：
 *
 * | 返回值 | 含义 |
 * | --- | --- |
 * | `undefined` / `null` / `false` | 继续（等价于没意见） |
 * | `true` | 取消，无原因 |
 * | 字符串 | 取消，字符串即原因 |
 * | `{ cancel: true, by?, reason? }` | 取消，推荐写法（`by` 默认取插件名） |
 * | 其它真值 | 取消，原因按 `String(value)` |
 *
 * 取消 = **本次行为整体不执行**：
 * - before-restart 取消 → 不写任何重启工件、不拉 helper、进程继续活着，
 *   响应 `{ ok:false, cancelled:true, reason, by }`；
 * - before-resume 取消 → 跳过全部候选恢复与 fallback 唤醒，只留一条
 *   `resume-cancel` 重启日志与 wake.log 记录。
 *
 * ## 兜底（fail-closed）
 *
 * - 处理器抛错 → 视为取消（`error:true`），原因 `hook error: <message>`：
 *   重启/恢复都是不可半途而废的动作，宁可停下来让人看见，也不带病继续；
 * - 处理器超时（默认 10s，配置项 `hookTimeoutMs`）→ 视为取消
 *   （`timeout:true`），避免一个卡死的第三方插件把重启/恢复永久挂住；
 * - 宿主无 `ctx.serial`（极旧宿主/上下文缺失）→ 静默跳过，不阻塞原有逻辑。
 *
 * 两份能力的接线位置、payload 字段与示例见 `docs/被扩展说明.md`；
 * 重启后恢复会话的提示词本身（投递什么文案）见 `docs/被注入说明.md`。
 *
 * @module dsh-resume-on-restart/hooks
 */

/** 「重启真正开始之前」的扩展点事件名。 */
export const BEFORE_RESTART_HOOK = 'resume-on-restart/before-restart';

/** 「重启完成、恢复会话之前」的扩展点事件名。 */
export const BEFORE_RESUME_HOOK = 'resume-on-restart/before-resume';

/** 「会话标题解析」的扩展点事件名（0.37.0 新增，链式覆盖标题）。 */
export const SESSION_TITLE_HOOK = 'resume-on-restart/session-title';

/** 事件名清单（供其它插件 import 后使用，避免字符串手写漂移）。 */
export const HOOK_EVENTS = Object.freeze({
  beforeRestart: BEFORE_RESTART_HOOK,
  beforeResume: BEFORE_RESUME_HOOK,
  sessionTitle: SESSION_TITLE_HOOK,
});

/** 单个处理器等待上限的默认值（ms）：超时按取消处理（fail-closed）。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** 本插件包名（payload.plugin 的固定值，也是取消记录里的默认 by）。 */
const PLUGIN_NAME = 'dsh-resume-on-restart';

/** 超时哨兵：与任何用户返回值都不可能相等（Symbol 唯一）。 */
const TIMEOUT = Symbol('resume-on-restart/hook-timeout');

/**
 * 把监听器返回值归一化为「取消记录」（纯函数，便于单测）。
 *
 * 口径严格对齐 cordis 的 `isBailed`（`null` / `false` / `undefined` 不算 bail），
 * 因此 `ctx.serial` 认为要停下来的值，这里一定归一化成取消；反之亦然。
 *
 * @param {unknown} value 监听器返回值
 * @returns {{cancelled: true, by: string|null, reason: string|null} |
 *   {cancelled: true, by: string|null, reason: string, error: true} |
 *   {cancelled: true, by: string|null, reason: string, timeout: true} | null}
 *   null = 不取消，继续原有逻辑
 */
export function normalizeHookCancel(value) {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return { cancelled: true, by: null, reason: null };
  if (typeof value === 'string') {
    return { cancelled: true, by: null, reason: value === '' ? null : value };
  }
  if (typeof value === 'object') {
    // 显式 cancel:false = 明确表态不取消（cordis 侧仍因"非空对象"而中止串行，
    // 但语义上把它当继续，避免"返回了个普通对象"就莫名其妙取消重启）
    if (value.cancel === false) return null;
    const byRaw = value.by ?? value.plugin ?? value.name;
    const reasonRaw = value.reason ?? value.message ?? value.error;
    const by = typeof byRaw === 'string' && byRaw !== '' ? byRaw : null;
    const reason = typeof reasonRaw === 'string' && reasonRaw !== '' ? reasonRaw : null;
    return { cancelled: true, by, reason };
  }
  return { cancelled: true, by: null, reason: String(value) };
}

/**
 * 归一化取消记录 → 一行可读文案（写日志/回包共用，纯函数）。
 *
 * 形如 `cancelled by plugin "foo": 别重启，正在跑数据迁移`；
 * `by` 与 `reason` 都缺失时退化为 `cancelled by plugin`。
 *
 * @param {{cancelled: boolean, by?: string|null, reason?: string|null}} cancel
 * @param {string} [fallbackBy] 调用方补充的来源名（如本插件名）
 * @returns {string}
 */
export function describeHookCancel(cancel, fallbackBy = PLUGIN_NAME) {
  if (cancel === null || typeof cancel !== 'object' || cancel.cancelled !== true) {
    return '';
  }
  const by = typeof cancel.by === 'string' && cancel.by !== ''
    ? cancel.by
    : typeof fallbackBy === 'string' && fallbackBy !== '' ? fallbackBy : null;
  const reason = typeof cancel.reason === 'string' && cancel.reason !== '' ? cancel.reason : null;
  const head = by !== null ? `cancelled by plugin "${by}"` : 'cancelled by plugin';
  return reason !== null ? `${head}: ${reason}` : head;
}

/**
 * 深冻结 payload（监听器只读；防止第三方顺手改掉本插件要落盘的候选/归因数据）。
 * 只冻结普通对象与数组（时间戳、字符串、数字天然不可变）；不递归函数/类实例。
 * @param {unknown} value
 * @returns {unknown} 同一个值（已冻结）
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * 构造 `before-restart` 的 payload（纯函数）：四个重启入口共用同一形状，
 * 字段只读。`candidates` 是「这次重启后会尝试恢复的候选」的快照（与恢复流程
 * 同源：marker.recentSessions 经 pickRestoreTargets 过滤），供处理器判断要不要
 * 拦下这次重启。
 *
 * @param {object} opts
 * @param {{kind: string, sessionId?: string}|undefined|null} [opts.origin] 发起方
 * @param {'helper'|'pid1-exit'} opts.mode 重启模式
 * @param {number} opts.delayMs 响应后延迟多久才真正退出
 * @param {string} opts.instanceId 当前进程实例 id
 * @param {number} opts.pid
 * @param {number} opts.port 当前绑定端口
 * @param {string} [opts.requestedAt] 触发时刻（ISO；缺省取当前时间）
 * @param {Array<{id: string, at?: string, running?: boolean}>} [opts.candidates]
 * @returns {object} 冻结后的 payload
 */
export function buildBeforeRestartPayload(opts = {}) {
  const origin = opts.origin !== null && typeof opts.origin === 'object' && typeof opts.origin.kind === 'string'
    ? Object.freeze({
      kind: opts.origin.kind,
      ...(typeof opts.origin.sessionId === 'string' && opts.origin.sessionId !== ''
        ? { sessionId: opts.origin.sessionId }
        : {}),
    })
    : null;
  const candidates = Array.isArray(opts.candidates)
    ? opts.candidates
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => Object.freeze({
        id: entry.id,
        at: typeof entry.at === 'string' ? entry.at : '',
        running: entry.running === true,
      }))
    : [];
  return deepFreeze({
    event: BEFORE_RESTART_HOOK,
    plugin: PLUGIN_NAME,
    phase: 'before-restart',
    origin,
    mode: opts.mode === 'pid1-exit' ? 'pid1-exit' : 'helper',
    delayMs: Number.isFinite(opts.delayMs) ? opts.delayMs : 0,
    instanceId: typeof opts.instanceId === 'string' ? opts.instanceId : '',
    pid: typeof opts.pid === 'number' ? opts.pid : process.pid,
    port: Number.isFinite(opts.port) ? opts.port : null,
    requestedAt: typeof opts.requestedAt === 'string' && opts.requestedAt !== ''
      ? opts.requestedAt
      : new Date().toISOString(),
    candidates: Object.freeze(candidates),
  });
}

/**
 * 构造 `before-resume` 的 payload（纯函数）：只在开机恢复流程触发一次。
 *
 * @param {object} opts
 * @param {string} opts.bootAt 本次启动时刻（ISO，boot 记录同值）
 * @param {string|null} [opts.prevBootAt] 上次启动时刻（ISO）
 * @param {number} [opts.downtimeMs] 距上次启动的间隔（ms）
 * @param {string|null} [opts.reason] 重启归因文案（signal / crash / restart-button …）
 * @param {object|null} [opts.origin] 重启来源记录（重启日志同款）
 * @param {Array<{id: string, at?: string, running?: boolean}>} [opts.candidates]
 *   本次将尝试恢复的候选快照（advisory：真正恢复前还会过排除/归档/正常结束门）
 * @param {string[]} [opts.registered] 主动注册（register_restart_recovery）的会话 id
 * @param {string[]} [opts.paused] 暂停集合里的会话 id
 * @param {Record<string, string>} [opts.excluded] 用户排除集合（id → 排除时刻）
 * @returns {object} 冻结后的 payload
 */
export function buildBeforeResumePayload(opts = {}) {
  const candidates = Array.isArray(opts.candidates)
    ? opts.candidates
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => Object.freeze({
        id: entry.id,
        at: typeof entry.at === 'string' ? entry.at : '',
        running: entry.running === true,
      }))
    : [];
  const idList = (list) => Object.freeze(
    (Array.isArray(list) ? list : [])
      .filter((id) => typeof id === 'string' && id !== '')
      .slice(),
  );
  const excluded = {};
  if (opts.excluded !== null && typeof opts.excluded === 'object' && !Array.isArray(opts.excluded)) {
    for (const [id, at] of Object.entries(opts.excluded)) {
      if (typeof id === 'string' && id !== '') excluded[id] = typeof at === 'string' ? at : '';
    }
  }
  return deepFreeze({
    event: BEFORE_RESUME_HOOK,
    plugin: PLUGIN_NAME,
    phase: 'before-resume',
    bootAt: typeof opts.bootAt === 'string' ? opts.bootAt : '',
    prevBootAt: typeof opts.prevBootAt === 'string' && opts.prevBootAt !== '' ? opts.prevBootAt : null,
    downtimeMs: Number.isFinite(opts.downtimeMs) ? opts.downtimeMs : null,
    reason: typeof opts.reason === 'string' && opts.reason !== '' ? opts.reason : null,
    origin: opts.origin !== null && typeof opts.origin === 'object' ? opts.origin : null,
    candidates: Object.freeze(candidates),
    registered: idList(opts.registered),
    paused: idList(opts.paused),
    excluded: Object.freeze(excluded),
  });
}

/**
 * 派发一个扩展点事件，同步等所有处理器跑完（`ctx.serial`：逐个 await，
 * 遇到第一个取消值即停）。
 *
 * 绝不抛错：处理器异常、超时、宿主缺 `ctx.serial` 都在内部消化成返回值，
 * 调用方只需判断 `null`（继续）还是取消记录。
 *
 * @param {object} ctx 插件上下文（要有 `serial`）
 * @param {string} event 事件名（BEFORE_RESTART_HOOK / BEFORE_RESUME_HOOK）
 * @param {object} payload 已冻结的 payload
 * @param {{timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<null | {cancelled: true, by: string|null, reason: string|null,
 *   error?: true, timeout?: true}>}
 */
export async function runRestartHook(ctx, event, payload, opts = {}) {
  const label = typeof opts.label === 'string' && opts.label !== '' ? opts.label : event;
  let serial = null;
  try {
    serial = ctx !== null && typeof ctx === 'object' && typeof ctx.serial === 'function'
      ? ctx.serial
      : null;
  } catch {
    serial = null;
  }
  if (serial === null) {
    // 极旧宿主 / 上下文缺失：没有扩展点可言，按"没人反对"放行，绝不阻塞原有逻辑
    return null;
  }
  const rawTimeout = Math.floor(Number(opts.timeoutMs));
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_HOOK_TIMEOUT_MS;
  let timer = null;
  try {
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      // 不因这个兜底定时器拖住宿主进程退出（重启路径上尤其重要）
      if (typeof timer?.unref === 'function') timer.unref();
    });
    const bail = await Promise.race([
      Promise.resolve().then(() => serial.call(ctx, event, payload)),
      timeoutPromise,
    ]);
    if (bail === TIMEOUT) {
      return {
        cancelled: true,
        by: null,
        reason: `${label} hook timeout after ${timeoutMs}ms`,
        timeout: true,
      };
    }
    return normalizeHookCancel(bail);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { cancelled: true, by: null, reason: `${label} hook error: ${reason}`, error: true };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ---- 0.37.0：会话标题扩展点（resume-on-restart/session-title，链式覆盖） ----

/**
 * 归一化 session-title 处理器的返回值为「覆盖标题」（纯函数）。
 *
 * 只认 `{ title: '非空字符串' }` 对象形式：非空字符串才生效（覆盖），其余返回值
 * —— `undefined` / `null` / `{}` / `{ title: '' }` / `{ title: 123 }` / 任意其它
 * 值 —— 一律视为「不覆盖」返回 null。**裸字符串不认**（避免「返回字符串算标题
 * 还是算取消」这类歧义，契约保持窄而清晰）。
 *
 * @param {unknown} value 处理器返回值
 * @returns {string|null} 非空字符串 = 覆盖标题；null = 不覆盖
 */
export function normalizeSessionTitleOverride(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = value.title;
  return typeof title === 'string' && title !== '' ? title : null;
}

/**
 * 构造 `session-title` 事件的 payload（纯函数，已冻结、只读）。
 *
 * 标题链是**逐步派发**的：每个处理器收到的 payload.title 都是「到此为止的当前
 * 标题」（默认解析值或上一个覆盖者的结果），所以每个步骤都要冻结一份新 payload
 * ——本函数就是那个唯一构造点（`runSessionTitleChain` 逐步调用它）。
 *
 * @param {object} opts
 * @param {string} opts.id 会话 id（非空；空 id 的调用没有意义，原样携带由调用方把关）
 * @param {string} [opts.title] 当前标题（本插件默认解析到的；缺失/空传 ''）
 * @param {string} [opts.phase] 解析场景（'restore-record' = 写 restore 记录时 /
 *   'settle-backfill' = 下发对账数据时惰性补齐），便于处理器区分上下文
 * @returns {object} 冻结后的 payload：`{ event, plugin, phase, id, title }`
 */
export function buildSessionTitlePayload(opts = {}) {
  return deepFreeze({
    event: SESSION_TITLE_HOOK,
    plugin: PLUGIN_NAME,
    phase: typeof opts.phase === 'string' && opts.phase !== '' ? opts.phase : '',
    id: typeof opts.id === 'string' ? opts.id : '',
    title: typeof opts.title === 'string' ? opts.title : '',
  });
}

/**
 * 跑一遍会话标题覆盖链：按监听器注册顺序逐个 await，后者拿到前者结果、后者可
 * 覆盖前者；返回最终标题字符串（可能为 ''，表示谁也没提供标题）。
 *
 * ## 为什么不用 `ctx.serial` / `ctx.waterfall`
 *
 * - `ctx.serial` 的监听器收到的是**同一份**参数，返回值只用于 bail（第一个非
 *   bail 值之外的结果会被丢掉）——做不了「后者拿到前者结果」的归约；
 * - `ctx.waterfall` 是洋葱/中间件模型（处理器要主动调 `next()` 才能把链走下去，
 *   且「先注册的在外层、不调 next 直接返回 = 一票否决下游」）——与「按注册顺序
 *   归约、后者覆盖前者」的语义正好相反。
 *
 * 所以这里直接向事件总线枚举监听器（`ctx.events.dispatch('emit', [事件, payload])`
 * 返回按注册顺序排列的回调数组，生命周期过滤照旧生效：插件卸载/禁用后监听器
 * 自动消失），然后自己按注册顺序逐个 await 做归约。`dispatch` 探测不到（极旧
 * 宿主）时回退 `ctx.serial` 的 bail 语义：第一个返回覆盖值的处理器生效、链停止
 * （降级但不炸，文档已注明）。
 *
 * ## 兜底（与 before-restart / before-resume 的 fail-closed **相反**：fail-open）
 *
 * 标题只是展示数据，绝不能因为第三方标题插件卡壳而阻塞恢复流程或 /restarts
 * 路由，所以：
 * - 处理器抛错 → console.warn 记录后按「不覆盖」继续跑下一个处理器；
 * - 处理器超时（默认 10s，配置项 `hookTimeoutMs`）→ console.warn 后按「不覆盖」
 *   继续跑下一个处理器（超时上限防一个卡死的插件拖住整条链）；
 * - 宿主既无 `ctx.events.dispatch` 也无 `ctx.serial` → 直接返回默认标题。
 *
 * @param {object} ctx 插件上下文（要有 `events.dispatch`，回退 `serial`）
 * @param {object} payload buildSessionTitlePayload 的输出（首个处理器的默认入参）
 * @param {{timeoutMs?: number, label?: string}} [opts]
 * @returns {Promise<string>} 最终标题（'' = 没有任何来源给出标题）
 */
export async function runSessionTitleChain(ctx, payload, opts = {}) {
  const label = typeof opts.label === 'string' && opts.label !== '' ? opts.label : SESSION_TITLE_HOOK;
  const rawTimeout = Math.floor(Number(opts.timeoutMs));
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_HOOK_TIMEOUT_MS;
  const baseTitle = payload !== null && typeof payload === 'object' && typeof payload.title === 'string'
    ? payload.title
    : '';
  const safeCtx = ctx !== null && typeof ctx === 'object' ? ctx : {};
  // 枚举监听器（注册顺序、fiber 生命周期过滤都由 dispatch 承担）；入参数组传副本
  // ——dispatch 会原地 shift 掉 thisArg 与事件名
  let listeners = null;
  try {
    const events = typeof safeCtx.events?.dispatch === 'function' ? safeCtx.events : null;
    if (events !== null) {
      listeners = events.dispatch('emit', [SESSION_TITLE_HOOK, payload]);
    }
  } catch (err) {
    console.warn(`[resume-on-restart] ${label} listener enumeration failed:`, err);
    listeners = null;
  }
  if (Array.isArray(listeners)) {
    let title = baseTitle;
    for (const listener of listeners) {
      if (typeof listener !== 'function') continue;
      // 每步重建冻结 payload：处理器看到的是「到此为止的当前标题」
      const stepPayload = buildSessionTitlePayload({
        id: payload?.id,
        title,
        phase: payload?.phase,
      });
      let timer = null;
      try {
        const timeoutPromise = new Promise((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
          if (typeof timer?.unref === 'function') timer.unref();
        });
        const outcome = await Promise.race([
          Promise.resolve().then(() => listener(stepPayload)),
          timeoutPromise,
        ]);
        if (outcome === TIMEOUT) {
          console.warn(`[resume-on-restart] ${label} hook timeout after ${timeoutMs}ms, keep current title`);
          continue;
        }
        const override = normalizeSessionTitleOverride(outcome);
        if (override !== null) title = override;
      } catch (err) {
        // fail-open：标题是展示数据，处理器抛错不阻塞恢复/路由，warn 可见
        console.warn(`[resume-on-restart] ${label} hook error (ignored, keep current title):`, err);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }
    return title;
  }
  // 降级路径：极旧宿主没有 ctx.events.dispatch → 用 ctx.serial 的 bail 语义
  // （第一个返回覆盖值的处理器生效、链停止；返回 undefined/null 时 serial 继续
  // 跑完但结果丢弃——能拿到一个覆盖就已比没有强）
  try {
    const serial = typeof safeCtx.serial === 'function' ? safeCtx.serial : null;
    if (serial === null) return baseTitle;
    const bail = await Promise.resolve().then(() => serial.call(safeCtx, SESSION_TITLE_HOOK, payload));
    const override = normalizeSessionTitleOverride(bail);
    return override !== null ? override : baseTitle;
  } catch (err) {
    console.warn(`[resume-on-restart] ${label} serial dispatch failed:`, err);
    return baseTitle;
  }
}
