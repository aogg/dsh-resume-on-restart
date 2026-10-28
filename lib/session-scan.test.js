import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import {
  findSessionRecordFile,
  hasHumanPromptInText,
  isHumanPromptRecord,
  isTurnStartRecord,
  lastTurnStateFromText,
  scanSessionHasHumanPrompt,
  scanSessionLastTurnState,
  turnEndKindOf,
} from './session-scan.js';

/** 运行环境的 node:zlib 是否具备 zstd 能力（node ≥ 23.8 内置；缺失则相关用例 skip）。 */
const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

/** 真实人工输入记录（消息对象直接在 data 上，DSH 会话记录 v4 的常见形状）。 */
const humanRecord = () => ({
  type: 'user/message',
  data: {
    role: 'user',
    content: [{ type: 'text', text: '帮我实现一个功能' }],
    source: { kind: 'user', form: 'prompt', summary: '' },
  },
});

/** 注入消息记录（kind 为插件/规则等非 user 值，不算人工输入）。 */
const injectedRecord = (kind) => ({
  type: 'user/message',
  data: {
    role: 'user',
    content: [{ type: 'text', text: '注入的系统通知' }],
    source: { kind, form: 'notice', summary: 'injected' },
  },
});

/** 消息对象嵌在 data.message 下的少数形状。 */
const nestedHumanRecord = () => ({
  type: 'user/message',
  data: { message: { role: 'user', source: { kind: 'user' } } },
});

// —— isHumanPromptRecord：单条记录的判定 ——

test('isHumanPromptRecord: type=user/message 且 data.source.kind=user → true', () => {
  assert.equal(isHumanPromptRecord(humanRecord()), true);
});

test('isHumanPromptRecord: 消息对象嵌在 data.message 下（少数形状）→ true', () => {
  assert.equal(isHumanPromptRecord(nestedHumanRecord()), true);
});

test('isHumanPromptRecord: 注入消息的 kind（dsh-resume-on-restart 等）→ false', () => {
  for (const kind of ['dsh-resume-on-restart', 'dsh-rules-auto', 'runtime-context', 'time-context']) {
    assert.equal(isHumanPromptRecord(injectedRecord(kind)), false, `kind=${kind} 不算人工输入`);
  }
});

test('isHumanPromptRecord: source 缺失/null/非对象 → false（fail-closed）', () => {
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: { role: 'user' } }), false);
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: { role: 'user', source: null } }), false);
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: { role: 'user', source: 'user' } }), false);
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: { role: 'user', source: ['user'] } }), false);
  // 嵌套形状同样 fail-closed
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: { message: { role: 'user' } } }), false);
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: { message: { role: 'user', source: 1 } } }), false);
});

test('isHumanPromptRecord: type 非 user/message / data 缺失 → false', () => {
  assert.equal(isHumanPromptRecord({ type: 'assistant/message', data: { source: { kind: 'user' } } }), false);
  assert.equal(isHumanPromptRecord({ type: 'user/message' }), false);
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: null }), false);
  assert.equal(isHumanPromptRecord({ type: 'user/message', data: 42 }), false);
});

test('isHumanPromptRecord: 畸形输入一律 false，不抛错', () => {
  for (const bad of [null, undefined, 42, 'user/message', true, [], [{ source: { kind: 'user' } }], {}, () => {}]) {
    assert.equal(isHumanPromptRecord(bad), false);
  }
});

// —— hasHumanPromptInText：JSONL 全文的判定 ——

test('hasHumanPromptInText: 人工记录夹在坏行/注入行之间 → true（命中即返回）', () => {
  const text = [
    JSON.stringify(injectedRecord('dsh-resume-on-restart')),
    '{broken json line', // 损坏行
    JSON.stringify(humanRecord()),
    '', // 空行
    'not json at all', // 损坏行
  ].join('\n');
  assert.equal(hasHumanPromptInText(text), true);
});

test('hasHumanPromptInText: 只有注入消息与坏行 → false', () => {
  const text = [
    JSON.stringify(injectedRecord('dsh-rules-auto')),
    JSON.stringify(injectedRecord('runtime-context')),
    '{truncated',
    '',
  ].join('\n');
  assert.equal(hasHumanPromptInText(text), false);
});

test('hasHumanPromptInText: 空串/纯空白/非字符串 → false，不抛错', () => {
  assert.equal(hasHumanPromptInText(''), false);
  assert.equal(hasHumanPromptInText('   \n\t\n'), false);
  assert.equal(hasHumanPromptInText(null), false);
  assert.equal(hasHumanPromptInText(undefined), false);
  assert.equal(hasHumanPromptInText(42), false);
  assert.equal(hasHumanPromptInText(Buffer.from('x')), false);
});

// —— findSessionRecordFile：目录树探测（临时目录） ——

const UUID_MAIN = '11111111-1111-4111-8111-111111111111';
const UUID_SUB = '22222222-2222-4222-8222-222222222222';

/** 建临时会话目录树：entries 为 [相对路径, 内容] 列表；返回 sessionsRoot。 */
function makeSessionsRoot(t, entries) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-resume-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of entries) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

test('findSessionRecordFile: 主会话目录 session-<uuid> 的 .zstd 文件命中', (t) => {
  const root = makeSessionsRoot(t, [
    [join('--code-www-my-github-proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'), 'compressed-bytes'],
  ]);
  assert.equal(findSessionRecordFile(root, `session-${UUID_MAIN}`), join(root, '--code-www-my-github-proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'));
});

test('findSessionRecordFile: 子代理裸 <uuid> 目录的无压缩文件命中', (t) => {
  const root = makeSessionsRoot(t, [
    [join('--code-www-my-github-proj--', UUID_SUB, 'session.v4.jsonl'), '{"type":"user/message"}\n'],
  ]);
  // 传入裸 uuid 与带 session- 前缀的 id 都能定位到同一路径
  assert.equal(findSessionRecordFile(root, UUID_SUB), join(root, '--code-www-my-github-proj--', UUID_SUB, 'session.v4.jsonl'));
  assert.equal(findSessionRecordFile(root, `session-${UUID_SUB}`), join(root, '--code-www-my-github-proj--', UUID_SUB, 'session.v4.jsonl'));
});

test('findSessionRecordFile: 找不到 → null（含 sessionsRoot 不存在）', (t) => {
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl'), 'x'],
  ]);
  assert.equal(findSessionRecordFile(root, '99999999-9999-4999-8999-999999999999'), null);
  assert.equal(findSessionRecordFile(join(root, 'no-such-dir'), `session-${UUID_MAIN}`), null);
});

test('findSessionRecordFile: 非法 sessionId → null（路径穿越/分隔符/过长/空/非字符串）', (t) => {
  const root = makeSessionsRoot(t, []);
  assert.equal(findSessionRecordFile(root, '../escape'), null);
  assert.equal(findSessionRecordFile(root, 'a/b'), null);
  assert.equal(findSessionRecordFile(root, 'a\\b'), null);
  assert.equal(findSessionRecordFile(root, ''), null);
  assert.equal(findSessionRecordFile(root, 'x'.repeat(201)), null);
  assert.equal(findSessionRecordFile(root, null), null);
  assert.equal(findSessionRecordFile(root, 42), null);
});

// —— scanSessionHasHumanPrompt：真实 zstd 解压的稳定判别 ——

test('scanSessionHasHumanPrompt: 注入+人工记录（zstd 压缩）→ human', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const text = [
    JSON.stringify(injectedRecord('dsh-resume-on-restart')),
    JSON.stringify(injectedRecord('time-context')),
    JSON.stringify(humanRecord()),
    '',
  ].join('\n');
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(text, 'utf8'))],
  ]);
  assert.deepEqual(scanSessionHasHumanPrompt(root, `session-${UUID_MAIN}`), { status: 'human' });
});

test('scanSessionHasHumanPrompt: 只有注入消息（裸 uuid 目录 + 压缩）→ none', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const text = [
    JSON.stringify(injectedRecord('dsh-rules-auto')),
    JSON.stringify(injectedRecord('runtime-context')),
    '',
  ].join('\n');
  const root = makeSessionsRoot(t, [
    [join('--proj--', UUID_SUB, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(text, 'utf8'))],
  ]);
  assert.deepEqual(scanSessionHasHumanPrompt(root, UUID_SUB), { status: 'none' });
});

test('scanSessionHasHumanPrompt: 无压缩 session.v4.jsonl 也能判定 → human', (t) => {
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl'), `${JSON.stringify(nestedHumanRecord())}\n`],
  ]);
  assert.deepEqual(scanSessionHasHumanPrompt(root, `session-${UUID_MAIN}`), { status: 'human' });
});

test('scanSessionHasHumanPrompt: 文件缺失 → unknown/session-file-missing（绝不抛错）', (t) => {
  const root = makeSessionsRoot(t, []);
  assert.deepEqual(scanSessionHasHumanPrompt(root, 'no-such-session'), { status: 'unknown', reason: 'session-file-missing' });
  assert.deepEqual(scanSessionHasHumanPrompt(join(root, 'missing'), 'no-such-session'), { status: 'unknown', reason: 'session-file-missing' });
});

test('scanSessionHasHumanPrompt: .zstd 文件损坏（解压失败）→ unknown/scan-error', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'), 'this is not zstd data'],
  ]);
  assert.deepEqual(scanSessionHasHumanPrompt(root, `session-${UUID_MAIN}`), { status: 'unknown', reason: 'scan-error' });
});

test('scanSessionHasHumanPrompt: 多帧拼接的 .zstd（真实 DSH 形状）→ 人工记录在后续帧也能命中', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  // 实测 DSH 把每批追加的记录各自压缩成一帧后顺序 append；对整文件一次
  // zstdDecompressSync 只解出第一帧（session 头），人工记录在后续帧会被漏判成 none
  const frame1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: UUID_MAIN })}\n`, 'utf8'));
  const frame2 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(injectedRecord('time-context'))}\n`, 'utf8'));
  const frame3 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(humanRecord())}\n`, 'utf8'));
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'), Buffer.concat([frame1, frame2, frame3])],
  ]);
  assert.deepEqual(scanSessionHasHumanPrompt(root, `session-${UUID_MAIN}`), { status: 'human' });
});

test('scanSessionHasHumanPrompt: 多帧拼接且只有注入记录 → none', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const frame1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: UUID_SUB })}\n`, 'utf8'));
  const frame2 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(injectedRecord('dsh-resume-on-restart'))}\n`, 'utf8'));
  const root = makeSessionsRoot(t, [
    [join('--proj--', UUID_SUB, 'session.v4.jsonl.zstd'), Buffer.concat([frame1, frame2])],
  ]);
  assert.deepEqual(scanSessionHasHumanPrompt(root, UUID_SUB), { status: 'none' });
});

// —— 0.17.0：会话最后已知 turn 状态（「正常结束不恢复」的判定源） ——

/** turn/end 记录（与会话日志实测形状一致）。 */
const turnEnd = (turn, kind, seq = 10) => ({
  type: 'turn/end',
  seq,
  time: 1791269422300,
  data: { turn, reason: { kind } },
});

/** turn/start 记录。 */
const turnStart = (turn, seq = 4) => ({
  type: 'turn/start',
  seq,
  time: 1791269422298,
  data: { turn },
});

test('isTurnStartRecord: type=turn/start → true；畸形输入一律 false 不抛错', () => {
  assert.equal(isTurnStartRecord(turnStart(1)), true);
  assert.equal(isTurnStartRecord({ type: 'turn/start' }), true);
  for (const bad of [null, undefined, 42, 'turn/start', [], turnEnd(1, 'completed'), {}, { type: 'turn/end' }]) {
    assert.equal(isTurnStartRecord(bad), false);
  }
});

test('turnEndKindOf: type=turn/end 且 data.reason.kind 非空字符串 → 该 kind', () => {
  assert.equal(turnEndKindOf(turnEnd(1, 'completed')), 'completed');
  assert.equal(turnEndKindOf(turnEnd(1, 'aborted')), 'aborted');
  assert.equal(turnEndKindOf(turnEnd(1, 'future-variant')), 'future-variant');
});

test('turnEndKindOf: 非 turn/end / reason 或 kind 缺失/畸形 → null（不参与状态判定）', () => {
  assert.equal(turnEndKindOf(turnStart(1)), null);
  assert.equal(turnEndKindOf({ type: 'turn/end' }), null);
  assert.equal(turnEndKindOf({ type: 'turn/end', data: {} }), null);
  assert.equal(turnEndKindOf({ type: 'turn/end', data: { turn: 1 } }), null);
  assert.equal(turnEndKindOf({ type: 'turn/end', data: { turn: 1, reason: {} } }), null);
  assert.equal(turnEndKindOf({ type: 'turn/end', data: { turn: 1, reason: { kind: '' } } }), null);
  assert.equal(turnEndKindOf({ type: 'turn/end', data: { turn: 1, reason: null } }), null);
  assert.equal(turnEndKindOf({ type: 'turn/end', data: 42 }), null);
  for (const bad of [null, undefined, 42, 'turn/end', []]) {
    assert.equal(turnEndKindOf(bad), null);
  }
});

test('lastTurnStateFromText: 最后一条 turn/end completed → completed', () => {
  const text = [
    JSON.stringify({ type: 'session', version: 4 }),
    JSON.stringify(turnStart(1)),
    JSON.stringify(turnEnd(1, 'completed', 6)),
  ].join('\n');
  assert.deepEqual(lastTurnStateFromText(text), { status: 'completed', kind: 'completed' });
  // 多轮后停在 completed：只有最后一条作数
  const multi = [
    JSON.stringify(turnStart(1, 4)),
    JSON.stringify(turnEnd(1, 'aborted', 6)),
    JSON.stringify(turnStart(2, 8)),
    JSON.stringify(turnEnd(2, 'completed', 12)),
  ].join('\n');
  assert.deepEqual(lastTurnStateFromText(multi), { status: 'completed', kind: 'completed' });
});

test('lastTurnStateFromText: 最后一条 turn/end 非 completed → ended（各 kind 与未知 variant）', () => {
  for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'future-variant']) {
    const text = [JSON.stringify(turnStart(1)), JSON.stringify(turnEnd(1, kind, 6))].join('\n');
    assert.deepEqual(lastTurnStateFromText(text), { status: 'ended', kind }, `kind=${kind}`);
  }
  // completed 之后又正常跑了一轮失败：以最后的 end 为准
  const regressed = [
    JSON.stringify(turnEnd(1, 'completed', 6)),
    JSON.stringify(turnStart(2, 8)),
    JSON.stringify(turnEnd(2, 'error', 12)),
  ].join('\n');
  assert.deepEqual(lastTurnStateFromText(regressed), { status: 'ended', kind: 'error' });
});

test('lastTurnStateFromText: 最后是 turn/start 无对应 turn/end → open-turn（崩溃/重启打断）', () => {
  // 单 turn 悬空
  assert.deepEqual(
    lastTurnStateFromText([JSON.stringify({ type: 'session', version: 4 }), JSON.stringify(turnStart(1))].join('\n')),
    { status: 'open-turn', kind: null },
  );
  // 前一轮正常结束、新一轮悬空：仍 open-turn（kind 带最后一条 end 的 kind）
  const dangling = [
    JSON.stringify(turnStart(1, 4)),
    JSON.stringify(turnEnd(1, 'completed', 6)),
    JSON.stringify(turnStart(2, 8)),
  ].join('\n');
  assert.deepEqual(lastTurnStateFromText(dangling), { status: 'open-turn', kind: 'completed' });
  // end 在 start 之前的乱序畸形日志：end 闭合此前状态，最后仍以 start 为准
  const weird = [
    JSON.stringify(turnEnd(9, 'completed', 2)),
    JSON.stringify(turnStart(1, 8)),
  ].join('\n');
  assert.deepEqual(lastTurnStateFromText(weird), { status: 'open-turn', kind: 'completed' });
});

test('lastTurnStateFromText: 无任何 turn 事件（含 text 非字符串/空/损坏行）→ no-turns', () => {
  assert.deepEqual(lastTurnStateFromText(JSON.stringify({ type: 'session', version: 4 })), { status: 'no-turns' });
  assert.deepEqual(lastTurnStateFromText(''), { status: 'no-turns' });
  assert.deepEqual(lastTurnStateFromText('   \n\t\n'), { status: 'no-turns' });
  assert.deepEqual(lastTurnStateFromText('{broken json\nnot json'), { status: 'no-turns' });
  assert.deepEqual(lastTurnStateFromText(null), { status: 'no-turns' });
  assert.deepEqual(lastTurnStateFromText(undefined), { status: 'no-turns' });
  assert.deepEqual(lastTurnStateFromText(42), { status: 'no-turns' });
});

test('lastTurnStateFromText: 损坏行跳过不影响判定（turn 记录夹在坏行之间照常识别）', () => {
  const text = [
    '{truncated',
    JSON.stringify(turnStart(1, 4)),
    'not json at all',
    JSON.stringify(turnEnd(1, 'completed', 6)),
    '',
  ].join('\n');
  assert.deepEqual(lastTurnStateFromText(text), { status: 'completed', kind: 'completed' });
});

test('scanSessionLastTurnState: 多帧 zstd（真实 DSH 形状）→ 最后一条 turn/end kind 判定', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const frame1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: UUID_MAIN })}\n`, 'utf8'));
  const frame2 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(turnStart(1, 4))}\n`, 'utf8'));
  const frame3 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(turnEnd(1, 'completed', 6))}\n`, 'utf8'));
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'), Buffer.concat([frame1, frame2, frame3])],
  ]);
  assert.deepEqual(scanSessionLastTurnState(root, `session-${UUID_MAIN}`), { status: 'completed', kind: 'completed' });
});

test('scanSessionLastTurnState: 无压缩 jsonl 的 aborted → ended（不恢复口径外照样恢复）', (t) => {
  const root = makeSessionsRoot(t, [
    [join('--proj--', UUID_SUB, 'session.v4.jsonl'), `${JSON.stringify(turnEnd(1, 'aborted'))}\n`],
  ]);
  assert.deepEqual(scanSessionLastTurnState(root, UUID_SUB), { status: 'ended', kind: 'aborted' });
});

test('scanSessionLastTurnState: 悬空 turn/start（zstd）→ open-turn', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const frame1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(turnEnd(1, 'completed', 6))}\n`, 'utf8'));
  const frame2 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(turnStart(2, 8))}\n`, 'utf8'));
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'), Buffer.concat([frame1, frame2])],
  ]);
  assert.deepEqual(scanSessionLastTurnState(root, `session-${UUID_MAIN}`), { status: 'open-turn', kind: 'completed' });
});

test('scanSessionLastTurnState: 文件缺失 → unknown/session-file-missing（保守恢复，绝不抛错）', (t) => {
  const root = makeSessionsRoot(t, []);
  assert.deepEqual(scanSessionLastTurnState(root, 'no-such-session'), { status: 'unknown', reason: 'session-file-missing' });
  assert.deepEqual(scanSessionLastTurnState(join(root, 'missing'), 'x'), { status: 'unknown', reason: 'session-file-missing' });
});

test('scanSessionLastTurnState: .zstd 损坏（解压失败）→ unknown/scan-error（保守恢复）', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const root = makeSessionsRoot(t, [
    [join('--proj--', `session-${UUID_MAIN}`, 'session.v4.jsonl.zstd'), 'not zstd at all'],
  ]);
  assert.deepEqual(scanSessionLastTurnState(root, `session-${UUID_MAIN}`), { status: 'unknown', reason: 'scan-error' });
});
