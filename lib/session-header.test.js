/**
 * 0.33.0 冷会话 header 磁盘读取（lib/session-scan.js 新增的
 * readSessionHeaderFromDisk / sessionHeaderFromLine / SESSION_HEADER_READ_SIZES）
 * 单元测试（node --test，无 e2e、不起任何服务、不碰真实 ~/.dsh）。
 *
 * 「冷会话」= 本进程没有活 agent、会话记录只落在磁盘上的会话（重启前被打断、
 * 恢复前尚未加载进 session store 的会话）；「热会话」= session store 里有活
 * Session 的会话。宿主的 sessions store 只对热会话有条目，冷会话
 * `get(id)` 返回 undefined → 拿不到 header → 认不出 subagent。本文件的函数就是
 * 冷会话 header 的唯一数据源（磁盘记录首行）。
 *
 * 覆盖口径：
 * 1. SESSION_HEADER_READ_SIZES：4KB 起倍增、上限 1MB（绝不整文件读的预算梯度）；
 * 2. sessionHeaderFromLine：实测 DSH 首行形状（origin/parentSession 在顶层）与
 *    防御式嵌套 header 形状、坏 JSON/非对象/空行一律 unknown；
 * 3. 真实临时多帧 zstd 文件（帧 1 = header，帧 2/3 = 其它记录，其中一个伪 header
 *    故意写成 origin:'fork'）→ 只解第一帧，取到的是帧 1 的 header；
 * 4. 首帧压缩后 > 4KB（随机载荷不可压缩）→ 4KB 读不出、按梯度加大到 16KB 才成功；
 * 5. 截断首帧 / 非 zstd 数据 → unknown/zstd-decode-error（绝不抛错）；
 * 6. 未压缩 `session.v4.jsonl` 只取首行（第二行的伪 header 不生效）；
 * 7. 无 zstd 环境（删掉 zlib.zstdDecompressSync 模拟 node < 23.8）→ 判定不了
 *    （unknown/zstd-unsupported），未压缩形态照常可读；
 * 8. id 非法（含 `..`、`/`、`\`、超长、空、非字符串）→ unknown/invalid-session-id；
 *    文件缺失（含 sessionsRoot 不存在）→ unknown/session-file-missing；
 * 9. **只读前几 KB 的证据**：10MB 文件（首帧 header + 9.9MB 填充）注入 readHead
 *    记录请求尺寸——正好一次 4096 字节请求就停（绝不整文件读），默认实现读同一
 *    文件也照常拿到 header。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import {
  SESSION_HEADER_READ_SIZES,
  readSessionHeaderFromDisk,
  sessionHeaderFromLine,
} from './session-scan.js';

/** 运行环境的 node:zlib 是否具备 zstd 能力（node ≥ 23.8 内置；缺失则相关用例 skip）。 */
const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';

/** 冷 subagent 会话 id（沿用实测事故里的真实 id 形状）与它的父会话 id。 */
const SUB_ID = '9ae5a36c-f8a4-47ab-a576-8b26bb3498fb';
const PARENT_ID = 'session-b1827f5a-a5e2-4650-83e8-eb072b98ae6a';

/** 会话记录首行 header（实测 DSH 形状：type/version/id + cwd + parentSession/origin）。 */
const headerRecord = (overrides = {}) => ({
  type: 'session',
  version: 4,
  id: SUB_ID,
  createdAt: 1794029836193,
  cwd: '/code/www/my/gitee/my-ai',
  ...overrides,
});

/** JSONL 行文本。 */
const jsonl = (obj) => `${JSON.stringify(obj)}\n`;

/** 单行文本压成一帧（真实会话记录 = 每批追加各压一帧后顺序拼接）。 */
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));

/**
 * 建临时 sessionsRoot 并写会话记录：entries 为 [相对路径, 内容(Buffer|string)]；
 * 返回 sessionsRoot 绝对路径（断言里拼路径用）。
 */
function makeSessionsRoot(t, entries = []) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ror-header-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of entries) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

/** 冷 subagent 会话记录的相对路径（子代理会话目录是裸 uuid）。 */
const zstdRecordPath = () => join('--code-www-my-gitee-my-ai--', SUB_ID, 'session.v4.jsonl.zstd');
const jsonlRecordPath = () => join('--code-www-my-gitee-my-ai--', SUB_ID, 'session.v4.jsonl');

// —— SESSION_HEADER_READ_SIZES：读取量预算梯度 ——

test('SESSION_HEADER_READ_SIZES: 4KB 起逐级 ×4、上限 1MB（绝不整文件读的预算）', () => {
  assert.deepEqual([...SESSION_HEADER_READ_SIZES], [4096, 16384, 65536, 262144, 1048576]);
  assert.equal(SESSION_HEADER_READ_SIZES[0], 4096, '梯度必须从 4KB 起（首帧通常只有几百字节）');
  for (let index = 1; index < SESSION_HEADER_READ_SIZES.length; index += 1) {
    assert.equal(SESSION_HEADER_READ_SIZES[index], SESSION_HEADER_READ_SIZES[index - 1] * 4);
  }
  assert.ok(SESSION_HEADER_READ_SIZES[SESSION_HEADER_READ_SIZES.length - 1] <= 1024 * 1024, '上限不得超过 1MB');
  assert.ok(Object.isFrozen(SESSION_HEADER_READ_SIZES), '梯度是常量，不允许运行期被改');
});

// —— sessionHeaderFromLine：首行 → header 对象（纯函数） ——

test('sessionHeaderFromLine: 实测形状（origin/parentSession 直接在首行对象上）→ ok', () => {
  const result = sessionHeaderFromLine(JSON.stringify(headerRecord({
    origin: 'subagent',
    parentSession: PARENT_ID,
    delegationDepth: 1,
  })));
  assert.equal(result.status, 'ok');
  assert.equal(result.header.origin, 'subagent');
  assert.equal(result.header.parentSession, PARENT_ID);
  assert.equal(result.header.cwd, '/code/www/my/gitee/my-ai');
});

test('sessionHeaderFromLine: 防御式嵌套 header 形状 → 取嵌套对象', () => {
  const nested = sessionHeaderFromLine(JSON.stringify({ type: 'session', header: { origin: 'subagent', parentSession: PARENT_ID } }));
  assert.equal(nested.status, 'ok');
  assert.equal(nested.header.origin, 'subagent');
  // 外层自身带 origin/parentSession 时优先外层（未来嵌套也不误取）
  const outer = sessionHeaderFromLine(JSON.stringify({ origin: 'fork', header: { origin: 'subagent' } }));
  assert.equal(outer.status, 'ok');
  assert.equal(outer.header.origin, 'fork');
});

test('sessionHeaderFromLine: 坏 JSON / 非对象 / 数组 / 空行 → unknown（绝不抛错）', () => {
  assert.deepEqual(sessionHeaderFromLine('{broken json'), { status: 'unknown', reason: 'session-header-parse-error' });
  assert.deepEqual(sessionHeaderFromLine('[1,2,3]'), { status: 'unknown', reason: 'session-header-not-object' });
  assert.deepEqual(sessionHeaderFromLine('"just a string"'), { status: 'unknown', reason: 'session-header-not-object' });
  assert.deepEqual(sessionHeaderFromLine('42'), { status: 'unknown', reason: 'session-header-not-object' });
  assert.deepEqual(sessionHeaderFromLine('null'), { status: 'unknown', reason: 'session-header-not-object' });
  assert.deepEqual(sessionHeaderFromLine(''), { status: 'unknown', reason: 'session-header-empty' });
  assert.deepEqual(sessionHeaderFromLine('   '), { status: 'unknown', reason: 'session-header-empty' });
  assert.deepEqual(sessionHeaderFromLine(null), { status: 'unknown', reason: 'session-header-empty' });
  assert.deepEqual(sessionHeaderFromLine(42), { status: 'unknown', reason: 'session-header-empty' });
});

// —— 真实多帧 zstd 文件：只解第一帧 ——

test('readSessionHeaderFromDisk: 真实多帧 zstd（首帧 header + 后续记录/伪 header）→ 取首帧 header', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const frames = Buffer.concat([
    // 帧 1：首行 session header（DSH 每批追加的记录各压一帧，首帧恒为 header）
    frame(jsonl(headerRecord({ origin: 'subagent', parentSession: PARENT_ID, delegationDepth: 1 }))),
    // 帧 2：一条人工输入记录
    frame(jsonl({ type: 'user/message', data: { role: 'user', source: { kind: 'user' } } })),
    // 帧 3：伪 header（origin 不同）——只解第一帧，绝不能取到它
    frame(jsonl(headerRecord({ origin: 'fork' }))),
  ]);
  const root = makeSessionsRoot(t, [[zstdRecordPath(), frames]]);
  const result = readSessionHeaderFromDisk(root, SUB_ID);
  assert.equal(result.status, 'ok');
  assert.equal(result.header.origin, 'subagent', '必须是首帧 header，而不是后续帧里的伪 header');
  assert.equal(result.header.parentSession, PARENT_ID);
  // 带 session- 前缀的 id 也能定位同一条记录
  const prefixed = readSessionHeaderFromDisk(root, `session-${SUB_ID}`);
  assert.equal(prefixed.status, 'ok');
  assert.equal(prefixed.header.parentSession, PARENT_ID);
});

test('readSessionHeaderFromDisk: 首帧压缩后 > 4KB → 4KB 读不出首帧，按梯度加大到 16KB 成功', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  // 随机载荷不可压缩：确保首帧压缩后明显大于 4KB，第一次 4KB 读取必然解不出
  const bigNote = randomBytes(6000).toString('base64');
  const first = frame(jsonl(headerRecord({ origin: 'subagent', parentSession: PARENT_ID, note: bigNote })));
  assert.ok(first.length > 4096, `首帧应大于 4KB（实际 ${first.length}）`);
  const root = makeSessionsRoot(t, [[
    zstdRecordPath(),
    Buffer.concat([first, frame(jsonl({ type: 'user/message', data: { role: 'user', source: { kind: 'user' } } }))]),
  ]]);
  const requests = [];
  const result = readSessionHeaderFromDisk(root, SUB_ID, {
    readHead: (file, size) => {
      requests.push(size);
      // 首帧就在文件开头：返回文件前 size 字节（测试内用内存 buffer 代替真实 pread）
      return first.subarray(0, size);
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.header.parentSession, PARENT_ID);
  assert.equal(result.header.note, bigNote);
  assert.deepEqual(requests, [4096, 16384], '4KB 解不出首帧 → 加大到 16KB 后首帧可解即停');
});

test('readSessionHeaderFromDisk: 截断首帧 / 非 zstd 数据 → unknown（zstd-decode-error，不抛错）', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const full = frame(jsonl(headerRecord({ origin: 'subagent', parentSession: PARENT_ID })));
  const truncated = full.subarray(0, Math.max(1, Math.floor(full.length * 0.6)));
  const truncatedRoot = makeSessionsRoot(t, [[zstdRecordPath(), truncated]]);
  assert.deepEqual(readSessionHeaderFromDisk(truncatedRoot, SUB_ID), { status: 'unknown', reason: 'zstd-decode-error' });

  const garbageRoot = makeSessionsRoot(t, [[zstdRecordPath(), Buffer.from('this is not zstd data')]]);
  assert.deepEqual(readSessionHeaderFromDisk(garbageRoot, SUB_ID), { status: 'unknown', reason: 'zstd-decode-error' });
});

// —— 未压缩 session.v4.jsonl：只取首行 ——

test('readSessionHeaderFromDisk: 未压缩 .jsonl 只取首行（第二行的伪 header 不生效）', (t) => {
  const root = makeSessionsRoot(t, [[
    jsonlRecordPath(),
    `${jsonl(headerRecord({ origin: 'subagent', parentSession: PARENT_ID }))}${jsonl(headerRecord({ origin: 'fork' }))}{broken line\n`,
  ]]);
  const result = readSessionHeaderFromDisk(root, SUB_ID);
  assert.equal(result.status, 'ok');
  assert.equal(result.header.origin, 'subagent');
  assert.equal(result.header.parentSession, PARENT_ID);
});

test('readSessionHeaderFromDisk: 未压缩文件首行坏 JSON / 非对象 / 空文件 → unknown', (t) => {
  const brokenRoot = makeSessionsRoot(t, [[jsonlRecordPath(), '{broken\n']]);
  assert.deepEqual(readSessionHeaderFromDisk(brokenRoot, SUB_ID), { status: 'unknown', reason: 'session-header-parse-error' });

  const arrayRoot = makeSessionsRoot(t, [[jsonlRecordPath(), '[1,2,3]\n']]);
  assert.deepEqual(readSessionHeaderFromDisk(arrayRoot, SUB_ID), { status: 'unknown', reason: 'session-header-not-object' });

  const emptyRoot = makeSessionsRoot(t, [[jsonlRecordPath(), '']]);
  assert.deepEqual(readSessionHeaderFromDisk(emptyRoot, SUB_ID), { status: 'unknown', reason: 'session-header-incomplete' });
});

// —— 无 zstd 环境降级（node < 23.8） ——

test('readSessionHeaderFromDisk: 无 zlib.zstdDecompressSync 环境 → zstd-unsupported，未压缩形态照常可读', (t) => {
  const zstdRoot = makeSessionsRoot(t, [[zstdRecordPath(), Buffer.from('compressed-bytes')]]);
  const jsonlRoot = makeSessionsRoot(t, [[jsonlRecordPath(), jsonl(headerRecord({ origin: 'subagent', parentSession: PARENT_ID }))]]);
  const original = zlib.zstdDecompressSync;
  // 模拟 node < 23.8：运行时探测拿不到内置 zstd 解压（每个测试文件独立进程，
  // 本用例 finally 恢复，绝不影响同文件其余用例）
  delete zlib.zstdDecompressSync;
  try {
    assert.equal(typeof zlib.zstdDecompressSync, 'undefined');
    assert.deepEqual(readSessionHeaderFromDisk(zstdRoot, SUB_ID), { status: 'unknown', reason: 'zstd-unsupported' });
    const jsonlResult = readSessionHeaderFromDisk(jsonlRoot, SUB_ID);
    assert.equal(jsonlResult.status, 'ok');
    assert.equal(jsonlResult.header.parentSession, PARENT_ID);
  } finally {
    if (original !== undefined) zlib.zstdDecompressSync = original;
  }
  assert.equal(typeof zlib.zstdDecompressSync, 'function', '环境必须恢复（默认读取路径依赖它）');
});

// —— id 非法 / 文件缺失 ——

test('readSessionHeaderFromDisk: id 非法（穿越/分隔符/超长/空/非字符串）→ invalid-session-id', (t) => {
  const root = makeSessionsRoot(t);
  for (const bad of ['../escape', 'a/b', 'a\\b', '', 'x'.repeat(201), null, undefined, 42, {}]) {
    assert.deepEqual(
      readSessionHeaderFromDisk(root, bad),
      { status: 'unknown', reason: 'invalid-session-id' },
      `id=${JSON.stringify(bad)} 应判非法`,
    );
  }
});

test('readSessionHeaderFromDisk: 文件缺失（含 sessionsRoot 不存在）→ session-file-missing', (t) => {
  const root = makeSessionsRoot(t);
  assert.deepEqual(readSessionHeaderFromDisk(root, SUB_ID), { status: 'unknown', reason: 'session-file-missing' });
  assert.deepEqual(
    readSessionHeaderFromDisk(join(root, 'no-such-dir'), SUB_ID),
    { status: 'unknown', reason: 'session-file-missing' },
  );
});

// —— 「只读前几 KB」的证据 ——

test('readSessionHeaderFromDisk: 10MB 文件首帧可解即停——注入 readHead 只被请求一次 4096 字节', { skip: HAS_ZSTD ? false : 'node zlib lacks zstd' }, (t) => {
  const first = frame(jsonl(headerRecord({ origin: 'subagent', parentSession: PARENT_ID })));
  // 真实会话记录可达数十 MB：这里首帧之后塞 10MB 填充（绝不该被读到）
  const big = Buffer.concat([first, Buffer.alloc(10 * 1024 * 1024, 0x20)]);
  const root = makeSessionsRoot(t, [[zstdRecordPath(), big]]);

  // 默认实现（真实 fs、按偏移只读文件头）照常拿到 header
  const viaFs = readSessionHeaderFromDisk(root, SUB_ID);
  assert.equal(viaFs.status, 'ok');
  assert.equal(viaFs.header.parentSession, PARENT_ID);

  // 注入读盘点：记录每次请求的字节数（证明实现只问 4096 字节、拿到首帧就停）
  const requests = [];
  const viaProbe = readSessionHeaderFromDisk(root, SUB_ID, {
    readHead: (file, size) => {
      requests.push(size);
      return big.subarray(0, size);
    },
  });
  assert.equal(viaProbe.status, 'ok');
  assert.deepEqual(requests, [4096], '首帧可解即停：只有一次 4096 字节请求，绝不整文件读');
  assert.equal(requests.reduce((sum, size) => sum + size, 0), 4096);
  assert.ok(big.length > 10 * 1024 * 1024, `文件远大于读取量（文件 ${big.length} 字节，只读 4096）`);
});
