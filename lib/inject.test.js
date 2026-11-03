/**
 * 0.27.0「inject 静态声明 tools」的回归守卫测试
 * （node --test，无 e2e、不起任何服务）。
 *
 * 背景：0.26.0 及之前 `const inject = ['agents']` 不声明 tools，fresh boot 时
 * 插件 fiber 常早于 tools 服务激活，apply 里 reflect.get('tools') 返回
 * undefined，restart_harness / register_restart_recovery 两处模型工具注册被
 * 静默跳过、工具从不下发进主会话工具列表（运行期重挂才偶发注册成功）。
 * 0.27.0 起声明 'tools' 让插件 fiber 等 tools 服务激活后再 apply。
 *
 * 本文件直接 import 断言（范式照抄 lib/unrestored.test.js）。lib/index.js
 * 顶层只 import node: 内置模块与 ./ 同目录模块（无 cordis/dsh 裸依赖，服务
 * 对象均在 apply(ctx) 内使用），纯 node --test 环境可直接加载——已实测
 * `node -e "import('./lib/index.js')"` 成功，无需源码文本断言回退。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inject, name } from './index.js';

test('name: 插件名恒为 dsh-resume-on-restart（cordis.patch.yml / 宿主路由前缀都按它挂）', () => {
  assert.equal(name, 'dsh-resume-on-restart');
});

test('inject: 是数组且非空（cordis 按它决定插件 fiber 的启动时机与注入服务）', () => {
  assert.ok(Array.isArray(inject), 'inject 必须是数组');
  assert.ok(inject.length > 0, 'inject 不能为空数组');
});

test('inject: 包含 agents（列出/访问 agent，恢复候选的来源服务）', () => {
  assert.ok(inject.includes('agents'), "inject 必须声明 'agents'");
});

test('inject: 包含 tools（0.27.0 回归守卫）——删掉它 fresh boot 模型工具注册会静默跳过：插件 fiber 早于 tools 服务激活，reflect.get(\'tools\') 拿到 undefined，restart_harness / register_restart_recovery 从不下发进主会话工具列表', () => {
  assert.ok(inject.includes('tools'), "inject 必须声明 'tools'（0.27.0 起），删掉会导致 fresh boot 工具注册静默跳过");
});
