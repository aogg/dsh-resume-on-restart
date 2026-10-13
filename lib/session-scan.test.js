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
  scanSessionHasHumanPrompt,
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
