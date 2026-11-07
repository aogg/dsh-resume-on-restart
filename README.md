# dsh-resume-on-restart

DSH 插件：检测 DSH 服务重启后，**自动恢复重启前活跃的会话**（把"重启前正在干活的会话"
恢复成 live agent 并投递通知，让它自己继续），失败时降级为向主 agent 投递一条**信息性消息**
（含中断时长、上次活跃会话等状态摘要），由 agent 自主决定下一步。0.8.0 起还内置**重启引擎**：
可在设置弹窗（二次确认）主动重启 DSH，普通进程 helper 握手原样拉起，容器 PID=1 优雅退出
交由容器重启策略拉起——重启完成后会话照常自动恢复。

解决"DSH 重启后会话中断、工作丢失"的问题——重启后无需用户去别的会话手动输入"继续"。

## 特性

- 🔄 **重启检测**：通过 marker 文件（记录上次 pid / 启动时间）判断是否发生重启
- ⏭️ **会话自动恢复**（0.3.0，0.5.0 起全量，0.9.1 收口，0.10.0 口径反转，0.17.0 正常结束不恢复，0.20.0 移除候选窗口限制）：
   重启后自动把重启前活跃过的会话（0.20.0 起最近活跃列表默认不限量，
   历史会话永不因窗口挤出而丢失恢复资格）resume 成 live agent 并投递通知
   （0.9.1 起逐个尝试全部候选，不再"首个成功即停"）；**0.17.0 起「正常结束」的
   会话不再恢复**（会话日志最后一条真实 turn/end `reason.kind === "completed"`，
   由重启后的日志扫描判定——文件缺失/解压失败/解析异常一律保守恢复，宁可多恢复）；
   subagent routing 持有的子代理会话按其**主会话祖先代理恢复**（`result: 'subagent'`，不算失败；
  0.33.0 起**冷会话**——本进程没有活 agent、会话记录只在磁盘上的会话——同样能识别，
  见下文「subagent 会话代理恢复」）；
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
   （重启按钮 / crash / signal 都一样），被暂停的会话都会被既有自动恢复流程恢复
   （0.20.0 起最近活跃列表默认不限量，暂停会话本就在列表里）；暂停与重启双向互斥（同时只允许一个进行）
- 🕒 **待恢复列表与恢复结果对账**（0.13.0，0.14.0 逐行/批量取消恢复，0.16.0 进入选项卡即展示，0.17.0 手动刷新，0.18.0 按工作区分组，0.21.0 等待态可视化强化，0.24.0 对账视图不再被列表遮蔽 + 进页面即刷新，0.25.0 会话行点击跳转 + 对账视图按工作区分组）：
   **进入设置弹窗「重启」选项卡即自动展示「待重启恢复会话列表」**（会话标题为主、
   完整 id 悬停提示 + 最后活跃时间 + 运行中标记（**0.32.1 起该标记取活 agent 的实时
   `status`**，不再是 marker 里的「最后已知」快照——被重启打断且此后从未再运行的会话
   不会再显示「● 运行中」）；**0.18.0 起按会话所属工作区
   分组展示**——组头为工作区完整路径、未知工作区组恒排最后，组间/组内按最后
   活跃时间新 → 旧；**0.25.0 起每个会话行支持点击跳转**——非 waiting 阶段行容器
   绑 onClick，走 dsh 官方 `uiWorkspace.openSession(sessionId)` 打开该会话，成功后
   自动关闭设置弹窗，行 hover 提亮、title 追加「点击打开会话」提示；行内
   checkbox 与行尾「取消 / 恢复」按钮已 stopPropagation，点控件不误触发跳转；
   **waiting 只读阶段不绑行点击、不加可点样式**——该阶段连按钮都隐藏，保持纯展示；
   逐行/批量「取消 / 恢复」在选项卡内
   直接可用，与「重启后将自动恢复 N 个」计数同口径联动；0.17.0 起标题行带
   「刷新」按钮——重拉 `/restart/info` 按最新口径合并重建，保留本地取消标记，
   拉取中禁用、失败静默保留现有列表，confirm 模式同样可用；**0.24.0 起进入
   选项卡与点「刷新」共用同一条数据管线**——进页面即按最新口径合并重建并收窄
   选中集合，行为与点刷新完全一致）；
   确认重启后展示同一列表（点击时刻重拉的最新口径）与等待计时——**0.21.0 起
   等待态一眼可见**：section 标题下紧跟醒目横幅（旋转圆环 spinner + 「DSH 正在
   重启」标题与副文案 + 右侧大号逐秒计时，`prefers-reduced-motion` 下停用动画），
   另有视口顶部居中的固定提示条（蓝底白字胶囊条，无论滚动到哪都恒定可见），
   原两段 12px 灰色小字状态行不再重复显示；
   **0.24.0 起对账视图不再被列表遮蔽**：点「重启 DSH」后若上一轮重启的对账数据
   还在，待恢复列表与对账视图两块堆叠展示（列表在上、对账视图在下），
   confirm/waiting/失败回 idle 各阶段都如此；
   列表支持逐行与批量「取消 / 恢复」（取消 = 重启后不自动恢复，已取消行弱化显示、保留在
   列表中可撤销；waiting 阶段只读且不绑行点击跳转）；
   重启完成页面刷新后，
   同一位置原位变为「上次重启(<时间>)的恢复结果：x/y 已恢复」+ 逐会话结算徽标
   （已恢复/恢复失败/已被用户排除/已归档跳过/经主会话代理恢复/预算耗尽跳过/
   无人工输入跳过/正常结束跳过/待结算——服务端结算是异步的，短轮询对账，超时未结算如实显示；
   0.24.0 起它与待恢复列表并存堆叠，点「重启 DSH」也不会把它藏掉；
   **0.25.0 起对账视图同样按工作区分组**——复用待恢复列表的同一套分组纯函数
   与组头样式，旧存根无 workspace 字段归「未知工作区」组，天然兼容；
   **0.25.0 起对账视图的逐会话行同样可点击跳转**到该会话并关闭设置弹窗
   （跳转只读不改数据，无取消/恢复控件冲突））
- 🔌 **重启引擎**（0.8.0，设计参考 [dsh-power-button](https://github.com/keyiadiannao/dsh-power-button)）：
   普通进程走 detach helper 的 ARM→COMMIT→ACK 握手原样拉起；**容器 PID=1 走"优雅退出 +
   容器重启策略拉起"**（见下文专节）。同一引擎同时供 `/restart` 命令与 `restart_harness`
   模型工具使用（名称冲突自动让位），防重入闩保证并发触发只生效一次
- 🗄️ **归档会话不恢复**（0.9.0）：恢复候选按权威名单 `workspaceRegistry.archivedSessionIds`
   自动剔除已归档会话，并按 DSH `ArchivedSessionGate` 同样的 lineage 规则剔除"归档会话的
   subagent 后代"；剔除在重启日志结算为 `archived`（不算失败），候选全是归档时保持安静、
   不回退吵主会话；`GET /restart/info` 的候选数同口径；registry 缺失时行为退化为现状
- 🔁 **服务等待超时的逐级递增续等与「上次重启无法恢复」列表**（0.26.0）：快等
   `sessionController` 就绪（默认 30s）超时不再整批放弃全部恢复候选——先照旧立即
   回退通知主会话，同时后台按逐级递增间隔（2s/4s/8s/16s/30s 封顶）续等，总预算
   `serviceWaitMaxMs`（默认 10 分钟）内服务就绪即补跑候选循环（同一实现：守卫、
   预算、簿记、store 清理全部一致；按会话 id 去重，不与 fallback 重复投递；等待
   期间被排除/已正常结束的候选按门既有口径结算）；续等也到上限才放弃——剩余候选
   逐条结算「等待超时」并登记「上次重启无法恢复」store（`<stateDir>/unrestored.json`，
   cap 100 条新在前），设置弹窗「重启」section 待恢复列表之后新增第三块列表
   （按工作区分组、行点击跳转、行级/批量手动恢复，恢复成功自动从 store 移除）
- 📌 **主动注册重启恢复**（0.19.0）：会话经 `register_restart_recovery` 模型工具
   （`register-restart-recovery` 技能正文指导模型调用）主动登记「重启后自动恢复」资格——
   即使会话之后不再活跃甚至结束，下次 DSH 重启仍会恢复它。
   资格持久化在 `<stateDir>/proactive-restore.json`（`{ [sessionId]: { at: ISO 注册时间, title? } }`，
   上限 100 条丢最旧），跨重启持久、**只移除已成功恢复的条目**（失败保留下次重启再试）。
   `/restart/info` 候选明细行新增 `source`（`'skill'` = 主动注册，`'auto'` = 自动候选），
   待恢复列表对主动注册会话显示「技能注册」徽标；恢复流程把主动注册会话并入恢复候选池
   （不受 `restoreMax` 截断——「主动注册会话总是恢复」），尊重既有过滤（用户排除/归档/
   human-prompt 守卫；0.22.0 起**正常结束门对主动注册会话放行**——用户显式要求总是恢复，
   不再被「正常收工后才注册」拦下）
- 🤖 **注册后守门自动重启**（0.22.0）：`register_restart_recovery` 工具 `action=add`
   登记成功后，插件武装一次「所有会话都完成时自动触发一次 DSH 重启」的守门器——
   **任何需要等待 DSH 重启或 agent 重启才能生效/继续的场景**（如安装/更新插件、
   修改需重启的配置）都应调用本工具注册，注册后继续当前会话，全部会话收尾后
   重启与恢复自动发生，无需用户手动点。「完成」口径：会话不在 `running` 即算完成，
   **正在向用户提问等待回答（提问中）的会话也算完成**（防御式探测宿主
   sessionProjections 投影，链路缺失/异常一律按「不在提问」保守继续等）。评估入口：
   武装后 2s 首评 + `agent/status` 事件 ~1s 去抖评估 + 30s 兜底重估（timer 全部
   unref）；判定全部完成后排定 `autoRestartSettleMs`（默认 10 秒）窗口再触发，
   窗口内又出现会话干活则取消回等待。触发与重启按钮/命令/工具共用 `restartLatch`
   防重入，`origin.kind='auto'`、重启日志 reason 标签 `auto-restart`。武装状态
   持久化在 `<stateDir>/pending-auto-restart.json`（幂等武装保留最早时刻），只在
   开机**一次性消费**——自动重启绝不会每次开机连环触发；`GET /restart/info` 的
   `autoRestart: { armed, armedAt }` 可查武装状态。任何重启失败（helper 拉起失败等）
   都不会丢武装：下一轮评估自动重试
- 🔇 **注册但不激活**（0.23.0）：`register_restart_recovery` 新增 `activate` 参数
   （boolean，默认 true）。`activate=true`（默认/不传）行为与现状完全一致——重启后
   自动恢复本会话并注入继续提示；`activate=false`＝「注册但不激活」——其余一切一致
   （登记持久化、武装守门自动重启、绕过正常结束门、待恢复列表可见），唯一差别：
   重启后本会话不自动恢复（不 resumeSession、不 deliver、不注入继续提示），重启日志
   结算 `no-activate`（不算失败），注册条目保留（下次重启同样静默跳过，待恢复列表
   带「注册·不激活」徽标、可手动恢复）；适合工作已收尾、只需触发重启让改动生效，
   或不想重启后本会话抢焦点的场景。全部候选均为不激活时安静收尾不 fallbackWake
   （不吵主会话），与其他候选混合时维持既有回退语义；`action=remove` 不区分模式
   照旧整体取消
- 📜 **重启日志**（0.5.0）：`<stateDir>/restarts.ndjson` 记录每次重启的 boot 记录（含停机归因、
  重启来源、原因标签）与逐会话 restore 结算（resumed/failed/excluded/archived/skipped-budget
  /skipped-no-human-prompt/0.17.0 的 skipped-completed），上限 200 条、损坏行跳过；wake.log 保留不动
- ⚙️ **设置弹窗重启日志**（0.5.0，0.31.0 起表格化）：web 设置弹窗「重启日志」section（slot `settings.section`），
  倒序表格展示每次重启的 记录时间、触发、来源、首次登记、登记次数、触发时刻、重启耗时、距上次重启、恢复结果 `x/y`，
  可展开 boot 详情与逐会话恢复明细；「距上次重启」= 上次重启完成到本次重启完成的间隔（含正常运行时间，非停机时长），
  0.31.0 起不再使用有歧义的「停机 N」文案
- 🖱️ **会话顶栏开关**（0.4.0 起；0.36.0 起**常驻 + 五态**，0.11.0 起状态同步走 ws 推送）：
  web 会话顶栏（「标准模式」标签同排）的「重启时恢复」条目**任何会话都显示**，状态按
  优先级判断：已归档（灰显禁用）→ 已登记（点击取消）→ 已排除（点击改为恢复）→
  自动恢复候选（点击改为不恢复）→ 其余（**典型 = 已完成的会话**，点击补登记
  「重启后恢复」，0.36.0 的用户诉求）。登记/排除按会话持久化，重启 DSH 后仍生效；
  候选/登记/排除/归档状态由宿主 websocket 快照广播实时同步（0.11.0 起不再轮询），
  多标签页自动对齐
- 🧩 **对外扩展点**（0.32.0，详见 [docs/被扩展说明.md](docs/被扩展说明.md)）：其它插件用
  `ctx.on` 注册两个 cordis 串行事件——`resume-on-restart/before-restart`（重启被调用后、
  真正重启前）与 `resume-on-restart/before-resume`（重启完成后、恢复会话前）。派发按注册
  顺序逐个 await，全部处理器跑完才继续原有逻辑；任一处理器返回 `{ cancel: true, by, reason }`
  即可**取消本次重启**（HTTP 409 / 命令与工具错误结果，不产生任何重启工件）或**取消本次
  自动恢复**（落一条 `resume-cancel` 重启日志，界面显示「恢复已取消」）。处理器抛错与超时
  （`hookTimeoutMs`，默认 10s）都按取消的 fail-closed 口径处理，卡死的第三方插件不会挂住流程
- 📣 **IM 事件通知取消**（0.35.0，兼容 dsh-im ≥ 5.8.17，详见 [docs/支持插件说明.md](docs/支持插件说明.md)）：
  作为**消费方**向 dsh-im 注册「发送前通知提供者」——重启工件开写前把「本次将恢复的候选」
  （与待恢复列表同口径，activate:false 不算）快照进进程内集合，此后到进程退出之间，
  这些会话因重启被打断而触发的 completed / failed / timeout 通知与计划内宿主级 shutdown
  通知按 `Decision={cancel:true}` 取消（恢复流程马上会拉起它们并注入继续提示，这两条
  通知是噪音）；候选为空、不命中、crash/startup 一律没意见（fail-open，照发）。dsh-im
  缺失或旧版时**零注册、零日志、零行为差异**（静态 inject 不声明 dshIm——cordis inject
  全是必须依赖、缺失即插件不加载；改用与 webServer 同款的动态注入 `ctx.inject(['dshIm'], …)`，
  版本门 `notificationVersion === 1`）
- 🧪 **技能展示 tab 与提示词可见**（0.32.0）：设置弹窗第三个 tab 由「技能与注入」改名
  **「技能展示」**（en `Skill Showcase`），并在技能/工具清单之后新增「重启后恢复会话的
  提示词」区块——按本次启动的真实数据渲染投递正文、逐行列出每个片段的出现条件与来源、
  给出投递方式（`followup`/`inject`、消息 `source`、`config.notice`）。数据来自只读路由
  `GET /notice`，与 `deliver()` 同源（[docs/被注入说明.md](docs/被注入说明.md)）
- 💬 **信息性消息**：投递"检测到重启 + 中断时长 + 上次活跃会话（+ 恢复说明）"摘要，由 agent 自主决定下一步
- 🎯 **活动追踪**（0.3.0 修复）：运行期间通过 cordis 真实事件（`agent/status`、
  `agent/inbox/inserted`、`agent/assistant-stream`）追踪最近活跃会话列表 `recentSessions`
  （0.20.0 起默认不限量——历史上活跃过的会话全部保留为恢复候选，
  正整数 `trackMax` 可设回数量上限；条目含 `running` 标记：最后已知是否运行中，由 `agent/status` 维护
  ——0.32.1 起仅供重启日志与恢复流程参考，界面徽标改取活 agent 实时状态）
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
4. **一次性消费自动重启武装文件**（0.22.0）：`<stateDir>/pending-auto-restart.json`
   非空 = 上个进程武装过「全部会话完成后自动重启」——归因打点（`armedAt`/`by`）后
   立刻删除，守门器不在新进程自动续期（不消费会把「等会话完成 → 重启」变成每次
   开机再重启的死循环）；会话恢复不受影响，仍由 `proactive-restore.json` 承载、
   照常走下面的恢复流程
5. 若判定为重启：
   - **写 boot 记录**（0.5.0，重启日志）：先做停机归因（读 `<stateDir>/pending-shutdown.json`
     并删除；读不到回退旧 marker 的 `when` 字段；都没有 = crash）与 origin 匹配（扫描
     `~/.dsh/power-restart/*.status.json`，取 `committedAt` 落在 [上次启动, 本次启动] 的最近一条），
     得出原因标签（`restart-button` / `auto-restart`（0.22.0 守门自动重启）/ `power-button` / `signal` / `crash` / `unknown`）后写一条 boot 记录到
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
     → **保守恢复**（宁可多恢复，维持旧行为）。**0.22.0 起主动注册的候选免扫描
     直接放行**（`filterCompletedCandidates` 的 bypassIds）——主动注册 = 用户显式
     要求总是恢复，绕过本门；提问中的会话 turn 开着本就放行。候选全部正常结束时
     安静收尾，
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
   - **subagent 会话代理恢复**（0.9.1，0.33.0 起覆盖冷会话）：**subagent 会话不能被重启
     恢复，只能由父会话代理**——`header.origin === 'subagent'` 的候选被 subagent routing
     持有，宿主 `resolveAgent` 一律拒绝（`is owned by subagent routing`，正确通道是经
     父会话/subagent delivery），直接恢复必然失败。候选阶段按会话 header 识别这类候选，
     结算为 `result: 'subagent'`（**不算失败**），并把其**最近的主会话祖先**（沿
     `parentSession` 上溯）作为代理恢复目标并入候选——用户的工作经 lead 会话继续；
     祖先被用户排除/已归档时不代理（尊重用户意图，安静结算）。五种结算文案
     （`covered by candidate session <parent>` / `ancestor session <parent> excluded by
     user` / `… is archived` / `resume delegated to ancestor session <parent>` /
     `no resumable ancestor session found`）由纯函数 `classifySubagentDisposition`
     （`lib/detect.js`）判定。
     **header 读取链（0.33.0）**：① 热会话——session store 的 `get(id).header`
     （0.9.1 口径逐字不变）；② 冷会话——store 里根本没有条目（`get(id)` 返回
     `undefined`），回退读磁盘会话记录的首帧（`lib/session-scan.js` 的
     `readSessionHeaderFromDisk`：只解第一帧、4KB 起倍增到 1MB 上限的读取梯度、
     未压缩 `session.v4.jsonl` 只读首行、判定不了就 unknown 且绝不抛错；进程内 memo
     只读一次盘）。于是冷 subagent 会话不再被当成普通候选直接 `resumeSession`
     （此前必然拿到 `owned by subagent routing` 并结算成指令式失败），也**不再出现在
     `GET /restart/info` 的待恢复列表**里。两级都判定不了时**维持现状**（候选照旧保留，
     由 `resolveAgent` 的 RemoteError 在恢复循环里兜底结算为 `result: 'subagent'`，
     绝不记 failed）——绝不因为读盘失败把候选当 subagent 丢掉。
     术语（本 README 只定义一次，后文沿用简称）：**冷会话** = 本进程没有活 agent、会话
     记录只落在磁盘上的会话（如重启前被打断、恢复前尚未加载进 store 的会话）；
     **热会话** = session store 里有活 Session 的会话。
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
持续记录最近活跃会话列表（同 id 去重挪到最前；0.20.0 起默认不限量，正整数 `trackMax`
才按数量截断），活动时节流落盘
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

### 会话顶栏开关（0.4.0 起；0.36.0 起常驻五态、支持给已完成会话补设恢复）

web 端在会话顶栏、「标准模式」标签同一个父容器（slot `conversation.session.header.actions`）
里注册兄弟条目 `resume-on-restart`，视觉复用同一套设计 token，**任何会话都显示**
（0.36.0 起不再按「是否恢复候选」门控隐藏；被忽略前缀的会话不渲染任何 DOM）。
按钮显示态按优先级从高到低判断，点击统一走 `POST /session-recovery`：

| 状态 | 判定 | 文案 | 行为 |
|---|---|---|---|
| `archived` | 会话已归档 | 已归档，重启不恢复（灰显禁用） | 点击无效（`aria-disabled` + 短路）；归档会话不参与恢复，需先在会话列表取消归档 |
| `registered` | 在 `proactive-restore.json` 有效登记里 | ✓ 重启时恢复（已登记） | 点击 → 取消登记 + 标记为不恢复（want=false） |
| `excluded` | 在 `excluded-sessions.json` 里 | ✕ 重启时不恢复（已排除） | 点击 → 清除排除 + 登记恢复（want=true） |
| `auto` | 在自动恢复候选（运行中/最近活跃） | ✓ 重启时自动恢复 | 点击 → 取消恢复（want=false） |
| `none` | 其余（典型 = 已完成会话） | 重启时恢复 | 点击 → 登记恢复（want=true） |

`archived` 覆盖一切；`registered` 与 `excluded` 由同一个入口互斥写入，正常不会同时命中
（若因外部写入重叠，`registered` 快照按恢复流程的既有口径**剔除被排除的条目**，按钮显示
`excluded`，不会出现「显示已登记、重启却不恢复」）。`excluded` 也优先于 `auto`——
恢复候选阶段先剔除被排除的会话。悬停文案只说点击后果（「点击→重启时恢复」/
「点击→重启时不恢复」），title 说明当前状态与原因。

生效范围**仅当前会话**：取消恢复写入
`~/.dsh/.resume-on-restart/excluded-sessions.json`
（`{ "sessions": { "<sessionId>": "<排除时间 ISO>" } }`，上限 1000 条、超出丢最旧）；
登记恢复写入 `~/.dsh/.resume-on-restart/proactive-restore.json`
（`{ "<sessionId>": { "at": "<登记时间 ISO>", "title"?: "会话标题" } }`，上限 100 条、
超出丢最旧；即使会话之后结束，重启后仍会恢复）。重启后的恢复流程先剔除被排除的会话
（见上方步骤 4），再按归档名单剔除；归档会话无论是否登记都不恢复。

客户端（`lib/client.js`，手写 bundle、仅依赖 baseline 的 react）通过以下插件自有 API 读写状态：

- `GET /api/dsh-resume-on-restart/state?ids=<sessionId>` → `{ ok, excluded: { [id]: iso }, restoreCandidates: { [id]: true }, registered: { [id]: { at, activate? } }, archived: { [id]: true } }`。
  `restoreCandidates` 取自宿主内存 `recentSessions` 的实时视图（纯函数 `collectRestoreCandidateIds`），
  0.17.0 起再剔除最后已知状态为正常结束的会话（开机由日志扫描播种、运行期由
  `session/event` 维护的集合，不在请求路径上扫日志），
  不看排除集合——被排除但仍是候选的会话照旧显示；0.36.0 起 `ids` 只挑请求的会话
  （缺省回全集），`registered` / `archived` 与 ws 快照同源（`registered` 已剔除被排除的
  无效登记）
- `POST /api/dsh-resume-on-restart/session-recovery`，body `{ sessionId, want: true|false }`
  （0.36.0 顶栏统一入口）：want=true → 清排除 + 写 proactive 登记（title 拿到才带）；
  want=false → 删登记（保留其他条目）+ 写排除。任一文件写失败 → `{ ok: false, error }`
  且不广播（客户端回滚乐观更新）；成功 → 广播 ws 快照并回 `{ ok, sessionId, want, state }`
- `POST /api/dsh-resume-on-restart/state`，body `{ sessionId, excluded: true|false }`
  （0.4.0 起的既有入口；待恢复列表的逐行/批量取消仍用它，顶栏 0.36.0 起改用上面的
  统一入口）；请求期间防重复点击，失败回滚 UI
- `GET /api/dsh-resume-on-restart/ws-info` → `{ ok, token }`（0.11.0 引入；0.12.0 起
  不再返回 port，见下）

ws 快照（`type: 'state'`）与 GET /state 同口径，0.36.0 起多带 `registered` / `archived`
两个字段，顶栏据此实时推导五态；多标签页自动对齐。

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
  （本次参与恢复的候选列表）。
  0.31.0 起另补（历史条目不回填，缺失时前端显示「—」）：`registrationFirstAt` /
  `registrationFirstSessionId`（本重启周期 `[prevBootAt, origin.requestedAt]` 内第一条
  register_restart_recovery action=add 成功记录的时刻 / 会话 id）/ `registrationCount`
  （同周期 add 记录条数，恒写数字）/ `restartMs`（`at − origin.requestedAt` 毫秒 =
  重启耗时）
- **登记调用留痕**（0.31.0）：`<stateDir>/register-calls.ndjson`（上限 200 条丢最旧、
  重写剔除损坏行），每次 register_restart_recovery **action=add 成功**追加
  `{ at, sessionId, activate? }`（activate 仅 false 时写；remove 不记录）——即上面
  boot 新字段的数据源
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
0.31.0 起为表格（列顺序固定：记录时间 / 触发 / 来源 / 首次登记 / 登记次数 / 触发时刻 /
重启耗时 / 距上次重启 / 恢复结果），倒序展示每次重启；「触发」按 reason 映射文案
（auto-restart →「自动重启（所有会话完成）」、settings-ui →「手动按钮」、
model-tool →「模型工具」），「来源」按 `origin.kind` 映射（auto →「自动」、
model-tool →「会话 <短id>」、settings-ui →「设置界面」）；点击行展开 boot 详情与
逐会话 restore 明细。文案走宿主 locale 服务（zh/en 字典、zh 为权威），样式自带
（DSH 设计 token，明暗自适应；窄屏横向滚动）。
注意 `downtimeMs` 的口径是「上次重启完成到本次重启完成的间隔（含正常运行时间）」，
**不是停机时长**，0.31.0 起列名为「距上次重启」并在 title 标注口径；「重启耗时」用
`restartMs`。

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

### 确认后的可视化与恢复结果对账（0.13.0，0.14.0 扩展，0.25.0 行点击跳转 + 对账分组）

「重启 DSH」按钮确认后的流程在 0.13.0 增加展示层（`/restart/health` 轮询的
instanceId 基线判定是豁免区，一行未动）：

1. **待恢复会话列表**：进入 confirm 弹窗时重新拉一次 `GET /restart/info`（列表取
   点击时刻的最新口径）；POST `/restart` 成功进入 waiting 阶段后展示
   「待重启恢复会话列表」——每行 = 会话标题为主（省略号截断、全文在元素 title
   属性悬停可见；标题缺失退回截断 id 并弱化显示）+ 最后活跃本地时间（at 缺失
   显示 —）+ `● 运行中` 标记（0.32.1 起取活 agent 的实时 status，`agents` 服务
   不可用时回退 marker 最后已知值）；完整会话 id 一律放在行容器的 title 属性做悬停
   提示，不再作为行主文本；列表空显示「无待恢复会话」。**0.25.0 起每个会话行
   支持点击跳转**：非 waiting 阶段行容器绑 onClick → `jumpToSession(row.id,
   close)`——走 dsh 官方 `uiWorkspace.openSession(sessionId)` 打开该会话（客户端
   工厂 `inject` 新增 `uiWorkspace` 服务；apply 时防御式存模块级引用，服务缺失
   时只 console.warn 不跳），成功后回调 `close` 关闭设置弹窗（settings.section
   owner props 注入），行加可点样式（`.dsh-ror-restore-click`，hover 提亮）、
   行 title 在完整 id 基础上追加「点击打开会话」提示（`restart.openSessionHint`
   双语）；任何失败只 console.warn 不抛错（跳转是锦上添花）；行内 checkbox 与
   行尾「取消 / 恢复」按钮 `stopPropagation`，点控件不误触发跳转；
   **waiting 只读阶段不绑行点击、不加可点样式**（该阶段隐藏全部按钮的既有约束）
2. **等待计时**：waiting 阶段显示「重启中… 已等待 N 秒」（组件内 setInterval
   每秒跳动，离开 waiting/组件卸载即清理；超时提示逻辑不变）
3. **存根落盘**：POST 成功后把 `{ at: 确认时刻ISO, restartId?（响应里缺失则省略）,
   candidates: [{id, at, running, title?（空则省略）, workspace?（非空字符串才带，
   0.25.0 对账视图分组用）}] }` 覆盖写入 localStorage（key
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
   `skipped-completed`=正常结束跳过（0.17.0）/ 无 restore 记录=待结算。
   **0.25.0 起对账视图的行区同样按工作区分组**：复用待恢复列表的
   `groupPendingRows` 纯函数与组头结构/样式（`.dsh-ror-pending-group`，workspace
   缺失/空串显示「未知工作区」并恒垫底），组内行结构（结算徽标 + 标题 + error）
   与分组前完全一致，结算计数行与标题不变——存根 candidates 0.25.0 起带
   workspace（`readPendingRestore` 归一化同款「非空字符串才保留」透传），
   **旧存根无该字段 → 不带 → 归「未知工作区」组，天然兼容**；**对账视图的逐会话
   行同样可点击跳转**（同 `jumpToSession` → `uiWorkspace.openSession`，成功后
   关闭设置弹窗；对账视图只读展示、行内无控件，不需要 stopPropagation）
5. **异步结算的短轮询**：服务端结算是异步的（sessionController 等待最多 30s +
   逐候选），存在待结算会话时每 3s 轮询一次 `/restarts`、最多 20 次，全部候选
   有结算记录即提前停止；轮询结束后仍未结算的显示「未结算」；定时器组件卸载时
   清理。下次点「确认重启」覆盖 localStorage 存根，UI 切回 waiting 列表态
   （**0.24.0 起对账视图仍在其下渲染**——0.13.0 的「confirm 列表存在即不渲染
   对账视图」遮蔽语义废止，待恢复列表在上、对账视图在下两块堆叠；存根数据链路
   不变，重启完成页面刷新后由新存根展示新一轮对账仍是既有预期）
6. **逐行 / 批量「取消 / 恢复」（0.14.0）**：每行行尾「取消 / 恢复」按钮 + 标题下
   批量工具条（全选 checkbox 支持半选 +「已选 N 项」+「取消所选」「恢复所选」，
   无选中行按钮禁用）；复用既有 `POST /state`（`{ sessionId, excluded }`）每会话
   一次请求、选中行逐个串行发送，乐观更新 + 失败仅回滚对应行并 console.warn；
   已取消行弱化显示并保留在列表中（可撤销），waiting 阶段列表转只读（隐藏
   checkbox 与全部按钮，**0.25.0 起也不绑行点击跳转**），对账视图保持只读（无
   取消/恢复控件；**0.25.0 起其行可点击跳转**，见第 4 点）。取消标记只存组件本地
   state，不写
   localStorage 存根（candidates 仍含全部行，被取消会话重启后由服务端 restore
   记录结算为 excluded）；重开 confirm 弹窗时经 `mergePendingRows` 合并——服务端
   返回的行为准（cancelled 用本地旧值），服务端不再返回的行保留并置
   `cancelled: true`（防「取消后无法恢复」）；「重启后将自动恢复 N 个」计数在列表
   存在时按未取消行数实时显示（`activePendingCount`）。合并/标记/计数均为可测
   纯函数（`mergePendingRows` / `setPendingCancelled` / `activePendingCount`），
   从 client bundle 工厂导出
7. **「上次重启无法恢复」列表（0.26.0）**：待恢复列表之后、对账视图之前的第三块
   （仅非空渲染；三块堆叠：列表在上、无法恢复居中、对账在下）。宿主快等
   `sessionController` 超时后先照旧回退 fallbackWake，同时后台按逐级递增间隔
   续等（总预算 `serviceWaitMaxMs`）：就绪即补跑候选循环（按 id 去重不重复投递）；
   续等也到上限才放弃——剩余候选逐条结算「等待超时」并登记
   `<stateDir>/unrestored.json`（cap 100 条新在前，同 id 更新不新增）。本列表
   行结构与待恢复列表一致：按工作区分组（同一 `groupPendingRows`，未知工作区
   垫底）、行首「等待超时」结算徽标（新配色类
   `.dsh-ror-result-skipped-service-timeout`）、会话标题、登记时间，行可点击
   跳转（同 `jumpToSession`）；行尾「恢复」按钮 + 全选/「恢复所选」批量工具条
   （复用 0.14.0 同款 key 与样式），串行逐个 `POST /unrestored/restore`、乐观
   移除行、失败 console.warn 保留行、在途集合防重复点击；点「刷新」与待恢复
   列表一并重拉（挂载同理，404 = 混合版本窗口静默不显示）。恢复成功（自动恢复
   /续等补跑/手动恢复）时 store 内同 id 条目自动移除，列表随之消失；对账视图
   出现 `skipped-service-timeout` 结算同样显示该徽标

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
候选过滤与恢复流程零改动。0.19.0 起明细行再加 `source` 字段（`'skill'` = 主动
注册重启恢复，`'auto'` = 其余自动候选）：候选池 = `visibleRestoreCandidateIds`
自动候选 ∪ 主动注册候选（`proactive-restore.json`——即使不再活跃甚至结束也总是
出现，除非被用户排除；去重主动注册优先，主动注册会话的 `at` = 注册时间、
`running` 回查 `recentSessions`（查不到 = false））。归档剔除 + subagent
拆分 + 0.17.0 正常结束剔除（`visibleRestoreCandidateIds`：开机日志扫描播种、运行期
`session/event` 维护，与 `GET /state`、恢复流程同口径）的候选口径见上文。
**0.33.0 起 subagent 拆分对冷会话同样生效**（header 走 store 优先 + 磁盘首帧回退）：
冷 subagent 会话不再出现在本列表里（此前会以普通候选出现，点了恢复必然失败）。
对账匹配/归组逻辑抽成
可测纯函数（`matchPendingBoot` / `collectSettlementsBySession` 等），见
`lib/pending-restore.test.js`。0.17.0 起待恢复列表标题行带「刷新」按钮（preview /
confirm 皆可用，waiting 只读态隐藏）：点击重拉 `GET /restart/info` →
`normalizeCandidateDetails` 构建行 → `mergePendingRows` 合并（保留本地取消标记，
服务端不再返回的行保留并置 `cancelled=true`）→ 更新渲染；拉取中禁用并显示
「刷新中…」，失败静默保留现有列表（`restart.pendingRefresh` / 
`restart.pendingRefreshing` 双语文案）。**0.24.0 起该管线与挂载共用同一实现
（`syncPendingFromInfo`）**：进入选项卡的自动构建与点「刷新」完全一致（同样
合并旧取消标记、同样收窄选中集合、失败同样 console.warn 保留现有行），挂载入口
语义保留——响应到达时已点「重启 DSH」（clickedRef 置位）则只更新 info 不覆盖
列表、pendingMode 仅从 none 升为 preview、卸载 cancelled 防串态；openConfirm
的确认弹窗重拉保持原实现不动。0.18.0 起行区按工作区分组渲染：纯函数
`groupPendingRows(rows)`（工厂导出，可单测）输出有序组数组 `[{ workspace, rows }]`
——组内按 at 倒序、组间按组内最新 at 倒序、未知工作区组恒排最后、入参不被修改；
组头 = 工作区完整路径（缺失/空串显示「未知工作区」，zh/en
`restart.pendingUnknownWorkspace`），组内行与既有行完全一致，批量工具条与全选
作用于全部组的全部行，刷新按钮、结算徽标、取消弱化行行为不变。**0.25.0 起
对账视图行区同样经 `groupPendingRows` 分组**（组头结构/样式复用同一套；存根
candidates 随 `startRestart` 写入带 workspace——非空字符串才带、与 title 同款
「拿到才带」口径，`readPendingRestore` 归一化透传，旧存根无该字段归「未知
工作区」组天然兼容）；并新增 `.dsh-ror-restore-click` 可点行样式（待恢复列表
非 waiting 阶段与对账视图全部行共用，hover 提亮照抄既有 layer-3 写法）与
`restart.openSessionHint` 双语文案（可点行容器 title 在完整 id 基础上追加的
跳转提示）；行点击跳转 = 模块级 `jumpToSession(sessionId, close)`，客户端工厂
`inject` 新增 `uiWorkspace` 服务（dsh-client-ui-workspace 的 UiWorkspace，
`openSession` 打开会话成功后回调 owner props 注入的 `close` 关闭设置弹窗）。

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
| `register_restart_recovery` 模型工具 | `model-tool` | ❌ | 0.19.0：登记/取消当前会话「重启后自动恢复」资格（`action` `add`=默认登记 / `remove`=取消，不区分模式）；0.23.0 起新增 `activate` 参数（boolean，默认 true）——`true`/不传＝重启后自动恢复本会话并注入继续提示；`false`＝注册但不激活：重启照常自动触发，但本会话不被拉起、不注入继续提示，保留在待恢复列表（带「不激活」徽标）可手动恢复；`register-restart-recovery` 技能正文指导模型调用；与重启引擎无关（不触发重启） |

### 新路由（本插件前缀 + 既有围栏，`enableRestart: false` 时整体不存在）

- `GET /api/dsh-resume-on-restart/restart/info` → `{ ok, mode, pid, instanceId,
  appExit, isContainer, restartDelayMs, pid1ExitCode, runningCandidates }`
  （0.13.0 起 `runningCandidates` 为候选明细对象数组 `[{ id, at, running, title? }]`：
  真实最后活跃时间 ISO（未知为 ''）、最后已知运行态、防御式会话标题
  （session projection `session/title` 投影优先、header 回退）；
  0.18.0 起明细行再加 `workspace`（所属工作区完整路径，未知 ''——registry 实体
  直映射 / workspace.json 只读回退 / slug 正解匹配，客户端按它分组展示）；
   0.19.0 起明细行再加 `source`（`'skill'` = 主动注册重启恢复，`'auto'` = 其余
   自动候选——主动注册会话即使不再活跃甚至结束也出现，除非被用户排除）；
  0.12.x 及更早为 `string[]`）
- `GET /api/dsh-resume-on-restart/restart/health` → `{ ok, instanceId, pid, mode,
  lifecycle, appExit[, restart: { restartId, fromInstanceId }][, restarted] }`
  （helper 就绪门控与客户端轮询共用；`restart` 身份块保留整个进程生命周期，
  `restarted` toast 标记被 `/restart/ack` 消费）
- `POST /api/dsh-resume-on-restart/restart` → `{ ok, mode, restartId, note }`（409 =
  已有重启进行中；0.32.0 起 409 也用于「被扩展点 before-restart 取消」：响应体
  `{ ok:false, cancelled:true, by, reason, error }`，客户端据此显示「重启被插件取消」）
- `GET /api/dsh-resume-on-restart/notice` → `{ ok, plugin, bootAt, prevBootAt, downtimeMs,
  restoredSessionId, sample, segments: [{ key, text }], delivery: { method, wakeup, role,
  source, customNotice } }`（0.32.0：重启后恢复会话的提示词——`sample` 是按本次启动
  真实数据渲染的完整正文，`segments` 恒为 8 条白名单全量、本次未出现的 `text` 为 `null`；
  设置弹窗「技能展示」tab 的提示词区块用它渲染，客户端不写死任何文案）
- `POST /api/dsh-resume-on-restart/restart/ack` → 消费 toast 标记
- `GET /api/dsh-resume-on-restart/unrestored` → `{ ok, rows: [{ id, at, bootAt?, title?, workspace?, error? }] }`（0.26.0：「上次重启无法恢复」只读列表，store 倒序、空 → rows: []；`enableRestart: false` 时不存在）
- `POST /api/dsh-resume-on-restart/unrestored/restore` → `{ ok }`（0.26.0：手动恢复一条，body `{ sessionId }`；等服务就绪（≤ `serviceWaitTimeoutMs`）后按候选循环同款恢复并投递继续提示，会话已活跃则不重复投递直接成功；成功从 store 移除该条并写 `resumed` 结算；失败 `{ ok:false, error }` 响应风格照 `POST /state`）

## 对外扩展点：让别的插件挂进重启与恢复流程（0.32.0）

两个 cordis 串行事件，其它插件 `ctx.on` 即可注册（监听器跟随插件 fiber 自动清理，
不需要 inject 本插件）：

| 事件名 | 触发时机 | 取消的后果 |
|---|---|---|
| `resume-on-restart/before-restart` | 重启被调用之后、真正重启之前（按钮 / `/restart` 命令 / `restart_harness` 工具 / 守门自动重启共用同一处） | 本次重启整体取消：不写工件、不拉 helper、进程继续活着；HTTP 409 + `{ cancelled, by, reason }` |
| `resume-on-restart/before-resume` | 重启完成、boot 记录落盘之后，挑候选与恢复会话之前（每次开机一次，续等补跑不重复） | 本次自动恢复整体取消：不挑候选、不恢复、不投递、不做 fallback 唤醒；落一条 `resume-cancel` 重启日志 |

```js
// 其它插件里
ctx.on('resume-on-restart/before-restart', async (payload) => {
  await flushMyJournal()                                    // 宿主会等它跑完
  if (myMigrationRunning()) {
    return { cancel: true, by: 'my-plugin', reason: '迁移中，稍后重启' } // 取消本次重启
  }
  return undefined                                          // 放行
})
```

- 派发语义：按注册顺序**逐个 await**，全部跑完（且都没有取消）才继续本插件原有逻辑。
- 取消约定：返回 `undefined` / `null` / `false` = 放行；返回任何其它非空值（推荐
  `{ cancel: true, by, reason }`）= 取消，并**终止后续处理器**（cordis `serial` 语义）。
- 兜底：处理器抛错、超过 `hookTimeoutMs` 都按取消处理（fail-closed）；宿主没有
  `ctx.serial` 时静默放行。
- 事件名常量：`import { HOOK_EVENTS } from 'dsh-resume-on-restart/hooks'`
  （包根也 re-export）。
- 完整字段表、示例、反例与排障：**[docs/被扩展说明.md](docs/被扩展说明.md)**。

## 与 dsh-im 的通知兼容（0.35.0）

本插件也支持**别的插件**：dsh-im ≥ 5.8.17（`ctx.dshIm.notificationVersion === 1`）。
作为消费方向它注册一个「发送前通知提供者」，取消两类重启前的噪音通知：

| 通知 | 取消条件 | 说明 |
|---|---|---|
| 会话级 `completed` / `failed` / `timeout` | `context.sessionId` 在「本次重启的待恢复候选集合」内 | 会话马上会被自动恢复并注入继续提示，被打断的通知是噪音 |
| 宿主级 `shutdown` | `sessionId` 为空 + 候选集合非空 | 计划内重启且确有会话将被恢复；候选集合为空则不取消（照发） |

- 候选集合：`before-restart` 钩子全部通过、重启工件开写之前，把 `restartInfoCandidates()`
  （与待恢复列表同口径；`activate: false` 只登记不拉起、不算「将恢复」）快照进进程内集合；
  进程退出自然消失——重启后新进程的 completed「恢复结果汇报」不受影响；重启失败立即清空。
- 不存在时完全降级：dsh-im 缺失/旧版 → 零注册、零日志、本插件其余功能零差异
  （动态注入 + 版本门，静态 `inject` 不含 `dshIm`）。
- 排障：dsh-im 日志 `notification (…) cancelled by resume-on-restart`；
  `ctx.dshIm.listNotificationProviders()` 应能看到本提供者。
- 版本判断、降级依据、取消口径与边界：**[docs/支持插件说明.md](docs/支持插件说明.md)**。

## 重启后投递的继续提示词（0.32.0）

重启后自动恢复会话时，本插件向每个恢复成功的会话投递**一条普通 user 消息**（不是
system prompt），正文由 `lib/detect.js` 的 `noticeSegments()` 逐行拼出（`buildNotice()`
= 各段 join）：

```
[resume-on-restart] 检测到 DSH 服务已重启。
上次运行于 <上次启动>，本次于 <本次启动> 重启完成。
中断约 <N 分 M 秒>。
重启前最近活跃的会话：<会话 id>
该会话最后活跃于 <ISO>。
已自动恢复重启前活跃的会话 <会话 id>（最后活跃于 <ISO>）。
<config.notice 自定义行（可选）>
如需继续之前的工作，或启动新任务，请自主决定下一步。
```

- 空的片段不出现（例如没有上次启动记录时第 2 行变成「本次于 Y 启动。」）。
- 投递方式由 `wakeup` 决定：`true`（默认）→ `agent.followup` 新回合；`false` →
  `agent.inject` 注入当前回合。
- 消息外壳（`createNoticeMessage`）：`role: 'user'` + `source { kind:
  'dsh-resume-on-restart', form: 'notice', summary: 'resume-on-restart: DSH restarted at …' }`
  （会话格式 v4 要求 `source.kind` 是生产者自己的名字且不能是 `'plugin'`）。
- 只有恢复成功的会话才收到；被排除/归档/正常结束/不激活/服务超时的一律不投递，
  续等补跑与手动恢复同一条实现、按 `deliveredTo` 去重。
- 在设置弹窗 → 重启 → **技能展示** tab 底部可见「重启后恢复会话的提示词」区块
  （真实渲染 + 逐行出现条件 + 投递方式）；数据源 `GET /notice`。
- 逐行模板表、真实样本、定制与排障：**[docs/被注入说明.md](docs/被注入说明.md)**。

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
| `trackMax` | `0` | 最近活跃会话列表 `recentSessions` 的长度上限；`0` = 不限（0.20.0 起默认——历史上活跃过的会话全部保留为恢复候选，会话永不因窗口挤出而丢失恢复资格；已知代价：该列表与 boot 记录随历史会话增长），正整数 = 旧语义按数量截断，非法值同 `0`（不限） |
| `persistThrottleMs` | `5000` | 活动时节流落盘间隔（窗口内合并为一次写盘） |
| `restoreSessions` | `true` | 重启后是否自动恢复重启前活跃的会话 |
| `restoreMax` | `0` | 最多恢复的会话数；`0` = 不限（遍历全部候选——0.17.0 起正常结束的会话先被正常结束门剔除，仍尊重排除名单与 `ignoredSessionPrefixes`），正整数 = 按活跃时间新 → 旧取前 N 个 |
| `restoreTimeoutMs` | `30000` | 候选恢复阶段的总预算（ms，0.7.0 起自 `sessionController` 就绪起算，等服务不占它），按候选数平摊、每候选最低 5 秒；超出预算的候选记 `skipped-budget`，全部候选失败/超预算后回退通知主会话 |
| `serviceWaitTimeoutMs` | `30000` | 0.7.0：候选恢复前全局等待 `sessionController` 就绪的独立预算（ms，轮询间隔 500ms），结果与耗时记入 `wake.log`；超时记 `service-wait-timeout` 并跳过全部候选直接回退通知主会话（0.26.0 起同时起后台续等任务，不再就此放弃） |
| `serviceWaitMaxMs` | `600000` | 0.26.0：快等超时后的后台续等总预算（ms）——续等按逐级递增间隔（2s/4s/8s/16s/30s 封顶）轮询，就绪即补跑候选循环（按 id 去重不与 fallback 重复投递）；到本预算仍不就绪才放弃，剩余候选逐条结算「等待超时」并登记「上次重启无法恢复」store 可手动恢复。非法/非正数回退默认 |
| `requireHumanPrompt` | `true` | 0.6.0：投递前是否要求目标会话有过真实人工输入（恢复候选与 fallback 回退都生效）；没有或扫描失败（fail-closed）就跳过投递并记日志，`false` 关闭守卫（完全旧行为） |
| `enableRestart` | `true` | 0.8.0：重启引擎总开关（设置弹窗「重启」按钮、`/restart` 命令、`/restart/*` 路由）。`false` 时全部不存在，插件回到纯观测 |
| `enableModelTool` | `true` | 0.8.0：是否注册 `restart_harness` 模型工具（0.19.0 起同时门控 `register_restart_recovery` 与 `register-restart-recovery` 技能）。设 `false` 则重启只走 GUI 按钮/命令；名称被其他插件占用时无论如何都会自动让位 |
| `restartDelayMs` | `1500` | 0.8.0：HTTP 回包返回后、请求退出前的延迟（ms），给回包与会话 flush 留时间 |
| `maxDelayMs` | `5000` | 0.8.0：模型工具 `delayMs` 参数的上限（有效下限 1000ms） |
| `pid1ExitCode` | `0` | 0.8.0：pid1-exit 模式的退出码。`--restart=on-failure` 策略只在非 0 退出时拉起容器；`always` / `unless-stopped` 保持默认 0 即可。取值 0-255，非法回退默认 |
| `autoRestartSettleMs` | `10000` | 0.22.0：注册后守门自动重启的 settle 窗口（ms）——全部会话完成（不在 running；正在向用户提问等待回答的也算完成）→ 再等这么多毫秒才真正触发重启；窗口内评估翻回「还有会话在干活」则取消回等待。非正数/非法回退默认 |
| `hookTimeoutMs` | `10000` | 0.32.0：对外扩展点（`before-restart` / `before-resume`）**单个处理器**的等待上限（ms）。超时按取消处理（fail-closed）——第三方插件卡死不会把重启/恢复流程永久挂住；处理器抛错同样按取消处理。非正数/非法回退默认。详见 [docs/被扩展说明.md](docs/被扩展说明.md) |

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
# groupPendingRows 分组排序与未知组垫底/workspace 字段归一化与合并透传、
# 0.19.0 的主动注册重启恢复：proactive-restore 读/写/裁剪/候选池合并
# （主动注册优先去重/命中排除丢弃/总是恢复豁免 restoreMax 截断）/source 字段
# 归一化与合并透传/技能徽标；0.22.0 规划中：auto-restart 纯函数
# （归一化/读/写/删/幂等合并/完成判定）与 filterCompletedCandidates 的
# bypassIds 直通（缺省向后兼容）单测由测试角色补齐）、
# 0.33.0 的冷会话 header 磁盘读取（首帧梯度读取/memo）与冷 subagent 结算口径
# 0.35.0 的 dsh-im 通知兼容（resolve 全分支/描述符形状/候选集合读写/缺失与旧版
# 降级/disposer/重复注册可见降级/动态注入接线）
# 0.36.0 的顶栏常驻开关（五态状态机/快照 registered·archived/新路由
# POST /session-recovery 的 want 语义/i18n 键集/ResumeToggle 渲染与点击分支）
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
`groupPendingRows` 分组排序/未知组垫底/不改入参与 workspace 字段归一化/合并透传、
0.19.0 的 source 字段归一化/合并透传/刷新管线穿透；0.24.0 起 client.js 的挂载
与刷新收敛为同一管线（`syncPendingFromInfo`）后仍以同一桩加载方式全量通过）与
`lib/proactive-restore.test.js` 的主动注册纯函数（normalize/read/write/cap
丢最旧、候选池合并——主动注册优先去重/命中排除丢弃主动注册身份/自动候选维持现状、
恢复候选三列表合并——picked>paused>proactive 去重/at 降序/restoreMax 截断但主动
注册豁免/脏输入防御/不改入参；真实临时文件读写、缺失/损坏 → {}），
不依赖 DSH 运行时。0.32.0 新增 `lib/hooks.test.js`（取消值归一化 / payload 构造与冻结 /
带超时的串行派发：缺 serial 放行、async 处理器等待、抛错与超时=取消）、
`lib/hook-cancel.test.js`（apply 接线：`POST /restart` 被 before-restart 取消 → 409 且
不产生任何重启工件；before-resume 取消 → 只落 boot + resume-cancel、无逐会话结算；
抛错 fail-closed；放行不写 resume-cancel）与 `lib/notice.test.js`（提示词分段 key 与
`buildNotice` 逐字一致、zh/en 的 `notice.when.*` 齐全、tab 改名、`groupEntries` 收集
`resume-cancel`、`resumeCancelText` 降级口径）与 0.32.1 新增的
`lib/running-badge.test.js`（`/restart/info` 运行徽标取活 agent 实时 status：
marker 陈旧 true 被实时 idle 覆盖、marker false 但真实在跑 → true、
`agents.list()` 空数组是有效数据不回退、`agents` 服务缺失 / `list()` 抛错 / 形状不合
一律回退 marker 最后已知值且路由照旧 200），均无 e2e、不起服务。0.33.0 新增
`lib/session-header.test.js`（13 用例：冷会话 header 的磁盘首帧读取——
`SESSION_HEADER_READ_SIZES` 4KB 起倍增/上限 1MB、首行 JSON → header 的两种形状、
真实临时多帧 zstd（首帧 header + 后续记录 + 伪 header）只解第一帧、首帧压缩后 >4KB
时按梯度从 4KB 试到 16KB、截断/非 zstd 数据的 unknown、未压缩文件只取首行、无
`zlib.zstdDecompressSync` 环境下 zstd 形态降级为 unknown 而未压缩形态照常、id 非法
与文件缺失的 unknown、**10MB 文件注入读盘点只被请求一次 4096 字节**的证据）与
`lib/cold-subagent.test.js`（15 用例：冷 subagent 不进 `/restart/info` 与直接恢复候选、
父会话是候选/被排除/归档/不在窗口/缺 parentSession 五种结算口径且绝不发 resume、
磁盘判定不了时维持现状留在候选、热会话只认 store、memo 删掉记录后仍按首次判定不再
读盘，以及 `classifySubagentDisposition` 的五种文案与优先级/脏输入防御）、
0.36.0 新增 `lib/recovery-state.test.js`（19 用例：五态优先级与 archived 覆盖一切、
16 种标记组合 host↔client 逐一对齐、点击意图映射、按钮渲染模型（文案/title/灰显/
禁用/aria-pressed）、i18n `recovery.*` 键集 zh/en 对齐、快照构造器脏输入与
「被排除的登记不算有效」，以及用极简 react 桩跑真实渲染路径/点击分支：五态文案与
aria、want 推导 + `POST /session-recovery` 请求体、归档态零请求），`lib/routes.test.js` 新增 4 用例（`POST /session-recovery`
的 want=true/want=false 对两个状态文件的影响、参数校验与 403 围栏、
`GET /state` 新字段与 ids 过滤），`lib/proactive-restore.test.js` 新增 1 用例
（已完成会话 + 主动登记 → 仍进入恢复候选且不受 restoreMax 截断），
另有 `tools/smoke.mjs` 手动冒烟：mock cordis ctx 启动插件、走查
GET 路由与 pid1-exit 分支（stub appExit；`DSH_HOME` 重定向到临时目录，绝不触碰真实
`~/.dsh`）。

## License

MIT。0.8.0 重启引擎的"detached helper relaunch"设计参考
[dsh-power-button](https://github.com/keyiadiannao/dsh-power-button)（MIT）与
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)（MIT），实现为本插件独立改写
（身份记录独立于检测 marker、容器 PID=1 的 pid1-exit 模式、会话静默检测覆盖
session.v4.jsonl[.zstd]），未复制其代码。
