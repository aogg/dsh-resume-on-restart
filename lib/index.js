/**
 * dsh-resume-on-restart host half.
 *
 * 检测 DSH 服务是否发生重启：启动时读取上次运行留下的 marker 文件，
 * 若 pid/启动时间与本次不同则判定为一次重启。
 *
 * 0.3.0 起重启后的行为：
 * 1. 优先"自动恢复重启前活跃的会话"——按 marker.recentSessions 候选逐个尝试：
 *    已 live 直接投递；未 live 通过 ctx 上的 sessionController 服务（resolveAgent）
 *    把会话恢复成 live Agent 再投递，让"重启前正在干活的会话"自己收到通知并继续。
 * 2. 所有候选都失败（或 sessionController 缺失/超时）→ 回退旧行为：
 *    向主 agent（config.target 解析 roots[0]）投递通知，由其自主决定下一步。
 *
 * 运行期间通过 cordis 真实事件（agent/status、agent/inbox/inserted、
 * agent/assistant-stream，payload 均含 agent）持续追踪最近活跃的会话列表，
 * 活动时节流落盘（默认 5 秒合并一次），SIGTERM/SIGINT 兜底 flush，
 * 使重启后能恢复"之前在哪工作"的上下文。
 *
 * 兼容性：本插件只依赖 cordis ctx 提供的 `agents` 服务与事件，不 import 任何
 * `@deepseek-ai/dsh-*` 内部包；sessionController 仅在运行时防御式探测
 * （ctx.reflect.get，缺失/异常即降级），因此可在 DSH Desktop 打包环境（app.asar）下运行，
 * 且其缺失绝不阻断插件加载与既有通知路径。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildNotice, computeProcessStartAtMs, detectRestart, pickRestoreTargets } from './detect.js';

const name = 'dsh-resume-on-restart';

/** 需要的注入服务：agents（列出/访问 agent）。sessionController 不注入，运行时防御式探测。 */
const inject = ['agents'];

const DEFAULTS = {
  enabled: true,
  stateDir: '.resume-on-restart',
  target: 'primary',
  wakeup: true,
  notice: '',
  // 关闭前"活跃即视为与任务相关"的宽限窗口（ms）
  shutdownGraceMs: 600000,
  // 活动追踪时忽略的会话 id 前缀（如多代理团队的根会话）
  ignoredSessionPrefixes: ['head-'],
  // ---- 0.3.0 新增 ----
  // 最近活跃会话列表长度上限
  trackMax: 5,
  // 活动时节流落盘的间隔（ms）：窗口内只写一次盘，用 setTimeout 合并
  persistThrottleMs: 5000,
  // 重启后是否自动恢复重启前活跃的会话
  restoreSessions: true,
  // 最多恢复的会话数（按活跃时间新 → 旧取前 N 个候选）
  restoreMax: 1,
  // 恢复（resume 候选）的总预算（ms）；超时放弃恢复并回退通知主会话
  restoreTimeoutMs: 30000,
};

/** 回退路径（通知主会话）轮询等待 agent 出现的最长时间（ms），与 0.2.0 保持一致。 */
const FALLBACK_MAX_WAIT_MS = 20000;
const FALLBACK_POLL_MS = 500;

/** 解析 DSH_HOME：优先环境变量，回退到用户主目录下的 .dsh。 */
function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 会话 id 是否以给定前缀开头（用于排除不需要追踪的会话）。 */
function ignoredByPrefix(sessionId, prefixes) {
  return (prefixes || []).some((p) => String(sessionId).startsWith(p));
}

/** 配置数值归一化：非正/非法值回退默认值。 */
function toPositiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 记录唤醒/投递/恢复结果到 markerDir/wake.log（追加，一行一条 JSON）。 */
function writeWakeLog(markerDir, deliveredTo, ok, error) {
  try {
    mkdirSync(markerDir, { recursive: true });
    appendFileSync(join(markerDir, 'wake.log'), `${JSON.stringify({
      deliveredTo, ok, error: error ?? null, at: new Date().toISOString(),
    })}\n`, 'utf8');
  } catch (e) {
    console.warn('[resume-on-restart] could not write wake.log:', e);
  }
}

/** 手写一条用户消息对象（等价于 @deepseek-ai/dsh-llm 的 createUserMessage）。 */
function createUserMessage({ content, source }) {
  return {
    role: 'user',
    content,
    source,
    id: crypto.randomUUID(),
  };
}

function apply(ctx, cfg = {}) {
  const config = { ...DEFAULTS, ...cfg };
  if (!config.enabled) return;

  const trackMax = toPositiveInt(config.trackMax, DEFAULTS.trackMax);
  const persistThrottleMs = toPositiveInt(config.persistThrottleMs, DEFAULTS.persistThrottleMs);
  const restoreMax = toPositiveInt(config.restoreMax, DEFAULTS.restoreMax);
  const restoreTimeoutMs = toPositiveInt(config.restoreTimeoutMs, DEFAULTS.restoreTimeoutMs);

  // 当前进程的启动时刻（epoch 毫秒）：写入 marker 供下次启动对比。
  // Docker 容器内 DSH 恒为 PID 1，pid 无法区分两次运行，只能靠它判断重启。
  const startAtMs = computeProcessStartAtMs();

  const markerDir = join(resolveDshHome(), config.stateDir);
  const markerPath = join(markerDir, 'marker.json');

  // 1. 读取上次 marker（容忍缺失/损坏）
  let marker = null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'));
    // lastBootAt/pid 必须存在；startAt 是 0.2.0 新增的可选字段，
    // 旧版 marker 没有它时不丢弃整个 marker（detectRestart 会回退用 lastBootAt 对比）
    if (raw && typeof raw.lastBootAt === 'string' && typeof raw.pid === 'number') {
      marker = raw;
    }
  } catch {
    marker = null; // 首次启动或损坏
  }

  const bootAt = new Date().toISOString();
  const { wasRestart, downtimeMs } = detectRestart(marker, Date.now(), process.pid, startAtMs);
  const prevBootAt = marker?.lastBootAt ?? null;
  const lastSessionId = marker?.lastSessionId ?? null;
  const lastActiveAt = marker?.lastActiveAt ?? null;

  // 2. 活动追踪：内存维护最近活跃列表 [{id, at(epoch ms)}]，最新在前。
  //    启动时用上次 marker 播种（兼容 ISO/毫秒时间），延续旧上下文，
  //    避免启动即用空列表覆盖掉上一进程留下的记录。
  const recentSessions = pickRestoreTargets(marker, trackMax);

  // 3. 持久化状态：启动写一次 + 活动时节流写 + 关闭兜底写
  const writeState = (extra = {}) => {
    try {
      mkdirSync(markerDir, { recursive: true });
      const latest = recentSessions[0] ?? null;
      const doc = {
        lastBootAt: bootAt,
        pid: process.pid,
        // 当前进程启动时刻（epoch 毫秒）：容器内 pid 恒为 1 时靠它判定重启
        startAt: startAtMs,
        // 兼容旧字段语义：列表第一个即"最近活跃会话"
        lastSessionId: latest?.id ?? marker?.lastSessionId ?? null,
        lastActiveAt: latest && latest.at > 0
          ? new Date(latest.at).toISOString()
          : marker?.lastActiveAt ?? null,
        // 0.3.0 新增：最近活跃会话列表（最新在前；at 为 ISO，未知为 ''）
        recentSessions: recentSessions.map((e) => ({
          id: e.id,
          at: e.at > 0 ? new Date(e.at).toISOString() : '',
        })),
        ...extra,
      };
      writeFileSync(markerPath, JSON.stringify(doc, null, 2));
    } catch (err) {
      console.warn('[resume-on-restart] could not write marker:', err);
    }
  };
  writeState();

  // 活动节流落盘：窗口内的多次活动合并为一次写盘，不再只靠 SIGTERM
  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeState();
    }, persistThrottleMs);
    // 不因待落盘的定时器阻止进程退出
    persistTimer.unref?.();
  };

  /** 从 payload 里取 agent 并记录活动（三个事件 payload 均含 agent）。 */
  const recordActivity = (agent) => {
    const sid = String(agent?.id ?? '');
    if (!sid || ignoredByPrefix(sid, config.ignoredSessionPrefixes)) return;
    const idx = recentSessions.findIndex((e) => e.id === sid);
    if (idx >= 0) recentSessions.splice(idx, 1);
    recentSessions.unshift({ id: sid, at: Date.now() });
    if (recentSessions.length > trackMax) recentSessions.length = trackMax;
    schedulePersist();
  };

  // 正常关闭（SIGTERM/SIGINT）时兜底 flush 最近活跃列表，供下次重启参考
  const flushOnShutdown = (signal) => {
    try {
      // 取消尚未触发的节流定时器，同步写盘后重发信号走原有退出流程
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      writeState({ when: new Date().toISOString() });
    } catch (e) {
      console.warn('[resume-on-restart] shutdown flush failed:', e);
    }
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.kill(process.pid, signal);
  };
  const onSigterm = () => flushOnShutdown('SIGTERM');
  const onSigint = () => flushOnShutdown('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  // 4. 监听真实存在的 agent 活动事件（0.2.0 监听的 agent/session-start、
  //    agent/pre-step 在 DSH 中不存在，导致追踪从未生效）：
  //    - agent/status：生命周期 idle⇄running 翻转
  //    - agent/inbox/inserted：有新消息进入收件箱
  //    - agent/assistant-stream：模型流式输出进行中
  //    三者 payload 均被 dsh-agent 的 dispatcher 融合进 agent 对象。
  ctx.on('agent/status', (payload) => recordActivity(payload?.agent));
  ctx.on('agent/inbox/inserted', (payload) => recordActivity(payload?.agent));
  ctx.on('agent/assistant-stream', (payload) => recordActivity(payload?.agent));

  // 5. 若发生重启：先尝试自动恢复重启前活跃的会话，全部失败再回退旧行为
  if (wasRestart) {
    ctx.inject(['agents'], (scope) => {
      ctx.effect(() => {
        // 恢复阶段的总预算：超时放弃恢复并回退
        const deadline = Date.now() + restoreTimeoutMs;
        const remainingMs = () => Math.max(0, deadline - Date.now());

        /** 给 promise 套超时；无论谁先完成都清掉定时器。 */
        const withTimeout = (promise, ms, label) => {
          let timer = null;
          return Promise.race([
            Promise.resolve(promise),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
              timer.unref?.();
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
        };

        /**
         * 防御式探测 sessionController 服务：
         * 用 ctx.reflect.get 非阻塞读取（未提供/未激活返回 undefined，不触发启动、不阻塞加载），
         * 且要求其具备 resolveAgent 方法；拿不到即降级。
         */
        const getSessionController = () => {
          try {
            const controller = ctx.reflect?.get?.('sessionController');
            return controller && typeof controller.resolveAgent === 'function' ? controller : null;
          } catch (err) {
            console.warn('[resume-on-restart] sessionController probe failed:', err);
            return null;
          }
        };

        /**
         * 通过 sessionController.resolveAgent(sessionId) 恢复会话为 live Agent。
         * 返回判别：成功 `{ agent }` / 失败 `{ error }`（stable failure union）。
         * 失败（含超时/缺失/异常/意外形状）一律 throw，由调用方记录并继续下一个候选。
         */
        const resumeSession = async (sessionId) => {
          const controller = getSessionController();
          if (!controller) throw new Error('sessionController service unavailable');
          const result = await withTimeout(
            controller.resolveAgent(sessionId),
            Math.max(1, remainingMs()),
            `resolveAgent(${sessionId})`,
          );
          if (result && typeof result === 'object' && result.agent) return result.agent;
          const reason = result && typeof result === 'object' && 'error' in result
            ? String(result.error)
            : 'unexpected resolveAgent result';
          throw new Error(reason);
        };

        const findTarget = () => {
          try {
            const roots = scope.agents.roots?.() ?? [];
            if (config.target === 'primary') {
              return roots[0] ?? scope.agents.list?.()[0] ?? null;
            }
            return scope.agents.get?.(config.target) ?? null;
          } catch (err) {
            console.warn('[resume-on-restart] agent lookup failed:', err);
            return null;
          }
        };

        /** 投递通知；restored 非空时文案命中"已自动恢复"。返回是否成功。 */
        const deliver = (target, restored = null) => {
          const text = buildNotice({
            bootAt,
            prevBootAt,
            downtimeMs,
            lastSessionId,
            lastActiveAt,
            customNotice: config.notice,
            restoredSessionId: restored?.id ?? undefined,
            restoredActiveAt: restored && restored.at > 0
              ? new Date(restored.at).toISOString()
              : undefined,
          });
          const msg = createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: 'plugin',
              plugin: 'dsh-resume-on-restart',
              form: 'notice',
              summary: `resume-on-restart: DSH restarted at ${bootAt}`,
            },
          });
          try {
            if (config.wakeup !== false) {
              target.followup(msg);
            } else {
              target.inject(msg);
            }
            console.log('[resume-on-restart] notice delivered to', String(target.id));
            writeWakeLog(markerDir, String(target.id), true, null);
            return true;
          } catch (err) {
            console.warn('[resume-on-restart] deliver failed:', err);
            writeWakeLog(markerDir, String(target.id), false, String(err));
            return false;
          }
        };

        // 回退：现有行为（config.target 解析 roots[0]，轮询等待最长 20 秒），保证不劣化
        const fallbackWake = () => {
          let target = findTarget();
          if (target) { deliver(target); return; }
          let waited = 0;
          const timer = setInterval(() => {
            waited += FALLBACK_POLL_MS;
            target = findTarget();
            if (target) {
              clearInterval(timer);
              deliver(target);
            } else if (waited >= FALLBACK_MAX_WAIT_MS) {
              clearInterval(timer);
              console.log('[resume-on-restart] no target agent found after wait, skip wake');
              writeWakeLog(markerDir, null, false, 'no target agent after wait');
            }
          }, FALLBACK_POLL_MS);
        };

        // 自动恢复候选：已 live 直接投递；未 live 经 sessionController 恢复后投递
        const restoreCandidates = async (candidates) => {
          for (const candidate of candidates) {
            if (remainingMs() <= 0) {
              console.warn('[resume-on-restart] restore budget exhausted, skip remaining candidates');
              return false;
            }
            let agent = null;
            try {
              agent = scope.agents.get?.(candidate.id) ?? null;
            } catch (err) {
              console.warn('[resume-on-restart] live lookup failed for session', candidate.id, ':', err);
            }
            if (!agent) {
              try {
                agent = await resumeSession(candidate.id);
                console.log('[resume-on-restart] session resumed via sessionController:', candidate.id);
              } catch (err) {
                const reason = err?.message ?? String(err);
                console.warn('[resume-on-restart] resume session', candidate.id, 'failed:', reason);
                writeWakeLog(markerDir, candidate.id, false, `resume failed: ${reason}`);
                continue;
              }
            }
            // 投递结果（成功/失败）由 deliver 内部记录 wake.log
            if (deliver(agent, candidate)) return true;
          }
          return false;
        };

        // 全程异步化：恢复失败/异常都回退到 fallbackWake，不阻塞插件与事件循环
        (async () => {
          try {
            if (config.restoreSessions !== false) {
              const candidates = pickRestoreTargets(marker, restoreMax);
              if (candidates.length > 0 && await restoreCandidates(candidates)) return;
              if (candidates.length > 0) {
                console.warn('[resume-on-restart] no restore candidate succeeded, fall back to primary target');
              }
            }
          } catch (err) {
            console.warn('[resume-on-restart] restore flow error:', err);
          }
          fallbackWake();
        })();
      });
    });
  } else {
    console.log('[resume-on-restart] no restart detected, boot normal');
  }
}

export { apply, inject, name };
