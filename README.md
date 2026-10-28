# dsh-resume-on-restart

DSH 插件：检测 DSH 服务重启后，**自动恢复重启前活跃的会话**（把"重启前正在干活的会话"
恢复成 live agent 并投递通知，让它自己继续），失败时降级为向主 agent 投递一条**信息性消息**
（含中断时长、上次活跃会话等状态摘要），由 agent 自主决定下一步。0.8.0 起还内置**重启引擎**：
可在设置弹窗（二次确认）主动重启 DSH，普通进程 helper 握手原样拉起，容器 PID=1 优雅退出
交由容器重启策略拉起——重启完成后会话照常自动恢复。

解决"DSH 重启后会话中断、工作丢失"的问题——重启后无需用户去别的会话手动输入"继续"。

## 特性

- 🔄 **重启检测**：通过 marker 文件（记录上次 pid / 启动时间）判断是否发生重启
- ⏭️ **会话自动恢复**（0.3.0，0.5.0 起全量，0.9.1 收口，0.10.0 口径反转，0.17.0 正常结束不恢复）：
   重启后自动把重启前最近活跃窗口内的会话 resume 成 live agent 并投递通知
   （0.9.1 起逐个尝试全部候选，不再"首个成功即停"）；**0.17.0 起「正常结束」的
   会话不再恢复**（会话日志最后一条真实 turn/end `reason.kind === "completed"`，
   由重启后的日志扫描判定——文件缺失/解压失败/解析异常一律保守恢复，宁可多恢复）；
   subagent routing 持有的子代理会话按其**主会话祖先代理恢复**（`result: 'subagent'`，不算失败）；
   依赖 DSH Host 的 `sessionController` 服务，缺失/失败时自动降级为通知主会话，
   开机无任何 live agent 时（0.9.1）升级经 sessionController 恢复最近活跃会话投递，
   不再 `no target agent after wait`
- 🖥️ **设置弹窗「重启」选项**（0.8.0）：设置弹窗左侧新增「重启」入口，展示重启模式说明、
   优雅退出通道可用性与「重启后将自动恢复 N 个活跃会话」；「重启 DSH」按钮**二次确认**
   （默认焦点「取消」的确认弹窗）后才执行，重启期间轮询新实例、就绪后页面自动刷新，
   回到页面时弹「已重启」回执 toast
- ⏸️ **暂停所有会话**（0.15.0）：设置弹窗「重启」section 的「暂停所有会话」按钮一键停止
   全部正在运行的主会话（等同逐个点「停止」，已排队的输入保留；子代理会话由其主会话接管），
   停止结果持久化到 `<stateDir>/paused-sessions.json`；此后无论以何种方式重启
   （重启按钮 / crash / signal 都一样），被暂停的会话都会被既有自动恢复流程恢复——
   含超出 `trackMax` 最近活跃窗口的会话；暂停与重启双向互斥（同时只允许一个进行）
- 🕒 **待恢复列表与恢复结果对账**（0.13.0，0.14.0 逐行/批量取消恢复，0.16.0 进入选项卡即展示，0.17.0 手动刷新，0.18.0 按工作区分组）：
   **进入设置弹窗「重启」选项卡即自动展示「待重启恢复会话列表」**（会话标题为主、
   完整 id 悬停提示 + 最后活跃时间 + 运行中标记；**0.18.0 起按会话所属工作区
   分组展示**——组头为工作区完整路径、未知工作区组恒排最后，组间/组内按最后
   活跃时间新 → 旧；逐行/批量「取消 / 恢复」在选项卡内
   直接可用，与「重启后将自动恢复 N 个」计数同口径联动；0.17.0 起标题行带
   「刷新」按钮——重拉 `/restart/info` 按最新口径合并重建，保留本地取消标记，
   拉取中禁用、失败静默保留现有列表，confirm 模式同样可用）；
   确认重启后展示同一列表（点击时刻重拉的最新口径）与「已等待 N 秒」等待计时；
   列表支持逐行与批量「取消 / 恢复」（取消 = 重启后不自动恢复，已取消行弱化显示、保留在
   列表中可撤销；waiting 阶段只读）；
   重启完成页面刷新后，
   同一位置原位变为「上次重启(<时间>)的恢复结果：x/y 已恢复」+ 逐会话结算徽标
   （已恢复/恢复失败/已被用户排除/已归档跳过/经主会话代理恢复/预算耗尽跳过/
   无人工输入跳过/正常结束跳过/待结算——服务端结算是异步的，短轮询对账，超时未结算如实显示）
- 🔌 **重启引擎**（0.8.0，设计参考 [dsh-power-button](https://github.com/keyiadiannao/dsh-power-button)）：
   普通进程走 detach helper 的 ARM→COMMIT→ACK 握手原样拉起；**容器 PID=1 走"优雅退出 +
   容器重启策略拉起"**（见下文专节）。同一引擎同时供 `/restart` 命令与 `restart_harness`
   模型工具使用（名称冲突自动让位），防重入闩保证并发触发只生效一次
- 🗄️ **归档会话不恢复**（0.9.0）：恢复候选按权威名单 `workspaceRegistry.archivedSessionIds`
   自动剔除已归档会话，并按 DSH `ArchivedSessionGate` 同样的 lineage 规则剔除"归档会话的
   subagent 后代"；剔除在重启日志结算为 `archived`（不算失败），候选全是归档时保持安静、
   不回退吵主会话；`GET /restart/info` 的候选数同口径；registry 缺失时行为退化为现状
- 📜 **重启日志**（0.5.0）：`<stateDir>/restarts.ndjson` 记录每次重启的 boot 记录（含停机归因、
  重启来源、原因标签）与逐会话 restore 结算（resumed/failed/excluded/archived/skipped-budget
  /skipped-no-human-prompt/0.17.0 的 skipped-completed），上限 200 条、损坏行跳过；wake.log 保留不动
- ⚙️ **设置弹窗重启日志**（0.5.0）：web 设置弹窗新增「重启日志」section（slot `settings.section`），
  倒序展示每次重启的时间、原因标签、来源、停机时长、恢复成功 x/y，可展开 boot 详情与逐会话恢复明细
- 🖱️ **会话顶栏开关**（0.4.0，0.10.0 口径反转，0.17.0 正常结束不显示，0.11.0 状态同步改 ws 推送）：web 会话顶栏（「标准模式」标签同排）出现「重启时恢复会话」条目，
  点击即可把当前会话标记为「重启后不自动恢复」，再点取消；标记按会话持久化，重启 DSH 后仍生效。
  条目对最近活跃窗口内（会被重启恢复）的会话显示——0.17.0 起正常结束的会话不再
  显示（不会被恢复）、0.10.0-0.16.x 含手动停止的会话，
  窗口外/被忽略前缀的会话不显示；候选/排除状态由宿主 websocket 快照广播实时同步
  （0.11.0 起，不再轮询），多标签页自动对齐
- 💬 **信息性消息**：投递"检测到重启 + 中断时长 + 上次活跃会话（+ 恢复说明）"摘要，由 agent 自主决定下一步
- 🎯 **活动追踪**（0.3.0 修复）：运行期间通过 cordis 真实事件（`agent/status`、
  `agent/inbox/inserted`、`agent/assistant-stream`）追踪最近活跃会话列表 `recentSessions`（上限 `trackMax`，
  条目含 `running` 标记：最后已知是否运行中，由 `agent/status` 维护）
- 💾 **节流落盘**：活动时 5 秒内合并一次写盘（不再只靠 SIGTERM），非优雅退出也不丢状态
- ✅ **兼容 DSH Desktop**：只依赖 cordis ctx 的 `agents` 服务与事件，不 import 任何 `@deepseek-ai/dsh-*` 内部包，可在 DSH Desktop 打包环境（app.asar）运行
- 手动结束和崩溃，两者之后都会触发自动恢复

## 安装

```powershell
# 用 dsh CLI 装到桌面 profile（DSH Desktop 默认用 desktop）
dsh plugin --profile desktop add <本目录路径>
# 重启 DSH Desktop 生效
```

## 运行逻辑

每次 DSH 启动时：

1. 读取 marker 文件（`~/.dsh/.resume-on-restart/marker.json`），记录上次的 `pid` / `lastBootAt` / `startAt` / `recentSessions`
2. 判断是否重启：当前进程 `pid` ≠ marker 的 `pid` → 判定发生重启；`pid` 相同（如容器内恒为 PID 1）则对比进程启动时间 `startAt`，偏差超过 2 秒容差 → 判定发生重启
3. 用旧 marker 播种内存中的最近活跃列表，写入新的 marker（更新为当前 pid / 时间）
4. 若判定为重启：
   - **写 boot 记录**（0.5.0，重启日志）：先做停机归因（读 `<stateDir>/pending-shutdown.json`
     并删除；读不到回退旧 marker 的 `when` 字段；都没有 = crash）与 origin 匹配（扫描
     `~/.dsh/power-restart/*.status.json`，取 `committedAt` 落在 [上次启动, 本次启动] 的最近一条），
     得出原因标签（`power-button` / `signal` / `crash` / `unknown`）后写一条 boot 记录到
     `restarts.ndjson`（随后恢复流程每结算一个候选再追加一条 restore 记录）
   - **自动恢复**（`restoreSessions`，默认开）：`pickRestoreTargets(marker, restoreMax)` 取候选
     （优先 `recentSessions`，0.10.0 口径反转：全部有效条目都是候选——候选池不看
     `running`、仅作记录；兼容只有 `lastSessionId` 的旧 marker；
     去重、按活跃时间新 → 旧、截断 `restoreMax`）；
     **候选先按用户排除集合过滤**（`filterExcludedCandidates`，被排除的候选记入 `wake.log` 与
     重启日志，`error: "excluded by user"`），再对剩余候选逐个尝试：已 live（`agents.get(id)`）直接投递；
     未 live 经 `sessionController.resolveAgent(id)` 恢复成 live agent 后投递。
     **正常结束门**（0.17.0，在归档剔除与 subagent 拆分之后、逐个尝试之前）：候选
     （`running:false` 及未知的；`running:true` 免扫描直通）逐个扫描其会话日志——
     最后一条真实 `turn/end` 的 `reason.kind === "completed"` → 跳过并结算
     `result: 'skipped-completed'`（不算失败）；最后是 `turn/start` 无对应 `turn/end`
     （turn 开着被崩溃/重启打断）或最后 kind ∈ {aborted, blocked, error, max-tokens,
     interrupted, forked, 未知 variant} → 照旧恢复；日志文件不存在/解压失败/解析异常
     → **保守恢复**（宁可多恢复，维持旧行为）。候选全部正常结束时安静收尾，
     不回退吵主会话；同一会话每进程只扫一次（memoized），判定结果同时喂给
     运行期候选显示口径（`GET /state`、ws 快照、`/restart/info` 只含过滤后候选；
     marker.recentSessions 条目顺带记录 `lastTurnEndKind` 仅供观测，**过滤不依赖它**，
     旧 marker 无该字段完全兼容；boot 记录 runningSessions 保持如实记录不过滤）。
     0.6.0「无真实人工输入不自动激活」守卫保持不变，叠加在新门之后（恢复循环内）。
     恢复候选前先用独立预算 `serviceWaitTimeoutMs`（0.7.0，默认 30 秒）一次性全局
     等待 `sessionController` 就绪（结果与耗时记入 `wake.log`；超时记
     `service-wait-timeout` 并跳过全部候选直接回退，不逐候选空转）；候选阶段不再
     等服务，总预算 `restoreTimeoutMs`（默认 30 秒）自服务就绪起算、按候选数平摊、
     每候选最低 5 秒，超出预算的候选记 `skipped-budget`；失败继续下一个候选。
     成功投递的通知含"已自动恢复重启前活跃的会话 xxx（最后活跃于 ...）"。
     **每个候选都会被尝试**（0.9.1：不再在第一个候选投递成功后提前结束——那会让
     其余候选会话既不恢复也无任何日志，0.5.0 全量恢复语义名存实亡）。
   - **subagent 会话代理恢复**（0.9.1）：`header.origin === 'subagent'` 的候选被
     subagent routing 持有，宿主 `resolveAgent` 一律拒绝（`is owned by subagent
     routing`，正确通道是经父会话/subagent delivery），直接恢复必然失败。候选阶段
     用 session store header（防御式探测，同归档过滤口径）识别这类候选，结算为
     `result: 'subagent'`（**不算失败**），并把其**最近的主会话祖先**（沿
     `parentSession` 上溯）作为代理恢复目标并入候选——用户的工作经 lead 会话继续；
     祖先被用户排除/已归档时不代理（尊重用户意图，安静结算）。session store 缺失
     时无法预识别（退化 = 现状），由 `resolveAgent` 的 RemoteError 在恢复循环里
     兜底结算为 `result: 'subagent'`（绝不记 failed）。
   - **回退**：所有候选都失败/被排除（0.17.0 起候选全部正常结束时不回退——安静收尾，
     正常收工的会话无需继续；或 sessionController 缺失/关闭恢复）时，轮询等待主 agent 出现
     （最长 20 秒），投递信息性消息：
     ```
     [resume-on-restart] 检测到 DSH 服务已重启。
     上次运行于 ...，本次于 ... 重启完成。
     中断约 X 秒。
     重启前最近活跃的会话：<session-id>
     如需继续之前的工作，或启动新任务，请自主决定下一步。
     ```
     轮询落空时的**可靠降级**（0.9.1）：宿主 `agents.roots()` 只返回"已 live"的顶层
     agent，开机若没有任何会话被恢复/打开，轮询必然落空（历史 `wake.log` 多条
     `no target agent after wait`——降级通知从此没有出口）。落空后升级：等
     `sessionController` 就绪（`serviceWaitTimeoutMs` 预算），把 `lastSessionId`
     （重启前最近活跃会话；subagent 会话先上溯主会话祖先）解析成 live agent 再投递
     ——与恢复候选同一恢复通道；尊重用户排除、归档、0.17.0 正常结束门与 human-prompt
     守卫（fail-closed），每一步 `wake.log` 留痕。
   - 每次投递/恢复结果都追加记录到 `wake.log`（一行一条 JSON：`deliveredTo` / `ok` / `error`）

运行期间通过 `agent/status`、`agent/inbox/inserted`、`agent/assistant-stream` 事件（payload 均含 `agent`，
`agent/status` 另带 `status`：`'running'`/`'idle'`，写进条目的 `running` 标记；其余事件沿用条目已有值）
与 `session/event` 事件（0.17.0 起，宿主在会话日志追加时派发，监听器收到
`(session, event)`——`turn/end` 时更新条目的记录性字段 `lastTurnEndKind` 并维护
运行期「正常结束」集合，`turn/start` 与运行态翻转将其移出；恢复过滤的判据始终是
重启后的日志扫描，不依赖这些内存态）
持续记录最近活跃会话列表（同 id 去重挪到最前，上限 `trackMax`），活动时节流落盘
（`persistThrottleMs` 内合并为一次写盘），SIGTERM/SIGINT 时兜底 flush，下次重启时用于恢复/通知。

### 会话自动恢复的依赖与降级

会话自动恢复依赖 DSH Host 的 `sessionController` 服务（`ctx.sessionController.resolveAgent(sessionId)`）。
插件**不把它声明为注入依赖**，而是运行时经 `ctx.reflect.get('sessionController')` 非阻塞探测；
该服务静态依赖 agents 等 11 个服务，按依赖序晚于 `agents` 激活。0.7.0 起，进入候选
循环前先用独立预算 `serviceWaitTimeoutMs` 全局轮询等待服务就绪（间隔 500ms，超时记
`service-wait-timeout` 后跳过全部候选直接回退）；候选阶段不再等服务——恢复候选前
只做一次防御式即时检查，取不到即抛 `sessionController service unavailable`。
服务缺失、无 `resolveAgent` 方法、调用抛错/超时/返回失败分支（如 `session/not-found`）时，
记录原因到 `wake.log` 并尝试下一个候选；全部失败自动降级为旧行为——通知主会话。
该探测绝不阻塞插件加载，也不影响既有通知路径。

### 无用户提示词的会话不自动激活（0.6.0 守卫）

"恢复候选投递"与"fallback 回退唤醒"两条路径在投递前都会先判定目标会话**是否有过真实
人工输入**，没有（或判定不了）就跳过并记日志——避免把"检测到 DSH 服务已重启……请自主
决定下一步"的通知灌进一个从未有用户输入的空会话，导致模型无人指示自主跑真实工作
（0.5.x 事故：fallback 取 `roots[0]` 拿到空会话 `session-78b03158` 被唤醒）。

判定口径（实测 DSH 会话记录 v4）：读取 `<DSH_HOME>/sessions/<项目目录>/[session-]<id>/
session.v4.jsonl[.zstd]`（主会话目录带 `session-` 前缀、子代理会话为裸 uuid；`.zstd` 为
多帧拼接，按帧逐个解压拼接），存在某行 `type === 'user/message'` 且消息对象
`source.kind === 'user'` 的记录即算有人工输入（消息对象通常直接在 `data` 上，少数嵌在
`data.message` 下，两种形状都兼容）。插件/规则注入消息的 kind（`dsh-resume-on-restart`、
`dsh-rules-auto`、`runtime-context`、`time-context` 等）不算人工输入；`source` 缺失一律
视为非人工。

fail-closed：记录文件缺失（`session-file-missing`）、运行环境 zlib 无 zstd 能力
（`zstd-unsupported`，见下方 node 版本要求）、读取/解压异常（`scan-error`）都按
"判定不了"处理，与"无人工输入"一样跳过投递。跳过会记入 `wake.log`（`ok: false`）与
重启日志（`result: 'skipped-no-human-prompt'`，设置弹窗可见）；恢复候选逐个继续尝试
下一个，fallback 则结束本轮回退、不向 roots 更深处找补。

关闭方式：配置 `requireHumanPrompt: false` 即完全关闭守卫（恢复旧行为）。
注意 zstd 解压依赖 node ≥ 23.8 内置的 `zlib.zstdDecompressSync`；更老的 node 上所有
`.zstd` 记录都会被判 `zstd-unsupported` 而拦下（fail-closed），无压缩的
`session.v4.jsonl` 不受影响。

### 会话顶栏开关（0.4.0，仅当前会话生效）

web 端在会话顶栏、「标准模式」标签同一个父容器（slot `conversation.session.header.actions`）
里注册兄弟条目 `resume-on-restart`，视觉复用同一套设计 token。显示门控：条目对恢复候选会话渲染
——即最近活跃窗口内的会话（0.10.0 起含手动停止的；0.17.0 起正常结束的会话不再是
恢复候选、不再显示，见下方 `GET /state` 的 `restoreCandidates`）；
窗口外/被忽略前缀的会话不渲染任何 DOM：

| 状态 | 文案 | 悬停文案 | 行为 |
|---|---|---|---|
| 正常 | 重启时恢复会话 | 取消→重启时恢复会话 | 点击 → 标记本会话「重启后不自动恢复」，条目变灰 |
| 已排除 | 已取消恢复（灰色） | 恢复→重启时恢复会话 | 点击 → 取消标记，回到正常态 |

生效范围**仅当前会话**：排除集合持久化在 `~/.dsh/.resume-on-restart/excluded-sessions.json`
（`{ "sessions": { "<sessionId>": "<排除时间 ISO>" } }`，上限 1000 条、超出丢最旧），
重启 DSH 后仍然有效；重启后的恢复流程会跳过被排除的会话（见上方步骤 4）。

客户端（`lib/client.js`，手写 bundle、仅依赖 baseline 的 react）通过以下插件自有 API 读写状态：

- `GET /api/dsh-resume-on-restart/state?ids=<sessionId>` → `{ ok, excluded: { [id]: iso }, restoreCandidates: { [id]: true } }`。
  `restoreCandidates` 取自宿主内存 `recentSessions` 的实时视图（纯函数 `collectRestoreCandidateIds`），
  0.17.0 起再剔除最后已知状态为正常结束的会话（开机由日志扫描播种、运行期由
  `session/event` 维护的集合，不在请求路径上扫日志），
  不看排除集合——被排除但仍是候选的会话仍显示灰色开关；当前会话不在其中、字段缺失或请求失败
  都按「不显示」处理
- `POST /api/dsh-resume-on-restart/state`，body `{ sessionId, excluded: true|false }`；请求期间防重复点击，失败回滚 UI
- `GET /api/dsh-resume-on-restart/ws-info` → `{ ok, token }`（0.11.0 引入；0.12.0 起
  不再返回 port，见下）

`sessionId` 由插槽框架注入（session 作用域标准 props，见 `@deepseek-ai/dsh-client-ui-session`
对 `SessionStandardProps` 的 merge 声明），不使用任何 window 全局。

该路由前缀比宿主 `/api` 长、不会自动经过宿主的浏览器信任围栏，插件自带最小围栏：
先借用宿主 `connection.requestRejection`（未认证 401 等），宿主未提供该服务时回退到复刻自
DSH 官方规则的判断——Host 必须是 loopback 或 `--trusted-host` 声明的 authority、
全接口绑定时要求本机来源、拒绝 `sec-fetch-site: cross-site`、带 Origin 时必须同源。
webServer 服务缺失时仅 console.warn，不阻断插件加载。

### 状态同步走 websocket 快照推送（0.11.0，不再轮询）

候选/排除状态的同步机制：挂载/切换会话时仍做一次 `GET /state` **一次性查询**
（事件驱动首帧到达前的兜底），此后**不再有任何周期性拉接口的定时器**——客户端改为订阅
宿主的 websocket 快照推送（旧版的 `window` `focus` 补偿查询与每 15 秒轮询一并移除）：

- **服务端**（`lib/ws-state.js`，0.12.0 起为「升级处理器 + 推送 hub」）：零依赖的最小
  RFC6455 ws 服务端逻辑（node:crypto 手写：`Sec-WebSocket-Accept = base64(sha1(key + GUID))`、
  客户端掩码去除、ping/pong/close、最简分片；只发**不加掩码**的文本帧；单帧 1MiB 上限，
  超出按 1009 关闭；30 秒心跳回收半开连接；连接数上限 64 兜底）。
  0.11.0 曾自建 http.Server bind `0.0.0.0` + 随机端口；0.12.0 起不自建 server——
  由 index.js 经宿主 `webServer.registerUpgrade` 把升级处理器挂在宿主主端口的精确
  路径 `/api/dsh-resume-on-restart/ws` 上（同源同端口；宿主按 pathname 精确分发、
  对升级路由不做围栏/认证，由插件 handler 全权负责）；
  随注册它的 `ctx.effect` 的 dispose 移除升级路由并关闭全部连接；宿主不支持
  `registerUpgrade`（旧版宿主）或注册失败只 console.warn 降级
  （此时 `/ws-info` 返回 503，开关退化为本组件挂载时的一次性查询），绝不阻断插件加载
- **接入与安全**：进程启动时生成随机 token；`GET /ws-info` 在既有前缀路由内、过同一
  信任围栏（宿主 `connection.requestRejection` 优先 + 最小围栏），**一次性**返回
  `{ ok, token }`（不是轮询；0.11.0 曾含 port，0.12.0 起同源不再需要）。
  ws 升级握手校验 query 里的 token（sha256 摘要后
  timing-safe 比较）+ 信任围栏（0.11.1：宿主 `connection.requestRejection` 仅 401
  直接拒绝；403 不再照单全收——宿主围栏的 `sec-fetch-site` 与 Origin host:port
  精确匹配两条规则为同端口 HTTP API 设计、不适配跨端口 ws，回退下述
  `explainWsUpgradeTrust` 裁决；宿主放行维持放行、宿主未提供该服务维持回退）。
  随机端口时代 ws 监听在独立端口上，跨端口 ws 握手必上报 `sec-fetch-site: cross-site`、
  Origin 是「页面来源」（宿主 webServer 的端口）——升级围栏因此做两点适配
  （`explainWsUpgradeTrust`；0.12.0 起同源，正常路径先命中宿主围栏放行的快速分支，
  适配保留为防御）：
  Host 主机名仍须 loopback 或宿主可信名单（按主机名匹配，防 DNS rebinding；0.11.1
  起与宿主围栏同源：优先读 `connection` 服务生效名单——含绑 0.0.0.0 时
  `resolveLanTrust` 自动派生的本机局域网地址，CLI `--trusted-host` 声明仅作回退，
  避免 LAN 部署下插件围栏比宿主严、ws 永远 host-untrusted）；
  `sec-fetch-site` 不再作为 ws 的否决项，同侧防护改由「随机 token + Origin 必须与 ws
  同主机名且端口等于宿主 webServer 端口」承担。0.11.1 另做容器适配：docker 部署经
  端口发布 NAT 进来的合法浏览器来源 socket 必非 loopback，`socket-not-loopback`
  检查仅在非容器环境执行（容器内跳过，其余规则不变）。拒绝日志按
  `reason|remoteAddress|cid` 节流去重（60 秒窗口一条 + 累计抑制数补报，每条带
  reason/来源 socket/Host/Origin/cid 明细），客户端既定设计的无限重试不再刷屏
- **推送协议**：连接建立后服务端立即推一帧**全量快照**
  `{ type:'state', restoreCandidates: { [id]: true }, excluded: { [id]: iso } }`
  （与 `GET /state` 同口径；客户端重连成功后的状态重建就靠它）；此后排除集合变化
  （`POST /state` 成功后）与候选集变化（`recordActivity` 的 `agent/*` 活动事件触发点）
  都广播同一快照结构。高频活动事件（`agent/assistant-stream` 等）做 **300ms 首发立即 +
  窗口合并节流**；快照内容没变（如同 id 活动只挪动 `recentSessions` 顺序、id 集合没变）
  直接跳过不重发，避免风暴
- **客户端**：模块级单例 ws 管理器——首个订阅者出现时懒拉一次 `/ws-info` 建连接
  （`ws(s)://<location.host>/api/dsh-resume-on-restart/ws?token=...&cid=<标签页随机 id>`，
  0.12.0 起同源路径（宿主主端口，`location.host` 自带端口）；协议随页面
  `location.protocol`；cid 为页面加载时生成一次的随机 id，0.11.1 起
  追加，供服务端拒绝日志区分来源标签页），
  快照按 sessionId 分发给订阅者（`ResumeToggle` 在 `useEffect` 里订阅自己的 id；
  已有快照时新订阅同步补发，切换会话零等待）。`/ws-info` 拉取失败与 ws 连接失败/断开
  都**无限重试**（指数退避 1s 起、封顶 5s，每轮重新拉 `/ws-info`——DSH 重启后插件
  实例重建、token 换新），**永不回退轮询**。开关点击仍是 `POST /state`（乐观更新 +
  失败回滚不变），
  服务端广播让各标签页（含发起方）自动对齐到同一服务端口径

「重启 dsh」功能的轮询是**豁免区**，保持不动：设置弹窗「重启」按钮确认后的
`/restart/health` 轮询、页面加载时的 `checkRestartedToast`、以及宿主恢复链路的
`waitForSessionController` / `fallbackWake` / `restoreCandidates` 均原样保留。

### 重启日志与设置弹窗（0.5.0）

每次重启的观测数据落在 `<stateDir>/restarts.ndjson`（默认
`~/.dsh/.resume-on-restart/restarts.ndjson`）：追加写、一行一条 JSON、上限 200 条
（超出丢最旧）、单行损坏跳过不丢整份日志。两类记录：

- **boot 记录**（开机判定为重启时写一条）：`at` / `prevBootAt` / `downtimeMs` / `pid` /
  `prevPid` / `startAt` / `prevStartAt` / `detectBasis`（`startAt-diff` | `bootAt-diff`）/
  `reason`（原因标签）/ `shutdown`（`{ seen, signal, at }` 停机归因）/ `origin`
  （`{ source, restartId, kind, sessionId, requestedAt }` 或 `null`）/ `runningSessions`
  （本次参与恢复的候选列表）
- **restore 记录**（恢复流程每结算一个候选写一条）：
  `{ type, bootAt, id, result, error, at }`，`result` ∈ `resumed` | `failed` |
  `excluded`（用户排除）| `skipped-budget`（预算耗尽）| `skipped-no-human-prompt`
  （0.6.0 守卫拦截）| `archived`（0.9.0 归档剔除）| `subagent`（0.9.1 subagent
  routing 持有，经主会话祖先代理恢复）| `skipped-completed`（0.17.0 正常结束门，
  error: null）；除 `failed` 外都不算失败

原因标签口径：`power-button`（有 origin，重启由 power-restart 流程发起）/ `signal`
（有 pending-shutdown 存根或旧 marker `when`、无 origin，即 SIGTERM/SIGINT 正常停机）/
`crash`（两者皆无：崩溃 / 强杀 / 容器重启）/ `unknown`（形状异常兜底）。

web 设置弹窗新增「重启日志」section（slot `settings.section`，写法照抄 dsh-prompt-history）：
倒序列表展示每次重启的 启动时间、原因标签徽标、来源（`origin.kind` + 截断 sessionId）、
停机时长、恢复成功 `x/y`；点击展开 boot 详情与逐会话 restore 明细。文案走宿主 locale
服务（zh/en 字典、zh 为权威），样式自带（DSH 设计 token，明暗自适应）。

数据经只读路由获取：`GET /api/dsh-resume-on-restart/restarts` → `{ ok, entries, max }`
（entries 为全部条目，时间正序，客户端自行倒序；围栏与 `/state` 相同）。客户端 bundle 属
profile 产物，需下次 DSH 重启重建后才在浏览器生效。

0.8.0 起原因标签新增 **`restart-button`**（重启由本插件的按钮/命令/模型工具发起，
`origin.source === 'dsh-resume-on-restart'`）；其余 origin（如 dsh-power-button 发起的）
仍是 `power-button`，无 origin 时照旧按停机归因给 `signal` / `crash`。

## 设置弹窗「重启」选项与重启引擎（0.8.0）

设置弹窗左侧在「重启日志」之后新增「重启」入口（第二个 `settings.section` 条目，
order 62），包含三块信息与一个按钮：

- **模式说明**：普通进程显示常规说明；检测到容器 PID=1（`resolveRestartMode()`）时
  额外提示"重启 = 优雅退出，由容器重启策略拉起；未配置策略需手动 docker start"
- **通道检查**：宿主 `appExit` 通道缺失时显示警示（重启将退化为直接退出）
- **恢复预告**：「重启后将自动恢复 N 个活跃会话」（`GET /restart/info` 的
  `runningCandidates`，与顶栏开关同一候选口径——被顶栏排除的会话不计入恢复，
  但仍计入此处显示的候选数；0.9.0 起该计数同口径剔除已归档会话及其
  subagent 后代，拿不到 `workspaceRegistry` 时维持现口径；0.13.0 起候选为
  对象明细 `[{ id, at, running, title? }]`，携带真实最后活跃时间、运行态与
  防御式会话标题（session projection 优先、header 回退），见下方
  「确认后的可视化与恢复结果对账」）
- **「重启 DSH」按钮**：点击先弹**二次确认**模态框——默认焦点在「取消」上，Esc 与
  点击遮罩都只是取消，唯一前进路径是显式点「确认重启」；确认后才 `POST /restart`

确认后的流程（客户端）：

1. 先捕获当前 `/restart/health` 的 `instanceId` 作为**基线**（不用页面加载时的旧值：
   服务可能早已被手动重启过，陈旧基线会把"早就换了实例"误判成本次重启成功）
2. `POST /restart`（失败直接显示错误并回到按钮态）
3. 单飞轮询 `/restart/health`（1.5s × 90 次，随后降为 5s 持续等待）：`instanceId`
   相对基线**变更**（或无基线时"见过挂掉 + 重新起来"）才刷新页面——短暂断线、
   单次网络抖动绝不会被当成重启成功
4. pid1-exit 模式超过快速窗口后提示"容器可能未配置重启策略，请手动 docker start"，
   本页继续降频等待；回到页面后若 `/restart/health` 报告 `restarted` 标记（本进程确为
   一次重启的产物且未被确认），顶部弹「已重启：……正在自动恢复」toast 并
   `POST /restart/ack` 消费，之后的刷新不再重弹

### 确认后的可视化与恢复结果对账（0.13.0，0.14.0 扩展）

「重启 DSH」按钮确认后的流程在 0.13.0 增加展示层（`/restart/health` 轮询的
instanceId 基线判定是豁免区，一行未动）：

1. **待恢复会话列表**：进入 confirm 弹窗时重新拉一次 `GET /restart/info`（列表取
   点击时刻的最新口径）；POST `/restart` 成功进入 waiting 阶段后展示
   「待重启恢复会话列表」——每行 = 会话标题为主（省略号截断、全文在元素 title
   属性悬停可见；标题缺失退回截断 id 并弱化显示）+ 最后活跃本地时间（at 缺失
   显示 —）+ `● 运行中` 标记；完整会话 id 一律放在行容器的 title 属性做悬停
   提示，不再作为行主文本；列表空显示「无待恢复会话」
2. **等待计时**：waiting 阶段显示「重启中… 已等待 N 秒」（组件内 setInterval
   每秒跳动，离开 waiting/组件卸载即清理；超时提示逻辑不变）
3. **存根落盘**：POST 成功后把 `{ at: 确认时刻ISO, restartId?（响应里缺失则省略）,
   candidates: [{id, at, running, title?（空则省略）}] }` 覆盖写入 localStorage（key
   `dsh-ror-pending-restore`，单条覆盖式，写入包 try/catch）；POST 失败回 idle：
   计时器随 phase 清理、列表保留显示、按钮回到可重试态（现状行为不变）
4. **重启后对账**：页面（重启后自动刷新）重新挂载时读存根（无则什么都不显示，
   现状不变），`GET /restarts` 找匹配的 boot 记录——`pending.restartId` 与
   `boot.origin.restartId` 相等优先，否则回退取 `boot.at >= pending.at - 2min`
   时钟容差的最新一条；找到后收集该 bootAt 之后的全部 restore 记录按会话 id
   归组，待恢复列表原位变为「上次重启(<时间>)的恢复结果：x/y 已恢复」+ 逐会话
   结算徽标（徽标之外同样以存根携带的会话标题为主，无 title 退回截断 id 弱化）：
   `resumed`=已恢复 / `failed`=恢复失败（展示 error 摘要）/
   `excluded`=已被用户排除 / `archived`=已归档跳过 / `subagent`=经主会话代理恢复 /
   `skipped-budget`=预算耗尽跳过 / `skipped-no-human-prompt`=无人工输入跳过 /
   `skipped-completed`=正常结束跳过（0.17.0）/ 无 restore 记录=待结算
5. **异步结算的短轮询**：服务端结算是异步的（sessionController 等待最多 30s +
   逐候选），存在待结算会话时每 3s 轮询一次 `/restarts`、最多 20 次，全部候选
   有结算记录即提前停止；轮询结束后仍未结算的显示「未结算」；定时器组件卸载时
   清理。下次点「确认重启」覆盖 localStorage 存根，UI 切回 waiting 列表态
6. **逐行 / 批量「取消 / 恢复」（0.14.0）**：每行行尾「取消 / 恢复」按钮 + 标题下
   批量工具条（全选 checkbox 支持半选 +「已选 N 项」+「取消所选」「恢复所选」，
   无选中行按钮禁用）；复用既有 `POST /state`（`{ sessionId, excluded }`）每会话
   一次请求、选中行逐个串行发送，乐观更新 + 失败仅回滚对应行并 console.warn；
   已取消行弱化显示并保留在列表中（可撤销），waiting 阶段列表转只读（隐藏
   checkbox 与全部按钮），对账视图保持只读。取消标记只存组件本地 state，不写
   localStorage 存根（candidates 仍含全部行，被取消会话重启后由服务端 restore
   记录结算为 excluded）；重开 confirm 弹窗时经 `mergePendingRows` 合并——服务端
   返回的行为准（cancelled 用本地旧值），服务端不再返回的行保留并置
   `cancelled: true`（防「取消后无法恢复」）；「重启后将自动恢复 N 个」计数在列表
   存在时按未取消行数实时显示（`activePendingCount`）。合并/标记/计数均为可测
   纯函数（`mergePendingRows` / `setPendingCancelled` / `activePendingCount`），
   从 client bundle 工厂导出

服务端配套（lib/index.js）：`GET /restart/info` 的 `runningCandidates` 从
`string[]` 升级为候选明细对象数组 `[{ id, at, running, title? }]`——真实最后活跃
时间（回查内存 `recentSessions`，ISO 输出、未知为 ''，与 boot 记录
`runningSessions` 同款口径）、最后已知运行态、以及防御式探测的会话标题：
DSH 宿主的会话标题不在 header，而是 session projection（`session/title` 事件的
last-wins 投影），故首选 `ctx.reflect.get('sessionProjections').stateOf(
sessions.get(id), 'title')`（非空字符串才采纳），回退 `record.title` /
`record.header.title`（无害防御）；`sessions.get(id)` 为 undefined 时不自造对象
直接放弃。任何一层缺失/异常都静默降级到下一层（只 console.warn），一律不带
title 字段，绝不阻塞路由。0.18.0 起明细行再加 `workspace` 字段（会话所属工作区
= 项目目录完整路径字符串，未知为 `''`，总是携带）——宿主 `sessionWorkspaceLookup`
每次请求一次构建 sessionId → path 映射、候选逐个查表，回退链：workspaceRegistry
`list()` 实体的 `path` + `sessionIds`（header 验证过 canonical cwd 的官方口径）→
只读解析 `<DSH_HOME>/storages/workspace.json`（unit v2，`tables.workspaces`，
绝不写）→ 条目只有 path 时经 `projectKeyOf`（宿主 dsh-session-persistence-jsonl
`projectKey` 的自写等价实现，编码有损、只能正解）与 `<DSH_HOME>/sessions`
项目目录名精确匹配 → 都拿不到归「未知工作区」；纯展示字段，`/state`、ws 快照、
候选过滤与恢复流程零改动。归档剔除 + subagent
拆分 + 0.17.0 正常结束剔除（`visibleRestoreCandidateIds`：开机日志扫描播种、运行期
`session/event` 维护，与 `GET /state`、恢复流程同口径）的候选口径见上文。
对账匹配/归组逻辑抽成
可测纯函数（`matchPendingBoot` / `collectSettlementsBySession` 等），见
`lib/pending-restore.test.js`。0.17.0 起待恢复列表标题行带「刷新」按钮（preview /
confirm 皆可用，waiting 只读态隐藏）：点击重拉 `GET /restart/info` →
`normalizeCandidateDetails` 构建行 → `mergePendingRows` 合并（保留本地取消标记，
服务端不再返回的行保留并置 `cancelled=true`）→ 更新渲染；拉取中禁用并显示
「刷新中…」，失败静默保留现有列表（`restart.pendingRefresh` / 
`restart.pendingRefreshing` 双语文案）。0.18.0 起行区按工作区分组渲染：纯函数
`groupPendingRows(rows)`（工厂导出，可单测）输出有序组数组 `[{ workspace, rows }]`
——组内按 at 倒序、组间按组内最新 at 倒序、未知工作区组恒排最后、入参不被修改；
组头 = 工作区完整路径（缺失/空串显示「未知工作区」，zh/en
`restart.pendingUnknownWorkspace`），组内行与既有行完全一致，批量工具条与全选
作用于全部组的全部行，刷新按钮、结算徽标、取消弱化行行为不变。

### 重启引擎的两种模式（lib/restart.js）

设计参考 [dsh-power-button](https://github.com/keyiadiannao/dsh-power-button)（MIT，
"detached helper relaunch"思想致谢），实现为本插件独立改写。`resolveRestartMode()`
按 `process.pid === 1` 分流：

**helper 模式（普通进程）**——与 power-button 同构的三段握手：

```
点击/命令/工具 → POST /restart（防重入闩，二次确认在客户端）
[host]    写 helper .cjs（内嵌 relaunch argv，0600）→ spawn（detached）
[helper]  ARM   → ror-<restartId>.status.json { stage:'armed' }
[host]    等 ARMED（5s）→ 写 COMMIT 文件（本 restartId）
[helper]  ACK   → status { stage:'committed', committedAt }
[host]    等 ACK → unref → 固化检测 marker + 停机存根 → 有界 flush → 延迟退出
          （ctx.get('appExit') 优雅树销毁优先，缺失自发 SIGTERM，看门狗兜底）
[helper]  等旧 pid 退出（时限 = host 退出预算 + 15s 派生，绝不先于 host 放弃）
          → 等端口释放 → 等会话记录静默（(size,mtime) 两次采样一致，覆盖
            session.v4.jsonl[.zstd]）→ 写重启身份记录 → spawn 新进程
            （原 argv+cwd，--port 0 被 pin 成实际端口；env 带 DSH_ROR_RESTART_ID）
          → 轮询 /restart/health 直到 instanceId 变更且 restartId 匹配 → 自删
[client]  轮询 → instanceId 变更 → 刷新 → toast → ack
```

任何握手失败都让旧进程继续活着并如实报错——"退出了却没人拉起"是 UI 唯一无法
恢复的结局；helper 拉起后的失败（如 health-timeout）由页面轮询超时暴露。

**pid1-exit 模式（容器内 PID=1）**——见下一节。

### Docker PID=1 的重启方案

本插件的目标部署（DSH 容器）正是 **PID=1 跑 DSH**：`ps -p 1` 即
`node /usr/local/bin/dsh --profile web --port 3080`。这与普通进程有本质差异：

- **内核语义**：PID namespace 的 init（PID 1）退出时，内核杀死该 namespace 内
  **所有**进程——detach 的 helper 也活不下来。power-button 式"helper 接管拉起"在
  PID=1 下**结构上不可能工作**：旧进程退出 → helper 被杀 → 无人拉起 → 服务死亡。
- **方案**：重启 = **优雅退出 + 交给容器运行时拉起**。host 在退出前把全部持久化
  记录写齐，然后请求退出：

  1. origin status（`~/.dsh/power-restart/ror-<restartId>.status.json`，带
     `committedAt`）→ 下次启动的 origin 扫描零改动命中，重启日志标注
     `restart-button` + 来源
  2. 重启身份记录（`<stateDir>/restart-identity.json`，带 `requestedAt`）→ 新实例
     凭 15 分钟时效窗口认领"我是重启产物"（无 env 令牌可继承，窗口防陈旧冒领），
     `/restart/health` 据此报 `restart` 身份与 `restarted` toast 标记
  3. 检测 marker 兜底 flush（固化 `recentSessions`/running 标记）→ 重启后照常自动
     恢复会话
  4. 停机归因存根（合成 `signal: 'restart-exit'`，与 crash 区分）
  5. `ctx.get('appExit')(pid1ExitCode)` 优雅退出（树销毁、存储 flush、端口释放）；
     宿主未提供通道时自发 SIGTERM 走既有优雅路径；unref 看门狗兜底硬退出

- **容器侧要求**：容器须以 `--restart=always` / `unless-stopped` 运行（退出后由
  Docker 自动拉起），或 `--restart=on-failure` 配合 `pid1ExitCode` 设为非 0；
  两者都没有时重启=停机，需手动 `docker start <容器>`，页面会明确提示这一点。
- **检测不受影响**：新实例启动后 `pid` 仍为 1，重启判定走既有的 `startAt` 偏差
  逻辑（>2s 容差即判定重启），停机时长、恢复候选、boot 记录全部照旧。

### 入口与防重入

三个入口共用同一引擎与同一个 at-most-once 闩（第二个并发触发得 `409`，绝不出现
双 helper 或双重退出）：

| 入口 | origin.kind | 二次确认 | 说明 |
|---|---|---|---|
| 设置弹窗「重启」按钮 | `settings-ui` | ✅ 客户端确认弹窗 | 无因果会话，重启日志只记来源类型 |
| `/restart` 命令 | `command` | ❌（可恢复操作） | 因果会话取发起命令的 agent |
| `restart_harness` 模型工具 | `model-tool` | ❌ | `delayMs` 下限 1000ms（模型不能在自身 turn 结算前杀进程）、上限 `maxDelayMs`；名称与 dsh-power-button / anweat/dsh-restart 一致，先到先得，被占用即让位 |

### 新路由（本插件前缀 + 既有围栏，`enableRestart: false` 时整体不存在）

- `GET /api/dsh-resume-on-restart/restart/info` → `{ ok, mode, pid, instanceId,
  appExit, isContainer, restartDelayMs, pid1ExitCode, runningCandidates }`
  （0.13.0 起 `runningCandidates` 为候选明细对象数组 `[{ id, at, running, title? }]`：
  真实最后活跃时间 ISO（未知为 ''）、最后已知运行态、防御式会话标题
  （session projection `session/title` 投影优先、header 回退）；
  0.18.0 起明细行再加 `workspace`（所属工作区完整路径，未知 ''——registry 实体
  直映射 / workspace.json 只读回退 / slug 正解匹配，客户端按它分组展示）；
  0.12.x 及更早为 `string[]`）
- `GET /api/dsh-resume-on-restart/restart/health` → `{ ok, instanceId, pid, mode,
  lifecycle, appExit[, restart: { restartId, fromInstanceId }][, restarted] }`
  （helper 就绪门控与客户端轮询共用；`restart` 身份块保留整个进程生命周期，
  `restarted` toast 标记被 `/restart/ack` 消费）
- `POST /api/dsh-resume-on-restart/restart` → `{ ok, mode, restartId, note }`（409 =
  已有重启进行中）
- `POST /api/dsh-resume-on-restart/restart/ack` → 消费 toast 标记

## Docker / PID 1 容器支持

在 Docker 容器里 DSH 服务永远以 PID 1 运行，`pid` 无法区分两次运行（旧版因此检测不到容器内重启）。0.2.0 起的检测方式：

- marker 中额外记录当前进程的启动时刻 `startAt`（由 `computeProcessStartAtMs` = `Date.now() - process.uptime() * 1000` 算出）
- `pid` 不同 → 直接判定重启（行为不变）
- `pid` 相同（容器场景）→ 对比本次进程启动时间与 marker 里的 `startAt`，无论时钟前移还是后移，偏差超过 2 秒容差（`START_AT_TOLERANCE_MS = 2000`）都判定重启
- 旧版 marker（没有 `startAt` 字段）自动兼容：回退用 `lastBootAt` 作为上次启动时间参与对比，不丢弃 marker

0.8.0 起插件自身也能在 PID=1 下**发起**重启（优雅退出 + 容器重启策略拉起，详见上一节
「Docker PID=1 的重启方案」）。

## 配置（cordis.patch.yml）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件开关 |
| `stateDir` | `.resume-on-restart` | marker/状态文件存放目录（相对 DSH_HOME；排除集合也在这里的 `excluded-sessions.json`） |
| `target` | `primary` | 唤醒目标（`primary`=主 agent，或指定会话 id） |
| `wakeup` | `true` | 是否真正唤醒（`false` 则只注入不唤醒） |
| `notice` | `''` | 附加到消息末尾的自定义提示 |
| `shutdownGraceMs` | `600000` | 关闭前"活跃即视为任务相关"的宽限窗口 |
| `ignoredSessionPrefixes` | `['head-']` | 不追踪的会话 id 前缀（如多代理团队的根会话） |
| `trackMax` | `5` | 最近活跃会话列表 `recentSessions` 的长度上限 |
| `persistThrottleMs` | `5000` | 活动时节流落盘间隔（窗口内合并为一次写盘） |
| `restoreSessions` | `true` | 重启后是否自动恢复重启前活跃的会话 |
| `restoreMax` | `0` | 最多恢复的会话数；`0` = 不限（遍历全部候选——0.17.0 起正常结束的会话先被正常结束门剔除，仍尊重排除名单与 `ignoredSessionPrefixes`），正整数 = 按活跃时间新 → 旧取前 N 个 |
| `restoreTimeoutMs` | `30000` | 候选恢复阶段的总预算（ms，0.7.0 起自 `sessionController` 就绪起算，等服务不占它），按候选数平摊、每候选最低 5 秒；超出预算的候选记 `skipped-budget`，全部候选失败/超预算后回退通知主会话 |
| `serviceWaitTimeoutMs` | `30000` | 0.7.0：候选恢复前全局等待 `sessionController` 就绪的独立预算（ms，轮询间隔 500ms），结果与耗时记入 `wake.log`；超时记 `service-wait-timeout` 并跳过全部候选直接回退通知主会话 |
| `requireHumanPrompt` | `true` | 0.6.0：投递前是否要求目标会话有过真实人工输入（恢复候选与 fallback 回退都生效）；没有或扫描失败（fail-closed）就跳过投递并记日志，`false` 关闭守卫（完全旧行为） |
| `enableRestart` | `true` | 0.8.0：重启引擎总开关（设置弹窗「重启」按钮、`/restart` 命令、`/restart/*` 路由）。`false` 时全部不存在，插件回到纯观测 |
| `enableModelTool` | `true` | 0.8.0：是否注册 `restart_harness` 模型工具。设 `false` 则重启只走 GUI 按钮/命令；名称被其他插件占用时无论如何都会自动让位 |
| `restartDelayMs` | `1500` | 0.8.0：HTTP 回包返回后、请求退出前的延迟（ms），给回包与会话 flush 留时间 |
| `maxDelayMs` | `5000` | 0.8.0：模型工具 `delayMs` 参数的上限（有效下限 1000ms） |
| `pid1ExitCode` | `0` | 0.8.0：pid1-exit 模式的退出码。`--restart=on-failure` 策略只在非 0 退出时拉起容器；`always` / `unless-stopped` 保持默认 0 即可。取值 0-255，非法回退默认 |

## 开发 / 测试

```bash
# 运行单元测试（重启判定、停机归因、origin 匹配、ndjson 裁剪、排除过滤、消息构建、
# 0.8.0 的重启引擎：模式判定/端口 pin/身份认领/helper 产物协议点/真实进程端到端、
# 0.9.0 的归档会话过滤：gate 同款 lineage/候选剔除/回退决策/restart/info 计数口径、
# 0.13.0 的确认后待恢复列表与恢复结果对账：localStorage 存根读写/boot 匹配
# （restartId 优先 + 时间容差回退）/restore 归组/候选明细归一化、
# 0.17.0 的正常结束门：turn 状态扫描/completed 跳过/异常与悬空照旧恢复/损坏保守恢复/
# 运行中直通/候选全正常结束的安静收尾/state 与 restart/info 显示同口径/刷新按钮管线、
# 0.18.0 的按工作区分组：projectKeyOf slug 编码/工作区条目归一/id→path 映射
# （sessionIds 直映射 + slug 正解匹配）/registry→workspace.json→未知的回退链接线/
# groupPendingRows 分组排序与未知组垫底/workspace 字段归一化与合并透传）
npm test
```

测试覆盖 `lib/detect.js` 中的纯函数（重启判定与检测依据、恢复候选挑选与排除过滤、
停机归因与原因标签、origin 时间窗匹配、ndjson 解析/裁剪、信息性消息构建、0.6.0 的
human-prompt 守卫判定、0.9.0 的归档名单归一化/lineage 判定/候选过滤/回退决策、
0.17.0 的正常结束门判定/候选过滤/回退安静收尾）、
`lib/session-scan.js` 中的会话记录扫描（人工输入记录判定、
JSONL 全文判定、记录文件定位、真实 zstd 压缩/多帧拼接下的端到端扫描、
0.17.0 的最后已知 turn 状态判定——completed/ended/悬空 turn/start/无 turn/损坏行、
多帧 zstd 端到端、文件缺失/损坏的 unknown 保守口径）、
`lib/restart.js` 中的重启引擎（模式判定、端口 pin、退出预算派生、身份认领、防重入闩、
helper 脚本产物的关键协议点断言，以及一个**真实进程端到端**：helper 面对 COMMIT 前
不出手、COMMIT 后先写身份记录再拉起、假目标以 health-timeout 收场而非假成功）、
`lib/archive.test.js` 的归档过滤接线（mock cordis ctx：`/restart/info` 计数口径、
候选全归档的安静收尾、workspaceRegistry 缺失时行为不变；0.18.0 的 id → 工作区
解析：`projectKeyOf` slug 编码、`normalizeWorkspaceEntries` 条目归一、
`buildWorkspaceIdMap` 直映射 + slug 正解匹配、registry → workspace.json →
未知工作区的回退链接线（探测抛异常降级、只读红线）、`/restart/info` 行带
workspace；无 e2e、不起服务）与
`lib/pending-restore.test.js` 的对账纯函数（桩 `window.__ModuleLoader__` 加载真实
client bundle：localStorage 存根防御式读写、boot 匹配——restartId 相等优先/时间
容差回退/只认 boot 记录、restore 按 id 归组、候选明细归一化含旧版 string[] 兼容、
0.17.0 刷新按钮的数据管线与 skipped-completed 徽标白名单、0.18.0 的
`groupPendingRows` 分组排序/未知组垫底/不改入参与 workspace 字段归一化/合并透传），
不依赖 DSH 运行时。另有 `tools/smoke.mjs` 手动冒烟：mock cordis ctx 启动插件、走查
GET 路由与 pid1-exit 分支（stub appExit；`DSH_HOME` 重定向到临时目录，绝不触碰真实
`~/.dsh`）。

## License

MIT。0.8.0 重启引擎的"detached helper relaunch"设计参考
[dsh-power-button](https://github.com/keyiadiannao/dsh-power-button)（MIT）与
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)（MIT），实现为本插件独立改写
（身份记录独立于检测 marker、容器 PID=1 的 pid1-exit 模式、会话静默检测覆盖
session.v4.jsonl[.zstd]），未复制其代码。
