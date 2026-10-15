# dsh-resume-on-restart

DSH 插件：检测 DSH 服务重启后，**自动恢复重启前活跃的会话**（把"重启前正在干活的会话"
恢复成 live agent 并投递通知，让它自己继续），失败时降级为向主 agent 投递一条**信息性消息**
（含中断时长、上次活跃会话等状态摘要），由 agent 自主决定下一步。0.8.0 起还内置**重启引擎**：
可在设置弹窗（二次确认）主动重启 DSH，普通进程 helper 握手原样拉起，容器 PID=1 优雅退出
交由容器重启策略拉起——重启完成后会话照常自动恢复。

解决"DSH 重启后会话中断、工作丢失"的问题——重启后无需用户去别的会话手动输入"继续"。

## 特性

- 🔄 **重启检测**：通过 marker 文件（记录上次 pid / 启动时间）判断是否发生重启
- ⏭️ **会话自动恢复**（0.3.0，0.5.0 起全量）：重启后自动把重启前停止时仍运行中的**全部**活跃会话
   resume 成 live agent 并投递通知；依赖 DSH Host 的 `sessionController` 服务，缺失/失败时自动降级为通知主会话
- 🖥️ **设置弹窗「重启」选项**（0.8.0）：设置弹窗左侧新增「重启」入口，展示重启模式说明、
   优雅退出通道可用性与「重启后将自动恢复 N 个运行中的会话」；「重启 DSH」按钮**二次确认**
   （默认焦点「取消」的确认弹窗）后才执行，重启期间轮询新实例、就绪后页面自动刷新，
   回到页面时弹「已重启」回执 toast
- 🔌 **重启引擎**（0.8.0，设计参考 [dsh-power-button](https://github.com/keyiadiannao/dsh-power-button)）：
   普通进程走 detach helper 的 ARM→COMMIT→ACK 握手原样拉起；**容器 PID=1 走"优雅退出 +
   容器重启策略拉起"**（见下文专节）。同一引擎同时供 `/restart` 命令与 `restart_harness`
   模型工具使用（名称冲突自动让位），防重入闩保证并发触发只生效一次
- 📜 **重启日志**（0.5.0）：`<stateDir>/restarts.ndjson` 记录每次重启的 boot 记录（含停机归因、
  重启来源、原因标签）与逐会话 restore 结算（resumed/failed/excluded/skipped-budget），
  上限 200 条、损坏行跳过；wake.log 保留不动
- ⚙️ **设置弹窗重启日志**（0.5.0）：web 设置弹窗新增「重启日志」section（slot `settings.section`），
  倒序展示每次重启的时间、原因标签、来源、停机时长、恢复成功 x/y，可展开 boot 详情与逐会话恢复明细
- 🖱️ **会话顶栏开关**（0.4.0）：web 会话顶栏（「标准模式」标签同排）出现「重启时恢复会话」条目，
  点击即可把当前会话标记为「重启后不自动恢复」，再点取消；标记按会话持久化，重启 DSH 后仍生效。
  条目只对会被重启恢复的会话显示（DSH 停止那一刻仍运行中），正常结束的会话不显示
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
     （优先 `recentSessions`，只取停止时仍运行中的条目——`running !== false`，缺失视为候选以兼容旧
     marker；兼容只有 `lastSessionId` 的旧 marker；去重、按活跃时间新 → 旧、截断 `restoreMax`；
     正常结束的会话不恢复，也不会经旧字段回退混回候选）；
     **候选先按用户排除集合过滤**（`filterExcludedCandidates`，被排除的候选记入 `wake.log` 与
     重启日志，`error: "excluded by user"`），再对剩余候选逐个尝试：已 live（`agents.get(id)`）直接投递；
     未 live 经 `sessionController.resolveAgent(id)` 恢复成 live agent 后投递。
     恢复候选前先用独立预算 `serviceWaitTimeoutMs`（0.7.0，默认 30 秒）一次性全局
     等待 `sessionController` 就绪（结果与耗时记入 `wake.log`；超时记
     `service-wait-timeout` 并跳过全部候选直接回退，不逐候选空转）；候选阶段不再
     等服务，总预算 `restoreTimeoutMs`（默认 30 秒）自服务就绪起算、按候选数平摊、
     每候选最低 5 秒，超出预算的候选记 `skipped-budget`；失败继续下一个候选。
     成功投递的通知含"已自动恢复重启前活跃的会话 xxx（最后活跃于 ...）"。
   - **回退**：所有候选都失败/被排除（或 sessionController 缺失/关闭恢复）时，轮询等待主 agent 出现
     （最长 20 秒），投递信息性消息：
     ```
     [resume-on-restart] 检测到 DSH 服务已重启。
     上次运行于 ...，本次于 ... 重启完成。
     中断约 X 秒。
     重启前最近活跃的会话：<session-id>
     如需继续之前的工作，或启动新任务，请自主决定下一步。
     ```
   - 每次投递/恢复结果都追加记录到 `wake.log`（一行一条 JSON：`deliveredTo` / `ok` / `error`）

运行期间通过 `agent/status`、`agent/inbox/inserted`、`agent/assistant-stream` 事件（payload 均含 `agent`，
`agent/status` 另带 `status`：`'running'`/`'idle'`，写进条目的 `running` 标记；其余事件沿用条目已有值）
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
里注册兄弟条目 `resume-on-restart`，视觉复用同一套设计 token。显示门控：条目只对恢复候选会话渲染
——即 DSH 停止那一刻仍 `running` 的会话（见下方 `GET /state` 的 `restoreCandidates`）；
正常结束的会话不渲染任何 DOM：

| 状态 | 文案 | 悬停文案 | 行为 |
|---|---|---|---|
| 正常 | 重启时恢复会话 | 取消→重启时恢复会话 | 点击 → 标记本会话「重启后不自动恢复」，条目变灰 |
| 已排除 | 已取消恢复（灰色） | 恢复→重启时恢复会话 | 点击 → 取消标记，回到正常态 |

生效范围**仅当前会话**：排除集合持久化在 `~/.dsh/.resume-on-restart/excluded-sessions.json`
（`{ "sessions": { "<sessionId>": "<排除时间 ISO>" } }`，上限 1000 条、超出丢最旧），
重启 DSH 后仍然有效；重启后的恢复流程会跳过被排除的会话（见上方步骤 4）。

客户端（`lib/client.js`，手写 bundle、仅依赖 baseline 的 react）通过以下插件自有 API 读写状态：

- `GET /api/dsh-resume-on-restart/state?ids=<sessionId>` → `{ ok, excluded: { [id]: iso }, restoreCandidates: { [id]: true } }`。
  `restoreCandidates` 取自宿主内存 `recentSessions` 的实时视图（新纯函数 `collectRestoreCandidateIds`），
  不看排除集合——被排除但仍是候选的会话仍显示灰色开关；当前会话不在其中、字段缺失或请求失败
  都按「不显示」处理
- `POST /api/dsh-resume-on-restart/state`，body `{ sessionId, excluded: true|false }`；请求期间防重复点击，失败回滚 UI

候选状态的查询时机：挂载/切换会话时一次、`window` `focus` 时一次、每 15 秒轮询一次
（`document.visibilityState !== 'visible'` 时跳过该轮）；POST 成功后不重新拉取候选集合。

`sessionId` 由插槽框架注入（session 作用域标准 props，见 `@deepseek-ai/dsh-client-ui-session`
对 `SessionStandardProps` 的 merge 声明），不使用任何 window 全局。

该路由前缀比宿主 `/api` 长、不会自动经过宿主的浏览器信任围栏，插件自带最小围栏：
先借用宿主 `connection.requestRejection`（未认证 401 等），宿主未提供该服务时回退到复刻自
DSH 官方规则的判断——Host 必须是 loopback 或 `--trusted-host` 声明的 authority、
全接口绑定时要求本机来源、拒绝 `sec-fetch-site: cross-site`、带 Origin 时必须同源。
webServer 服务缺失时仅 console.warn，不阻断插件加载。

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
  `{ type, bootAt, id, result: resumed|failed|excluded|skipped-budget, error, at }`

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
- **恢复预告**：「重启后将自动恢复 N 个运行中的会话」（`GET /restart/info` 的
  `runningCandidates`，与顶栏开关同一候选口径——被顶栏排除的会话不计入恢复，
  但仍计入此处显示的运行中候选数）
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
| `restoreMax` | `0` | 最多恢复的会话数；`0` = 不限（遍历全部 `running !== false` 候选，仍尊重排除名单与 `ignoredSessionPrefixes`），正整数 = 按活跃时间新 → 旧取前 N 个 |
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
# 0.8.0 的重启引擎：模式判定/端口 pin/身份认领/helper 产物协议点/真实进程端到端）
npm test
```

测试覆盖 `lib/detect.js` 中的纯函数（重启判定与检测依据、恢复候选挑选与排除过滤、
停机归因与原因标签、origin 时间窗匹配、ndjson 解析/裁剪、信息性消息构建、0.6.0 的
human-prompt 守卫判定）、`lib/session-scan.js` 中的会话记录扫描（人工输入记录判定、
JSONL 全文判定、记录文件定位、真实 zstd 压缩/多帧拼接下的端到端扫描）与
`lib/restart.js` 中的重启引擎（模式判定、端口 pin、退出预算派生、身份认领、防重入闩、
helper 脚本产物的关键协议点断言，以及一个**真实进程端到端**：helper 面对 COMMIT 前
不出手、COMMIT 后先写身份记录再拉起、假目标以 health-timeout 收场而非假成功），
不依赖 DSH 运行时。另有 `tools/smoke.mjs` 手动冒烟：mock cordis ctx 启动插件、走查
GET 路由与 pid1-exit 分支（stub appExit；`DSH_HOME` 重定向到临时目录，绝不触碰真实
`~/.dsh`）。

## License

MIT。0.8.0 重启引擎的"detached helper relaunch"设计参考
[dsh-power-button](https://github.com/keyiadiannao/dsh-power-button)（MIT）与
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)（MIT），实现为本插件独立改写
（身份记录独立于检测 marker、容器 PID=1 的 pid1-exit 模式、会话静默检测覆盖
session.v4.jsonl[.zstd]），未复制其代码。
