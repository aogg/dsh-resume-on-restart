# dsh-resume-on-restart

DSH 插件：检测 DSH 服务重启后，**自动恢复重启前活跃的会话**（把"重启前正在干活的会话"
恢复成 live agent 并投递通知，让它自己继续），失败时降级为向主 agent 投递一条**信息性消息**
（含中断时长、上次活跃会话等状态摘要），由 agent 自主决定下一步。

解决"DSH 重启后会话中断、工作丢失"的问题——重启后无需用户去别的会话手动输入"继续"。

## 特性

- 🔄 **重启检测**：通过 marker 文件（记录上次 pid / 启动时间）判断是否发生重启
- ⏭️ **会话自动恢复**（0.3.0，0.5.0 起全量）：重启后自动把重启前停止时仍运行中的**全部**活跃会话
   resume 成 live agent 并投递通知；依赖 DSH Host 的 `sessionController` 服务，缺失/失败时自动降级为通知主会话
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
     恢复的总预算为 `restoreTimeoutMs`（默认 30 秒）按候选数平摊、每候选最低 5 秒，
     超出预算的候选记 `skipped-budget`；失败继续下一个候选。
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
该服务静态依赖 agents 等 11 个服务，按依赖序晚于 `agents` 激活，探测扑空时在候选的预算切片内
每 500ms 轮询等待服务就绪（0.5.2 起），切片耗尽才判该候选失败（error 区分"等待服务超时"）。
服务缺失、无 `resolveAgent` 方法、调用抛错/超时/返回失败分支（如 `session/not-found`）时，
记录原因到 `wake.log` 并尝试下一个候选；全部失败自动降级为旧行为——通知主会话。
该探测绝不阻塞插件加载，也不影响既有通知路径。

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

## Docker / PID 1 容器支持

在 Docker 容器里 DSH 服务永远以 PID 1 运行，`pid` 无法区分两次运行（旧版因此检测不到容器内重启）。0.2.0 起的检测方式：

- marker 中额外记录当前进程的启动时刻 `startAt`（由 `computeProcessStartAtMs` = `Date.now() - process.uptime() * 1000` 算出）
- `pid` 不同 → 直接判定重启（行为不变）
- `pid` 相同（容器场景）→ 对比本次进程启动时间与 marker 里的 `startAt`，无论时钟前移还是后移，偏差超过 2 秒容差（`START_AT_TOLERANCE_MS = 2000`）都判定重启
- 旧版 marker（没有 `startAt` 字段）自动兼容：回退用 `lastBootAt` 作为上次启动时间参与对比，不丢弃 marker

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
| `restoreTimeoutMs` | `30000` | 恢复的总预算（ms），按候选数平摊、每候选最低 5 秒；超出预算的候选记 `skipped-budget`，全部候选失败/超预算后回退通知主会话 |

## 开发 / 测试

```bash
# 运行单元测试（重启判定、停机归因、origin 匹配、ndjson 裁剪、排除过滤、消息构建）
npm test
```

测试覆盖 `lib/detect.js` 中的纯函数（重启判定与检测依据、恢复候选挑选与排除过滤、
停机归因与原因标签、origin 时间窗匹配、ndjson 解析/裁剪、信息性消息构建），
不依赖 DSH 运行时。

## License

MIT
