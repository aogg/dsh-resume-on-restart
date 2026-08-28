/**
 * dsh-resume-on-restart host half.
 *
 * 检测 DSH 服务是否发生重启：启动时读取上次运行留下的 marker 文件，
 * 若 pid/启动时间与本次不同则判定为一次重启。重启后，向主 agent 投递一条
 * 信息性消息（含上次活跃会话/中断时长等状态摘要），由 agent 自主决定下一步
 * （继续旧工作 / 换任务 / 忽略），而不是命令式地强制"继续"。
 *
 * 运行期间通过 cordis 事件（agent/session-start、agent/pre-step）持续追踪
 * 最近活跃的会话，并在正常关闭（SIGTERM/SIGINT）或每次启动时持久化状态，
 * 使重启后能向 agent 提供"之前在哪工作"的上下文。
 *
 * 兼容性：本插件只依赖 cordis ctx 提供的 `agents` 服务，不 import 任何
 * `@deepseek-ai/dsh-*` 内部包，因此可在 DSH Desktop 打包环境（app.asar）下运行。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildNotice, detectRestart } from './detect.js';

const name = 'dsh-resume-on-restart';

/** 需要的注入服务：agents（列出/访问 agent）。 */
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
};

/** 解析 DSH_HOME：优先环境变量，回退到用户主目录下的 .dsh。 */
function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 会话 id 是否以给定前缀开头（用于排除不需要追踪的会话）。 */
function ignoredByPrefix(sessionId, prefixes) {
  return (prefixes || []).some((p) => String(sessionId).startsWith(p));
}

/** 记录唤醒/投递结果到 markerDir/wake.log。 */
function writeWakeLog(markerDir, deliveredTo, ok, error) {
  try {
    writeFileSync(join(markerDir, 'wake.log'), JSON.stringify({
      deliveredTo, ok, error: error ?? null, at: new Date().toISOString(),
    }), 'utf8');
  } catch (e) { /* ignore */ }
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

  const markerDir = join(resolveDshHome(), config.stateDir);
  const markerPath = join(markerDir, 'marker.json');

  // 1. 读取上次 marker（容忍缺失/损坏）
  let marker = null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (raw && typeof raw.lastBootAt === 'string' && typeof raw.pid === 'number') {
      marker = raw;
    }
  } catch {
    marker = null; // 首次启动或损坏
  }

  const bootAt = new Date().toISOString();
  const { wasRestart, downtimeMs } = detectRestart(marker, Date.now(), process.pid);
  const prevBootAt = marker?.lastBootAt ?? null;
  const lastSessionId = marker?.lastSessionId ?? null;
  const lastActiveAt = marker?.lastActiveAt ?? null;

  // 2. 活动追踪（运行期间持续记录最近活跃会话）
  let trackedActiveId = null;
  let trackedActiveAt = 0;
  const recordActivity = (agent) => {
    const sid = String(agent?.id ?? '');
    if (ignoredByPrefix(sid, config.ignoredSessionPrefixes)) return;
    trackedActiveId = sid;
    trackedActiveAt = Date.now();
  };

  // 3. 持久化状态（启动时写 marker + 正常关闭时写最近活跃）
  const writeState = (extra = {}) => {
    try {
      mkdirSync(markerDir, { recursive: true });
      const doc = {
        lastBootAt: bootAt,
        pid: process.pid,
        // 优先最近追踪的活跃会话，否则保留上次的
        lastSessionId: trackedActiveId ?? marker?.lastSessionId ?? null,
        lastActiveAt: trackedActiveAt
          ? new Date(trackedActiveAt).toISOString()
          : marker?.lastActiveAt ?? null,
        ...extra,
      };
      writeFileSync(markerPath, JSON.stringify(doc, null, 2));
    } catch (err) {
      console.warn('[resume-on-restart] could not write marker:', err);
    }
  };
  writeState();

  // 正常关闭（SIGTERM/SIGINT）时记录最近活跃会话，供下次重启参考
  const onSigterm = () => {
    try {
      if (trackedActiveId) writeState({ when: new Date().toISOString() });
    } catch (e) { /* ignore */ }
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.kill(process.pid, 'SIGTERM');
  };
  const onSigint = () => {
    try {
      if (trackedActiveId) writeState({ when: new Date().toISOString() });
    } catch (e) { /* ignore */ }
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.kill(process.pid, 'SIGINT');
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  // 4. 监听 agent 活动事件（追踪最近活跃会话）
  ctx.on('agent/session-start', ({ agent }) => {
    recordActivity(agent);
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    recordActivity(agent);
    return next();
  });

  // 5. 若发生重启，向主 agent 投递信息性消息
  if (wasRestart) {
    ctx.inject(['agents'], (scope) => {
      ctx.effect(() => {
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
        const deliver = (target) => {
          const text = buildNotice({
            bootAt,
            prevBootAt,
            downtimeMs,
            lastSessionId,
            lastActiveAt,
            customNotice: config.notice,
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
          } catch (err) {
            console.warn('[resume-on-restart] deliver failed:', err);
            writeWakeLog(markerDir, String(target.id), false, String(err));
          }
        };
        // 首次立即尝试
        let target = findTarget();
        if (target) { deliver(target); return; }
        // 轮询等待 agent 出现（最长 ~20 秒）
        let waited = 0;
        const MAX_WAIT_MS = 20000;
        const POLL_MS = 500;
        const timer = setInterval(() => {
          waited += POLL_MS;
          target = findTarget();
          if (target) {
            clearInterval(timer);
            deliver(target);
          } else if (waited >= MAX_WAIT_MS) {
            clearInterval(timer);
            console.log('[resume-on-restart] no target agent found after wait, skip wake');
            writeWakeLog(markerDir, null, false, 'no target agent after wait');
          }
        }, POLL_MS);
      });
    });
  } else {
    console.log('[resume-on-restart] no restart detected, boot normal');
  }
}

export { apply, inject, name };
