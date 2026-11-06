/**
 * 0.30.0「tab3 收敛到本插件」的宿主侧纯函数单测（node --test，无 e2e、不起服务）。
 *
 * 直接 import lib/index.js 的导出（照 lib/apply.test.js 先例，只 import 纯函数，
 * 不调用 apply、不读写真实 ~/.dsh）：
 * 1. 常量：OWN_PLUGIN_NAME / OWN_SKILL_NAME(S) / OWN_TOOLS（两个模型工具的名称与
 *    description 非空，且注册处与展示处共用同一份常量）；
 * 2. isOwnPluginSkill：名字白名单是**唯一可靠判定**（实测 summary 里本插件技能是
 *    provider:'runtime'、source:'runtime'，别家 runtime 技能同样 provider 'runtime'）；
 *    provider 显式等于包名作前瞻兜底；脏形状一律 false；
 * 3. filterOwnPluginSkills：混合目录只留本插件技能（别家 genui / ao-simple-daily-report
 *    100% 不出现），非数组 → []；
 * 4. filterOwnPluginSkillUsageEntries：调用记录按技能名过滤（聚合前口径），
 *    非数组/脏条目安全跳过；
 * 5. lastBootAtOf：倒序取最后一条 type==='boot' 的 at（缺失回退 bootAt），
 *    无 boot / 脏输入 → ''。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWN_PLUGIN_NAME,
  OWN_SKILL_NAME,
  OWN_SKILL_NAMES,
  OWN_TOOLS,
  REGISTER_RECOVERY_TOOL,
  RESTART_HARNESS_TOOL,
  filterOwnPluginSkillUsageEntries,
  filterOwnPluginSkills,
  isOwnPluginSkill,
  lastBootAtOf,
} from './index.js';

// ---- 常量：工具定义与技能名白名单 ----

test('常量: 本插件技能名单一 + 两个模型工具名称/description 非空', () => {
  assert.equal(OWN_PLUGIN_NAME, 'dsh-resume-on-restart');
  assert.equal(OWN_SKILL_NAME, 'register-restart-recovery');
  assert.deepEqual([...OWN_SKILL_NAMES], ['register-restart-recovery']);
  assert.deepEqual(OWN_TOOLS.map((tool) => tool.name), ['restart_harness', 'register_restart_recovery']);
  assert.equal(RESTART_HARNESS_TOOL.name, 'restart_harness');
  assert.equal(REGISTER_RECOVERY_TOOL.name, 'register_restart_recovery');
  for (const tool of OWN_TOOLS) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, `${tool.name} description 应非空`);
  }
  // 两个工具的定义对象必须是同一份引用（注册与展示共用，不重复写死文案）
  assert.equal(OWN_TOOLS[0], RESTART_HARNESS_TOOL);
  assert.equal(OWN_TOOLS[1], REGISTER_RECOVERY_TOOL);
});

// ---- isOwnPluginSkill：名字白名单是唯一可靠判定 ----

test('isOwnPluginSkill: 本插件技能（provider runtime/source runtime）命中白名单', () => {
  assert.equal(isOwnPluginSkill({
    name: 'register-restart-recovery',
    provider: 'runtime',
    source: 'runtime',
    description: '注册当前会话的重启恢复行为…',
  }), true);
});

test('isOwnPluginSkill: 别家技能一律 false（genui=provider dsh-genui；别家 runtime 技能同样 false）', () => {
  assert.equal(isOwnPluginSkill({ name: 'genui', provider: 'dsh-genui', source: 'bundled' }), false);
  assert.equal(isOwnPluginSkill({ name: 'ao-simple-daily-report', provider: 'runtime', source: 'runtime' }), false);
  assert.equal(isOwnPluginSkill({ name: 'find-init-helper', provider: 'dsh-skill-filesystem', source: 'user' }), false);
});

test('isOwnPluginSkill: provider 显式等于插件包名作前瞻兜底；脏形状一律 false', () => {
  assert.equal(isOwnPluginSkill({ name: 'future-skill', provider: OWN_PLUGIN_NAME }), true);
  for (const bad of [null, undefined, [], 'x', 42, {}, { name: '' }]) {
    assert.equal(isOwnPluginSkill(bad), false);
  }
});

// ---- filterOwnPluginSkills / filterOwnPluginSkillUsageEntries ----

test('filterOwnPluginSkills: 混合目录只留本插件技能，保持原顺序；非数组 → []', () => {
  const catalog = [
    { name: 'genui', provider: 'dsh-genui', source: 'bundled' },
    { name: 'register-restart-recovery', provider: 'runtime', source: 'runtime' },
    { name: 'ao-simple-daily-report', provider: 'runtime', source: 'runtime' },
    { name: 'find-init-helper', provider: 'dsh-skill-filesystem', source: 'user' },
  ];
  assert.deepEqual(filterOwnPluginSkills(catalog).map((item) => item.name), ['register-restart-recovery']);
  for (const bad of [null, undefined, {}, 'x']) assert.deepEqual(filterOwnPluginSkills(bad), []);
});

test('filterOwnPluginSkillUsageEntries: 按技能名过滤（聚合前口径），脏条目安全跳过', () => {
  const entries = [
    { at: '2026-11-06T01:00:00.000Z', skill: 'genui', ok: true },
    { at: '2026-11-06T02:00:00.000Z', skill: 'register-restart-recovery', ok: true },
    { at: '2026-11-06T03:00:00.000Z', skill: 'ao-simple-daily-report', ok: false },
    null,
    'x',
    { at: '2026-11-06T04:00:00.000Z' },
  ];
  assert.deepEqual(
    filterOwnPluginSkillUsageEntries(entries).map((entry) => entry.skill),
    ['register-restart-recovery'],
  );
  for (const bad of [null, undefined, {}, 'x', 42]) assert.deepEqual(filterOwnPluginSkillUsageEntries(bad), []);
});

// ---- lastBootAtOf：最近一次 boot 时刻 ----

test('lastBootAtOf: 倒序取最后一条 boot 的 at；at 缺失回退 bootAt；无 boot/脏输入 → \'\'', () => {
  const entries = [
    { type: 'boot', at: '2026-11-06T04:00:00.000Z' },
    { type: 'restore', id: 'a', result: 'resumed' },
    { type: 'boot', at: '2026-11-06T05:32:36.068Z' },
    { type: 'restore', id: 'b', result: 'resumed' },
  ];
  assert.equal(lastBootAtOf(entries), '2026-11-06T05:32:36.068Z');
  // at 缺失/空串时回退 bootAt（兼容性口径）
  assert.equal(lastBootAtOf([{ type: 'boot', bootAt: '2026-11-06T06:00:00.000Z' }]), '2026-11-06T06:00:00.000Z');
  assert.equal(lastBootAtOf([{ type: 'restore', id: 'a' }]), '');
  for (const bad of [null, undefined, {}, 'x', 42]) assert.equal(lastBootAtOf(bad), '');
});
