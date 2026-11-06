/**
 * 0.29.0「技能调用统计」纯函数单测（node --test，无 e2e、不起任何服务）。
 *
 * 直接 import lib/skill-usage.js 断言**全部导出**（范式照抄 lib/auto-restart.test.js：
 * 真实临时文件 + tmpdir、测完 rmSync 清理；被测函数全部防御式，绝不抛错）：
 * 1. skillUsagePathOf：拼 `<stateDir>/skill-usage.ndjson`；
 * 2. 常量：MAX_SKILL_USAGE_ENTRIES=1000 / SKILL_USAGE_TAIL=200 /
 *    SKILL_USAGE_BY_SESSION_LIMIT=10 / SKILL_USAGE_DAILY_WINDOW=7；
 * 3. createSkillUsageWriter + readSkillUsage：追加写入与读回一致（条目顺序保留）；
 * 4. 上限截断：写入超过 max 条后文件只剩最近 max 条（丢最旧）；
 * 5. 损坏行：读取时跳过损坏行不影响好行；触发重写时损坏行被剔除、不占上限名额；
 * 6. aggregateSkillUsage：
 *    - total/firstAt/lastAt（最早/最近时刻；at 不可解析的条目不计时间维度）；
 *    - 按技能 count/okCount/lastAt（ok 缺省不计数）；
 *    - byWorkspace：按 workspacePath 计数，空/缺失不计；
 *    - bySession：按次数降序平手按最近调用新在前、取前 10、title 首见保留；
 *    - daily7：固定 now 锚定 7 个 UTC 日期槽（旧→新），窗口内归槽、窗口外不计、
 *      空槽 count=0；
 *    - 脏输入：非数组/null/非对象条目/缺 skill 名 → 安全跳过不抛错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SKILL_USAGE_ENTRIES,
  SKILL_USAGE_TAIL,
  SKILL_USAGE_BY_SESSION_LIMIT,
  SKILL_USAGE_DAILY_WINDOW,
  aggregateSkillUsage,
  createSkillUsageWriter,
  readSkillUsage,
  skillUsagePathOf,
} from './skill-usage.js';

/** 每个用例独立的临时目录，绝不读写真实状态目录。 */
function useTempDir() {
  return mkdtempSync(join(tmpdir(), 'ror-skill-usage-'));
}

/** 便捷构造一条合法调用记录。 */
const ENTRY = (skill, at, extra = {}) => ({
  at,
  skill,
  sessionId: 'session-a',
  cwd: '/code/www/demo',
  ok: true,
  ...extra,
});

test('skillUsagePathOf: 拼 <stateDir>/skill-usage.ndjson', () => {
  assert.equal(skillUsagePathOf('/home/u/.dsh/x'), join('/home/u/.dsh/x', 'skill-usage.ndjson'));
});

test('常量: 上限 1000 / 尾部 200 / bySession 前 10 / daily7 窗口 7 天', () => {
  assert.equal(MAX_SKILL_USAGE_ENTRIES, 1000);
  assert.equal(SKILL_USAGE_TAIL, 200);
  assert.equal(SKILL_USAGE_BY_SESSION_LIMIT, 10);
  assert.equal(SKILL_USAGE_DAILY_WINDOW, 7);
});

// ---- createSkillUsageWriter + readSkillUsage：追加写入与读取 ----

test('写入器: 逐条追加，readSkillUsage 读回顺序与内容一致', () => {
  const dir = useTempDir();
  try {
    const file = skillUsagePathOf(dir);
    const append = createSkillUsageWriter(file);
    const first = ENTRY('skill-a', '2026-11-01T00:00:00.000Z');
    const second = ENTRY('skill-b', '2026-11-02T00:00:00.000Z', { ok: false });
    append(first);
    append(second);
    const entries = readSkillUsage(file);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], first);
    assert.deepEqual(entries[1], second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入器: 目录不存在时自动创建（markerDir 首次落盘）', () => {
  const dir = useTempDir();
  try {
    const nested = join(dir, 'deep', 'marker');
    const file = skillUsagePathOf(nested);
    createSkillUsageWriter(file)(ENTRY('skill-a', '2026-11-01T00:00:00.000Z'));
    assert.equal(readSkillUsage(file).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入器: 超上限丢最旧——max=3 写 5 条只剩最近 3 条', () => {
  const dir = useTempDir();
  try {
    const file = skillUsagePathOf(dir);
    const append = createSkillUsageWriter(file, 3);
    for (const at of ['01', '02', '03', '04', '05']) {
      append(ENTRY(`skill-${at}`, `2026-11-0${at.at(-1)}T00:00:00.000Z`));
    }
    const entries = readSkillUsage(file);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.skill), ['skill-03', 'skill-04', 'skill-05']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSkillUsage: 损坏行跳过，不影响其余好行', () => {
  const dir = useTempDir();
  try {
    const file = skillUsagePathOf(dir);
    writeFileSync(
      file,
      [
        JSON.stringify(ENTRY('skill-a', '2026-11-01T00:00:00.000Z')),
        '{broken json',
        '',
        '42',
        JSON.stringify(ENTRY('skill-b', '2026-11-02T00:00:00.000Z')),
      ].join('\n'),
      'utf8',
    );
    const entries = readSkillUsage(file);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].skill, 'skill-a');
    assert.equal(entries[1].skill, 'skill-b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写入器: 触发重写时损坏行被剔除（不占上限名额、可继续追加）', () => {
  const dir = useTempDir();
  try {
    const file = skillUsagePathOf(dir);
    // 预置 3 条（其中 1 条损坏）——写入器启动计数把损坏行也算进 lines，
    // 预置 4 行（其中 1 条损坏）——写入器启动计数把损坏行也算进 lines，
    // 追加 1 条后 lines=5 > max=3 触发重写，重写剔除损坏行。
    // 行格式约定「每行一条 + 尾换行」：无尾换行会让下一行 append 拼进末行
    // 被整体当损坏行剔除（与 restarts.ndjson 写入器同款容错口径），此处按
    // 正常格式预置
    writeFileSync(
      file,
      `${[
        JSON.stringify(ENTRY('skill-old', '2026-10-01T00:00:00.000Z')),
        '{broken',
        JSON.stringify(ENTRY('skill-a', '2026-11-01T00:00:00.000Z')),
        JSON.stringify(ENTRY('skill-b', '2026-11-02T00:00:00.000Z')),
      ].join('\n')}\n`,
      'utf8',
    );
    const append = createSkillUsageWriter(file, 3);
    append(ENTRY('skill-c', '2026-11-03T00:00:00.000Z'));
    const entries = readSkillUsage(file);
    assert.equal(entries.length, 3, '重写后只保留 3 条');
    assert.deepEqual(entries.map((e) => e.skill), ['skill-a', 'skill-b', 'skill-c'], '损坏行与最旧一条被剔除');
    // 重写后计数已修正（lines=kept=3），再追加 1 条 lines=4 > 3 再次触发重写
    // （丢最旧）——max 是硬上限，文件条数恒 ≤ max
    append(ENTRY('skill-d', '2026-11-04T00:00:00.000Z'));
    const again = readSkillUsage(file);
    assert.equal(again.length, 3);
    assert.deepEqual(again.map((e) => e.skill), ['skill-b', 'skill-c', 'skill-d']);
    assert.ok(existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSkillUsage: 文件不存在 → 空数组（ENOENT 属预期）', () => {
  const dir = useTempDir();
  try {
    assert.deepEqual(readSkillUsage(skillUsagePathOf(dir)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- aggregateSkillUsage：聚合 ----

/** 聚合窗口锚：固定「今天」= 2026-11-06（UTC），单测不受真实日期影响。 */
const NOW = new Date('2026-11-06T12:00:00.000Z');

test('聚合: total/firstAt/lastAt——最早与最近一次调用时刻', () => {
  const agg = aggregateSkillUsage([
    ENTRY('skill-a', '2026-11-03T10:00:00.000Z'),
    ENTRY('skill-b', '2026-11-05T10:00:00.000Z'),
    ENTRY('skill-a', '2026-11-04T10:00:00.000Z'),
  ], NOW);
  assert.equal(agg.total, 3);
  assert.equal(agg.firstAt, '2026-11-03T10:00:00.000Z');
  assert.equal(agg.lastAt, '2026-11-05T10:00:00.000Z');
});

test('聚合: at 不可解析的条目计入 count 但不参与时间维度', () => {
  const agg = aggregateSkillUsage([
    ENTRY('skill-a', 'not-a-date'),
    ENTRY('skill-a', '2026-11-04T10:00:00.000Z'),
  ], NOW);
  assert.equal(agg.total, 2);
  assert.equal(agg.firstAt, '2026-11-04T10:00:00.000Z');
  assert.equal(agg.lastAt, '2026-11-04T10:00:00.000Z');
  const bucket = agg.skills['skill-a'];
  assert.equal(bucket.count, 2);
  assert.equal(bucket.lastAt, '2026-11-04T10:00:00.000Z');
});

test('聚合: 按技能 count/okCount/lastAt——ok 缺省/非 true 不计成功', () => {
  const agg = aggregateSkillUsage([
    ENTRY('skill-a', '2026-11-01T00:00:00.000Z', { ok: true }),
    ENTRY('skill-a', '2026-11-02T00:00:00.000Z', { ok: false }),
    // ok 缺省（构造后删除字段，模拟字段缺失的条目）
    (() => { const e = ENTRY('skill-a', '2026-11-03T00:00:00.000Z'); delete e.ok; return e; })(),
    ENTRY('skill-b', '2026-11-03T00:00:00.000Z', { ok: true }),
  ], NOW);
  assert.equal(agg.skills['skill-a'].count, 3);
  assert.equal(agg.skills['skill-a'].okCount, 1);
  assert.equal(agg.skills['skill-a'].lastAt, '2026-11-03T00:00:00.000Z');
  assert.equal(agg.skills['skill-b'].count, 1);
  assert.equal(agg.skills['skill-b'].okCount, 1);
});

test('聚合: byWorkspace 按 workspacePath 计数，空/缺失不计', () => {
  const agg = aggregateSkillUsage([
    ENTRY('skill-a', '2026-11-01T00:00:00.000Z', { workspacePath: '/code/www/a' }),
    ENTRY('skill-a', '2026-11-02T00:00:00.000Z', { workspacePath: '/code/www/a' }),
    ENTRY('skill-a', '2026-11-03T00:00:00.000Z', { workspacePath: '/code/www/b' }),
    ENTRY('skill-a', '2026-11-04T00:00:00.000Z', { workspacePath: '' }),
    ENTRY('skill-a', '2026-11-05T00:00:00.000Z'), // 字段缺失
  ], NOW);
  assert.deepEqual(agg.skills['skill-a'].byWorkspace, {
    '/code/www/a': 2,
    '/code/www/b': 1,
  });
});

test('聚合: bySession 按次数降序取前 10，title 首见保留', () => {
  const rows = [];
  // skill-a：session-x 3 次、session-y 1 次；session-x 应排前且带 title
  rows.push(ENTRY('skill-a', '2026-11-01T00:00:00.000Z', { sessionId: 'session-x', sessionTitle: '主会话' }));
  rows.push(ENTRY('skill-a', '2026-11-02T00:00:00.000Z', { sessionId: 'session-x', sessionTitle: '改名后' }));
  rows.push(ENTRY('skill-a', '2026-11-03T00:00:00.000Z', { sessionId: 'session-y' }));
  rows.push(ENTRY('skill-a', '2026-11-04T00:00:00.000Z', { sessionId: 'session-x' }));
  rows.push(ENTRY('skill-a', '2026-11-05T00:00:00.000Z', { sessionId: '' })); // 空 id 不计
  const agg = aggregateSkillUsage(rows, NOW);
  const bySession = agg.skills['skill-a'].bySession;
  assert.equal(bySession.length, 2);
  assert.equal(bySession[0].id, 'session-x');
  assert.equal(bySession[0].count, 3);
  assert.equal(bySession[0].title, '主会话', 'title 取首见，后续改名不覆盖');
  assert.equal(bySession[0].lastAt, '2026-11-04T00:00:00.000Z');
  assert.equal(bySession[1].id, 'session-y');
  assert.equal(bySession[1].count, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(bySession[1], 'title'), false);
});

test('聚合: bySession 超过 10 个会话时截断为前 10（次数最多者保留）', () => {
  const rows = [];
  for (let i = 0; i < SKILL_USAGE_BY_SESSION_LIMIT + 3; i += 1) {
    rows.push(ENTRY('skill-a', '2026-11-01T00:00:00.000Z', { sessionId: `s-${i}` }));
  }
  // 低频会话再补 1 次都追不上 s-13（1 次 vs 1 次平手按 lastAt）——构造一个
  // 明确的 13 会话场景：前 10 个各 2 次、后 3 个各 1 次，截断后应剩下前 10 个
  const rebuilt = [];
  for (let i = 0; i < 10; i += 1) {
    rebuilt.push(ENTRY('skill-a', '2026-11-01T00:00:00.000Z', { sessionId: `s-${i}` }));
    rebuilt.push(ENTRY('skill-a', '2026-11-02T00:00:00.000Z', { sessionId: `s-${i}` }));
  }
  for (let i = 10; i < 13; i += 1) {
    rebuilt.push(ENTRY('skill-a', '2026-11-03T00:00:00.000Z', { sessionId: `s-${i}` }));
  }
  const agg = aggregateSkillUsage(rebuilt, NOW);
  const bySession = agg.skills['skill-a'].bySession;
  assert.equal(bySession.length, SKILL_USAGE_BY_SESSION_LIMIT);
  assert.ok(bySession.every((row) => row.count === 2), '截断后保留的全会是 2 次的高频会话');
});

test('聚合: bySession 平手时最近调用新在前', () => {
  const agg = aggregateSkillUsage([
    ENTRY('skill-a', '2026-11-01T00:00:00.000Z', { sessionId: 'older' }),
    ENTRY('skill-a', '2026-11-05T00:00:00.000Z', { sessionId: 'newer' }),
  ], NOW);
  const bySession = agg.skills['skill-a'].bySession;
  assert.equal(bySession.length, 2);
  assert.equal(bySession[0].id, 'newer');
  assert.equal(bySession[1].id, 'older');
});

test('聚合: daily7——固定锚最近 7 个 UTC 日期槽（旧→新），窗口内归槽、窗口外不计', () => {
  const agg = aggregateSkillUsage([
    ENTRY('skill-a', '2026-11-05T08:00:00.000Z'), // 昨天 → 槽 6
    ENTRY('skill-a', '2026-11-05T09:00:00.000Z'), // 昨天 → 槽 6
    ENTRY('skill-a', '2026-11-06T00:30:00.000Z'), // 今天 → 槽 7
    ENTRY('skill-a', '2026-10-30T00:00:00.000Z'), // 窗口外
    ENTRY('skill-a', '2026-11-01T00:00:00.000Z'), // 7 天槽内（11-01）
  ], NOW);
  const daily7 = agg.skills['skill-a'].daily7;
  assert.equal(daily7.length, 7);
  assert.deepEqual(daily7.map((d) => d.date), [
    '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03',
    '2026-11-04', '2026-11-05', '2026-11-06',
  ]);
  assert.deepEqual(daily7.map((d) => d.count), [0, 1, 0, 0, 0, 2, 1]);
});

test('聚合: daily7 各技能独立归槽', () => {
  const agg = aggregateSkillUsage([
    ENTRY('skill-a', '2026-11-05T08:00:00.000Z'),
    ENTRY('skill-b', '2026-11-06T08:00:00.000Z'),
  ], NOW);
  assert.deepEqual(agg.skills['skill-a'].daily7.map((d) => d.count), [0, 0, 0, 0, 0, 1, 0]);
  assert.deepEqual(agg.skills['skill-b'].daily7.map((d) => d.count), [0, 0, 0, 0, 0, 0, 1]);
});

test('聚合: 脏输入安全——非数组/空数组 → 全零统计；非对象条目与缺 skill 名的条目跳过', () => {
  for (const dirty of [null, undefined, 'nope', 42, [], [null, 1, 'x', {}, { skill: '' }, { skill: 7 }]]) {
    const agg = aggregateSkillUsage(dirty, NOW);
    assert.equal(agg.total, 0);
    assert.equal(agg.firstAt, null);
    assert.equal(agg.lastAt, null);
    assert.deepEqual(agg.skills, {});
  }
});

test('聚合: 空输入的 daily7 不预建技能桶（skills 为空对象）', () => {
  const agg = aggregateSkillUsage([], NOW);
  assert.deepEqual(agg, { total: 0, firstAt: null, lastAt: null, skills: {} });
});
