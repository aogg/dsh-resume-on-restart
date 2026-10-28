import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

/**
 * 会话记录扫描（0.6.0 新增）：判定一个会话是否有过真实人工输入。
 *
 * 背景（0.5.x 事故）：重启后"恢复候选投递"与"fallback 唤醒"都可能命中一个从未
 * 有过任何用户输入的空会话，"检测到 DSH 服务已重启……请自主决定下一步"的通知
 * 灌进去后，模型无人指示自主跑了一轮真实工作。因此自动激活前必须先判定目标
 * 会话有过真实人工输入，没有（或判定不了）就不投递。
 *
 * 判定口径（实测 DSH 会话记录 v4）：
 * - 会话记录文件：`<DSH_HOME>/sessions/<项目目录>/[session-]<id>/session.v4.jsonl.zstd`，
 *   也兼容无压缩的 `session.v4.jsonl`。项目目录名形如 `--code-www-my-github-xxx--`，
 *   其下主会话目录为 `session-<uuid>`、子代理会话目录为裸 `<uuid>`。
 * - 记录为 JSONL，每行一个 JSON。真实人工输入 = 存在某行 `type === 'user/message'`
 *   且其消息对象 `source.kind === 'user'`。消息对象通常直接在 `data` 上
 *   （`data.role === 'user'`、`data.source.kind`），少数类型嵌在 `data.message` 下，
 *   两种形状都兼容。插件/规则注入消息的 kind 是其它值（如 `dsh-resume-on-restart`、
 *   `dsh-rules-auto`、`runtime-context`、`time-context`），不算人工输入；
 *   `source` 缺失一律视为非人工（fail-closed 方向）。
 * - 解压用 node:zlib 的 `zstdDecompressSync`（node ≥ 23.8 内置；运行时以
 *   `typeof zlib.zstdDecompressSync === 'function'` 探测，不支持则判 unknown）。
 *   实测 DSH 的 `session.v4.jsonl.zstd` 不是单个 zstd 流，而是把每批追加的记录
 *   各自压缩成一帧后顺序拼接（多个 zstd frame 首尾相连）：对整文件一次
 *   `zstdDecompressSync` 只解出第一帧（通常是 `session` 头），后续全部记录都被
 *   漏掉，真实会话会被误判成 none。因此解压按 zstd 帧魔法号（`28 B5 2F FD`）
 *   切片逐帧解后拼接；个别帧解不出（崩溃截断等）跳过该帧尽力而为——少读记录
 *   只会往 none（拦截）方向错，不会往 human（放行）方向错。
 *
 * 全部函数都绝不抛错：畸形输入按"非人工/未命中"处理；fs/解压异常归入
 * `{ status: 'unknown', reason: 'scan-error' }`，由调用方按 fail-closed 跳过投递。
 *
 * 0.17.0 新增：会话"最后已知 turn 状态"扫描（scanSessionLastTurnState 及其
 * 纯函数底座 lastTurnStateFromText / isTurnStartRecord / turnEndKindOf）——
 * 「正常结束（最后一条真实 turn/end kind === 'completed'）的会话重启后不再恢复」
 * 的判定源；文件定位与多帧 zstd 解压复用人工输入扫描的同一套读取器，
 * 扫描失败归入 unknown，由调用方按保守口径（照旧恢复）处理。
 */

/** findSessionRecordFile 的 sessionId 长度上限（与宿主 state 路由的口径一致）。 */
const MAX_SESSION_ID_LENGTH = 200;

/** zstd 帧魔法号 `28 B5 2F FD`（每帧都以它开头，用于切分拼接的多帧文件）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解压 `.zstd` 会话记录为 UTF-8 文本（需运行环境具备 zlib.zstdDecompressSync）。
 *
 * DSH 的记录文件是多帧拼接：每批追加的记录各自 `zstdCompressSync` 成一帧后顺序
 * append。`zstdDecompressSync(整文件)` 只解第一帧，因此这里按帧魔法号切片逐帧
 * 解后拼接；若某帧切片解压失败（可能是魔法号恰好出现在压缩载荷里的假切分，或
 * 崩溃导致的截断尾帧），向后合并一段再试，仍失败则跳过该段继续（尽力而为，
 * 少读的记录只会让结果偏向 none/拦截，不会偏向 human/放行）。
 * 整个文件一帧都解不出时抛错，由调用方归入 scan-error。
 *
 * @param {Buffer} raw 文件原始字节
 * @returns {string} 拼接后的 JSONL 全文
 */
function decompressZstdFrames(raw) {
  // 收集全部帧魔法号出现位置（候选帧边界；压缩载荷里也可能凑巧出现假边界）
  const positions = [];
  for (let pos = raw.indexOf(ZSTD_MAGIC); pos !== -1; pos = raw.indexOf(ZSTD_MAGIC, pos + 1)) {
    positions.push(pos);
  }
  if (positions.length === 0 || positions[0] !== 0) {
    throw new Error('not a zstd session record (no frame magic at offset 0)');
  }
  let text = '';
  let index = 0;
  while (index < positions.length) {
    let end = index + 1;
    let decoded = null;
    // 先按相邻边界切片解；失败则合并下一段再试（消化假切分/截断段）
    while (decoded === null) {
      const from = positions[index];
      const to = end < positions.length ? positions[end] : raw.length;
      try {
        decoded = zlib.zstdDecompressSync(raw.subarray(from, to));
      } catch {
        end += 1;
        if (end > positions.length) break; // 从这里到文件尾都解不出：当作截断段跳过
      }
    }
    if (decoded !== null) text += decoded.toString('utf8');
    else console.warn(`[resume-on-restart] skipped undecodable zstd frame at offset ${positions[index]}`);
    index = end;
  }
  return text;
}

/**
 * 单条会话记录是否是"真实人工输入"（纯函数，便于单元测试）。
 *
 * 口径：`type === 'user/message'` 且消息对象 `source.kind === 'user'`。消息对象
 * 通常直接在 `data` 上，少数嵌在 `data.message` 下，两种形状都兼容；`source`
 * 缺失/非对象视为非人工（fail-closed）。任何畸形输入返回 false，绝不抛错。
 *
 * @param {unknown} entry 单条解析后的记录对象
 * @returns {boolean}
 */
export function isHumanPromptRecord(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.type !== 'user/message') return false;
  const data = entry.data;
  if (data === null || typeof data !== 'object') return false;
  // 消息对象两种形状：通常直接在 data 上；少数类型嵌在 data.message 下
  for (const message of [data, data.message]) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
    const { source } = message;
    // source 缺失/非对象一律视为非人工（fail-closed：判定不了就不当人工输入）
    if (source === null || typeof source !== 'object' || Array.isArray(source)) continue;
    if (source.kind === 'user') return true;
  }
  return false;
}

/**
 * 在会话记录全文（JSONL 文本）中是否存在至少一条真实人工输入（纯函数）。
 * 按行 split 后逐行 try/catch JSON.parse（损坏行跳过，不影响其余行），
 * 命中一条人工记录立即返回 true；全部解析完没有返回 false；text 非字符串返回 false。
 *
 * @param {unknown} text 会话记录文件解压/读取后的全文
 * @returns {boolean}
 */
export function hasHumanPromptInText(text) {
  if (typeof text !== 'string') return false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // 损坏行（可能被截断/手改）跳过：单行损坏不得影响其余行的判定
    }
    if (isHumanPromptRecord(entry)) return true;
  }
  return false;
}

/**
 * 在 sessionsRoot（`<DSH_HOME>/sessions`）下定位某会话的记录文件（同步 fs）。
 * 项目子目录下的会话目录有两种形状：主会话 `session-<uuid>`、子代理会话裸
 * `<uuid>`；文件有 `.zstd` 压缩与无压缩两种变体。按既定顺序逐个探测，
 * 存在即返回该绝对路径；找不到/sessionsRoot 不存在返回 null。
 * sessionId 非法（非非空字符串、长度 > 200、含 `/`、`\` 或 `..`）返回 null。
 *
 * @param {string} sessionsRoot 会话根目录（`<DSH_HOME>/sessions`）
 * @param {string} sessionId 会话 id（可带 `session-` 前缀，剥离一次得到 uuid）
 * @returns {string|null}
 */
export function findSessionRecordFile(sessionsRoot, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) return null;
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) return null;
  // 主会话目录带 `session-` 前缀，剥离一次得到 uuid（子代理会话目录本就是裸 uuid）
  const uuid = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
  if (!uuid) return null;
  let projectDirs;
  try {
    projectDirs = readdirSync(sessionsRoot);
  } catch {
    return null; // sessionsRoot 不存在（或不可读）→ 视为找不到
  }
  for (const projectDir of projectDirs) {
    for (const candidate of [
      join(sessionsRoot, projectDir, `session-${uuid}`, 'session.v4.jsonl.zstd'),
      join(sessionsRoot, projectDir, uuid, 'session.v4.jsonl.zstd'),
      join(sessionsRoot, projectDir, `session-${uuid}`, 'session.v4.jsonl'),
      join(sessionsRoot, projectDir, uuid, 'session.v4.jsonl'),
    ]) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // 该目录形状/文件变体不存在：探测下一个，不记日志（逐项探测本就是预期失败的流程）
      }
    }
  }
  return null;
}

/**
 * 扫描某会话是否有过真实人工输入（稳定判别，绝不抛错）：
 * - `{ status: 'human' }`：存在真实人工输入，允许自动激活；
 * - `{ status: 'none' }`：能读到记录但没有任何真实人工输入，禁止自动激活；
 * - `{ status: 'unknown', reason }`：判定不了（session-file-missing /
 *   zstd-unsupported / scan-error），调用方按 fail-closed 禁止自动激活。
 *
 * @param {string} sessionsRoot 会话根目录（`<DSH_HOME>/sessions`）
 * @param {string} sessionId 会话 id（可带 `session-` 前缀）
 * @returns {{status: 'human'}|{status: 'none'}|{status: 'unknown', reason: string}}
 */
export function scanSessionHasHumanPrompt(sessionsRoot, sessionId) {
  try {
    const file = findSessionRecordFile(sessionsRoot, sessionId);
    if (!file) return { status: 'unknown', reason: 'session-file-missing' };
    const isZstd = file.endsWith('.zstd');
    // node < 23.8 的 zlib 没有 zstd 内置解压：判定不了按 unknown 处理（fail-closed）
    if (isZstd && typeof zlib.zstdDecompressSync !== 'function') {
      return { status: 'unknown', reason: 'zstd-unsupported' };
    }
    const raw = readFileSync(file);
    const text = isZstd ? decompressZstdFrames(raw) : raw.toString('utf8');
    return { status: hasHumanPromptInText(text) ? 'human' : 'none' };
  } catch (err) {
    console.warn('[resume-on-restart] session human-prompt scan failed:', err);
    return { status: 'unknown', reason: 'scan-error' };
  }
}

// ---- 0.17.0 新增：会话最后已知 turn 状态扫描（「正常结束不恢复」的判定源） ----
//
// 背景（0.17.0）：0.10.0 恢复口径反转后，最近活跃窗口内全部会话（含正常结束的）
// 重启后都会被恢复——用户明确不要恢复"正常收工"的会话。过滤主判据用会话日志扫描：
// 事件内存态会因崩溃丢失，重启后日志已完整落盘，是唯一真源。判定口径（实测 DSH
// 会话记录 v4，宿主 dsh-agent-loop 经 session.append 落盘、crash 孤儿 turn 由
// repair 补写 interrupted closer）：
// - `turn/end`（`data.reason.kind`）是最后已知状态的权威：kind === 'completed'
//   即"正常结束"；
// - 最后是 `turn/start` 无后续 turn/end → turn 开着被崩溃/重启打断；
// - 其余 kind（aborted/blocked/error/max-tokens/interrupted/forked 及插件扩展的
//   未知 variant）都算"不是正常结束"；
// - 文件缺失/解压失败/解析异常 → `{ status: 'unknown' }`，调用方保守恢复
//   （宁可多恢复，避免漏掉正在干活的会话）。

/**
 * 单条会话记录是否是 turn/start（纯函数，防御式；畸形输入 false，绝不抛错）。
 * @param {unknown} entry 单条解析后的记录对象
 * @returns {boolean}
 */
export function isTurnStartRecord(entry) {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry.type === 'turn/start';
}

/**
 * 单条会话记录的 turn/end kind（纯函数，防御式）：`type === 'turn/end'` 且
 * `data.reason.kind` 为非空字符串时返回该 kind；其余（非 turn/end、reason/kind
 * 缺失或形状不对）一律 null——这类记录不参与最后已知状态判定。绝不抛错。
 * @param {unknown} entry 单条解析后的记录对象
 * @returns {string|null}
 */
export function turnEndKindOf(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (entry.type !== 'turn/end') return null;
  const data = entry.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const reason = data.reason;
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) return null;
  return typeof reason.kind === 'string' && reason.kind ? reason.kind : null;
}

/**
 * 从会话记录全文（JSONL 文本）判定"最后已知 turn 状态"（纯函数，便于单元测试）。
 * 逐行 try/catch JSON.parse（损坏行跳过，不影响其余行），按出现顺序跟踪：
 * - `turn/start` → 该 turn 开着；
 * - `turn/end` → 该 turn 闭合，记录其 kind（宿主 invariant 保证 end 匹配开着的
 *   turn；畸形日志里 end 不匹配/无 start 也按"闭合此前状态"处理——只认最后一条）。
 * 全部读完：
 * - 最后相关事件是 turn/end 且 kind === 'completed' → `{ status: 'completed', kind }`；
 * - 最后相关事件是 turn/end 且 kind 非.completed → `{ status: 'ended', kind }`；
 * - 最后相关事件是 turn/start（无后续 end）→ `{ status: 'open-turn', kind }`
 *   （kind 为最后一条 turn/end 的 kind 或 null）；
 * - 全文没有任何 turn 事件（含 text 非字符串/空）→ `{ status: 'no-turns' }`。
 * 三种非 completed 状态都交给调用方按"不是正常结束 → 恢复"处理。
 * @param {unknown} text 会话记录文件解压/读取后的全文
 * @returns {{status: 'completed', kind: string}|{status: 'ended', kind: string}|{status: 'open-turn', kind: string|null}|{status: 'no-turns'}}
 */
export function lastTurnStateFromText(text) {
  let hasOpenTurn = false;
  let lastEndKind = null;
  if (typeof text === 'string') {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // 损坏行（可能被截断/手改）跳过：单行损坏不得影响其余行的判定
      }
      if (isTurnStartRecord(entry)) {
        hasOpenTurn = true;
        continue;
      }
      const kind = turnEndKindOf(entry);
      if (kind !== null) {
        hasOpenTurn = false;
        lastEndKind = kind;
      }
    }
  }
  if (hasOpenTurn) return { status: 'open-turn', kind: lastEndKind };
  if (lastEndKind === null) return { status: 'no-turns' };
  return lastEndKind === 'completed'
    ? { status: 'completed', kind: 'completed' }
    : { status: 'ended', kind: lastEndKind };
}

/**
 * 扫描某会话"最后已知 turn 状态"（稳定判别，绝不抛错）。文件定位与解压复用
 * 人工输入扫描的同一套读取器（findSessionRecordFile + 多帧 zstd 拼接解压）：
 * - `lastTurnStateFromText` 的四种结果之一：日志可读时的判定；
 * - `{ status: 'unknown', reason }`：判定不了（session-file-missing /
 *   zstd-unsupported / scan-error），调用方按保守口径恢复（宁可多恢复）。
 * @param {string} sessionsRoot 会话根目录（`<DSH_HOME>/sessions`）
 * @param {string} sessionId 会话 id（可带 `session-` 前缀）
 * @returns {{status: 'completed', kind: string}|{status: 'ended', kind: string}|{status: 'open-turn', kind: string|null}|{status: 'no-turns'}|{status: 'unknown', reason: string}}
 */
export function scanSessionLastTurnState(sessionsRoot, sessionId) {
  try {
    const file = findSessionRecordFile(sessionsRoot, sessionId);
    if (!file) return { status: 'unknown', reason: 'session-file-missing' };
    const isZstd = file.endsWith('.zstd');
    // node < 23.8 的 zlib 没有 zstd 内置解压：判定不了按 unknown 处理（保守恢复）
    if (isZstd && typeof zlib.zstdDecompressSync !== 'function') {
      return { status: 'unknown', reason: 'zstd-unsupported' };
    }
    const raw = readFileSync(file);
    const text = isZstd ? decompressZstdFrames(raw) : raw.toString('utf8');
    return lastTurnStateFromText(text);
  } catch (err) {
    console.warn('[resume-on-restart] session last-turn-state scan failed:', err);
    return { status: 'unknown', reason: 'scan-error' };
  }
}
