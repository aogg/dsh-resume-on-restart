# Changelog

## [0.33.0] - 2026-11-07

### Fixed

- **subagent 会话不能被重启恢复，只能由父会话代理——冷 subagent 会话此前却被当成普通
  候选直接 resume**（实际症状：`restarts.ndjson` 里该会话 `result: 'subagent'` 但
  `error` 是 `resume failed: RemoteError: … is owned by subagent routing`，即
  「指令式失败」而不是「由父会话代理」；实测两次 boot 的
  `9ae5a36c-f8a4-47ab-a576-8b26bb3498fb`、`ebe218d8-326f-4e2e-a3de-0c21fdce8e09`）。
  根因：`sessionHeaderLookup()` 只查 `ctx.reflect.get('sessions').get(id).header`，
  而宿主 sessions store 只对**热会话**有条目；**冷会话**（定义：本进程没有活 agent、
  会话记录只落在磁盘上的会话，例如重启前被打断、恢复前尚未加载进 store 的会话）
  `get(id)` 返回 `undefined` → 拿不到 header → `partitionSubagentCandidates` 认不出
  subagent → 当普通候选 `resumeSession` → 宿主以 `is owned by subagent routing` 拒绝。
  磁盘上其实能判（记录首行就是 header：`{"type":"session",…,"parentSession":…,
  "origin":"subagent","delegationDepth":1}`），只是 store 拿不到。修复：
  - **`lib/session-scan.js` 新增 `readSessionHeaderFromDisk(sessionsRoot, sessionId)`**
    （还有纯函数 `sessionHeaderFromLine`、常量 `SESSION_HEADER_READ_SIZES`）：定位复用
    `findSessionRecordFile`；`.zstd` 用 `zlib.zstdDecompressSync`（`typeof === 'function'`
    探测，node < 23.8 没有 → `unknown/zstd-unsupported`，绝不抛错）**只解第一帧**；
    **限制读取量**——从 4KB 起倍增尝试（4/16/64/256KB…上限 1MB），首帧可解即停，绝不整
    文件读（会话记录可达数十 MB，`/restart/info` 会逐候选调用）；未压缩
    `session.v4.jsonl` 只读首行；文件缺失 / 解压失败 / JSON 坏 / 首行非对象 / id 非法
    （含 `/`、`\`、`..`、超长）→ 一律 `{ status: 'unknown', reason }`（口径与仓库既有
    扫描一致），绝不抛错。
  - **`lib/index.js` 的 `sessionHeaderLookup()` 改为「store 优先 + 磁盘回退」**，并加
    **进程内 memo**（`id → header|null`，**只缓存读盘结果**——热会话每次照旧走 store，
    行为逐字不变；`/restart/info` 逐候选调用、boot 恢复再查一次，不 memo 就会反复
    open/pread/解压）。
  行为口径（每条都有单测）：
  1. 冷 subagent 会话不再进入「直接恢复」候选，也不再出现在 `GET /restart/info` 的
     待恢复列表（`directRestorableCandidates` 同一条链自动生效）；
  2. 父会话是候选 → 结算 `subagent session; covered by candidate session <parent>`，
     不直接 resume；
  3. 父会话被用户排除 → `subagent session; ancestor session <parent> excluded by user`，
     **绝不发 resume**；
  4. 父会话归档 → 同款 archived 文案（`… ancestor session <parent> is archived`；
     0.9.0 归档过滤先剔同 lineage 的候选，故实际链路常先结算 `archived`，该文案是
     lineage 走不通时的防御式兜底）；
  5. 父会话不是候选（不在窗口）→ 走既有 proxies 代理恢复（0.9.1 语义不变）；
  6. header 有 `origin:'subagent'` 但缺/非法 `parentSession` →
     `subagent session; no resumable ancestor session found`；
  7. 磁盘也判定不了 → **维持现状**（留在候选里，由宿主 RemoteError 兜底）——
     绝不许因为「读盘失败」把候选当 subagent 丢掉。
  结算的五种 mode/文案抽成 `lib/detect.js` 的纯函数 `classifySubagentDisposition`
  （`covered` / `excluded` / `archived` / `delegated` / `none`，优先级与历史文案逐字
  一致），供逐条单测。
- 术语：**冷会话** = 本进程没有活 agent、会话记录只落在磁盘上的会话（如重启前被打断、
  恢复前尚未加载的会话）；**热会话** = session store 里有活 Session 的会话。该定义
  写在 `lib/session-scan.js` 模块头、README「subagent 会话代理恢复」段与本条 CHANGELOG。

### Tests

- 新增 `lib/session-header.test.js`（13 用例）：读取量梯度常量、首行 JSON → header
  的两种形状、真实临时多帧 zstd（首帧 header + 后续记录 + 伪 header）只解第一帧、
  首帧压缩后 >4KB 时 4KB 读不出→按梯度到 16KB 成功、截断首帧/非 zstd 数据 →
  `unknown/zstd-decode-error`、未压缩文件只取首行、无 `zlib.zstdDecompressSync` 环境
  下 zstd 形态 `unknown/zstd-unsupported` 而未压缩形态照常、id 非法与文件缺失、
  **10MB 文件注入读盘点只被请求一次 4096 字节**（只读前几 KB 的证据）。
- 新增 `lib/cold-subagent.test.js`（15 用例）：mock cordis ctx + 临时 `DSH_HOME`、
  磁盘上写真实会话记录（首行 header），覆盖上面七条口径、store 优先（热会话只认
  store，磁盘写 subagent 也不影响）、memo（删掉会话记录后第二次 `/restart/info` 仍按
  首次读到的 header 判定，同用例内用「从没读到过记录的会话照旧是候选」作对照），以及
  `classifySubagentDisposition` 的五种文案/优先级/脏输入防御。

## [0.32.1] - 2026-11-07

### Fixed

- **待重启恢复列表的运行徽标取实时状态**（实际症状：列表里一个早已不在运行的会话仍显示
  「● 运行中」）。`GET /restart/info` 候选明细的 `running` 此前读 `marker.recentSessions`
  的「最后已知」快照——它只在 `agent/status` 事件到来时更新，因此会话被重启打断（turn 开着
  被 kill）、之后恢复又失败（宿主以 `owned by subagent routing` 拒绝 subagent 会话即实例）时
  该标记永久停在 `true`，界面就把一个此后从未运行过的会话显示成运行中。
  现在改为查活 agent 的实时 status（`ctx.get('agents').list()` → `status === 'running'`，
  与「暂停所有会话」、守门自动重启同一个 `selectRunningAgentIds` 枚举口径）：
  - marker 说 `true` 但活 agent 是 idle / 根本不在名单里 → `running:false`；
  - marker 说 `false` 但活 agent 正在跑 → `running:true`；
  - `agents` 服务探不到（旧宿主 / 服务缺失 / `list()` 抛错 / 返回非数组）→ **回退** 0.13.0
    口径（marker 最后已知值），降级行为逐字不变，路由照旧 200；
  - `agents.list()` 返回空数组是**有效数据**（此刻没有会话在运行，例如刚开机尚未恢复任何
    会话），一律 `running:false`，不回退到陈旧的 marker 值。
  候选集合与 `at` / `title` / `workspace` / `source` / `activate` 等其余字段口径完全不变；
  恢复流程（`running:true` 免扫描直通正常结束门）仍读 boot 快照里的 `running`，不受影响。
  新增 `lib/running-badge.test.js`（5 个接线用例）钉住上述四条口径。

## [0.32.0] - 2026-11-07

### Added

- **对外扩展点**（`lib/hooks.js`，新文件；其余插件用 `ctx.on` 注册 cordis 串行事件）：
  - `resume-on-restart/before-restart`：重启被调用之后、真正重启之前派发。四个入口
    （设置弹窗按钮 / `/restart` 命令 / `restart_harness` 模型工具 / 注册后守门自动重启）
    共用 `performRestart` 这一处，因此每个重启请求只派发一次。处理器按注册顺序逐个
    `await`，全部跑完才继续原有重启逻辑；任一处理器返回取消值即**本次重启整体取消**：
    不写任何重启工件、不 spawn helper、进程继续活着，统一返回
    `{ ok:false, cancelled:true, mode, restartId:null, by, reason, error }`。
    `POST /restart` 对取消回 **409**（与「重启失败」的 500 区分），客户端文案区分为
    「重启被插件取消」；`/restart` 命令与模型工具以错误结果返回 `error` 文案；守门
    自动重启保留武装、下一轮再试。`wake.log` 留一行 `restart cancelled: …`。
  - `resume-on-restart/before-resume`：检测到重启、停机归因与 boot 记录落盘之后，
    挑候选与 `restoreCandidates` 之前派发（每次开机一次，服务慢启动后的续等补跑不
    重复派发）。取消即**本次自动恢复整体跳过**：不挑候选、不 `resumeSession`、不投递
    继续提示、也不做 fallback 唤醒；`restarts.ndjson` 落一条 `type:'resume-cancel'`
    条目（`by` / `reason` / `detail`，处理器抛错或超时另带 `hookError` / `hookTimeout`
    标记），`wake.log` 留一行，设置弹窗「重启日志」结果列显示「恢复已取消」并在展开
    明细给出取消方与原因。
  - 取消约定对齐 cordis `isBailed`（`null` / `false` / `undefined` = 放行；其它非空值
    = 取消，推荐 `{ cancel: true, by, reason }`），并明确 `serial` 语义：任何非空返回值
    都会终止后续处理器（`{ cancel: false }` 只是「不算取消」，同样截断串行链）。
  - 兜底（fail-closed）：处理器抛错、或超过新配置项 `hookTimeoutMs`（默认 `10000`ms）
    都按取消处理；宿主缺 `ctx.serial` 时静默放行，不阻塞原有逻辑。
  - 事件名常量从 `lib/hooks.js` 导出（`HOOK_EVENTS` / `BEFORE_RESTART_HOOK` /
    `BEFORE_RESUME_HOOK`），包根 re-export，并新增包导出子路径
    `dsh-resume-on-restart/hooks`。
- **`GET /api/dsh-resume-on-restart/notice`**（只读，围栏同本插件其余路由）：返回重启后
  恢复会话的提示词——`sample`（按本次启动真实数据渲染的完整正文）、`segments`（8 条
  白名单片段，本次未出现的 `text` 为 `null`）、`delivery`（`followup`/`inject`、
  消息 `source`、`config.notice`、`restoredSessionId`）。数据与 `deliver()` 同源，
  客户端不写死任何文案。
- **`lib/detect.js` 新增 `noticeSegments()` / `NOTICE_SEGMENT_KEYS`**：把提示词拆成
  可枚举片段（`header` / `boot` / `downtime` / `lastSession` / `lastActive` / `restored`
  / `custom` / `tail`），`buildNotice()` 改为各段 `join('
')`——**输出与 0.31.x 逐字
  一致**（`lib/detect.test.js` 的逐字断言继续守护）。
- 文档：新增 [docs/被扩展说明.md](docs/被扩展说明.md)（两个扩展点的事件名、触发时机、
  payload 字段表、取消约定、抛错/超时兜底、可观测性、反例、代码位置索引）与
  [docs/被注入说明.md](docs/被注入说明.md)（投递时机与对象、消息外壳与 v4 约束、逐行
  模板表、真实样本、为什么这么写、如何在界面上查看、定制与排障）。

### Changed

- **设置弹窗第三个 tab 由「技能与注入」改名「技能展示」**（`restart.tabSkills`，zh
  `技能展示` / en `Skill Showcase`），并在技能列表与「本插件模型工具」区块之后新增
  「重启后恢复会话的提示词」区块（`NoticePanel`，`.dsh-ror-notice*`）：真实渲染正文、
  逐片段出现条件（i18n `notice.when.<key>`）与投递方式；`/notice` 路由 404 时显示
  「重启 DSH 后可见」的混合版本提示，不算加载失败。
- 重启日志表格的「恢复结果」列与展开明细支持 `resume-cancel` 条目（徽标「恢复已取消」，
  取消方/原因/抛错/超时明细；`groupEntries` 归入所属 boot 组，孤儿条目自成一组）。

### Fixed

- 无（本版本无缺陷修复）。

### Tests

- 新增 `lib/hooks.test.js`（取消归一化、payload 形状与冻结、带超时的串行派发：
  缺 `serial` 放行 / async 等待 / 抛错=取消 / 超时=取消）、
  `lib/hook-cancel.test.js`（apply 接线：`POST /restart` 取消 → 409 且无重启工件；
  `before-resume` 取消 → 只落 boot + `resume-cancel`、无逐会话结算；抛错 fail-closed；
  放行不写 `resume-cancel`）、`lib/notice.test.js`（分段 key 与 `buildNotice` 一致、
  zh/en 的 `notice.when.*` 齐全、tab 文案、`groupEntries` 收集 `resume-cancel`、
  `resumeCancelText` 降级口径），`lib/routes.test.js` 增 `/notice` 用例。
  `npm test` 共 406 个用例全绿。

## [0.31.1] - 2026-11-06

### Fixed

- **历史重启日志条目的「重启耗时」按 `at − origin.requestedAt` 回算**
  （lib/client.js）：`restartMs` 是 0.31.0 才新增的字段，历史 boot 记录没有它，
  此前表格行与展开明细一律显示「—」；这些记录的 `at`（记录生成时刻）与
  `origin.requestedAt`（重启发起时刻）都在，新增纯函数 `restartMsOf(boot)`
  （有限数 restartMs 原样用 → 否则两侧可解析且 `at >= requestedAt` 时回算差值 →
  否则 null），表格「重启耗时」列与 groupDetail 明细行统一改用
  `humanizeMs(restartMsOf(boot))`，能显示的都显示、真算不出仍是「—」。
  `restartMsOf` 与 `humanizeMs` 同口径从 client 工厂导出，新增 3 个单测覆盖
  「原样 / 回算 / 都缺」三种路径；package.json version 0.31.0 → 0.31.1
  （顶层 description 字段不动）。

## [0.31.0] - 2026-11-06

### Added

- **登记调用留痕与重启周期统计**（lib/register-calls.js 独立模块 + lib/index.js）：
  - 新 ndjson 文件 `<stateDir>/register-calls.ndjson`（上限 200 条超出丢最旧、
    重写顺带剔除损坏行，照 restarts.ndjson 写入器同款模式与容错口径）：
    `register_restart_recovery` 工具 **action=add 成功**时追加
    `{ at, sessionId, activate? }`（`activate` 仅显式 false 时写入；remove
    不记录）。写失败只 console.warn，绝不影响登记与自动重启流程。
  - 每次写 boot 记录时补算并落 4 个新字段（历史条目不回填，前端对缺失字段
    显示「—」）：
    - `registrationFirstAt` / `registrationFirstSessionId`：本重启周期
      `[prevBootAt, origin.requestedAt]`（**两端闭区间**）内第一条 add 记录的
      时刻 / 会话 id（纯函数 `cycleRegistrations` 统计；无记录缺省不写）；
    - `registrationCount`：同周期内 add 记录条数（恒写数字，无记录为 0）；
    - `restartMs`：本次 boot 时刻 − `origin.requestedAt` 毫秒（重启发起时刻
      缺失/不可解析/晚于 boot 时缺省不写）。
  - 周期统计的纯函数放在 lib/register-calls.js（`cycleRegistrations`），边界
    不可解析时该侧按无边界处理（crash 等无 origin 的周期仍可统计）；
    `GET /restarts` 原样返回条目数组，新字段自然带出、旧条目形状不变。

### Changed

- **设置弹窗 tab2「重启日志」由行列表改为表格，并消除「停机」文案歧义**
  （lib/client.js RestartLogSection）：
  - 列顺序固定（表头固定文案 zh/en 成组补齐）：「记录时间」（最左，记录
    `at`）/「触发」/「来源」/「首次登记」/「登记次数」/「触发时刻」/
    「重启耗时」/「距上次重启」/「恢复结果」。触发文案：auto-restart →
    「自动重启（所有会话完成）」、settings-ui →「手动按钮」、model-tool →
    「模型工具」，其余沿用既有 reason.* 字典（未命中原样）；来源：origin.kind
    的 auto →「自动」、model-tool →「会话 <短id>」、settings-ui →「设置界面」，
    其余保持 kind + 短 id。
  - **原「停机 2h 46m」文案废止**：`downtimeMs` 的口径是「上次重启完成到本次
    重启完成的间隔（含正常运行时间）」，不是停机时长——列名改为「距上次
    重启」，title 明写口径；旧 i18n key `label.downtime` 一并删除（zh/en）。
  - 「登记次数」列 title 提示「本重启周期内 register_restart_recovery 调用
    次数」；「重启耗时」用 `humanizeMs` 格式化为「13s」「1m 5s」「2h 46m」。
  - 展开明细行为保留（行可点、可键盘 Enter/Space 展开，明细整行跨列，明细
    内同口径补齐新字段）；空态 / 404 容错 / 加载失败 / 刷新按钮 / 结算徽标等
    既有行为全部保留；新样式类 `.dsh-ror-log*`（表头与行共用同一 grid 列宽
    模板，窄屏横向滚动不挤压，设计 token 明暗自适应）。

### Tests

- 新增 lib/register-calls.test.js：`cycleRegistrations` 周期边界（含
  prevBootAt / requestedAt 闭区间、窗口外、无边界、乱序取最早、空记录、脏
  输入、activate=false）+ 写入器/读取器（追加、上限裁剪丢最旧、重写剔除损坏
  行、文件缺失）共 13 个用例。
- 新增 lib/restart-log-format.test.js：`humanizeMs` 毫秒 → 文案（13s /
  1m 5s / 2h 46m / 非正数与非法输入 → —）共 4 个用例。
- lib/apply.test.js 新增宿主接线 2 例：register_restart_recovery action=add
  成功写 register-calls.ndjson（activate=false 携带、remove 与失败不留痕）；
  boot 记录补登记周期统计与 restartMs（窗口闭区间、窗口外剔除、restartMs =
  boot.at − requestedAt）。共 19 个新用例，`npm test` 全绿（371 通过）。

## [0.30.0] - 2026-11-06

### Added

- **设置弹窗 tab1「已登记重启恢复（未重启）」列表**（lib/client.js
  RestartSection + 宿主只读路由）：
  - 宿主新增只读路由 `GET /api/dsh-resume-on-restart/restart/registrations`
    （围栏、鉴权与 404/错误口径完全照 GET /restarts）→
    `{ ok, lastBootAt, registrations: [{ sessionId, at, title?, activate?,
    workspacePath? }] }`。数据源 `<stateDir>/proactive-restore.json`：读取复用
    readProactiveRestore / normalizeProactiveRestore（不新写解析），过滤用新纯
    函数 `pendingRestartRegistrations(raw, lastBootAt)`
    （lib/proactive-restore.js）——只保留**登记时间 at 晚于最近一次 boot** 的
    登记（lastBootAt 取 restarts.ndjson 最后一条 `type === 'boot'` 的 at，
    缺失回退 bootAt；无 boot 记录/at 不可解析时无从判断 → 保留），按 at 倒序。
    标题优先 sessionTitleLookup（sessionProjections 投影），拿不到退登记实体
    自带的 entry.title；`activate` 仅注册但不激活（false）携带；
    `workspacePath` 走会话 `header.cwd` → workspaceRegistry.resolveByPath，
    拿不到再退 id → 工作区映射，仍拿不到就省略字段（**登记实体本身不存 cwd，
    没有改登记格式**）。
  - 客户端 tab1 在「待重启恢复会话列表」之后、「上次重启无法恢复」之前新增该
    块：标题 + 口径轻提示 + 行区；行 = 模式徽标（`activate === false` →
    「不激活」琥珀调 / 其余 →「恢复」蓝调）+ 会话标题（缺失退 shortId 弱化）+
    会话短 id 弱化小字（有标题时才显示；完整 id 恒在行容器 title）+ 工作区路径
    小字（拿到才显示，省略号截断）+ 登记时间；行可点跳转（jumpToSession，成功后
    关设置弹窗，照 0.25.0 可点行做法）。
    空态「暂无已登记会话」；路由 404（混合版本窗口）→ 整块静默隐藏不算失败
    （照 /restarts 404 口径），其余错误落一小段错误文案 + console.warn。
  - i18n 新增 zh/en：restart.regTitle / restart.regEmpty / restart.regAt /
    restart.regBadgeRestart / restart.regBadgeNoActivate / restart.regError /
    restart.regHint；新样式类 .dsh-ror-reg-badge / .dsh-ror-reg-badge-off /
    .dsh-ror-reg-ws / .dsh-ror-reg-hint（设计 token，明暗主题自适应）。
- **tab3「技能与注入」新增「本插件模型工具」区块**（lib/client.js
  SkillsSection）：展示 `register_restart_recovery` 与 `restart_harness`
  两个模型工具的名称 + description（两张工具卡，样式照 .dsh-ror-skill* 体系），
  并标注「工具不是技能」轻提示；数据来自 /skills/catalog 响应新增的
  `tools: [{ name, description }]`，host 侧直接引用注册工具时用的常量
  RESTART_HARNESS_TOOL / REGISTER_RECOVERY_TOOL（OWN_TOOLS），**不重复写死
  文案**。catalog 无 tools 字段（旧版 host / 404 混合版本窗口）时整块不渲染。

### Changed

- **tab3 收敛到本插件范围**（lib/index.js + lib/client.js）：
  - `GET /skills/catalog` 的 skills 只保留本插件注册的技能（实测本插件
    `ctx.skills.register` 出来的 summary 是 `provider: "runtime"`、
    `source: "runtime"`——provider 是宿主 SkillRegistry 的 runtime 层名而**不是
    插件包名**，别家 runtime 技能同样是 'runtime'（对照：genui 是
    `provider: "dsh-genui"`、`source: "bundled"`），所以**名字白名单
    register-restart-recovery 是唯一可靠判定**，`provider === 插件包名` 只作
    前瞻兜底；纯函数 isOwnPluginSkill / filterOwnPluginSkills 可单测），
    genui / find-init-helper / ao-simple-daily-report 等别家技能 100% 不出现。
  - usage 聚合同口径：**聚合前**用 filterOwnPluginSkillUsageEntries 按技能名
    过滤（skill-usage.ndjson 原始记录不动），`GET /skills/usage` 的 entries
    与 total 用同一口径过滤。
  - 全局统计行「被调用技能数」文案标注为本插件范围
    （skills.statUsed zh「被调用技能数（本插件）」/ en "Skills invoked (this
    plugin)"），skills.note / skills.empty 口径说明同步微调。
- 技能名收敛到常量 OWN_SKILL_NAME / OWN_SKILL_NAMES（注册处与过滤白名单同一
  来源，避免两处漂移）；两个模型工具的 name + description 抽到模块常量，注册
  与设置弹窗展示共用同一份文案。
- lib/proactive-restore.js 文件头注释补 0.30.0（pendingRestartRegistrations）。
- 新增/补充单测（node --test，无 e2e、不起服务；总数 333 → 352）：
  - lib/own-scope.test.js（新，7 用例）：工具常量与共用引用、isOwnPluginSkill
    白名单判定/别家技能不命中/脏输入、filterOwnPluginSkills、
    filterOwnPluginSkillUsageEntries、lastBootAtOf at/bootAt 回退与脏输入；
  - lib/routes.test.js（新，4 用例）：用假 ctx 跑 apply() 后直接调路由 handler，
    断言 /skills/catalog 的过滤与 tools 字段、/skills/usage 同口径过滤、
    /restart/registrations 的 boot 过滤/倒序/字段、以及不可信 Host → 403；
  - lib/proactive-restore.test.js 追加 pendingRestartRegistrations 5 用例
    （at > lastBootAt 过滤与倒序、at == lastBootAt 剔除、lastBootAt 缺失全保留、
    activate/title 携带口径、at 不可解析保留 + 脏输入）；
  - lib/pending-restore.test.js 追加 normalizeRestartRegistrations 3 用例
    （sessionId/at/可选字段归一化、activate 仅 false 携带、保持宿主顺序与脏输入）。
  package.json test 脚本纳入两个新文件。

## [0.29.0] - 2026-11-06

### Added

- **host 侧技能调用统计**（lib/index.js + 新模块 lib/skill-usage.js）：
  - 监听宿主 `tools/result` 事件（宿主 dsh-tools 每次工具执行落定后派发
    `(exec, result)`，写法已核对宿主源码与 dsh-tool-present 插件先例；宿主对
    观察者异常自带 contain），过滤 `exec.name === 'skill'` 的调用逐条记录
    `{ at, skill, sessionId, sessionTitle?, workspacePath?, cwd, ok }` 到
    `<stateDir>/skill-usage.ndjson`：技能名取 `exec.arguments.name`、会话 id 取
    `exec.agent.id`、cwd 取 `exec.agent.session.header.cwd`、成功与否取
    `!result.isError`；sessionTitle 复用 sessionProjections 投影
    （sessionTitleLookup 现成函数），workspacePath 用 cwd →
    workspaceRegistry.resolveByPath（异步解析，拿不到留空）。
  - 新模块 lib/skill-usage.js：ndjson 追加写入器（上限 1000 条超出丢最旧、
    重写顺带剔除损坏行——照 restarts.ndjson 写入器同款模式与容错口径，写失败
    只 warn）+ 聚合函数（total/firstAt/lastAt + 每技能 count/okCount/lastAt/
    byWorkspace/bySession（按次数降序取前 10）/daily7（最近 7 天 UTC 日期槽））。
  - 两个只读路由（围栏与 404/错误口径照 GET /restarts）：
    `GET /skills/catalog` → `{ ok, skills: [{name, source, provider, description,
    whenToUse, content, modelInvocable, userInvocable}], usage: <聚合统计> }`
    （目录来自 ctx.reflect.get('skills') 的 list()/get()，服务缺失/读取失败 →
    空数组 + warn 不 500）；`GET /skills/usage` → `{ ok, entries: <尾部 200 条>,
    total }`。
  - 事件监听/技能服务不可用时统计为空（warn 可见），不影响插件其他功能；
    apply.test.js 监听器守卫用例纳入 tools/result。
  - lib/skill-usage.test.js（新，19 用例，node --test 无 e2e）：路径拼接、常量、
    追加写入与读取、目录自动创建、上限截断丢最旧、损坏行跳过/重写剔除、
    聚合（时间维度/at 不可解析降级、按技能、按工作区、按会话排序与截断、
    平手排序、daily7 归槽与窗口外、脏输入安全）；package.json test 脚本纳入。
- **设置弹窗第三个 tab「技能与注入」**（lib/client.js）：「重启」合并条目
  （0.28.0 起 RestartTabsSection）在 tab1「重启」/tab2「重启日志」后新增
  tab3「技能与注入」（restart.tabSkills，zh「技能与注入」/en "Skills &
  Prompts"；默认选中仍是 tab1），新组件 SkillsSection：
  - 挂载时并行拉 GET /skills/catalog 与 GET /skills/usage；404（插件更新后
    DSH 未重启的混合版本窗口）按空态「暂无数据」展示不算失败（照 0.5.1
    「重启日志」先例），其余失败走报错态；
  - 顶部全局统计行（总调用次数 / 被调用过的技能数 / 记录起始时间）+ 搜索框
    （按名称+描述大小写不敏感就地过滤）；
  - 每技能卡片：名称、来源（provider，title 带 source 来源类别）、徽标
    （模型可用 modelInvocable / 用户可见 userInvocable）、description、
    whenToUse、该技能统计（总次数/成功率/最近调用）、「正文」折叠展开
    （content `<pre>` 预格式化，默认收起）、按工作区分布、按会话分布（前 10）、
    最近7天每日次数（纯文本，不引图表库）；
  - 新样式类 .dsh-ror-skill*（设计 token 照既有体系，明暗主题自适应）；
    i18n 新增 restart.tabSkills 与 skills.* 文案组（zh/en）。
- package.json：version 0.28.0 → 0.29.0，description 追加 0.29.0 说明，
  test 脚本纳入 lib/skill-usage.test.js。

## [0.28.0] - 2026-11-06

### Changed

- **设置弹窗「重启日志」与「重启」合并为单个条目内的两个 tab**（lib/client.js，纯
  UI 结构合并，「重启日志」功能无任何行为变化）：
  - 原先两个独立的 settings.section 条目（0.5.0 起 order 61「重启日志」、0.8.0 起
    order 62「重启」）主题重复、设置弹窗左侧出现两个相近入口；0.28.0 起只注册一个
    条目「重启」（label 复用既有 restart.nav；id 保留 resume-on-restart、order 61
    不变，原 restart-now 条目移除）。
  - 新外层组件 RestartTabsSection 持有本地 tab state（useState，默认 restart），
    tab 栏（新类名 .dsh-ror-tabs / .dsh-ror-tab / .dsh-ror-tab-active：设计 token
    取值照抄 .dsh-ror-btn / .dsh-ror-refresh，选中态蓝调强调照抄 .dsh-ror-waiting
    的 rgba(43,124,201,*) 用色口径，明暗主题自适应；role=tablist/tab +
    aria-selected）切换两块内容：tab1「重启」= 原 RestartSection 全部内容与行为
    （默认选中）；tab2「重启日志」= 原 RestartLogSection 全部内容与行为（404
    容错、加载失败报错态、结算徽标全部原样保留）。
  - 切换按 tab 条件渲染其中一块，与原先设置弹窗左侧导航二选一的挂载语义一致；
    两组件内部逻辑/state/定时器/清理函数零改动，只在最外面包了一层 tab（两块
    各自的根 div.dsh-ror-settings 不动，外壳不额外包 padding）。
  - i18n 新增 restart.tabRestart / restart.tabLog（zh/en）；settings.nav 字典项
    保留但不再被引用（顶部 label 改用 restart.nav）。
- package.json：version 0.27.2 → 0.28.0（顶层 description 字段不动）。

## [0.27.2] - 2026-11-06

### Fixed

- **注册恢复与立即重启两组提示词互相区分**（lib/index.js，三处纯文案，不改任何逻辑）：
  插件有两类重启入口——register_restart_recovery 模型工具 / register-restart-recovery
  技能是「注册恢复资格：等**所有会话完成后**才自动触发一次重启」，restart_harness
  模型工具是「立即重启（不等会话收尾）」——此前的工具 description / 技能提示词
  没有把两者语义对照讲清，模型可能把「注册」误当成「立即重启」。本次：
  - register_restart_recovery 工具 description 末尾补「不是立即重启」区分句，
    并指明需要立即重启时用 restart_harness 工具或 GUI「重启 DSH」按钮，两者
    可配合（先注册恢复资格再立即重启）。
  - register-restart-recovery 技能：whenToUse 末尾补「需要立即重启、不等会话
    收尾的场景用 restart_harness 工具，不要用本技能」；content「注册后的行为」
    一节末尾新增「与立即重启的区分」小段（等所有会话完成 ≠ 立即重启，可与
    restart_harness / GUI「重启 DSH」/ /restart 配合）。
  - restart_harness 工具 description 末尾反向补一句：要「等所有会话完成后自动
    重启并恢复指定会话」时改用 register_restart_recovery 登记，而不是本工具。

## [0.27.1] - 2026-11-06

### Changed

- **register-restart-recovery 技能 description 摘要行补上触发时机**（lib/index.js）：
  0.27.0 及之前 description 一行只写两种模式（默认「重启后自动恢复并继续」、
  activate=false 则「重启但不激活本会话」），没有写明「注册后是等**所有会话
  完成**才自动触发一次重启」这一关键触发时机——该说明此前只在正文 content
  里，模型看技能目录摘要（available_skills 的 summary 行）时看不到，容易
  不知道重启何时发生。0.27.1 起 description 开头补括注「（注册后等所有会话
  完成自动触发一次重启）」；whenToUse / content 与其他任何代码均不动。
- package.json：version 0.27.0 → 0.27.1（顶层 description 字段不动）。

## [0.27.0] - 2026-11-04

### Fixed

- **fresh boot 模型工具注册被静默跳过（inject 静态声明 tools）**（lib/index.js）：
  0.26.0 及之前 `const inject = ['agents']` 不声明 tools，而插件 fiber 常早于
  tools 服务激活——fresh boot 时 apply 里 `ctx.reflect.get('tools')` 返回
  undefined，restart_harness / register_restart_recovery 两处模型工具注册被
  静默跳过、工具从不下发进主会话工具列表，只有运行期重挂（tools 恰已激活）
  才会偶发注册成功——这正是「508 条请求 header 仅 1 条含工具」的根因。
  0.27.0 起 inject 声明 `['agents', 'tools']`：插件 fiber 等 tools 服务激活后
  再 apply，fresh boot 注册必成功，模型工具在主会话稳定下发；两处注册点的
  reflect.get 防御式读取保留作双保险（缺服务不阻塞、优雅降级），跳过时补
  console.warn 日志可见不再静默；sessionController / skills 仍不在静态
  inject，保持运行时防御式探测。
- package.json：version 0.26.0 → 0.27.0，description 末尾追加 0.27.0 行为一句。

### Tests

- 新增 lib/inject.test.js 4 用例回归守卫（直接 import 断言；lib/index.js 顶层
  只依赖 node: 内置与同目录模块，纯 node --test 可加载）：name 恒为
  dsh-resume-on-restart、inject 是数组且非空、含 'agents'、含 'tools'——防
  再有人把 'tools' 删掉导致 fresh boot 工具注册静默跳过复发；package.json
  test 脚本纳入新文件；`npm test` 314 个用例全部通过

## [0.26.0] - 2026-11-03

### Added

- **服务等待超时后的逐级递增续等**（lib/index.js，四层方案的核心层）：0.7.0 起
  restoreCandidates 进入候选循环前用 serviceWaitTimeoutMs（默认 30s）一次性快等
  sessionController，超时即 `skip all restore candidates` 整批放弃（连逐条 restore
  结算都没有）。真实事故：2026-11-03 boot 服务约 50-70s 才就绪，2 个运行中候选被
  静默丢弃、fallbackWake 只唤醒了最近活跃的 1 个会话。0.26.0 起超时不再就此结束：
  - 快速层不变：快等超时保持既有返回值 `{ restoredAny: false }`，fallbackWake
    照旧立即执行；
  - 续等层（新增）：快等超时起后台续等任务，按 `escalationDelayMs(attempt)` 逐级
    递增间隔轮询（`= min(2000 * 2^(attempt-1), 30000)`：2s/4s/8s/16s/30s 封顶，
    纯函数导出供单测），总预算新配置 `serviceWaitMaxMs`（默认 600000 = 10 分钟，
    cordis.patch.yml config 同步新增、toPositiveInt 读取照 serviceWaitTimeoutMs
    同款）；就绪后**补跑候选循环**——与正常路径同一实现（restoreCandidates 复用：
    requireHumanPrompt 守卫、restoreTimeoutMs 预算、appendRestartLog 簿记、
    proactive/unrestored store 清理全部一致，不新造逻辑），补跑前按既有口径重过
    用户排除集合与正常结束门（等待期间被排除/已正常结束的候选按门既有口径结算，
    不强造 resumed），并**按会话 id 去重**：fallbackWake 已投递的会话（deliver
    成功即登记的 deliveredTo 集合）跳过不重复投递；补跑成功照常写 resumed 结算
    与既有簿记，wake.log 记一条含 deferred restore 与实际等待时长的说明；
    防重入（同一 boot 只起一个任务、无 running 候选不起），定时器随插件
    dispose 清理；
  - 兜底可见层（新增）：续等也到 serviceWaitMaxMs 上限才放弃——对每个剩余候选
    （fallback 已投递的除外）逐条结算 `result: 'skipped-service-timeout'`
    （error 注明 sessionController not ready within serviceWaitMaxMs）写
    restarts.ndjson + wake.log，并逐条登记「上次重启无法恢复」store。
- **「上次重启无法恢复」store 与手动恢复路由**（lib/unrestored.js + lib/index.js）：
  - 新模块 lib/unrestored.js（风格照 lib/proactive-restore.js）：readUnrestored /
    writeUnrestored / normalizeUnrestored / capUnrestored 纯函数导出（另附
    upsertUnrestored / removeUnrestoredIds 两个纯函数供登记与移除接线）；
    文件 `<stateDir>/unrestored.json`，条目 `{ id, at（登记时刻ISO）, bootAt?,
    title?, workspace?, error? }`；cap 100 条、新在前；同 id 重复登记 = 原位更新
    不新增；恢复成功某会话（正常路径 / 续等补跑 / 手动恢复）时 store 内同 id
    条目自动移除；
  - 新路由（enableRestart 门控、围栏与注册写法照既有 /state、/pause-all）：
    `GET /api/dsh-resume-on-restart/unrestored` → `{ ok:true, rows:[...] }`
    （store 倒序，空 → rows: []）；`POST /api/dsh-resume-on-restart/unrestored/
    restore`（body `{sessionId}`）手动恢复——等服务就绪（≤ serviceWaitTimeoutMs，
    同一 waitForSessionController）后按候选循环同款恢复该会话（resumeSession +
    deliver 投递继续提示；会话已活跃则不重复投递直接按成功处理）；成功 →
    `{ok:true}` + store 移除该条 + restarts.ndjson 记 restore 行
    `result:'resumed'`（error:null）+ wake.log；失败 → `{ok:false,error}`
    （响应风格照 POST /state）。
- **设置弹窗「重启」section 新增第三块「上次重启无法恢复」列表**（lib/client.js）：
  挂载 GET /unrestored（404 = 混合版本窗口 → 静默不显示，照 /restarts 404 口径）；
  refreshPendingList 点「刷新」时一并重拉；仅 rows 非空渲染，位置在待恢复列表
  之后、对账视图之前；行结构与另两个列表一致——可点行（jumpToSession(row.id,
  close) + .dsh-ror-restore-click + title 追加 restart.openSessionHint）、行首
  结算徽标（新 key `restore.skipped-service-timeout`，zh「等待超时」/en "timeout"，
  新 CSS 类 .dsh-ror-result-skipped-service-timeout 青灰蓝调）、会话标题、登记
  时间、行尾「恢复」按钮（复用 restart.pendingRestore）；**按工作区分组**（复用
  groupPendingRows，组头结构与样式同待恢复列表，未知工作区垫底）；批量工具条照
  0.14.0 模式：全选 checkbox（半选）+「已选 N 项」（复用 key）+「恢复所选」
  （复用 restart.pendingRestoreSelected）；串行逐个 POST /unrestored/restore，
  乐观更新（成功移除行）+ 失败 console.warn 保留行，行级/批量在途集合
  （unrestoredMutatingIds）防重复点击；新增纯函数 normalizeUnrestoredRows
  （工厂导出供单测）。

### Changed

- **服务等待超时不再整批放弃**（lib/index.js）：restoreCandidates 超时路径保持
  返回 `{ restoredAny:false }`（fallbackWake 照旧）的同时起续等任务；候选循环内
  恢复成功即从「无法恢复」store 自动移除同 id 条目（正常路径与续等补跑共用
  restoreCandidates 收尾，一处实现两路径同口径）；对账视图结算徽标白名单
  SETTLE_RESULTS 增 `skipped-service-timeout`（对账视图出现该结算同样有徽标，
  settle.skipped-service-timeout 同配色）；withTimeout / sessionController 探测
  与等待 / resumeSession / deliver 自 agents effect 上移 apply 层（续等补跑与
  手动恢复路由与候选循环共用同一实现，逻辑逐字未动）。
- **fallback 投递按 deliveredTo 防重**（lib/index.js）：续等补跑与 fallbackWake
  之间存在并发窗口——服务恰在 fallback 等待/轮询进行中就绪时，续等补跑可能先
  恢复并投递某候选（含最后活跃会话），fallback 随后仍会向同一会话重复投递继续
  提示（补跑侧的 deliveredTo 去重只覆盖「fallback 先、补跑后」方向）。fallback
  两处投递点（roots 即时命中与轮询命中）与 escalateFallbackWake 升级投递前同样
  查 deliveredTo（新增第三道门 passesDeliveredGate）：已登记过的不重复投递，
  wake.log 记 `fallback wake skipped: already delivered (deferred restore)` +
  console.log（本条并入 0.26.0：随本次发布部署，未单独发版）。
- package.json：version 0.25.0 → 0.26.0，description 末尾追加 0.26.0 行为一句；
  README.md：功能列表新增「续等与无法恢复列表」条目、配置表增 serviceWaitMaxMs
  行、「确认后的可视化与恢复结果对账」小节补第三列表说明；lib/index.js 与
  lib/client.js 文件头 JSDoc 补 0.26.0 段；lib/unrestored.js 头部说明照
  proactive-restore.js 风格。

### Tests

- 新增 lib/unrestored.test.js 24 用例（接手失败子代理半成品逐行审阅后续写）：escalationDelayMs
  续等阶梯（1..5 精确值、≥6 恒 30s 封顶、非法入参按 1、小数取整/数字字符串）、
  normalizeUnrestored / capUnrestored / upsertUnrestored / removeUnrestoredIds 纯函数
  全口径、readUnrestored / writeUnrestored 真实临时文件往返（缺失/损坏/写失败降级）、
  登记→裁剪→移除组合管线；lib/pending-restore.test.js 增 6 用例：normalizeUnrestoredRows
  归一化（合法行保留、脏行剔除、at 归 ''、可选字段非空字符串才带、非法输入 []）与
  groupPendingRows 分组串联；package.json test 脚本纳入新文件；`npm test` 310 个用例
  全部通过

## [0.25.0] - 2026-11-03

### Added

- **待恢复列表与对账视图的会话行点击跳转**（lib/client.js）：两个列表的每一行
  都支持点击跳转到该会话——走 dsh 官方跳转方案 `uiWorkspace.openSession(sessionId)`
  （dsh-client-ui-workspace 的 UiWorkspace 接口，官方 chat /
  dsh-client-ui-conversation 同款用法）：工厂 `inject` 新增 `uiWorkspace`，apply
  时经 `setUiWorkspace` 存模块级引用（防御式：非对象或缺 `openSession` 函数存
  null）；模块级 `jumpToSession(sessionId, close)` = `openSession(sessionId)`
  成功后回调 `close` 关闭设置弹窗（settings.section 契约 owner props 注入
  `close`，RestartSection 签名扩展为 `{ t, close }`、可能 undefined 由
  `jumpToSession` 防御）；任何失败只 console.warn 不抛错——跳转只是锦上添花，
  不能让行点击炸掉设置弹窗。可点范围与约束：
  - 待恢复列表行**非 waiting 阶段**（`pendingReadonly === false`）绑行 onClick +
    `.dsh-ror-restore-click` 可点样式（新增 CSS，hover 提亮照抄既有
    `--dsw-alias-bg-layer-3` 写法），行 title 在原完整 id 基础上追加跳转提示
    （zh/en 新 key `restart.openSessionHint`：「点击打开会话」/「Click to open
    session」）；**waiting 只读阶段不绑行点击、不加可点样式**（与该阶段隐藏全部
    按钮的既有约束一致，保持纯展示）；
  - 行内 checkbox 与行尾「取消 / 恢复」按钮 `onClick` `stopPropagation`，点控件
    不误触发行跳转（原有标记/勾选逻辑不变）；批量工具条在行外，不受影响；
  - 对账视图（「上次重启(<时间>)的恢复结果」）逐会话行同样绑 onClick 跳转 +
    可点样式 + title 提示——只读展示、行内无控件，无 stopPropagation 需求。

### Changed

- **对账视图按工作区分组**（lib/client.js）：对账视图（settlement 块）的行区从
  平铺改为复用待恢复列表既有的 `groupPendingRows` 纯函数按工作区分组——组头
  一行复用待恢复列表同款结构与样式类（`.dsh-ror-pending-group`，workspace
  缺失/空串显示 `restart.pendingUnknownWorkspace` 并恒垫底，组容器 title 属性
  同款），组内行结构（结算徽标 + 标题 + error）与分组前完全一致，结算计数行
  （x/y 已恢复）与标题不变。数据链路：`startRestart` 写 localStorage 存根的
  candidates 增带 `workspace`（非空字符串才带，与 title 同款「拿到才带」），
  `readPendingRestore` 归一化同步透传（非空字符串才保留）；**旧存根无该字段
  → 不带 → 归「未知工作区」组，天然兼容**
- package.json：version 0.24.0 → 0.25.0，description 末尾追加 0.25.0 行为一句；
  README.md：待恢复列表与对账视图功能描述处补 0.25.0 条目与行为说明（点击跳转
  用官方 uiWorkspace.openSession、跳转后关弹窗、waiting 只读不跳、对账视图
  分组、存根带 workspace、旧存根兼容）

### Tests

- 新增 lib/pending-restore.test.js 5 用例：readPendingRestore 存根 candidates 的
  workspace 非空字符串才保留（数字/对象/空串一律不带 key）、旧存根无该字段回归
  兼容、writePendingRestore → readPendingRestore 含/不含 workspace（含 restartId
  与 title）覆盖式往返一致、candidates 直接喂 groupPendingRows 的分组串联（带
  workspace 进对应组、无 workspace 归 '' 未知组恒垫底）；`npm test` 280 个用例
  全部通过

## [0.24.0] - 2026-11-03

### Changed

- **点「重启 DSH」后不再丢失上次重启的对账视图**（lib/client.js）：对账视图
  （「上次重启(<时间>)的恢复结果：x/y 已恢复」+ 逐会话结算徽标）的渲染门从
  `!showConfirmList && settlement !== null` 放宽为 `settlement !== null`——
  0.13.0 起「confirm 列表存在即不渲染对账视图」的遮蔽语义废止。0.24.0 起点下
  「重启 DSH」进入 confirm、waiting 等待、POST 失败回 idle 各阶段，只要上一轮
  重启的对账数据（localStorage 存根）还在，就与待恢复列表两块堆叠渲染：列表在
  上、对账视图在下（0.16.0 preview 模式既有双块结构的推广）。存根数据链路零
  改动——readPendingRestore / matchPendingBoot / 待结算短轮询 / startRestart
  覆盖存根语义不变，重启完成页面刷新后由新存根展示新一轮对账仍是既有预期
- **进入「重启 DeepSeek Harness」选项卡 = 点下待恢复列表的「刷新」按钮**
  （lib/client.js）：挂载 effect 与 refreshPendingList 原是两条重复但不完全一致
  的路径（挂载只在 pendingRows 为 null 时构建、不合并、不收窄选中集合、失败无
  warn），收敛为共用同一条管线 `syncPendingFromInfo`：GET /restart/info →
  setInfo → normalizeCandidateDetails → 本地无行直接用服务端行、有行经
  mergePendingRows 合并（服务端为准、保留本地取消标记，服务端不再返回的行保留
  并置 cancelled=true）→ 选中集合同步收窄（只保留仍存在的行）→ 失败静默
  （console.warn，现有行原样保留）。进入页面现在与点刷新完全一致（同样合并旧
  取消标记、同样收窄选中集合、失败同样留 warn 排查痕迹）。入口语义保持不变：
  挂载路径响应到达时 clickedRef 已置位则只更新 info 不覆盖列表（setInfo 仍
  执行）、pendingMode 仅从 none 升为 preview 绝不降级 confirm、卸载 cancelled
  防串态；刷新按钮防重入（refreshing）、拉取中禁用并显示「刷新中…」、finally
  复位、不改 pendingMode；openConfirm 的确认弹窗重拉保持原实现（clickedRef
  置位、pendingMode=confirm、phase 切换不动）；waiting 只读门控、批量取消/恢复、
  工作区分组、restart.pendingList 各文案零改动
- package.json：version 0.23.0 → 0.24.0，description 末尾追加 0.24.0 行为一句；
  README.md：特性列表与「确认后的可视化与恢复结果对账」小节按新行为修订（对账
  视图不再被列表遮蔽、进入选项卡与刷新按钮同管线）

### Tests

- `node --check lib/client.js` 通过；`npm test`（纯 node --test，无构建）全绿：
  275 个用例全部通过（lib/pending-restore.test.js 经 window.__ModuleLoader__ 桩
  加载重构后的 client bundle 正常，对账/归一化/合并/分组纯函数用例全部通过；
  无新增用例——本次为纯客户端行为与重构，未改任何可导出纯函数）

## [0.23.0] - 2026-11-01

### Added

- **注册但不激活模式**（`register_restart_recovery` 新增 `activate` 参数，boolean，
  默认 true）：`activate=true`（默认/不传）行为与现状完全一致；`activate=false`＝
  「注册但不激活」——其余一切一致（登记持久化、武装守门自动重启、绕过正常结束门、
  待恢复列表可见），唯一差别：重启后本会话不自动恢复（不 resumeSession、不
  deliver、不注入继续提示），结算 `result:'no-activate'`（error:null，不算失败）；
  注册条目保留在 proactiveRestore（下次重启同样静默跳过，待恢复列表保持带徽标、
  可手动恢复）；适合工作已收尾、只需触发重启让改动生效，或不想重启后本会话抢
  焦点的场景。`action=remove` 不区分模式，照旧整体取消登记

### Changed

- lib/proactive-restore.js：entry 新增可选 `activate` 字段——**仅在值为 false 时
  保留落盘**（activate 为 true 或缺失一律不写该字段，旧文件字节不变）；
  normalizeProactiveRestore / readProactiveRestore / writeProactiveRestore /
  capProactiveRestore 实现与 docstring 同步；mergeProactiveCandidatePool 输出行
  支持 `activate:false`（仅 false 才带，供 /restart/info 路由与客户端徽标）；
  mergeProactiveRestoreCandidates 不变（激活开关在宿主循环查 store）
- lib/index.js：工具 parameters 增 `activate` boolean（description 讲清两模式
  区别与典型场景，execute 的 add 分支在 `args?.activate === false` 时给 entry 写
  `activate:false`，返回值带 `activate` 布尔）；boot 恢复流程在候选进入
  restoreCandidates 循环前把 `proactiveRestore.get(id)?.activate === false` 的候选
  拆出来（参照 skippedCompleted 的处理模式：console.log + writeWakeLog +
  appendRestartLog 结算 no-activate），不从 store 删除、不参与 restoredAny；
  /restart/info 候选池映射输出行仅 false 才带 `activate:false`；工具 description
  与技能 content 重写（两种模式各一段 + 典型场景 + 调用示例，保留「完成」口径与
  remove 取消的说明）；文件头 JSDoc 补 0.23.0 说明段
- lib/detect.js：classifyRestoreFallback 纯函数新增 `skippedNoActivateCount` 输入
  （缺省 0 时输出与现状逐字节一致）：无可恢复候选且全部为 no-activate 结算 →
  安静收尾不回退 fallbackWake（否则「故意不激活的重启」反而会吵醒主会话）；
  no-activate 与其他候选混合时维持既有回退语义不变
- lib/client.js：候选行归一化（normalizeCandidateDetails）与合并
  （mergePendingRows）透传 `activate:false`（仅 false 才带，风格同 source，服务端
  为准、没带回退本地旧值）；待恢复行 `source==='skill' && activate===false` 显示
  新徽标「注册·不激活」（restart.pendingNoActivate，琥珀调
  .dsh-ror-noactivate-badge，与紫调技能注册徽标区分）；结算徽标白名单
  SETTLE_RESULTS 与重启日志明细行结果标签增 `no-activate`
  （settle.no-activate / restore.no-activate，zh「注册不激活」/en「no activate」，
  .dsh-ror-result-no-activate 新配色）；zh/en 字典补全部新 key；文件头 JSDoc 补
  0.23.0 段落
- README.md / package.json：功能列表与模型工具表格补 0.23.0 说明；version
  0.23.0、description 补 0.23.0 行为一句

### Tests

- lib/proactive-restore.test.js：normalize 对 activate:false 保留、true/缺失/非布尔
  不落盘、旧格式兼容；read/write 回环保留 flag（落盘文本仅 1 处 activate）；
  cap 不丢 flag；mergeProactiveCandidatePool 输出行带 activate:false 仅限 false 条目
- lib/detect.test.js：classifyRestoreFallback 新口径（全 no-activate → 不回退；
  与其他候选并存且其他全失败 → 回退；不传新参 → 输出与旧一致）
- lib/archive.test.js：宿主接线（照「候选全部正常结束 → 安静收尾」模式）——候选
  全部 no-activate → 安静收尾、重启日志 result:'no-activate'、proactiveRestore 条目
  保留、不 fallbackWake、/restart/info 行带 activate:false；工具注册 schema 含
  activate 参数（execute add 按 activate 落盘与回显、remove 照旧整体取消）
- lib/pending-restore.test.js：结算徽标白名单含 no-activate；normalizeCandidateDetails
  / mergePendingRows 的 stub 归一化透传 activate（仅 false 参与、服务端为准回退本地）
- `npm test`（纯 node --test，无构建）全绿：275 个用例全部通过

## [0.22.0] - 2026-10-31

### Added

- **注册后守门自动重启**（lib/auto-restart.js 新模块 + lib/index.js）：`register_restart_recovery`
  工具 `action=add` 登记成功后，插件武装一次「所有会话都完成时自动触发一次 DSH
  重启」的守门器——装完插件/更新插件/改完需重启的配置这类等待重启的工作，
  注册后即可继续当前会话，全部会话收尾后重启与恢复自动发生，无需用户手动点：
  - 武装状态持久化在 `<stateDir>/pending-auto-restart.json`
    （`{ schemaVersion: 1, armedAt: 最早武装时刻, by: 最新注册者 }`），武装幂等
    （重复注册保留最早 `armedAt`、`by` 更新为最新注册者）；`action=remove` 成功且
    已无任何主动注册时解除（删文件 + 清守门器 timer）。武装文件只在开机
    **一次性消费**（归因打点后删除——不消费会把「等会话完成 → 重启」变成每次
    开机再重启的死循环）；触发路径不删武装文件，`performRestart` 失败的分支留给
    下一轮评估重试，成功后新进程开机消费
  - **「完成」口径**：会话不在 `running` 即算完成；**正在向用户提问等待回答
    （提问中）的会话也算完成**——防御式探测宿主 sessionProjections 投影
    （`stateOf(agent.session, 'userQuestions')?.questions?.active` 存在
    `state==='continued'` 条目），链路任一层缺失/形状不对/抛异常 = 不在提问，
    保守方向是继续等，绝不因探测失败提前重启
  - 评估入口：武装成功后延迟 2s 首评（注册那一刻本会话必然 running，天然等待
    一轮）；`agent/status` 事件顺带调度 ~1s 去抖评估；30s 兜底重估防事件丢失。
    全部 timer `unref`。枚举口径与 pause-all 一致（`selectRunningAgentIds`）。
    判定 done:false → 取消已排定的触发继续等；done:true → 排定
    `autoRestartSettleMs`（默认 10000ms）窗口后触发，窗口内评估翻回 done:false
    则取消回等待。触发与既有入口共用 `restartLatch` 防重入：`pauseLatch` 非空 /
    claim 失败（已有重启在途）= 本轮放弃、武装保留
  - 触发 `origin.kind='auto'`（lib/restart.js `ORIGIN_KINDS` 新增），boot 记录
    reason 标签 `auto-restart`（detect.shutdownReasonOf 新识别，优先于 source
    判定）；`GET /restart/info` 响应体新增 `autoRestart: { armed, armedAt }`
    （排障用便宜字段，读现值；lib/client.js 不动）
  - 新配置 `autoRestartSettleMs`（默认 10000，`toPositiveInt` 归一化；cordis.patch.yml
    config 块同步）
  - 提示词扩充：工具 description 与技能 `content`/`whenToUse` 明确「任何需要等待
    DSH 重启或 agent 重启才能生效/继续的场景（如安装/更新插件、修改需重启的配置）
    都应调用本工具注册」，技能新增「注册后的行为」小节说明守门与提问中口径、
    使用场景追加「需等待 DSH 重启的工作」「需等待 agent 重启的工作」两条

### Fixed

- **主动注册的会话重启后不再被「正常结束门」拦下**（lib/detect.js +
  lib/index.js）：`filterCompletedCandidates` 增第三参 `bypassIds`（Set/数组，
  缺省或空 = 现行为逐字节不变，向后兼容），命中的候选免扫描直接恢复。boot 恢复
  流程传入 `new Set(proactiveRestore.keys())`——主动注册 = 用户显式要求总是恢复
  （0.19.0 技能承诺「即使会话结束后仍会恢复」），不再被 0.17.0「最后 turn
  正常结束 → skipped-completed」的口径拦下导致注册承诺落空；提问中的会话 turn
  开着本就放行，与门原语义一致

### Tests

- 既有 239 个用例全部通过（`filterCompletedCandidates` 既有用例全部双参调用，
  验证缺省 `bypassIds` 的向后兼容）；0.22.0 纯函数单测（auto-restart
  normalize/read/write/remove/merge/ classify、bypassIds 过滤、auto-restart
  reason 标签）由测试角色补齐

## [0.21.0] - 2026-10-31

### Changed

- **重启等待态可视化强化**（lib/client.js）：设置弹窗「重启」选项卡里两次确认
  重启后的 waiting 阶段，原实现只是两段 12px 灰色小字（`.dsh-ror-restart-status`
  的 `restart.waiting` / `restart.elapsed` 行），混在内容里要认真看才知道已进入
  等待状态。0.21.0 起升级为一眼可见的两层提示：
  - **醒目横幅卡片** `.dsh-ror-waiting` 紧跟 section 标题（`restart.title` 的 h4）
    之后、note 段之前，进入 waiting 即出现、不用滚动就能看到：左侧 CSS 旋转
    圆环 spinner（`.dsh-ror-waiting-spin`，`@keyframes dsh-ror-spin` .8s 线性
    无限；`prefers-reduced-motion:reduce` 下 `animation:none` 尊重减弱动效偏好），
    中间主文案区（i18n `restart.waitingTitle`「DSH 正在重启」加粗标题 +
    `restart.waitingSub` 副文案「重启指令已确认发出，新实例就绪后本页自动刷新，
    期间无需任何操作。」），右侧大号逐秒计时（`restart.elapsedBig`，18px 加粗蓝、
    `font-variant-numeric:tabular-nums` 防跳动；复用既有 `elapsedSec`，计时逻辑
    零改动）。配色沿用既有蓝调 `rgba(43,124,201,*)`（同 `.dsh-ror-reason-restart-button`），
    文字颜色走 `--dsw-alias-label-*` 设计 token，明暗主题自适应
  - **视口顶部固定提示条** `.dsh-ror-waiting-fixed`（position:fixed 定位写法照抄
    既有 `.dsh-ror-toast`：top 14px 水平居中、z-index 同 10001；胶囊圆角
    `border-radius:999px`、蓝底 `rgba(43,124,201,.95)` 白字加粗、阴影同 toast
    风格，`max-width:min(560px,calc(100vw - 40px))` 小屏不溢出）：spinner（白调
    覆盖）+ `restart.waiting` 文案 + 分隔的 `restart.elapsed`「已等待 N 秒」，
    无论滚动到选项卡哪个位置都恒定可见；DOM 挂在 section 内、随条件渲染
    离开 waiting 即消失
  - 原两段 12px 小字 inline waiting 行删除（被横幅 + 固定条取代，不重复显示）；
    `restart.waiting` / `restart.elapsed` 保留复用于固定条；timedOut 超时提示
    段落保留原位置与样式；非 waiting 分支、待恢复列表、对账视图、确认/暂停
    弹窗逻辑全部不动（横幅与固定条均为条件渲染，纯 UI 改动，宿主 half 零改动）

## [0.20.0] - 2026-10-31

### Changed

- **移除 trackMax 恢复候选窗口限制（默认不限量）**（lib/index.js）：0.3.0 起
  `trackMax` 默认 5，把 marker.recentSessions 截断为最近 5 条，第 6 新及更旧
  的会话被静默挤出、重启后永远不被恢复（真实事故：2026-10-31 session-830af88f
  因此未被恢复）。0.20.0 起默认 `trackMax = 0 = 不限`：recentSessions 不再
  截断，历史上活跃过的会话全部保留为恢复候选；`trackMax` 配置保留向后兼容——
  缺省/0/非法 → 不限（与 restoreMax 复用同一 `normalizeRestoreMax` 口径，
  MAX_SAFE_INTEGER 传 pickRestoreTargets 事实全量），正整数 → 旧语义 floor 后
  按数量截断。`restoreMax` 默认 0（不限）不变；正常结束门、restoreTimeoutMs
  候选预算（skipped-budget 可见结算）、human-prompt 守卫、归档/排除/subagent
  过滤全部保持不变。已知代价（用户接受）：marker.recentSessions 与 boot 记录
  runningSessions 将随历史会话无界增长（boot 记录变长属预期）

### Tests

- lib/detect.test.js 新增 0.20.0 trackMax 口径用例：0（默认）/缺失/非法 →
  不限、正整数（含小数 floor/字符串数字）→ 旧语义截断、
  `pickRestoreTargets(marker, MAX_SAFE_INTEGER)` 全量返回不截断、
  `pickRestoreTargets(marker, 5)` 仍取前 5 条（向后兼容）；测试注释说明与
  index.js apply 闭包内 recordActivity 截断逻辑的对应关系（闭包内无法直测）

## [0.19.1] - 2026-10-31

### Fixed

- **技能注册补 `source`**（lib/index.js）：`register-restart-recovery` 技能注册
  新增 `source: 'runtime'`（官方 SkillSource 枚举值）——宿主 dsh-skill
  `validateDefinition` 强制要求 `source` 为字符串，缺失导致 skill 工具加载技能
  正文报错 `loaded skill "register-restart-recovery" source must be a string`

### Changed

- 技能 `invocation.userInvocable` `true` → `false`（`modelInvocable` 保持
  `true`）：宿主 skills/list（Web 技能菜单）与用户点名注入按 `userInvocable`
  过滤，技能仅 agent 可见可用，界面不再列出，仅模型目录与 skill 工具可用；
  lib/apply.test.js 追加 `source` 与 `invocation` 断言锁住新契约；package.json
  版本 `0.19.0` → `0.19.1`

## [0.19.0] - 2026-10-29

### Added

- **主动注册重启恢复**（lib/proactive-restore.js 新模块 + lib/index.js +
  lib/client.js）：会话经模型工具/技能主动登记「重启后自动恢复」资格——即使会话
  之后不再活跃（超出 trackMax 最近活跃窗口）甚至结束，下次 DSH 重启仍会恢复它：
  - **持久化**：`<stateDir>/proactive-restore.json`，格式
    `{ [sessionId]: { at: ISO 注册时间, title? } }`，上限 100 条丢最旧。
    纯函数模块（可单测）：`normalizeProactiveRestore` / `readProactiveRestore`
    （缺失/损坏 → `{}`）/ `writeProactiveRestore`（best-effort，失败只告警）/
    `capProactiveRestore` / `mergeProactiveCandidatePool` / `mergeProactiveRestoreCandidates`。
    宿主 `apply` 启动读入内存 Map（跨重启持久、**不随开机一次性消费**），变更写回
  - **技能注册**（B）：`ctx.skills.register({ name: 'register-restart-recovery', ... })`
    注册全局技能（agent 技能目录可见），正文指导模型调用 `register_restart_recovery`；
    skills/tools 不在静态 inject（`['agents']`）里，经 `ctx.reflect.get` 防御式探测
    （缺服务不阻塞、优雅降级）；注册返回的 disposer 不随 ctx 自动失效，用
    `ctx.effect` 返回的清理函数显式挂回（同 rules-auto 模式）
  - **模型工具**（C）：`register_restart_recovery`（`tools.register`，与
    restart_harness 同款防御式探测 + 已注册跳过）；`execute` 读
    `exec.agent.session.id`，add（默认，登记当前时间 + best-effort 标题）/
    remove（取消登记），写回 proactive store，返回 `{ ok, sessionId, ... }`
  - **/restart/info 候选池**（D）：候选明细行新增 `source`（'skill' = 主动注册，
    'auto' = 自动候选）。候选池 = `visibleRestoreCandidateIds` 自动候选 ∪
    主动注册候选（去重主动注册优先；主动注册命中用户排除则丢弃主动注册身份——
    会话若同时是自动候选仍以自动候选出现；仅主动注册的会话总是出现，at = 注册
    时间、running 回查 recentSessions（查不到 = false））。`/state`、ws 快照零改动
  - **恢复流程**（E）：把 proactive 会话并入恢复候选池——不在 recentSessions 的以
    `{ id, at: 注册时间 }` 形式并入，优先级 recentSessions > 暂停 > 主动注册
    （主动注册会话如果被暂停集合覆盖，用暂停集合的 at）；主动注册条目**不受
    restoreMax 截断**（「主动注册会话总是恢复」），尊重既有过滤（用户排除/归档/
    human-prompt 守卫/正常结束门）；恢复成功后**只移除已成功恢复**的主动注册条目
    （失败/被过滤的保留下次重启再试），`restoreCandidates` 返回
    `{ restoredAny, restoredIds }` 供宿主精确清理
  - **客户端**（F）：`normalizeCandidateDetails` 透传 `source`（非空字符串才带）；
    `mergePendingRows` 合并 `source`（服务端为准、没带回退本地、服务端不再返回的
    保留行沿本地）；`renderPendingRow` 对 `source === 'skill'` 显示新徽标
    `dsh-ror-skill-badge`「技能注册」（其余维持既有运行中徽标逻辑）；设置弹窗确认
    列表与预览列表同一 `renderPendingList`；CSS 新增 `.dsh-ror-skill-badge`（紫调，
    与运行中绿/已取消灰区分）；zh/en 字典新增 `restart.pendingSkill`
    （"技能注册" / "Skill registered"）

### Changed

- package.json 版本 `0.18.0` → `0.19.0`；test 脚本加入
  `lib/proactive-restore.test.js`；README 同步主动注册重启恢复说明、/restart/info
  的 source 字段与恢复流程的主动注册并入口径

## [0.18.0] - 2026-10-28

### Added

- **设置弹窗「重启」：待重启恢复会话列表按工作区分组展示**（lib/index.js +
  lib/client.js；行内容与操作全部保留、跨组可用）：
  - **数据链路**：`GET /restart/info` 候选明细行新增 `workspace` 字段（会话所属
    工作区 = 项目目录完整路径字符串，未知为 `''`，总是携带）。宿主侧
    `sessionWorkspaceLookup`（与 titleOf 同一查询路径）每次请求一次构建
    sessionId → path 映射、候选逐个查表，绝无每候选重复 readdir——回退链：
    1. 宿主 `workspaceRegistry.list()` 实体的 `path` + `sessionIds`（header
       验证过 canonical cwd 的官方归属口径；0.15.0 起已用同一 registry 拿
       archivedSessionIds）；
    2. registry 缺失/无有效条目 → 只读解析 `<DSH_HOME>/storages/workspace.json`
       （unit v2，`tables.workspaces`，实测条目同样带 `path` + `sessionIds`；
       **只读参考，绝不写**）；
    3. 条目只有 path 没有 sessionIds → 路径经 `projectKeyOf` 编码成 slug 与
       `<DSH_HOME>/sessions` 项目目录名**正解精确匹配**（slug 形如
       `--code-www-my-github-xxx--`，编码有损、不能反解；`projectKeyOf` 为宿主
       dsh-session-persistence-jsonl `projectKey` 的自写等价实现——插件不 import
       任何 `@deepseek-ai/dsh-*` 内部包，出处已注明）；
    4. 整条链路拿不到 → `workspace: ''`，客户端归「未知工作区」组。
    纯展示字段：`/state`、ws 快照（顶栏开关）、候选过滤与恢复流程零改动
  - **分组纯函数** `groupPendingRows(rows)`（client.js 工厂导出，可单测）：输入
    行数组（含 workspace），输出有序组数组 `[{ workspace, rows }]`——组内按 at
    倒序、组间按组内最新 at 倒序、未知工作区组（workspace 缺失/空串）恒排最后；
    返回新数组不改入参，脏行跳过、非法输入空数组，绝不抛错
  - **分组渲染**（renderPendingList，preview / confirm / waiting 各阶段同一
    构建）：行区按组渲染——组头一行 = 工作区完整路径（省略号截断、全文在
    title 属性，`.dsh-ror-pending-group` 小节标题样式），workspace 缺失/空串
    显示「未知工作区」；组内行与既有行完全一致（运行中徽标、标题、最后活跃
    时间、已取消徽标与弱化行、行尾「取消 / 恢复」按钮）；批量工具条与全选
    语义保持既有（作用于全部组的全部行）；空列表仍显示「无待恢复会话」；
    标题行「刷新」按钮、waiting 只读门控、对账视图均不变。
    zh/en 字典新增 `restart.pendingUnknownWorkspace`
  - **合并/归一化透传**：`normalizeCandidateDetails` 对 workspace 非空字符串
    才带（旧宿主无字段/未知 `''` 一律不带，与 title 同款「拿到才带」）；
    `mergePendingRows` 服务端为准、服务端这轮没带回退本地旧值、服务端不再
    返回的保留行沿本地旧值（分组跨刷新/合并保持稳定）

### Changed

- package.json 版本 `0.17.0` → `0.18.0`；README 同步工作区分组说明、
  /restart/info 的 workspace 字段与 slug 回退链；既有 /restart/info 接线
  断言统一补 `workspace: ''`（registry 与 workspace.json 全缺失的 mock 场景）

## [0.17.0] - 2026-10-28

### Added

- **恢复口径再收窄：正常结束的会话不再自动恢复**（0.10.0 口径反转曾让正常收工的
  会话重启后也被恢复；lib/session-scan.js + lib/detect.js + lib/index.js）：
  - **新恢复口径**：恢复候选 = 最近活跃窗口内且**最后已知状态不是「正常结束」**。
    判定主判据用会话日志扫描（重启后日志已完整落盘，是真源；事件内存态会因崩溃
    丢失）：最后一条真实 `turn/end` 的 `reason.kind === "completed"` → 跳过并结算
    `result: 'skipped-completed'`（error: null，不算失败）；最后是 `turn/start`
    无对应 `turn/end`（turn 开着被崩溃/重启打断）或最后 kind ∈ {aborted, blocked,
    error, max-tokens, interrupted, forked, 未知 variant} → 照旧恢复；日志文件
    不存在/解压失败/解析异常 → **保守恢复**（宁可多恢复，维持旧行为）；
    `running:true`（重启时仍在运行）免扫描直通
  - **新纯函数**（可单测）：`scanSessionLastTurnState` / `lastTurnStateFromText` /
    `isTurnStartRecord` / `turnEndKindOf`（session-scan.js，复用人工输入扫描的
    同一套文件定位与多帧 zstd 解压读取器）、`classifyCompletedRestoreGate` /
    `filterCompletedCandidates`（detect.js）；`classifyRestoreFallback` 扩展
    `skippedCompletedCount`——候选全部正常结束时安静收尾，不回退吵主会话
    （与归档安静收尾同款）
  - **接线点**：开机恢复流程在归档剔除与 subagent 拆分之后、逐个尝试之前过
    正常结束门；`fallbackWake` 直达目标与 `escalateFallbackWake` 升级目标同样过门
    （最后已知状态正常结束就不投递，wake.log 留痕）；0.6.0 human-prompt 守卫
    保持不变，叠加在新门之后；boot 记录 `runningSessions` 保持如实记录（不过滤）
  - **同步点**：`GET /state` 的 restoreCandidates（顶栏开关显示门控）、ws 快照、
    `GET /restart/info` 的 runningCandidates（0.13.0 候选明细）都只含过滤后候选
    ——开机对播种的 recentSessions 逐个扫描一次（memoized，恢复门复用同一结果），
    运行期由宿主 `session/event` 事件维护（turn/end completed 加入、turn/start 与
    其他 kind 移出、agent/status running 移出），请求路径不扫日志
  - **记录性字段**：marker.recentSessions 条目新增 `lastTurnEndKind`（由
    `session/event` 监听维护，随节流落盘；**仅供观测，恢复过滤绝不依赖它**——
    崩溃会丢；旧 marker 无该字段完全兼容）
  - **附带修复**：开机恢复流程的 `picked` 候选按 `mergePausedCandidates` 契约带上
    `running`（此前 `pickRestoreTargets` 只回 `{id, at}`，运行态被归一化丢失——
    0.15.0 起该字段无消费者所以无症状，0.17.0 的门需要它）
- **设置弹窗「重启」：待恢复列表标题行新增「刷新」按钮**（lib/client.js
  RestartSection；preview / confirm 皆可用，waiting 只读态隐藏——该阶段隐藏全部
  按钮的既有约束不变）：点击重新 `GET /restart/info` → `normalizeCandidateDetails`
  构建行 → `mergePendingRows` 合并（与 openConfirm 同一口径：保留本地取消标记、
  服务端不再返回的行保留并置 `cancelled=true`）→ 同步收窄选中集合 → 更新渲染；
  拉取中按钮禁用并显示「刷新中…」；失败静默保留现有列表（console.warn，沿用既有
  错误处理风格）。zh/en 字典新增 `restart.pendingRefresh` / `restart.pendingRefreshing`
- **结算徽标新增 `skipped-completed`**（对账视图「正常结束跳过」+ 重启日志 section
  的 `restore.skipped-completed`；SETTLE_RESULTS 白名单同步扩充），zh/en 双语

### Changed

- package.json 版本 `0.16.0` → `0.17.0`；README 同步 0.17.0 恢复口径、候选显示
  口径、刷新按钮与日志枚举说明

## [0.16.0] - 2026-10-27

### Added

- **设置弹窗「重启」：进入选项卡即自动展示本次待恢复的会话列表**（lib/client.js
  RestartSection，纯前端改动；后端与存根 schema 零改动）：
  - **挂载即见，不再等点按钮**：section 挂载时既有的 `GET /restart/info` 拿到响应后，
    直接经 `normalizeCandidateDetails` 构建待恢复列表并渲染（新列表来源模式
    `pendingMode = preview`）——进入「重启」选项卡就能看到本次要待恢复的会话，
    不必先点「重启 DSH」；空列表照旧显示「无待恢复会话」
  - **操作能力原样可用**：preview 列表与点「重启 DSH」后的列表（confirm）共用同一
    构建 `renderPendingList`——0.14.0 的逐行/批量「取消 / 恢复」在选项卡内直接可用
    （取消 = 该会话重启后不自动恢复，乐观更新 + 失败回滚，取消标记只存组件本地
    state）；「重启后将自动恢复 N 个」计数按同一行数据 `activePendingCount`
    实时联动
  - **既有阶段门控不破坏**：`pendingRows` 行数据语义不变（null = 列表未构建）；
    `openConfirm` 点击时刻重拉 + `mergePendingRows` 合并口径保留——preview 阶段的
    取消标记随合并进入 confirm，服务端不再返回的行保留并置 `cancelled=true`；
    新增 `clickedRef` 防挂载请求晚到覆盖点击时刻已合并的列表（也不得回落
    preview）；waiting 只读、POST 失败回 idle 列表保留，均不变
  - **对账视图门控**：confirm 列表仍优先于重启后对账视图（0.13.0 语义不变）；
    preview 列表**不遮蔽**对账视图——重启后的新页面（存根未覆盖前）列表与
    「上次重启的恢复结果」两块同时渲染，列表在上

### Changed

- **列表来源模式 state**：RestartSection 新增 `pendingMode`（none / preview /
  confirm）与 `clickedRef`；列表构建抽成 `renderPendingList()` 供 preview 与
  confirm 两处共用（同一份行构建与取消/恢复能力，零行为分叉）
- package.json 版本 `0.15.0` → `0.16.0`

## [0.15.0] - 2026-10-27

### Added

- **设置弹窗「重启」：「暂停所有会话」按钮 + 暂停后的会话在任意重启后自动恢复**
  （lib/client.js RestartSection + lib/index.js 新路由 `POST /api/dsh-resume-on-restart/pause-all`）：
  - **一键暂停**：经 agents 服务枚举运行中会话（`status === 'running'` 且不被
    `ignoredSessionPrefixes` 排除），逐个用 `sessionController.cancel({ sessionId })`
    停止——「用户点停止」的同一实现，已排队的输入保留；subagent routing 持有的
    会话跳过并结算为 subagent（不算失败，与恢复口径一致）；响应
    `{ ok, stopped: [{id, title?}], subagent: [id], failed: [{id, error}] }`，
    同时 `recordActivity(id, 'idle')` 立即更新内存视图与 marker
  - **暂停集合持久化**：停止成功的会话并入 `<stateDir>/paused-sessions.json`
    （与 excluded-sessions.json 完全同款 `{ sessions: { [id]: atISO } }`，读写归一化
    防御风格照抄排除集合）；`enablePauseAll` 配置开关（默认开，仅显式 false 关闭）
  - **恢复口径**：wasRestart 开机时暂停文件被一次性消费——`mergePausedCandidates`
    把暂停条目并入恢复候选池（按 id 去重 recentSessions 优先、at 新 → 旧、
    `restoreMax` 截断），随后照走既有排除/归档/subagent 拆分/恢复流程；**超出
    `trackMax` 最近活跃窗口的会话同样恢复**；读取后删文件 + 清内存集合，只发生一次。
    候选并集（`unionRestoreCandidateIds`）同时接入四处：`GET /state` 的
    restoreCandidates、ws 快照、`/restart/info` 的 runningCandidates（at 优先
    recentSessions 真实值，否则用暂停时刻）、开机恢复流程——顶栏开关、ws 快照、
    重启确认列表与恢复流程全部可见暂停会话
  - **双向互斥**：`POST /pause-all` 与 `POST /restart` 经 pauseLatch/restartLatch
    互相检查（409 + 稳定错误文案）；同类的并发重复请求由各自闩拦截
  - **UI 与 i18n**：「暂停所有会话」按钮位于「重启 DSH」左侧（中性 `.dsh-ror-btn`，
    非 danger 红；仅 `info.pauseAll === false` 时隐藏，info 拿不到照常显示）；
    二次确认弹窗复用 `.dsh-ror-modal` 系列样式（RestartConfirmDialog 泛化
    title/body/confirmLabel/neutral props 供两处共用，默认焦点「取消」、Esc/点遮罩
    取消）；doing 阶段两个按钮禁用 +「正在暂停…」；成功展示 formatPauseResult 摘要
    并重拉 `/restart/info` 刷新候选计数与列表运行徽标；zh/en 字典补齐 `pause.*`
    全部新 key（zh 权威）

### Changed

- **新增纯函数**（detect.js）：`unionRestoreCandidateIds`（候选 id 并集去重，ids
  顺序在前）、`mergePausedCandidates`（picked 优先去重 + at 降序 + restoreMax
  截断）、`selectRunningAgentIds`（running 过滤 + 忽略前缀，防御式）——全部不抛错、
  不修改入参
- **/restart/info 响应体新增 `pauseAll: enablePauseAll`**；cancel 通道的
  sessionController 探测要求 resolveAgent + cancel 都存在，与恢复路径探测
  （只要求 resolveAgent）分开实现，恢复语义零改动
- **client 工厂新增导出 `formatPauseResult`**（暂停结果摘要文案），与上述 detect
  纯函数一并单测（新增 `lib/pause-all.test.js`，加入 `npm test`）
- package.json 版本 `0.14.0` → `0.15.0`

## [0.14.0] - 2026-10-26

### Added

- **设置弹窗「重启」：待重启恢复会话列表的逐行与批量「取消 / 恢复」操作**
  （lib/client.js RestartSection，0.13.0 引入的列表原位扩展；后端零改动）：
  - **行级操作**：每行行尾「取消 / 恢复」小按钮——未取消行「取消」把该会话标记为
    重启后不自动恢复，点击后乐观变为已取消态（弱化样式 + 「已取消」徽标，行保留在
    列表中不许消失，否则无法撤销）；已取消行「恢复」撤销标记、行回到正常态
  - **批量工具条**：列表标题与行之间 = 全选 checkbox（支持半选 indeterminate）+
    「已选 N 项」计数 +「取消所选」「恢复所选」两个按钮，无选中行时按钮禁用；
    waiting 阶段（重启已发出）列表转只读——checkbox 与全部操作按钮隐藏，重启后
    对账视图（settlement）保持只读不动
  - **接口复用**：既有 `POST /api/dsh-resume-on-restart/state`（body
    `{ sessionId, excluded: true|false }`）每会话一次请求，批量对选中行逐个
    **串行**发送；乐观更新 + 失败仅回滚对应行并 console.warn（风格照抄顶栏开关
    ResumeToggle.toggle）；在途行禁用自身按钮防重复点击
  - **数据口径**：行数据本地扩展 `cancelled` 标记（组件本地 state），不写入
    localStorage 存根——存根 schema 不变、candidates 仍含全部行，被取消会话重启后
    由服务端 restore 记录结算为 excluded，对账视图已有「已被用户排除」徽标，
    对账逻辑零改动

### Changed

- **openConfirm 口径合并（防「取消后无法恢复」）**：`pendingRows` 已存在时不再直接
  用服务端列表覆盖，改经新导出纯函数 `mergePendingRows(prevRows, nextRows)` 合并——
  服务端返回的行为准（`cancelled` 字段用本地旧值，title 服务端缺失时回退本地旧值），
  本地已有但服务端不再返回的行保留并置 `cancelled: true`（服务端已把该会话剔除出
  恢复候选 = 取消生效）；`pendingRows === null`（首次）维持现状直接用服务端列表；
  选中集合随合并同步只保留仍存在的行
- **「重启后将自动恢复 N 个活跃会话」计数**：待恢复列表存在时改按未取消行数实时
  显示（新导出纯函数 `activePendingCount(rows)`），行级/批量取消后即时反映；列表
  不存在（本轮没点过按钮）维持 `/restart/info` 的服务端计数
- **新增导出纯函数**（从 client bundle 工厂导出，供 node --test 经
  `window.__ModuleLoader__` 桩加载后直接单测）：`mergePendingRows`（服务端为准 +
  本地取消标记保留 + 服务端缺行置 cancelled + 按 id 去重防御）、
  `setPendingCancelled(rows, ids, cancelled)`（返回新数组不改入参，ids 支持单个
  字符串或数组）、`activePendingCount`（未取消行数，防御式）
- **i18n**：zh/en 字典补齐 `restart.pending*` 新 key（zh 权威，en 对齐）：
  取消/Cancel、恢复/Restore、已取消/Cancelled、取消所选/Cancel selected、
  恢复所选/Restore selected、已选 %s 项/%s selected、全选/Select all；
  内嵌 CSS 补批量工具条/checkbox/行内小按钮/已取消弱化行样式（配色沿用现有
  --dsw-alias token，明暗主题自适应）
- package.json 版本 `0.13.0` → `0.14.0`

## [0.13.0] - 2026-10-26

### Added

- **设置弹窗「重启」：确认后的待恢复会话列表与等待计时**（lib/client.js RestartSection）：
  「重启 DSH」按钮进入 confirm 弹窗时重新拉一次 `GET /restart/info`（保证列表是
  点击时刻的最新口径）；POST `/restart` 成功进入 waiting 阶段后展示
  「待重启恢复会话列表」——每行 = 截断会话 id（+ 防御式会话标题）+ 最后活跃
  本地时间（at 缺失显示 —）+ `● 运行中` 标记，列表空显示「无待恢复会话」；
  waiting 阶段另显示「重启中… 已等待 N 秒」（组件内 setInterval 每秒跳动，
  离开 waiting/组件卸载即清理；timedOut 提示逻辑不动）
- **重启完成后的逐会话恢复结果对账**：POST `/restart` 成功后把
  `{ at: 确认时刻ISO, restartId?, candidates: [{id,at,running}] }` 覆盖写入
  localStorage（key `dsh-ror-pending-restore`，单条覆盖式、写入包 try/catch）；
  页面（重启后自动刷新）重新挂载时读存根（无则什么都不显示，现状不变），
  `GET /restarts` 匹配 boot 记录（`pending.restartId === boot.origin.restartId`
  优先，回退 `boot.at >= pending.at - 2min` 时钟容差的最新一条），收集该 bootAt
  之后的 restore 记录按 id 归组，待恢复列表原位变为「上次重启(<时间>)的恢复结果：
  x/y 已恢复」+ 逐会话结算徽标（resumed=已恢复 / failed=恢复失败（error 摘要）/
  excluded=已被用户排除 / archived=已归档跳过 / subagent=经主会话代理恢复 /
  skipped-budget=预算耗尽跳过 / skipped-no-human-prompt=无人工输入跳过 / 无记录
  =待结算）；服务端结算是异步的（sessionController 等待最多 30s + 逐候选），
  存在待结算会话时每 3s 短轮询 `/restarts`、最多 20 次，全部候选有结算记录即
  提前停止，轮询结束仍未结算的显示「未结算」；定时器组件卸载时清理。
  POST 失败回 idle：计时器随 phase 清理、列表保留、按钮可重试（现状行为不变）。
  下次点「确认重启」覆盖 localStorage，UI 切回 waiting 列表态。
  对账匹配/归组逻辑抽成可测纯函数（`readPendingRestore` / `writePendingRestore` /
  `matchPendingBoot` / `collectSettlementsBySession` / `normalizeCandidateDetails`）
  并从 client bundle 工厂导出，`node --test` 经 `window.__ModuleLoader__` 桩加载
  真实 bundle 后直接单测（新增 `lib/pending-restore.test.js`）
- **i18n**：T 字典 zh/en 补齐待恢复列表、等待计时与逐会话结算徽标全部新文案
  （zh 权威：已恢复/恢复失败/已被用户排除/已归档跳过/经主会话代理恢复/预算耗尽
  跳过/无人工输入跳过/待结算/未结算等）

### Changed

- **`GET /restart/info` 的 `runningCandidates` 从 `string[]` 升级为候选明细对象数组
  `[{ id, at, running, title? }]`**（lib/index.js）：此前
  `.map((id) => ({ id, at: 0 }))` 把真实最后活跃时间丢了，现回查内存
  `recentSessions` 携带真实 `at`（最后活跃毫秒时间戳 → ISO 字符串输出，未知为 ''，
  与 boot 记录 `runningSessions` 同款口径）与最后已知运行态 `running`；
  归档剔除 + subagent 拆分的候选口径完全不变（`directRestorableCandidates`）。
  另防御式经 `ctx.reflect.get('sessions')` 探测会话标题（`record.title` 优先、
  其次 `record.header.title`，非空字符串才采纳）：store 缺失/形状不对/抛异常
  一律不带 title 字段，绝不阻塞路由
- **测试**：`archive.test.js` 的 `/restart/info` 断言随 payload 形状更新（候选明细
  含真实 id/at/running、归档剔除口径不变、手动停止的 `running:false` 如实透出），
  新增 title 防御探测接线测试；新增 `lib/pending-restore.test.js`（存根读写、
  boot 匹配、restore 归组、候选明细归一化），挂进 `npm test`

### Fixed

- **待重启恢复会话列表显示会话标题而不是会话 id 列表**（0.13.0 交付后的用户反馈修正）：
  - **根因**：0.13.0 的 title 探测读的是 `sessions.get(id).title` / `.header.title`，
    但 DSH 宿主的会话标题不在 header——它是 session projection（`session/title`
    事件的 last-wins 投影），探测几乎必落空 → 列表只显示会话 id
  - **宿主 title 读取链重排**（lib/index.js `sessionTitleLookup`）：首选
    `ctx.reflect.get('sessionProjections').stateOf(sessions.get(id), 'title')`
    （同步、物化到该 Session 当前游标；非空字符串才采纳，null/undefined/非 string
    都不要）；次选保留 `record.title` / `record.header.title` 回退（无害防御）；
    都没有 → 不带 title 字段。`sessions.get(id)` 为 undefined（未入 store/被逐出）
    时不自造对象去调 stateOf，直接走回退/放弃；服务探测失败、stateOf 抛异常只
    console.warn 一次后静默降级到下一层，绝不阻塞 `/restart/info` 路由
  - **客户端列表改「标题为主、id 退位」**（lib/client.js）：待恢复列表（waiting
    阶段）与重启后对账视图（settlement）的每行改为「徽标/标记 + 会话标题
    （flex:1 省略号截断，全文在元素 title 属性）+ 最后活跃时间 / error 摘要」；
    title 缺失（未命名会话/旧存根）才退回 shortId 且用弱化色（新样式类
    `.dsh-ror-restore-title` / `.dsh-ror-restore-title-fallback`），完整 id 一律
    放行容器 title 属性做悬停提示，不再作为行主文本。localStorage 存根 candidates
    同步携带 title（`{ id, at, running, title? }`，title 空则省略字段），
    `readPendingRestore` 归一化保留非空字符串 title
  - **测试**：`archive.test.js` 的 title 接线改为 mock `sessionProjections`
    （stateOf 返回标题）+ sessions（活 Session 对象）验证投影首选链路，并补断言
    stateOf 返回 null / sessions.get 为 undefined / projections 探测抛异常时的
    回退与降级、服务全缺失不带 title 且路由 200；`pending-restore.test.js` 补
    title 保留/省略断言

### Notes

- `/restart/health` 轮询的成功判定逻辑（instanceId 基线比对）是豁免区，
  0.13.0 未动一行——本次全部是展示层与对账视图
- `checkRestartedToast` 既有判定逻辑保持不动

## [0.12.0] - 2026-10-26

### Changed

- **ws 状态推送从「插件自监听随机端口」迁移到宿主 DSH webServer 主端口 + 插件路径**
  （升级端点改为同源的 `GET(Upgrade) /api/dsh-resume-on-restart/ws`）。动机：0.11.0
  起 ws 服务端 bind `0.0.0.0` + 随机端口，整套拓扑都被迫围绕「跨端口」打补丁——
  - 跨端口 ws 握手必报 `sec-fetch-site: cross-site`、宿主围栏按 host:port 精确匹配
    Origin 必拒 → 0.11.1 被迫加 403 回退补丁（`explainWsUpgradeTrust` 裁决）；
  - 容器端口发布 NAT 下合法浏览器来源 socket 必非 loopback → 又加
    socket-not-loopback 跳过补丁；
  - 端口要经 `/ws-info` 下发，DSH 重启后端口变化客户端还要重拉重连。
  现改为经宿主 `webServer.registerUpgrade` 把升级处理器挂在宿主主端口的精确路径
  `HTTP_BASE + '/ws'` 上（宿主 server 的 'upgrade' 事件按 pathname 精确查表分发、
  查不到 destroy；宿主对升级路由不做围栏/认证，仍由插件 handler 全权负责，职责
  与原实现一致），同源同端口后上述补丁不再必需：
  - `lib/ws-state.js` 从「自持 http.Server」重构为「升级处理器 + 推送 hub」：
    移除自建 server、bind、随机端口与 `start()`，改为导出
    `handleUpgrade(req, socket, head)`（token timing-safe 校验、注入的
    verifyUpgrade 围栏、协议头校验、连接登记、首帧全量快照的顺序与逻辑不变）；
    连接数上限、1MiB 帧上限、30s 心跳回收、300ms 合并节流 + 内容去重广播、
    close() 清理全部连接全部保留；socket 生命周期交宿主 upgradedSockets 统一管理，
    本侧 dispose 只发 close 帧后 destroy；`info()` 返回 `{ ok, token }`
  - `lib/index.js`：`ctx.inject(['webServer'], ...)` 内防御式探测
    `typeof webServer.registerUpgrade === 'function'`，可用则注册升级路由
    （同名路径被占等注册失败只 console.warn 降级）；不可用（旧版宿主）同样降级：
    `wsPush` 保持 null、`/ws-info` 返回 503、客户端按既定设计无限重试但开关退化
    为一次性 GET /state，绝不炸插件加载；effect 清理函数里调用注册返回的
    disposer + `wsPush.close()`。围栏逻辑全部保留不动（401/403 回退顺序、
    `explainWsUpgradeTrust`、容器跳过 socket-not-loopback、cid 解析、节流拒绝
    日志）——同源之后正常路径先命中「宿主围栏放行」的快速分支，这些防御不碍事
  - `lib/client.js`：ws URL 改同源
    `ws(s)://<location.host>/api/dsh-resume-on-restart/ws?token=...&cid=...`
    （协议仍随 `location.protocol`，`location.host` 自带端口）；`/ws-info` 照旧
    一次性拉取（拿 token），响应里不再有 port 字段也不读它；指数退避 1s~5s
    无限重试策略不变
- **`/ws-info` 契约变化**：`{ ok, port, token }` → `{ ok, token }`（不再返回
  port）；服务不可用仍返回 503，语义不变

## [0.11.1] - 2026-10-26

### Fixed

- **修复 ws 升级被宿主围栏误拒导致的日志刷屏**（线上症状：DSH 服务端日志被
  `[resume-on-restart] ws upgrade rejected by host fence: host-fence` 每 1~5 秒刷
  一行，会话恢复完成后仍持续）。根因有两层：
  - **宿主 HTTP 围栏误伤跨端口 ws**（根修）：`verifyWsUpgrade` 把宿主
    `connection.requestRejection` 的 403 原样照单全收，而该围栏为同端口 HTTP API
    设计——请求带 Origin 时要求与请求 host:port 精确同源、对 `sec-fetch-site:
    cross-site` 一票否决；「页面 :3080 ↔ ws 随机端口」的跨端口 ws 每次握手必 403
    → ws 永远连不上 → 客户端按既定设计无限重试（1s~5s 退避，README 明确绝不回退
    轮询）→ 服务端每次拒绝一行日志。现裁决顺序重构：401 仍直接拒绝
    （not-authenticated，语义不变）；403 不再照单全收，回退插件自带的 ws 拓扑适配
    围栏 `explainWsUpgradeTrust` 裁决；`undefined`（宿主放行）维持放行；`null`
    （宿主未提供该服务）维持回退本插件围栏
  - **容器 NAT 适配**（仅修 403 回退还不够）：docker 部署经端口发布 NAT 进来的
    合法浏览器，来源 socket 必非 127.0.0.1（是 docker 网桥地址），原
    `socket-not-loopback` 检查会把所有合法标签页拒之门外。现该检查仅在非容器环境
    执行（`/.dockerenv` 在 apply() 里 stat 一次，`/restart/info` 的 isContainer
    同源复用），其余围栏规则不变——Host 主机名信任、Origin 拓扑匹配、随机 token
    timing-safe 校验三道闸全部保留
- **ws 升级拒绝日志节流去重**（日志纪律）：新增 `createWsUpgradeRejectLogger`，
  key = `reason|remoteAddress|cid`——同 key 首次输出完整明细；60 秒窗口内静默；
  窗口后再触发补一行并带累计抑制数（如 `(suppressed 12 in last 60s)`）。每条输出
  都带区分明细：reason、来源 socket 地址、Host、Origin（头值一律过 `logSafeHeader`
  防伪行截断）、cid，缺失项显示 `<absent>`。401 路径与 403 回退后仍被插件围栏拒绝
  的路径都走该助手；HTTP 路由的 `refuse()` 维持不打日志
- **ws URL 追加每标签页随机标识 cid**：ws 升级层没有会话概念，客户端（lib/client.js）
  页面加载时生成一次随机 id（`crypto.randomUUID` 优先、`Math.random` 拼接降级，
  清洗为 URL 安全字符并截断 ≤64）追加为 `&cid=`；服务端升级路径从 req.url 解析
  （非法/缺失按 `<absent>`），纳入节流 key 与日志明细。客户端无限重试策略不变
  （既定设计，绝不回退轮询）
- **ws 围栏信任源对齐宿主生效名单**（403 回退后的最后一处根因：上两步修完线上仍
  每分钟一条 `ws upgrade rejected: host-untrusted` 汇总日志）。页面从局域网/容器
  IP（如 `http://172.19.0.199:3080`）打开时，插件围栏的 Host 主机名检查读的是
  `webStartup.trustedHosts`——那里只有 CLI `--trusted-host` 参数（本部署未配置 →
  空数组）；而宿主围栏实际使用的是 `connection` 服务经 `resolveLanTrust` 合成的
  生效名单（webServer 绑 0.0.0.0 时自动并入本机全部非内部 IPv4）。两份名单不一致
  使插件围栏比宿主严：宿主放行的页面来源 ws 仍 `host-untrusted` → 客户端按既定
  设计无限重试。现 `declaredTrustedHosts` 按优先级读取：`ctx.get('connection')
  .trustedHosts`（宿主 `requestRejection` 实际使用的生效名单，GUI 能从该 IP 正常
  打开即证明目标地址在其内）→ 回退 `webStartup.trustedHosts`（CLI 声明）→ 都没有
  为空数组；防御式取值仅收字符串数组元素

## [0.11.0] - 2026-10-22

### Changed
- **顶栏开关状态同步从 15 秒轮询改为 websocket 快照推送**（用户规则：能不用轮询接口就
  不用轮询、改用 websocket；ws 连接失败必须一直重试、绝不回退轮询。唯一豁免的
  「重启 dsh」轮询不受影响，豁免区零改动）：
  - **新增 `lib/ws-state.js`（零依赖最小 RFC6455 服务端，node:http + node:crypto，
    不新增任何 npm 依赖）**：`Sec-WebSocket-Accept = base64(sha1(key + GUID))` 握手、
    客户端掩码去除、ping/pong/close、最简分片（客户端数据不消费，只为正确吃掉字节流）、
    只发不加掩码的文本帧、单帧/累积缓冲 1MiB 上限（超出 1009 关闭）、30s 心跳回收
    半开连接、连接数上限 64 兜底；bind `0.0.0.0` + 随机端口（可达性与宿主 webServer
    一致，局域网 IP 打开的 GUI 同样可用），`server.unref()` + 连接 socket `unref()`
    不改变进程退出行为；随注册它的 `ctx.effect` dispose 关闭；listen 失败只
    console.warn 降级，绝不炸插件加载
  - **安全**：进程启动生成随机 token（base64url 24 字节）；既有前缀路由新增
    `GET /ws-info`（过既有信任围栏：宿主 `connection.requestRejection` 优先 + 最小围栏）
    一次性返回 `{ ok, port, token }`（不是轮询）；ws 升级握手校验 query 的 token
    （sha256 摘要后 `timingSafeEqual`）+ 与 HTTP 路由同口径的信任围栏
    （新纯函数 `explainWsUpgradeTrust`，不信任直接 destroy 不给回包）。ws 拓扑适配：
    跨端口 ws 握手 `sec-fetch-site` 必为 `cross-site`、Origin 是页面来源（宿主
    webServer 端口）——Host 主机名仍须 loopback/`--trusted-host` 声明（按主机名匹配，
    防 DNS rebinding），`sec-fetch-site` 不再否决，同侧防护由「随机 token + Origin
    必须与 ws 同主机名且端口等于宿主 webServer 端口」承担
  - **推送协议**：连接建立后立即推一帧全量快照 `{ type:'state', restoreCandidates,
    excluded }`（与 `GET /state` 同口径）；排除集合变化（`POST /state` 成功后）与
    候选集变化（`recordActivity` 触发点）都广播同一快照；高频活动事件做 300ms
    首发立即 + 窗口合并节流，快照内容没变（如同 id 活动只挪动 `recentSessions` 顺序）
    直接跳过不重发
  - **`lib/client.js`**：彻底删除 `POLL_INTERVAL_MS` 与 15 秒 `setInterval`（及补偿性
    的 window focus 查询）——全文件不再有任何周期性拉接口的定时器；新增模块级单例
    ws 管理器：懒拉一次 `/ws-info` → `new WebSocket(ws(s)://<hostname>:<port>/?token=...)`
    （协议随页面 `location.protocol`），快照按 sessionId 分发（`ResumeToggle` 在
    `useEffect` 里订阅自己的 id，已有快照时新订阅同步补发）；`/ws-info` 拉取失败与
    ws 连接失败/断开都无限重试（指数退避 1s 起、封顶 5s，每轮重拉 `/ws-info`——
    DSH 重启后随机端口会变），重连成功后服务端快照即完成状态重建，多标签页自动对齐；
    挂载时保留一次性 `GET /state`（事件驱动首帧前的兜底，非轮询，且被更晚到的
    ws 快照保护不被覆盖）；开关点击仍是 `POST /state`（乐观更新 + 失败回滚不变）
  - **豁免区零改动**：`RestartSection` 的 `/restart/health` 轮询、`checkRestartedToast`、
    `lib/restart.js` 全部、宿主 `waitForSessionController` / `fallbackWake` /
    `restoreCandidates` 均原样保留
- package.json 版本 `0.10.0` → `0.11.0`

## [0.10.0] - 2026-10-22

### Changed
- **恢复口径反转：手动停止的会话重启后同样恢复、同样显示顶栏开关**（回归 0.3.x
  的覆盖行为，废除 0.4.0 引入的"只有 DSH 停止那一刻仍 running 的会话才恢复/才
  显示开关"口径；0.4.0 之后的其他能力全部保留）：
  - `pickRestoreTargets`（lib/detect.js）不再按 `running === false` 过滤候选——
    `marker.recentSessions` 的全部有效条目（id 为非空字符串的对象条目）都是候选，
    去重、按活跃时间新 → 旧、截断 `restoreMax` 的既有链路不变；配套的"recentSessions
    全被 running 过滤光也不回退 `lastSessionId`"防混回逻辑随之简化为普通的
    "有列表就整表接管，没有才走 legacy 回退"
  - `collectRestoreCandidateIds`（lib/detect.js）同口径去掉 `running !== false`
    条件——开关显示候选 = 恢复候选，顶栏开关对最近活跃窗口（`trackMax`）内的全部
    会话渲染，含手动停止/正常结束的；窗口外/被忽略前缀的会话仍不显示
  - `running` 字段的记录逻辑保留不动（`agent/status` 照常维护、marker 照常序列化），
    但降级为纯记录字段（供重启日志与旧版本兼容），不再参与任何候选/显示过滤；
    启动播种由"一律回填 `running: true`"改为沿用 marker 里最后已知的 running 值
    （纯字符串旧格式 / legacy `lastSessionId` 条目仍回填 true），boot 记录
    `runningSessions` 的 running 同步如实取值
  - 其余过滤链全部不变：用户排除名单（`excluded-sessions.json`）、归档过滤
    （含 subagent 后代 lineage）、subagent 代理主会话恢复、human-prompt 守卫
    （`requireHumanPrompt`）、`trackMax` 窗口、`restoreMax` 上限
  - lib/client.js 开关门控本就只看 `/state` 的 `restoreCandidates`（随宿主口径
    自动放宽，无逻辑改动），仅同步更新注释与 zh/en 文案（"重启前运行中的会话"→
    "重启前活跃的会话（含手动停止的）"、候选数单位"个运行中的会话"→"个活跃会话"）

## [0.9.1] - 2026-10-16

### Fixed
- **全量恢复不再"首个成功即停"**：`restoreCandidates` 此前在第一个候选投递成功后
  直接 `return`，其余运行中会话既不恢复也没有任何日志（10-14 05:48 boot 4 个候选
  只有 3 条 restore 记录，第 4 个候选凭空消失；与 README 0.5.0 起的"全量恢复"语义
  直接矛盾）。现改为逐个尝试全部候选、汇总 restored；预算耗尽的候选照旧记
  `skipped-budget`（可见，而非无声消失）
- **subagent routing 持有的候选不再记 failed**：宿主 `sessionController.resolveAgent`
  对 `header.origin === 'subagent'` 的会话一律拒绝（稳定 RemoteError 文案
  `session "x" is owned by subagent routing`，正确通道是经父会话/subagent delivery；
  10-13 09:30 与 10-14 05:48 两次 boot 各有一个候选因此失败）。候选阶段用 session
  store header（防御式探测，与归档过滤同口径）识别这类候选：
  - 结算为 **`result: 'subagent'`**（与 archived/excluded 并列，**不算失败**），
    error 注明处置方式（代理祖先 / 被候选覆盖 / 祖先被排除 / 祖先归档 / 无祖先）
  - **经主会话祖先代理恢复**：沿 `parentSession` 上溯到最近的主会话祖先，作为代理
    恢复目标并入候选（去重、按活跃时间新 → 旧），用户的工作经 lead 会话继续；
    祖先被用户排除或已归档时不代理（尊重用户意图，安静结算）
  - session store 缺失 → 无法预识别（退化 = 现状），恢复循环里对 RemoteError 文案
    兜底识别，同样结算 `result: 'subagent'`（绝不记 failed）
  - `GET /restart/info` 的 `runningCandidates`（设置弹窗「重启后将自动恢复 N 个」）
    同口径剔除 subagent 会话（store 缺失时维持现口径）
  - 纯函数在 lib/detect.js：`isSubagentSessionHeader` / `mainAncestorSessionId` /
    `partitionSubagentCandidates`；lib/client.js 补 zh「子代理会话」/en `subagent`
    文案与青调徽标
- **fallbackWake 不再 `no target agent after wait`**：宿主 `agents.roots()` 只返回
  "已 live"的顶层 agent（`AgentRegistry.roots`），开机若没有任何会话被恢复/打开，
  20 秒轮询必然落空，降级通知从此没有出口（10-10 至 10-15 历史 wake.log 至少 7 条
  该错误）。落空后升级：等 `sessionController` 就绪（`serviceWaitTimeoutMs` 预算），
  把 `lastSessionId`（重启前最近活跃会话；subagent 会话先沿 `parentSession` 上溯
  主会话祖先）经 `resolveAgent` 解析成 live agent 再投递——与恢复候选同一恢复通道；
  尊重用户排除、归档（lineage 口径）与 human-prompt 守卫（fail-closed），每一步
  `wake.log` 留痕。human-prompt 守卫从 fallbackWake 局部提升到作用域级，轮询与
  升级路径共用同一 blocked 记忆
- **`resumeSession` 预算边角**：候选阶段 deadline 未设（`deadline === 0`，如 fallback
  升级路径）时旧实现 `max(1, remainingMs())` 会退化为 1ms 即超时；现以
  `budgetMs`/`restoreTimeoutMs` 为准；升级路径显式 `ignoreStageDeadline`，不继承
  候选阶段已耗尽的预算

### Notes
- 等待预算复核（0.7.0 的 `serviceWaitTimeoutMs` 独立预算 + 9b2bd2a 轮询等待）：
  10-16 00:53 boot 实测 sessionController 13.7s 就绪、独立预算下恢复成功；候选阶段
  总预算（`restoreTimeoutMs` 30s、按候选数平摊、每候选最低 5s）在"逐个尝试全部候选"
  后可能对尾部候选记 `skipped-budget`，属可见的预期行为（需要时调大 `restoreTimeoutMs`）

## [0.9.0] - 2026-10-15

### Added
- **恢复候选过滤已归档会话（归档不恢复）**：权威归档名单在宿主
  `ctx.workspaceRegistry.archivedSessionIds`（持久化在 workspace spec，跨重启保留）；
  归档是用户主动行为，unarchive 之前会话不可能正常干活（DSH 的 `ArchivedSessionGate`
  也会拒绝归档会话及其 subagent 后代跑模型步骤），本插件在更早的恢复候选阶段拦截：
  - **候选阶段剔除**：恢复流程在用户排除过滤之后、human-prompt 守卫与
    agents.get/resumeSession 之前，防式探测 `workspaceRegistry`（`ctx.reflect.get`
    非阻塞，不注入、不阻塞加载）读归档名单，归档会话从候选中剔除；能拿到
    session store（`ctx.reflect.get('sessions')`）时按 gate 同样的 lineage 规则把
    "归档会话的 subagent 后代"一并剔除——沿 session.header 的 `origin==='subagent'`
    + `parentSession` 向上走，任一祖先在名单里即剔除（fork 出的会话是独立会话
    不继承；祖先不在 store 时直接查该祖先 id 后终止，与 gate 同款）；拿不到
    store 就只查直系名单。过滤纯函数在 lib/detect.js：`normalizeArchivedSessionIds` /
    `sessionUnderArchivedLineage` / `filterArchivedCandidates`
  - **重启日志新结算结果 `archived`**：被剔除的候选与既有"用户排除"同口径结算
    （wake.log + 重启日志 `result: 'archived'`、error `session is archived`），与
    resumed/failed/excluded/skipped-budget/skipped-no-human-prompt 并列，**不算失败**；
    lib/client.js 设置弹窗重启日志补 zh「已归档」/en「archived」文案与紫调徽标配色
  - **回退语义**：候选全被归档剔除（无可恢复候选）时不触发 fallbackWake 降级
    通知——全是归档会话 = 用户有意归档，重启后保持安静，不吵主会话；可恢复候选
    失败、全部用户排除、无任何候选等其余情况回退行为完全不变（决策收口到新纯函数
    `classifyRestoreFallback`，脏输入保守回退）
  - **`GET /restart/info` 同口径**：设置弹窗「重启后将自动恢复 N 个运行中的会话」的
    `runningCandidates` 与恢复流程走同一过滤（含 subagent 后代），拿不到
    workspaceRegistry 时维持现口径
  - **防御退化**：workspaceRegistry 缺失/形状异常 → 不过滤（行为完全退化为现状）；
    session store 缺失 → 只查直系名单；单个会话 header 读取失败只影响它自己的
    lineage 判定，不阻断整个过滤

### Tests
- 新增 lib/archive.test.js（node --test，无 e2e、不起服务）：纯函数层（名单归一化、
  gate 同款 lineage 判定——自身/直系/多级祖先/缺失父会话/fork 不继承/防环/非法
  输入、候选过滤含"空名单零 lookup"与"store 缺失只查直系"、classifyRestoreFallback
  分支）与宿主接线层（mock cordis ctx：`/restart/info` 计数口径、候选全归档的安静
  收尾 + archived 结算、workspaceRegistry 缺失时行为完全不变；`DSH_HOME` 重定向
  临时目录，绝不触碰真实 `~/.dsh`）

## [0.8.0] - 2026-10-15

### Added
- **重启引擎（lib/restart.js，设计参考 dsh-power-button，独立实现）**：本插件从"只观测重启"
  升级为"可以发起重启"。两种模式由 `resolveRestartMode` 判定：
  - **helper（普通进程）**：真 `.cjs` detach helper（不用 `node -e`）经
    **ARM → COMMIT → ACK** 三段握手接管拉起职责——host 等到 helper ARM 才写 COMMIT、
    等到 ACK 才 unref 并安排自身退出；helper 等旧 pid 退出（时限由 host 退出预算
    `preExitBudgetMs + 15s` 派生）、端口释放、会话记录静默（(size, mtime) 连续两次采样
    一致；正则覆盖 `session.v4.jsonl[.zstd]`，power-button 的 `/session\.jsonl/` 会漏掉
    v4 形态）后，以原 argv+cwd（`--port 0` 被 pin 成实际端口）拉起新进程，env 带
    `DSH_ROR_RESTART_ID` 启动令牌，轮询 `/restart/health` 直到 `instanceId` 变更且
    `restart.restartId` 匹配才算就绪（端口投机者冒充不了），最后自删
  - **pid1-exit（容器内 PID=1，本插件的现实部署形态）**：PID 1 退出即容器销毁、PID
    namespace 内所有进程（含 detach helper）被内核杀死，helper 方案在结构上不可能工作。
    该模式改为"退出前把全部持久化记录写齐 → 优雅退出 → 交由容器重启策略拉起"：host 依次
    写 origin status（`~/.dsh/power-restart/ror-<restartId>.status.json`，带 `committedAt`）、
    重启身份记录（`<stateDir>/restart-identity.json`，带 `requestedAt` 时效窗口
    `IDENTITY_TTL_MS=15min` 防陈旧认领）、检测 marker 兜底 flush、停机归因存根
    （合成 `signal: 'restart-exit'`），然后 `ctx.get('appExit')` 优雅退出（缺失时自发
    SIGTERM 走既有优雅路径，unref 看门狗兜底 `process.exit(pid1ExitCode)`）。容器需以
    `--restart=always/unless-stopped`（或 `on-failure` 配合非 0 退出码）运行才能自动拉起
  - **退出前的持久化兜底（两模式共用）**：取消节流定时器同步固化检测 marker
    （`recentSessions`/running 标记是恢复流程的唯一数据源）+ 写停机归因存根；恢复流程本身
    零改动，重启后照常走"boot 记录 → 自动恢复运行中的会话 → fallback 通知主会话"
- **设置弹窗左侧「重启」选项（第二个 `settings.section` 条目，order 62）**：显示模式说明
  （PID=1 时提前告知依赖容器重启策略）、优雅退出通道可用性（appExit missing 警示）与
  「重启后将自动恢复 N 个运行中的会话」（`GET /restart/info`，与顶栏开关同口径）；
  「重启 DSH」按钮先弹**二次确认**模态框（默认焦点「取消」，Esc/点遮罩取消，必须显式点
  「确认重启」），确认后先捕获基线 `instanceId` 再 `POST /restart`，随后单飞轮询
  `/restart/health`：`instanceId` 相对基线变更（或无基线时"见过挂掉 + 重新起来"）才刷新
  页面，短暂断线绝不当成功；pid1-exit 模式超时提示容器策略可能未拉起（需手动
  `docker start`），降频（5s）继续等待
- **重启回执 toast**：页面加载时查 `/restart/health`，`restarted` 标记为真（本进程确为一次
  重启的产物且未被确认）弹「已重启：……正在自动恢复」顶部通知并 `POST /restart/ack` 消费
  （只清 toast 标记，`restart` 身份块保留整个进程生命周期；身份记录由启动时
  `matchRestartIdentity` 消费——v2 令牌匹配（helper）或时效窗口（pid1）才认领，手动启动
  不能冒领）
- **`/restart` 命令与 `restart_harness` 模型工具（对齐 dsh-power-button 的入口集合）**：
  与按钮共用同一个 at-most-once 闩（第二个并发触发得 409，绝不双 helper/双退出）；
  因果会话取发起者（origin.kind = `settings-ui` / `command` / `model-tool`），重启日志据此
  标注来源；名称已被其他插件注册时记日志让位，不影响本插件其余能力；模型工具 `delayMs`
  下限 1000ms（模型不能在自身 turn 结算前杀进程）、上限 `maxDelayMs`
- **origin 归因零改动复用**：helper 握手 status 写到 `~/.dsh/power-restart/` 目录（文件名
  `ror-` 前缀与 power-button 区分），`committedAt` 落在 [上次启动, 本次启动] 窗口内即被
  既有 `pickOriginRecord` 扫描命中；boot 记录 reason 新增 **`restart-button`** 标签
  （`origin.source === 'dsh-resume-on-restart'`，其余 origin 仍是 `power-button`），重启日志
  UI 补徽标配色与 zh/en 文案；启动时顺带 7 天 housekeeping 清理本插件工件（helper 脚本/
  日志、`ror-*.commit.json`、`ror-*.status.json`），不碰 power-button 的记录
- **新路由**（均在本插件既有前缀与围栏之下，`enableRestart: false` 时整体不存在）：
  `GET /api/dsh-resume-on-restart/restart/info`（模式/候选数/appExit 状态）、
  `GET /restart/health`（instanceId + 重启身份 + lifecycle，helper 就绪门控与客户端轮询
  共用）、`POST /restart`（防重入闩）、`POST /restart/ack`
- **新配置**：`enableRestart`（默认 `true`，按钮/命令/路由总开关）、`enableModelTool`
  （默认 `true`）、`restartDelayMs`（默认 `1500`）、`maxDelayMs`（默认 `5000`）、
  `pid1ExitCode`（默认 `0`；`--restart=on-failure` 部署设非 0）
- **新测试**：lib/restart.test.js（模式判定、端口 pin、预算派生、身份认领 7 分支、防重入
  闩、delay 夹取、helper 脚本产物协议点断言、**helper 真实进程端到端**——COMMIT 前不出手/
  COMMIT 后先写身份再拉起/假目标以 health-timeout 收场而非假成功）；detect.test.js 追加
  `shutdownReasonOf` 的 restart-button 用例；tools/smoke.mjs 手动冒烟（mock ctx 启动插件 +
  GET 路由 + pid1-exit 分支 stub appExit 端到端，`DSH_HOME` 重定向隔离）

### Security
- `POST /restart` 是破坏性操作，走本插件既有最小围栏（宿主 `connection.requestRejection`
  优先，缺失时回退复刻自 DSH 官方规则的 Host/Origin/sec-fetch-site 判断）+ 防重入闩；
  二次确认在客户端强制（默认焦点「取消」）。helper 脚本内嵌 relaunch argv，写盘 `0600`
  且握手失败即删；status/身份/commit 记录原子写（temp+rename）`0600`；启动令牌读后即删，
  不泄漏给子进程

### Changed
- 检测 marker.json **绝不被重启流程覆写**（power-button 的 helper 会覆写它自己的 marker；
  本插件的身份记录独立存 `restart-identity.json`，`recentSessions` 数据源不受影响）
- `POST /restart` 成功回包语义：helper 模式 = 握手三段全部完成、helper 已接手；pid1-exit
  模式 = 记录已写齐、进程即将优雅退出。此后的 helper 失败（如 health-timeout）只能靠
  页面轮询超时暴露，与 power-button 一致

## [0.7.0] - 2026-10-14

### Fixed
- **等服务挤占候选预算（多候选时首个候选必然等待超时）**：`sessionController` 按依赖序
  晚于 `agents` 激活，0.5.2 把等待放进每个候选的预算切片后，候选一多每份切片就被摊薄
  ——实测 4 候选 × 30s 总预算 = 每候选 7.5s，而该次启动服务实际 ~13s 才就绪，首个候选
  必然以 `sessionController service not ready within 7487ms` 失败。现把"等服务"拆出
  独立总预算：`restoreCandidates()` 进入候选循环前用新配置 `serviceWaitTimeoutMs`
  （默认 `30000`，与 `restoreTimeoutMs` 相互独立）一次性全局轮询等待（间隔仍为
  `SERVICE_POLL_MS` 500ms），结果与耗时记入 `wake.log`（就绪记
  `sessionController ready after <N>ms`）。就绪后候选阶段不再等服务：`resumeSession`
  的轮询退化为一次防御式即时检查（取不到即抛 `sessionController service unavailable`，
  不再等待），`resolveAgent` 仍用 `withTimeout` 按候选剩余预算封顶；`restoreTimeoutMs`
  语义收窄为"候选阶段总预算"，自服务就绪、进入候选循环前起算（等待已耗时间不占它）。
  等待超时（服务始终未就绪）不逐候选空转：`wake.log` 记一条
  `service-wait-timeout: sessionController not ready within <N>ms` 后直接回退
  `fallbackWake` 降级通知，保证通知必达。已 live 候选（`agents.get` 直接可得）的
  处理顺序不变；marker、`/state`、restarts 只读路由与 restarts.ndjson 记录结构均不变

## [0.6.0] - 2026-10-13

### Added
- **无用户提示词的会话不再被自动激活（恢复/回退投递守卫）**：新增 lib/session-scan.js，
  投递前扫描目标会话的记录文件（`<DSH_HOME>/sessions/<项目目录>/[session-]<id>/session.v4.jsonl[.zstd]`）
  判定是否有过真实人工输入；`restoreCandidates()` 在逐个尝试候选前（先于 agents.get /
  resumeSession）、`fallbackWake()` 在拿到回退目标后（立即与轮询两条路径）都先过该守卫，
  不通过就跳过投递并记日志（wake.log `ok:false` + 重启日志 `result: 'skipped-no-human-prompt'`，
  后者经 classifyHumanPromptGuard 输出 stable union），继续处理后续候选/结束本轮回退。
  判定口径（实测）：记录为 JSONL，真实人工输入 = 存在某行 `type === 'user/message'` 且消息
  对象 `source.kind === 'user'`（消息对象通常直接在 `data` 上，少数嵌在 `data.message` 下，
  两种形状都兼容）；插件/规则注入消息的 kind（`dsh-resume-on-restart`、`dsh-rules-auto`、
  `runtime-context`、`time-context` 等）不算人工输入；`source` 缺失一律视为非人工。
  fail-closed：文件缺失（`session-file-missing`）、运行环境 zlib 无 zstd 能力（node < 23.8，
  `zstd-unsupported`）、解压/读取异常（`scan-error`）一律按"判定不了"拦截。新增配置
  `requireHumanPrompt`（默认 `true`），设为 `false` 关闭守卫 = 完全旧行为
- **多帧拼接的 zstd 会话记录解压**：实测 `session.v4.jsonl.zstd` 不是单个 zstd 流，而是每批
  追加的记录各自压缩成一帧后顺序拼接；对整文件一次 `zstdDecompressSync` 只解出第一帧
  （通常只有 `session` 头），真实会话会被整体误判成 none、守卫会把几乎所有会话都拦掉。
  解压改为按 zstd 帧魔法号切片逐帧解后拼接（个别帧解不出则合并/跳过，尽力而为——少读
  记录只往拦截方向错），并在 680+ 真实会话上验证：无真实输入的空会话判 none、有真实
  用户提示词的会话判 human

### Fixed
- **空会话被 fallback 唤醒后自主干活（0.5.x 事故）**：重启后恢复候选 `8fc70d1a`（子代理
  会话）恢复失败，回退路径 fallbackWake 取 `scope.agents.roots()[0]`，拿到一个从未有过
  任何用户输入的空会话 `session-78b03158`，把"检测到 DSH 服务已重启……请自主决定下一步"
  的通知灌进去，导致模型无人指示自主跑了一轮真实工作。现两条投递路径都要求目标会话
  有过真实人工输入（见上），没有或判定不了就跳过，该空会话在真实数据上验证为被正确拦截

### Tests
- 新增 lib/session-scan.test.js（`node --test`，无 e2e）：`isHumanPromptRecord`
  （kind=user 真、各注入 kind 与缺失 source 假、畸形输入假）、`hasHumanPromptInText`
  （坏行混入、命中即真、空/非字符串假）、`findSessionRecordFile`（mkdtemp 临时目录树下
  主会话/子代理目录命中、找不到 null、非法 id null）、`scanSessionHasHumanPrompt`
  （真实 `zlib.zstdCompressSync` 压缩 → human/none、多帧拼接形状、无压缩 jsonl、
  文件缺失 → session-file-missing、损坏 zstd → scan-error；环境无 zstd 能力时该组
  用例自动 skip）；lib/detect.test.js 追加 `classifyHumanPromptGuard` 四分支用例

## [0.5.2] - 2026-10-13

### Fixed
- **重启后恢复候选全部失败（立即失败，30s 预算从未被消耗）**：`sessionController`
  服务静态依赖 `agents` 等 11 个服务（`dsh-api-session-controller` 内 `static inject`），
  按 cordis 依赖序必然晚于 `agents` 激活；而恢复流程原先在 `ctx.inject(['agents'])`
  回调里立即经 `ctx.reflect.get('sessionController')` 非阻塞探测，拿不到即抛
  `sessionController service unavailable`——开机后百毫秒内所有候选逐个立即失败，
  只能走降级通知。现改为在候选的预算切片内每 500ms（`SERVICE_POLL_MS`）轮询等待
  服务就绪，就绪即恢复；切片耗尽才判该候选失败，error 文案区分「等待服务超时」
  （`sessionController service not ready within <N>ms`），后续候选仍按原预算平摊
  （每候选最低 5s、总预算 `restoreTimeoutMs` 封顶），全部失败仍走既有
  `fallbackWake` 降级。已 live 候选（`agents.get` 直接可得）不经过等待，照旧直接
  投递；marker、`/state`、restarts 只读路由与 wake.log / restarts.ndjson 记录结构
  均不变。 cordis 仅在提供方 fiber 启动时注册服务，无法低成本预判某环境「永不提供」
  该服务，故未加跳过等待的特判，等待总量由既有预算兜底

## [0.5.1] - 2026-10-12

### Fixed
- 设置弹窗「重启日志」对 `GET /api/dsh-resume-on-restart/restarts` 404（插件更新后
  DSH 未重启、宿主 half 尚无该路由的混合版本窗口）按空日志展示「暂无重启记录」，
  不再显示「重启日志加载失败」；日志文件不存在时宿主本就返回空数组，客户端不再
  出现报错态。401/403/5xx/网络错误等其余失败仍按「加载失败」报错，真实故障不吞

## [0.5.0] - 2026-10-12

### Added
- **重启日志 `restarts.ndjson`**（宿主 half）：`<stateDir>/restarts.ndjson`（默认
  `~/.dsh/.resume-on-restart/restarts.ndjson`），追加写、一行一条 JSON、上限 200 条
  （超出丢最旧，重写时顺带剔除损坏行）、单行损坏跳过不丢整份日志。开机
  `detectRestart === true` 时先写一条 `boot` 记录（`at`/`prevBootAt`/`downtimeMs`/
  `pid`/`prevPid`/`startAt`/`prevStartAt`/`detectBasis`/`reason`/`shutdown`/`origin`/
  `runningSessions`），恢复流程每结算一个候选再写一条 `restore` 记录
  （`{ type, bootAt, id, result: resumed|failed|excluded|skipped-budget, error, at }`）；
  `wake.log` 保留不动。设置弹窗经只读路由按 boot 分组倒序展示
- **停机归因**：SIGTERM/SIGINT 兜底 flush 时同步写 `<stateDir>/pending-shutdown.json`
  （`{ signal, at }`，marker 的 `when` 字段保留作旧版兼容）；下次开机读取归因后
  立即删除（存根只消费一次，避免遗留存根把后续 crash 误归因为 signal）。读不到
  且旧 marker 无 `when` = 崩溃 / 强杀 / 容器重启。原因标签：
  `power-button`（有 origin）/ `signal`（有 pending-shutdown 或 marker.when、无 origin）/
  `crash`（两者皆无）/ `unknown`（形状异常兜底），写入 boot 记录的 `reason` 字段
- **origin 匹配**：开机扫描 `~/.dsh/power-restart/*.status.json`（单文件损坏只丢该
  文件），取 `committedAt` 落在 [上次启动, 本次启动] 闭区间的最近一条作为本次重启
  发起方，整形为 `{ source: 'power-button', restartId, kind, sessionId, requestedAt }`
  写入 boot 记录；没有命中 → `origin: null`（原因归 shutdown 侧）
- **全量恢复（解「重启后只有打开的那个界面才回复对话」）**：`restoreMax` 默认改为
  `0` = 不限——遍历全部 `running !== false` 候选（仍尊重用户排除名单与
  `ignoredSessionPrefixes`）；正整数语义不变（按活跃时间新 → 旧取前 N 个）。
  `restoreTimeoutMs`（默认 30s）总预算按候选数平摊、每候选最低 5s；超出预算的
  候选不再静默丢弃，逐个记 `skipped-budget`；失败继续下一个候选的行为不变
- **只读路由 `GET /api/dsh-resume-on-restart/restarts`**：返回
  `{ ok, entries, max }`（entries 为 restarts.ndjson 全部条目，时间正序，客户端自行
  倒序展示）。沿用现有围栏模式：宿主 `connection.requestRejection` 优先，
  回退自带最小浏览器信任围栏（只读 GET，同 /state 的规则）
- **设置弹窗「重启日志」section**（客户端 half，slot `settings.section`，写法照抄
  dsh-prompt-history）：倒序列表，每条显示 启动时间、原因标签徽标、来源
  （origin.kind + sessionId 截断）、停机时长、恢复成功 x/y；点击展开该条 boot 详情
  （上次启动 / pid 变化 / 判定依据 / 停机归因 / origin / 恢复候选列表）与逐会话
  restore 明细（结果徽标 + 截断会话 id + 错误）。文案走宿主 locale 服务
  （`dsh-resume-on-restart` 命名空间，zh/en 字典、zh 为权威，未命中回退内置 zh），
  样式自带（一次注入 `<style>`，全部走 DSH 设计 token，明暗自适应）；
  挂载拉取一次 + 手动刷新，失败显示错误文案并 console.warn。客户端 bundle 属
  profile 产物，需下次 DSH 重启重建后才在浏览器生效

### Changed
- `restoreMax` 默认值 `1` → `0`（不限），`cordis.patch.yml` 内置配置同步改为 `0`
- 宿主 `deliver()` 返回值从 boolean 改为 `{ ok, error }`（stable union），供恢复流程
  把投递失败原因同时写入 wake.log 与重启日志

### Tests
- `lib/detect.test.js` 新增 18 例（合计 60）：`detectBasisOf`、`normalizeRestoreMax`
  （0=不限与 pickRestoreTargets 的衔接）、`attributeShutdown`（pending-shutdown 有效 /
  回退 marker.when / 都无 = crash）、`shutdownReasonOf` 四标签、`pickOriginRecord`
  时间窗匹配（窗口内取最近、窗外排除、闭区间边界、损坏记录跳过、非法输入）、
  `parseNdjson` / `serializeNdjson` / `capNdjsonEntries` / `compactNdjson`
  （损坏行跳过、超出丢最旧、互逆）

## [0.4.0] - 2026-10-12

### Added
- **web 会话顶栏开关**（客户端 half `lib/client.js`，手写 bundle、仅依赖 baseline 的 react，
  无构建链）：在会话顶栏「标准模式」标签同一个父容器（slot `conversation.session.header.actions`）
  注册兄弟条目 `resume-on-restart`（order 10，同排同款设计 token）。正常态「重启时恢复会话」，
  悬停「取消→重启时恢复会话」；点击把当前会话标记为「重启后不自动恢复」，条目变灰、
  文案「已取消恢复」，悬停「恢复→重启时恢复会话」；再点取消标记。条目仅对恢复候选会话渲染
  （见下方「恢复候选按停止时仍运行中过滤」等本轮补充条目）。
  当前会话 id 由 session 作用域插槽的标准 props（`sessionId`）注入，不用 window 全局
- **插件自有状态 API**（宿主 half）：`GET /api/dsh-resume-on-restart/state?ids=...` 查询、
  `POST /api/dsh-resume-on-restart/state`（body `{ sessionId, excluded }`）标记/取消；
  sessionId 非空且 ≤200 字符，排除集合上限 1000 条、超出丢最旧。客户端请求失败按「未排除」
  显示并 console.warn，不弹窗；POST 期间防重复点击，失败回滚 UI
- **排除集合持久化**：`<stateDir>/excluded-sessions.json`（`{ sessions: { [id]: excludedAtISO } }`，
  损坏按空处理、写盘失败只告警），重启 DSH 后仍然有效
- **恢复流程跳过被排除的会话**：候选在逐个尝试前经新纯函数
  `filterExcludedCandidates(candidates, excludedMap)`（lib/detect.js）过滤，
  被排除的候选记入 wake.log（`error: "excluded by user"`）；全部被排除/失败仍回退通知主会话（文案不变）
- **自有路由的浏览器信任围栏**：本插件路由前缀比宿主 `/api` 长、不会自动经过宿主围栏，
  先借用宿主 `connection.requestRejection`（未认证 401 等），宿主未提供该服务时回退到
  复刻 DSH 官方规则的最小判断（Host loopback/`--trusted-host`、全接口绑定时本机来源、
  拒绝 `sec-fetch-site: cross-site`、Origin 同源）；webServer 服务缺失仅 console.warn，不阻断加载
- **恢复候选按「停止时仍运行中」过滤**（本轮补充，恢复与开关显示同一口径）：判定口径 =
  DSH 停止那一刻该会话 status 为 `running`（干活中被打断）。`pickRestoreTargets` 只把
  `running !== false` 的 `recentSessions` 条目当候选（缺失按 true，兼容旧 marker，旧恢复行为
  不变；legacy `lastSessionId` 回退路径同样视为候选）；`recentSessions` 全部 `running: false`
  （正常结束）时不恢复，也不会经旧字段回退混回候选
- **marker `recentSessions` 条目新增 `running` 字段**（本轮补充）：由 `agent/status` 事件
  （payload `{ agent, status }`）写入——`'running'` → true、`'idle'` → false；其余活动事件
  不带 status，沿用同 id 条目已有值；新条目缺省 false，序列化时缺失写 false。启动播种自旧
  marker 的候选条目回填 `running: true`（它们正是上次停止时仍运行中的会话），避免
  「本进程 GET 显示候选、下次重启却不恢复」的口径分裂
- **`GET /state` 响应新增 `restoreCandidates`**（本轮补充）：`{ [id]: true }`，取自宿主内存
  `recentSessions` 经新纯函数 `collectRestoreCandidateIds`（lib/detect.js）的实时视图，
  不看排除集合——被排除但仍是候选的会话仍显示灰色开关
- **顶栏开关显示门控与刷新时机**（本轮补充）：客户端只在当前会话命中 `restoreCandidates`
  时渲染条目，正常结束的会话返回 null（字段缺失/响应异常/请求失败都按不显示）；
  查询时机为挂载/切换会话时、`window` `focus` 时、每 15 秒轮询一次（页面隐藏时跳过该轮，
  cancelled 标志防串态）；悬停文案、POST 标记/取消、失败回滚、防重复点击均不变

## [0.3.1] - 2026-10-12

### Fixed
- 重启后通知投递必失败（会话采纳消息即抛
  `SessionFormatError("format v4 message requires a producer-owned source kind")`，
  本轮运行失败、用户点重试再次失败）：通知消息 source 沿用了已废弃的 v3 写法
  `{ kind: 'plugin', plugin: 'dsh-resume-on-restart', ... }`，而 DSH 会话格式 v4 的
  source 校验要求 `source.kind` 为非空字符串且 `!== 'plugin'`。
  改为 producer-owned kind `{ kind: 'dsh-resume-on-restart', form: 'notice', summary: ... }`
  ——选裸插件名而非 `plugin:<name>` 映射形式，是因本环境同类第三方插件 dsh-rules-auto
  即用裸插件名作 kind，已在 v4 会话日志中验证可正常持久化

### Changed
- 通知消息对象构造抽出为可单测的纯函数 `createNoticeMessage({ text, bootAt })`
  （lib/detect.js，内部 `content=[{type:'text',text}]`、`role:'user'`、id 用 UUID），
  `deliver()` 改为调用它；移除 lib/index.js 中不再被别处使用的 `createUserMessage`。
  运行行为除 source 形状外完全不变

## [0.3.0] - 2026-10-09

### Fixed
- 活动追踪从未生效：0.2.0 监听的 `agent/session-start`、`agent/pre-step` 事件在 DSH 中
  不存在，导致 `marker.lastSessionId` 恒为 null；改为监听 DSH 真实存在的事件
  `agent/status`、`agent/inbox/inserted`、`agent/assistant-stream`（三者 payload 均含 `agent`）
- 状态只在 SIGTERM 落盘：非优雅退出丢状态；活动时改为节流落盘（默认 5 秒内合并为一次
  写盘，`persistThrottleMs` 可调），SIGTERM/SIGINT 兜底 flush 逻辑保留
- 启动时不再用空列表覆盖上次状态：启动即用旧 marker 播种最近活跃列表，延续旧上下文

### Added
- 重启后**自动恢复重启前活跃的会话**：按活跃时间新 → 旧逐个候选，已 live 直接投递，
  未 live 通过 DSH Host 的 `sessionController.resolveAgent(sessionId)` 恢复成 live Agent
  再投递（"重启前正在干活的会话"自己收到通知并继续）；新配置 `restoreSessions`（默认开）、
  `restoreMax`（默认 1）、`restoreTimeoutMs`（默认 30000，恢复/等待总预算）
- 会话自动恢复依赖 DSH Host 的 `sessionController` 服务（运行时经 `ctx.reflect.get`
  防御式探测，不注入、不阻塞插件加载），缺失/超时/失败时**自动降级**为旧行为：通知主会话
- marker 新增 `recentSessions` 字段（最近活跃会话列表 `[{id, at}]`，最新在前，
  上限 `trackMax` 默认 5）；`lastSessionId`/`lastActiveAt` 语义不变（= 列表第一个）
- 兼容只有 `lastSessionId` 的旧 marker 恢复候选（`pickRestoreTargets` 纯函数，lib/detect.js）
- 通知文案：命中自动恢复时输出"已自动恢复重启前活跃的会话 xxx（最后活跃于 ...）"，
  旧调用不传参时文案不变
- wake.log 改为追加式（一行一条 JSON），支持记录多个候选的恢复/投递结果

## [0.2.0] - 2026-10-09

### Fixed
- Docker 容器内 DSH 恒为 PID 1，旧版 `marker.pid === pid` 恒成立导致容器内重启永远检测不到；
  pid 相同时改为对比进程启动时间 `startAt`（`computeProcessStartAtMs`），偏差超过 2 秒容差即判定重启
  （双向比较，时钟前移/后移均覆盖）；pid 不同仍直接判定重启，中断时长仍按 `lastBootAt` 计算

### Added
- marker 新增 `startAt` 字段（当前进程启动时刻，epoch 毫秒）
- 旧格式 marker（无 `startAt`）自动兼容：回退用 `lastBootAt` 对比，不丢弃 marker

## [0.1.0] - 2026-08-28

### Added
- 检测 DSH 服务重启（通过 marker 文件对比 pid / 启动时间）
- 重启后向主 agent 投递信息性消息（含中断时长、上次活跃会话），由 agent 自主决定下一步
- 运行期间追踪最近活跃会话（`agent/session-start`、`agent/pre-step`）
- 正常关闭（SIGTERM/SIGINT）时持久化活跃会话状态
- 单元测试（重启检测、消息构建）
- GitHub Actions CI
