/**
 * dsh-resume-on-restart host half.
 *
 * 检测 DSH 服务是否发生重启：启动时读取上次运行留下的 marker 文件，
 * 若 pid/启动时间与本次不同则判定为一次重启。
 *
 * 0.3.0 起重启后的行为：
 * 1. 优先"自动恢复重启前活跃的会话"——按 marker.recentSessions 候选逐个尝试：
 *    已 live 直接投递；未 live 通过 ctx 上的 sessionController 服务（resolveAgent）
 *    把会话恢复成 live Agent 再投递，让"重启前正在干活的会话"自己收到通知并继续。
 * 2. 所有候选都失败（或 sessionController 缺失/超时）→ 回退旧行为：
 *    向主 agent（config.target 解析 roots[0]）投递通知，由其自主决定下一步。
 *
 * 运行期间通过 cordis 真实事件（agent/status、agent/inbox/inserted、
 * agent/assistant-stream，payload 均含 agent；agent/status 另带 status）持续追踪
 * 最近活跃的会话列表（条目含最后已知是否运行中的 running 标记），
 * 活动时节流落盘（默认 5 秒合并一次），SIGTERM/SIGINT 兜底 flush，
 * 使重启后能恢复"之前在哪工作"的上下文。
 *
 * 0.4.0 起新增 web 会话顶栏开关（lib/client.js）的宿主 half：
 * 1. 注册 prefix 路由 `/api/dsh-resume-on-restart/state`（GET 查询 / POST 标记），
 *    排除集合持久化在 `<stateDir>/excluded-sessions.json`，重启后仍生效。
 * 2. 恢复流程在逐个尝试候选前用排除集合过滤，被排除的候选记入 wake.log
 *    （error: "excluded by user"）。
 * 3. 本插件路由比宿主 `/api` 更长，不会经过宿主的浏览器信任围栏，
 *    因此自带最小围栏（同 Host、Origin 同源、拒绝 sec-fetch-site: cross-site、
 *    未认证 401）；webServer 经动态 ctx.inject(['webServer'], ...) 等服务激活后
 *    注册，不加入插件 inject、不阻塞加载。
 * 4. 恢复与顶栏开关显示同一口径（0.10.0 反转 0.4.0 口径）：最近活跃列表
 *    （0.20.0 起默认不限量，正整数 trackMax 才截断）内的全部会话——含手动
 *    停止（DSH 停止那一刻 idle）与正常结束的会话——都是恢复候选，顶栏开关对
 *    它们渲染；marker.recentSessions 条目的
 *    running 字段（由 agent/status 维护）不再参与候选过滤，仅作为记录保留
 *    （供重启日志与旧版本兼容）。
 *
 * 0.5.0 起新增重启日志与全量恢复：
 * 1. 重启日志 `<stateDir>/restarts.ndjson`（追加写、一行一条 JSON、上限 200 条
 *    超出丢最旧、损坏行跳过）：开机 detectRestart === true 时先写一条 boot 记录
 *    （含停机归因 shutdown、origin 匹配、原因标签 reason、候选会话列表），
 *    恢复流程每结算一个候选再写一条 restore 记录（resumed/failed/excluded/
 *    skipped-budget）；wake.log 保留不动。设置弹窗（lib/client.js）经
 *    `GET /api/dsh-resume-on-restart/restarts` 只读展示。
 * 2. 停机归因：SIGTERM/SIGINT 兜底 flush 时写 `<stateDir>/pending-shutdown.json`
 *    （`{ signal, at }`），下次开机读取归因后删除；读不到 = 崩溃 / 强杀 /
 *    容器重启（reason=crash；回退兼容旧 marker 的 when 字段，reason=signal）。
 * 3. origin 匹配：扫描 `~/.dsh/power-restart/*.status.json`，取 committedAt 落在
 *    [上次启动, 本次启动] 的最近一条作为重启发起方；没有 → origin: null。
 * 4. 全量恢复：restoreMax 默认 0 = 不限（遍历全部候选，仍尊重
 *    排除名单与 ignoredSessionPrefixes）；restoreTimeoutMs 总预算按候选数平摊，
 *    每候选最低 5s，超出预算的候选记 skipped-budget；失败继续下一个。
 *
 * 0.5.2 修复"重启后恢复候选全部失败"：sessionController 服务静态依赖 agents 等
 * 11 个服务，按依赖序必然晚于 agents 激活；恢复流程原先在 ctx.inject(['agents'])
 * 回调里立即非阻塞探测，开机百毫秒内必然扑空、逐候选立即失败。现改为在候选的
 * 预算切片内每 500ms 轮询等待服务就绪，就绪即恢复；切片耗尽才判失败（error
 * 文案区分"等待服务超时"），仍走既有的 fallbackWake 降级路径。
 *
 * 0.6.0 起新增"无用户提示词的会话不自动激活"守卫（lib/session-scan.js）：
 * 恢复候选投递与 fallbackWake 回退唤醒都在投递前扫描目标会话的记录文件
 * （`<DSH_HOME>/sessions/<项目目录>/[session-]<id>/session.v4.jsonl[.zstd]`），
 * 判定其是否有过真实人工输入（存在 `type === 'user/message'` 且消息对象
 * `source.kind === 'user'` 的记录，插件/规则注入消息的 kind 不算）；没有、或
 * 文件缺失/zstd 不支持/扫描失败（fail-closed）就跳过投递并记日志——不再把
 * "请自主决定下一步"的通知灌进从未有用户输入的空会话导致模型无人指示自主
 * 干活。`requireHumanPrompt: false` 可关闭守卫（完全恢复旧行为）。
 *
 * 0.7.0 修复"等服务挤占候选预算"（0.5.2 的后续）：等待 sessionController 就绪
 * 从候选预算切片中拆出——restoreCandidates() 进入候选循环前用独立预算
 * serviceWaitTimeoutMs（默认 30s，与 restoreTimeoutMs 互不挤占）一次性全局轮询
 * 等待，结果与耗时记入 wake.log；就绪后候选阶段不再等服务（resumeSession 退化
 * 为一次防御式即时检查，resolveAgent 仍按候选剩余预算 withTimeout 封顶），
 * restoreTimeoutMs 只作为候选阶段总预算、自服务就绪起算；等待超时则不逐候选
 * 空转，wake.log 记 service-wait-timeout 后直接回退 fallbackWake 降级通知。
 *
 * 0.8.0 起新增"重启引擎"（lib/restart.js，设计参考 dsh-power-button）：设置弹窗
 * 新增左侧「重启」选项（二次确认后才重启），并提供 /restart 命令与
 * restart_harness 模型工具（名称已被其他插件注册时自动让位）。重启分两种模式：
 * - helper（普通进程）：真 .cjs detach helper 经 ARM→COMMIT→ACK 握手接管拉起，
 *   等旧 pid 退出、端口释放、会话文件静默后以原 argv+cwd（端口 pin）拉起新进程；
 * - pid1-exit（容器内 PID=1）：PID 1 退出即容器销毁、helper 必死，因此退出前把
 *   origin status（power-restart/ror-<id>.status.json）、重启身份记录
 *   （restart-identity.json）、检测 marker 兜底 flush、停机归因存根全部写盘后
 *   优雅退出，由容器重启策略/手动 docker start 拉起。
 * 两种模式都被既有链路完整消化：开机 detectRestart 判定重启（pid1 靠 startAt
 * 差异）→ origin 扫描命中 ror-*.status.json → boot 记录 reason=restart-button →
 * 自动恢复运行中的会话 → /restart/health 暴露重启身份，客户端轮询 instanceId
 * 变更后自动刷新并弹「已重启」toast（POST /restart/ack 消费）。
 * 检测 marker.json 绝不被重启流程覆写（recentSessions 是恢复的唯一数据源）。
 *
 * 0.9.0 起恢复候选过滤已归档会话（归档不恢复）：权威归档名单在宿主
 * ctx.workspaceRegistry.archivedSessionIds（持久化在 workspace spec，跨重启
 * 保留）。恢复候选阶段与 GET /restart/info 的候选数都按它剔除；拿得到
 * session store（ctx.reflect.get('sessions')）时按 DSH ArchivedSessionGate
 * 同样的 lineage 规则把"归档会话的 subagent 后代"一并剔除（沿
 * session.header 的 origin==='subagent' + parentSession 向上走，任一祖先
 * 归档即剔除；拿不到 store 就只查直系名单）。被剔除的候选在重启日志结算为
 * `result: 'archived'`（不算失败）；候选全被归档剔除时不回退 fallbackWake
 * 降级通知——全是归档会话 = 用户有意归档，重启后保持安静，不吵主会话。
 * workspaceRegistry 缺失（防御式探测 ctx.reflect.get，非阻塞）→ 不过滤，
 * 行为完全退化为现状。
 *
 * 0.9.1 起修复三类残留失败（历史 wake.log / restarts.ndjson 逐条对应）：
 * 1. 全量恢复不再"首个成功即停"：restoreCandidates 此前在第一个候选投递成功后
 *    直接 return，其余运行中会话既不恢复也没有任何日志（10-14 05:48 boot 4 候选
 *    只有 3 条 restore 记录）。现改为逐个尝试全部候选、汇总 restored，
 *    预算耗尽的候选照旧记 skipped-budget（可见，而非凭空消失）。
 * 2. subagent routing 持有的会话不再算 failed：宿主 sessionController 对
 *    header.origin==='subagent' 的会话一律拒绝（RemoteError `is owned by
 *    subagent routing`，正确通道是经父会话/subagent delivery）。候选阶段用
 *    session store header（防御式探测，同归档过滤口径）识别这类候选，结算为
 *    `result: 'subagent'`（不算失败），并把"最近的主会话祖先"作为代理恢复目标
 *    并入候选（用户的工作经 lead 继续；祖先被用户排除/归档则不代理）；
 *    store 缺失时无法预识别，由 resolveAgent 的 RemoteError 兜底结算为
 *    result:'subagent'（绝不记 failed）。
 * 3. fallbackWake 不再 "no target agent after wait"：宿主 agents.roots() 只返回
 *    已 live 的顶层 agent，开机若没有任何会话被恢复/打开，20 秒轮询必然落空，
 *    降级通知从此没有出口（历史 wake.log 多条该错误）。落空后升级：等
 *    sessionController 就绪，把 marker.lastSessionId（重启前最近活跃会话；
 *    subagent 会话先沿 parentSession 上溯到主会话祖先；尊重用户排除、归档与
 *    human-prompt 守卫）解析成 live agent 再投递——与恢复候选同一恢复通道。
 *
 * 0.11.0 起顶栏开关（lib/client.js 的 ResumeToggle）的状态同步改走 websocket 快照
 * 推送（lib/ws-state.js，零依赖最小 RFC6455 服务端，取代客户端此前的 15 秒轮询）：
 * 随注册它的 ctx.effect dispose 关闭、不可用只 console.warn 降级绝不炸插件加载
 * （此时 /ws-info 返回 503，客户端保持无限重试、开关退化为其挂载时的一次性查询）。
 * 进程启动生成随机 token，经既有前缀路由新增的 GET /ws-info（过同一信任围栏）
 * 一次性下发接入信息；ws 升级握手校验 query 的 token（timing-safe）+ ws 适配版
 * 信任围栏（explainWsUpgradeTrust），不信任直接 destroy。
 * 连接建立后立即推一帧全量快照 { type:'state', restoreCandidates, excluded }；此后
 * 排除集合变化（POST /state 成功）与候选集变化（recordActivity 触发点）都广播同一
 * 快照，高频活动事件做 300ms 首发立即 + 窗口合并节流，快照内容没变不重发。
 *
 * 0.12.0 起 ws 推送从「插件自监听 0.0.0.0 + 随机端口」迁移到宿主 webServer 主端口
 * 的同源精确路径 /api/dsh-resume-on-restart/ws（webServer.registerUpgrade 升级路由：
 * 宿主按 pathname 精确分发、对升级路由不做围栏/认证，仍由插件 handler 全权负责）。
 * 随机端口曾迫使整套跨端口拓扑补丁——跨端口 ws 必报 sec-fetch-site: cross-site 的
 * 围栏误拒（403 回退补丁）、容器端口发布 NAT 的 socket-not-loopback 误拒（跳过补丁）、
 * 端口要经 /ws-info 下发且 DSH 重启后端口变化要重拉；同源后这些不再必需，
 * /ws-info 只下发 { ok, token }。围栏的 401/403 回退顺序与 explainWsUpgradeTrust
 * 等防御全部保留不动（同源正常路径会先命中「宿主围栏放行」的快速分支）。
 *
 * 0.11.1 修复线上刷屏（`ws upgrade rejected by host fence` 每 1~5 秒一行、恢复
 * 完成后仍持续）：1) 根因是宿主 connection.requestRejection（为同端口 HTTP API
 * 设计：Origin 须与请求 host:port 精确同源、sec-fetch-site: cross-site 一票否决）
 * 被原样套在跨端口 ws 升级上，页面 :3080 / ws 随机端口每次握手必 403 → ws 永远
 * 连不上 → 客户端按既定设计无限重试。现 401 仍直接拒绝；403 不再照单全收，回退
 * explainWsUpgradeTrust 裁决；undefined 放行、null 回退，均维持语义。2) 容器
 * （/.dockerenv，apply 时 stat 一次）经端口发布 NAT，合法浏览器来源 socket 必非
 * loopback——socket-not-loopback 检查仅非容器执行，其余围栏规则不变。3) 拒绝日志
 * 节流去重（key=reason|remote|cid，60s 窗口 + 累计抑制数补报，每条带
 * reason/remote/Host/Origin/cid 明细）；客户端 ws URL 追加每标签页随机 cid。
 *
 * 0.13.0 起 GET /restart/info 的 runningCandidates 从 string[] 升级为候选明细
 * 对象数组 `[{ id, at, running, title? }]`：此前 `.map((id) => ({ id, at: 0 }))`
 * 把真实最后活跃时间丢了，现回查内存 recentSessions 携带真实 `at`（ISO 字符串，
 * 未知为 ''，与 boot 记录 runningSessions 同款口径）与最后已知运行态 `running`；
 * 归档剔除 + subagent 拆分的候选口径完全不变（directRestorableCandidates）。
 * 另防御式探测会话标题（非空字符串才采纳）：DSH 宿主的会话标题不在 header，
 * 而是 session projection（`session/title` 事件的 last-wins 投影）——首选
 * `ctx.reflect.get('sessionProjections').stateOf(sessions.get(id), 'title')`
 * （同步、物化到该 Session 当前游标），回退 `record.title` / `record.header.title`
 * （无害防御）；sessions.get 为 undefined 时不造对象直接放弃。任何一层缺失/异常
 * 静默降级到下一层（只 console.warn），一律不带 title 字段，绝不阻塞路由。
 * 客户端「确认重启」后据此展示待恢复会话列表（标题为主、id 退为悬停提示），
 * 重启完成后凭 localStorage 存根对账逐会话恢复结果（见 lib/client.js）。
 *
 * 0.15.0 起新增「暂停所有会话」（设置弹窗「重启」section 的按钮，lib/client.js）：
 * 1. 新路由 POST /pause-all（enablePauseAll=false 时整体不存在）：先经 pauseLatch
 *    防重入（与 restartLatch 双向互斥——重启进行中拒绝暂停、暂停进行中 /restart
 *    拒绝重启，均 409），再经 agents 服务枚举运行中会话（detect.selectRunningAgentIds：
 *    status==='running' 且不被 ignoredSessionPrefixes 排除），逐个经
 *    sessionController.cancel({ sessionId }) 停止——它内部就是「用户点停止」的同一实现
 *    （agent.cancel({kind:'user'},{keepInbox:true})，已排队的输入保留）；subagent routing
 *    持有的会话（稳定错误文案 SUBAGENT_ROUTING_ERROR）跳过并结算为 subagent
 *    （不算失败，与恢复口径一致）。
 * 2. 停止成功的会话并入内存 pausedSessions 并一次写盘到
 *    `<stateDir>/paused-sessions.json`（与 excluded-sessions.json 完全同款：
 *    `{ sessions: { [id]: atISO } }`，读写归一化防御风格照抄排除集合）；同时
 *    recordActivity(id, 'idle') 立即更新内存视图与 marker。
 * 3. 候选并集（detect.unionRestoreCandidateIds）把 pausedSessions 并入四处候选口径：
 *    GET /state 的 restoreCandidates、ws 快照（buildWsSnapshot）、/restart/info 的
 *    runningCandidates（restartInfoCandidates：at 优先 recentSessions 真实值，否则用
 *    暂停时刻 atISO）、开机恢复流程候选池——顶栏开关、ws 快照、重启确认列表与恢复
 *    流程全部可见暂停会话（0.20.0 起最近活跃列表默认不限量、暂停会话本就在
 *    列表里；并集机制保留，历史上窗口时代它兜底窗口外会话）。
 * 4. wasRestart 开机时该文件被一次性消费：mergePausedCandidates 把暂停条目
 *    （running:false）并入恢复候选（按 id 去重 recentSessions 优先、at 新 → 旧、
 *    restoreMax 截断），随后照走既有排除/归档/subagent 拆分/恢复流程；读取后立刻
 *    删除文件 + 清空内存集合，只发生一次——不消费的话下一次 crash 重启会把早已
 *    恢复过的暂停会话再恢复一遍。非重启启动只读入内存、不删文件。
 * 5. cancel 通道的 sessionController 探测要求 resolveAgent + cancel 两个方法都存在，
 *    与恢复路径的探测（只要求 resolveAgent）分开实现，暂停路径的要求变化绝不影响
 *    恢复语义。/restart/info 响应体新增 `pauseAll: enablePauseAll`（客户端据此决定
 *    是否渲染按钮）。
 *
 * 0.17.0 起恢复口径再收窄：**正常结束的会话不再自动恢复**（0.10.0 口径反转曾让
 * 正常收工的会话重启后也被恢复，用户明确不要）。恢复候选 = 最近活跃窗口内且
 * **最后已知状态不是「正常结束」**：
 * 1. 判定主判据用会话日志扫描（lib/session-scan.js 的 scanSessionLastTurnState，
 *    memoized 复用）：最后一条真实 turn/end 的 reason.kind === 'completed' →
 *    跳过（restore 记录 result: 'skipped-completed'，error: null）；最后是
 *    turn/start 无对应 turn/end（turn 开着被崩溃/重启打断）或最后 kind ∈
 *    {aborted, blocked, error, max-tokens, interrupted, forked, 未知 variant} →
 *    照旧恢复；文件缺失/解压失败/解析异常 → unknown → **保守恢复**（宁可多
 *    恢复，维持旧行为）。日志是真源：事件内存态会因崩溃丢失，扫描在重启后做、
 *    日志已完整。0.6.0 human-prompt 守卫保持不变，叠加在新门之后。
 * 2. 运行期用宿主 `session/event` 事件（payload (session, event)，event 与日志
 *    记录同形状）低成本维护：turn/end completed → 会话进运行期 completedSessions
 *    集合（GET /state、ws 快照、/restart/info 的候选显示口径只含过滤后候选）；
 *    turn/start 与其他 kind → 移出。marker.recentSessions 条目顺带记录
 *    `lastTurnEndKind`（仅供观测），但**恢复过滤绝不依赖它**（崩溃会丢），
 *    旧 marker 无该字段完全兼容；boot 记录 runningSessions 保持如实记录（不过滤）。
 * 3. 回退唤醒同样过新门：fallbackWake 直达目标与 escalateFallbackWake 的
 *    lastSessionId 升级目标，最后已知状态为正常结束就不投递（wake.log 留痕）；
 *    候选全被正常结束门跳过时安静收尾（classifyRestoreFallback 的
 *    skippedCompletedCount，与归档安静收尾同款），不为正常收工的会话吵主会话。
 *
 * 0.18.0 起待恢复列表按工作区分组（lib/client.js 的 groupPendingRows 纯函数 +
 * renderPendingList 分组渲染；行内容与操作全部保留、跨组可用）。数据源：
 * /restart/info 候选明细行新增 `workspace` 字段（会话所属工作区 = 项目目录
 * 完整路径字符串，未知为 ''，总是携带）。宿主侧解析（sessionWorkspaceLookup，
 * 与 titleOf 同一查询路径一次构建映射、候选逐个查表，绝无每候选重复 readdir）：
 * 1. 首选宿主 workspaceRegistry 实体（ctx.reflect.get('workspaceRegistry').list()
 *    ——Workspace.path 是 canonical 目录路径、Workspace.sessionIds 是 header
 *    验证过 canonical cwd 的官方归属口径；0.15.0 起已用同一 registry 拿
 *    archivedSessionIds）；2. registry 缺失/无有效条目时只读解析
 * `<DSH_HOME>/storages/workspace.json`（unit v2，tables.workspaces——**只读
 * 参考，绝不写**；实测条目同样带 path+sessionIds）；3. 条目只有 path 没有
 * sessionIds 时，把路径经 projectKeyOf 编码成 slug 与 `<DSH_HOME>/sessions`
 * 的项目目录名正解精确匹配（slug 形如 `--code-www-...--`，编码有损、不能反解；
 * projectKeyOf 为宿主 dsh-session-persistence-jsonl `projectKey` 的自写等价
 * 实现——插件不 import 任何 @deepseek-ai/dsh-* 内部包，出处已注明）；4. 整条
 * 链路拿不到 → workspace = ''，客户端归入「未知工作区」组。纯展示字段：
 * /state、ws 快照（顶栏开关）、候选过滤与恢复流程零改动。
 *
 * 0.19.0 起新增「主动注册重启恢复」：会话经 `register_restart_recovery` 模型工具
 * （register-restart-recovery 技能正文指导模型调用）主动登记「重启后自动恢复」
 * 资格——即使会话不再活跃甚至结束后，下次 DSH
 * 重启仍会恢复它。数据持久化在 `<stateDir>/proactive-restore.json`
 * （`{ [sessionId]: { at: ISO 注册时间, title? } }`，上限 100 条丢最旧），启动读入
 * 内存 Map、变更写回（lib/proactive-restore.js 纯函数，可单测）：
 * 1. 模型工具与技能都经 ctx.reflect.get 防御式探测注册（skills/tools 不在静态
 *    inject（['agents']）里，缺服务不阻塞、优雅降级；技能注册返回的 disposer
 *    不随 ctx 自动失效，用 ctx.effect 返回的清理函数显式挂回）；
 * 2. /restart/info 候选明细行新增 `source`（'skill' = 主动注册，'auto' = 自动
 *    候选）：候选池 = visibleRestoreCandidateIds 的自动候选 ∪ proactiveRestore 的
 *    主动注册候选（去重主动注册优先、主动注册命中用户排除则丢弃，其余总是出现），
 *    主动注册会话的 at = 注册时间、running 回查 recentSessions（查不到 = false）；
 * 3. 恢复流程把 proactiveRestore 会话并入恢复候选池（不在 recentSessions 的以
 *    { id, at: 注册时间 } 形式并入；优先级 recentSessions > 暂停 > 主动注册；
 *    主动注册条目不受 restoreMax 截断——「主动注册会话总是恢复」），尊重既有
 *    过滤（用户排除/归档/human-prompt 守卫/正常结束门）；恢复成功后只移除已
 *    成功恢复的主动注册条目（失败保留下次重启再试），其余条目跨重启持久。
 *
 * 0.20.0 起**移除 trackMax 恢复候选窗口限制**（真实事故：2026-10-31 session-830af88f
 * 落在第 6 新及更旧处、被 0.3.0 的 trackMax=5 静默挤出，重启后永不恢复）：
 * 1. 默认 trackMax = 0 = 不限：marker.recentSessions 不再截断，历史上活跃过的会话
 *    全部保留为恢复候选（同 id 去重挪到最前的维护语义不变）。trackMax 与
 *    restoreMax 复用同一 normalizeRestoreMax 口径——缺省/0/非法 → 不限
 *    （MAX_SAFE_INTEGER，pickRestoreTargets 事实全量返回）；正整数 → 旧语义
 *    floor 后按数量截断（显式配置向后兼容仍生效）。restoreMax 默认 0（不限）不变；
 *    正常结束门、restoreTimeoutMs 候选预算（skipped-budget 可见结算）、
 *    human-prompt 守卫、归档/排除/subagent 过滤全部保持不变。
 * 2. 已知代价（用户接受）：marker.recentSessions 与 boot 记录 runningSessions 将
 *    随历史会话无界增长（marker 每次落盘全量写；boot 记录变长属预期）；
 *    recordActivity 的截断语句保留（trackMax 正整数时仍执行，默认不限量下
 *    大数值不会触发）。
 *
 * 0.22.0 起新增「注册后守门自动重启」（lib/auto-restart.js 新模块）：
 * `register_restart_recovery` 工具 action=add 登记成功后，插件武装一次「所有会话
 * 都完成时自动触发一次 DSH 重启」的守门器，让「装完插件/改完需重启的配置」这类
 * 等待重启的工作自动走到重启与恢复，无需用户手动点：
 * 1. 武装状态持久化在 `<stateDir>/pending-auto-restart.json`
 *    （`{ schemaVersion: 1, armedAt: 最早武装时刻, by: 最新注册者 }`），武装幂等
 *    （重复注册保留最早 armedAt）；action=remove 成功且已无任何主动注册时解除
 *    （删文件 + 清守门器 timer）。武装文件只在开机**一次性消费**（归因打点后删除，
 *    防止「等会话完成 → 重启 → 开机又武装」死循环），触发路径不删——失败分支留给
 *    下一轮评估重试，成功后新进程开机消费；
 * 2. 「完成」口径：会话不在 running 即算完成；正在向用户提问等待回答（提问中）
 *    的会话也算完成——防御式探测宿主 sessionProjections 投影
 *    （stateOf(agent.session, 'userQuestions')?.questions?.active 存在
 *    state==='continued' 条目），链路任一层缺失/异常 = 不在提问，保守方向是
 *    继续等、绝不提前重启；
 * 3. 评估入口：武装成功后延迟 2s 首评（注册那一刻本会话必然 running，天然等待）；
 *    agent/status 事件顺带调度 ~1s 去抖评估；另有 30s 兜底重估防事件丢失。
 *    全部 timer unref。判定 done:false → 取消已排定的触发继续等；done:true →
 *    排定 autoRestartSettleMs（默认 10s）窗口后触发，窗口内评估翻回 done:false
 *    则取消回等待。触发与既有入口共用 restartLatch 防重入（pauseLatch 非空 /
 *    claim 失败 = 本轮放弃、武装保留）；origin.kind='auto'，boot 记录 reason
 *    标签 'auto-restart'（detect.shutdownReasonOf / lib/restart.js ORIGIN_KINDS）；
 * 4. 恢复修复：boot 恢复流程的 0.17.0「正常结束门」（filterCompletedCandidates）
 *    增第三参 bypassIds，主动注册的候选免扫描直接恢复——「主动注册 = 用户显式
 *    要求总是恢复」（技能 0.19.0 起的承诺），不再被「正常收工后注册」的会话
 *    重启后不恢复的旧口径拦下；提问中的会话 turn 开着本就放行，与门原语义一致；
 *    第三参缺省/空时行为与 0.17.x 逐字节一致（向后兼容）；
 * 5. 提示词扩充：工具 description 与技能 content/whenToUse 明确「任何需要等待
 *    DSH 重启或 agent 重启才能生效/继续的场景都应调用本工具注册」；/restart/info
 *    响应体增 autoRestart: { armed, armedAt }（排障用便宜字段，不动 lib/client.js）。
 *
 * 0.23.0 起新增「注册但不激活」模式：`register_restart_recovery` 工具新增
 * `activate` 参数（boolean，默认 true）。两种模式：
 * 1. activate=true（默认/不传）：行为与现状完全一致——重启后自动恢复本会话并
 *    注入继续提示；
 * 2. activate=false＝「注册但不激活」：其余一切一致（登记持久化、武装守门自动
 *    重启、绕过正常结束门、待恢复列表可见），唯一差别：重启后本会话不自动恢复
 *    （不 resumeSession、不 deliver、不注入继续提示），结算 `result:'no-activate'`
 *    （error:null，不算失败）；注册条目保留在 proactiveRestore（下次重启同样
 *    静默跳过，待恢复列表保持带徽标、可手动恢复）。action=remove 不区分模式，
 *    照旧整体取消登记。
 * 实现接线：entry 的 `activate` 仅 false 时落盘（lib/proactive-restore.js 归一化，
 * true/缺失一律不写该字段，旧文件字节不变）；boot 恢复流程在候选进入
 * restoreCandidates 循环前把 proactiveRestore.get(id)?.activate === false 的候选
 * 拆出来（参照 skippedCompleted 的处理模式：console.log + writeWakeLog +
 * appendRestartLog 结算 no-activate），不从 store 删除、不参与 restoredAny；
 * 全部候选均为 no-activate 时安静收尾不打 fallbackWake（classifyRestoreFallback
 * 增 skippedNoActivateCount 输入，与 archived/skippedCompleted 同口径），
 * 与其他候选混合时维持既有回退语义不变；/restart/info 候选池映射输出行仅
 * false 才带 activate:false（客户端据此显示「注册·不激活」徽标，见 lib/client.js）。
 *
 * 0.26.0 起修复「服务迟迟未就绪时候选被整批静默放弃」（真实事故：2026-11-03 boot
 * 服务约 50-70s 才就绪，30s 快等超时后 2 个运行中候选被 `skip all restore candidates`
 * 一批丢弃——连逐条 restore 结算都没有，调用方回退 fallbackWake 只唤醒最近活跃
 * 的 1 个会话）。四层方案：
 * 1. 快速层不变：restoreCandidates 进入候选循环前仍先用 serviceWaitTimeoutMs
 *    （默认 30s）快等，等到就走既有候选循环；
 * 2. 续等层（新增）：快等超时不再就此结束——起后台续等任务，轮询等待**逐级递增**
 *    （escalationDelayMs(attempt) = min(2000 * 2^(attempt-1), 30000)：2s/4s/8s/16s/
 *    30s 封顶，纯函数导出供单测），总预算 serviceWaitMaxMs（默认 600000 = 10 分钟）。
 *    就绪后**补跑候选循环**——与正常路径同一实现（restoreCandidates 复用：正常
 *    结束门、排除集合、requireHumanPrompt 守卫、restoreTimeoutMs 预算、
 *    appendRestartLog 簿记、主动注册 store 移除全部一致，不新造逻辑）；补跑前按
 *    会话 id 去重（fallbackWake 已投递的 deliveredTo 集合跳过，不重复投递；等待
 *    期间被用户排除/已正常结束的候选按门既有口径重新结算，不强造 resumed）；
 *    补跑成功照常写 resumed 结算与既有簿记，wake.log 记一条含 deferred restore
 *    与实际等待时长的说明；
 * 3. 回退层保持即时：fallbackWake 照旧在快等超时后立即执行（restoredAny:false
 *    返回值不变）；fallback 投递（两处投递点与升级回退）同样按 deliveredTo 防重
 *    （防续等补跑与 fallback 并发窗口的重复投递）；
 * 4. 兜底可见层（新增）：续等也到 serviceWaitMaxMs 上限才放弃——对每个剩余候选
 *    逐条结算 `result:'skipped-service-timeout'`（error 注明 sessionController
 *    not ready within serviceWaitMaxMs）写 restarts.ndjson + wake.log，并逐条登记
 *    「上次重启无法恢复」store（lib/unrestored.js，`<stateDir>/unrestored.json`，
 *    cap 100 新在前、同 id 更新不新增）。新路由（enableRestart 门控、围栏同既有）：
 *    `GET /unrestored` 只读列表；`POST /unrestored/restore`（body {sessionId}）
 *    手动恢复——等服务就绪（≤ serviceWaitTimeoutMs）后按候选循环同款恢复该会话
 *    （resumeSession + 投递继续提示；已活跃则不重复投递直接按成功处理），成功从
 *    store 移除该条并写 restore 结算 `result:'resumed'`（error:null）+ wake.log；
 *    失败 `{ok:false,error}`（响应风格照 POST /state）。客户端（lib/client.js）
 *    在设置弹窗「重启」section 待恢复列表之后新增第三块「上次重启无法恢复」列表
 *    （404 = 混合版本窗口静默不显示；按工作区分组、行点击跳转、结算徽标
 *    skipped-service-timeout、行尾/批量手动恢复）。恢复成功（正常路径/续等补跑/
 *    手动恢复）时 store 内同 id 条目自动移除。续等任务防重入（同一 boot 只起一个、
 *    无 running 候选不起），定时器随插件 dispose 清理。
 *
 * 兼容性：本插件只依赖 cordis ctx 提供的 `agents` 服务与事件，不 import 任何
 * `@deepseek-ai/dsh-*` 内部包；sessionController 只在运行时防御式探测
 * （ctx.reflect.get 非阻塞读取；绝不直接读取未在 inject 声明的服务属性——
 * cordis 上下文代理对此必抛）；webServer 经动态 ctx.inject(['webServer'], ...)
 * 等服务激活后再注册路由，不加入插件 inject、不阻塞加载，缺失/异常即降级，
 * 因此可在 DSH Desktop 打包环境（app.asar）下运行，
 * 且其缺失绝不阻断插件加载与既有通知路径。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  attributeShutdown,
  buildNotice,
  classifyCompletedRestoreGate,
  classifyHumanPromptGuard,
  classifyRestoreFallback,
  collectRestoreCandidateIds,
  compactNdjson,
  computeProcessStartAtMs,
  createNoticeMessage,
  detectBasisOf,
  detectRestart,
  filterArchivedCandidates,
  filterCompletedCandidates,
  filterExcludedCandidates,
  mainAncestorSessionId,
  normalizeArchivedSessionIds,
  normalizeRestoreMax,
  parseNdjson,
  partitionSubagentCandidates,
  pickOriginRecord,
  pickRestoreTargets,
  selectRunningAgentIds,
  sessionUnderArchivedLineage,
  shutdownReasonOf,
  unionRestoreCandidateIds,
} from './detect.js';
import { isTurnStartRecord, scanSessionHasHumanPrompt, scanSessionLastTurnState, turnEndKindOf } from './session-scan.js';
import { createWsStatePush } from './ws-state.js';
import {
  MAX_PROACTIVE_RESTORE,
  capProactiveRestore,
  mergeProactiveCandidatePool,
  mergeProactiveRestoreCandidates,
  readProactiveRestore,
  writeProactiveRestore,
} from './proactive-restore.js';
import {
  MAX_UNRESTORED,
  capUnrestored,
  readUnrestored,
  removeUnrestoredIds,
  upsertUnrestored,
  writeUnrestored,
} from './unrestored.js';
import {
  AUTO_RESTART_SCHEMA_VERSION,
  classifyAutoRestartGate,
  mergeAutoRestartArm,
  readAutoRestartArm,
  removeAutoRestartArm,
  writeAutoRestartArm,
} from './auto-restart.js';
import {
  LAUNCH_TOKEN_ENV,
  SOURCE,
  buildOriginRecord,
  clampModelDelayMs,
  createTransitionLatch,
  matchRestartIdentity,
  resolveRestartMode,
  restartDsh,
} from './restart.js';

const name = 'dsh-resume-on-restart';

/** 需要的注入服务：agents（列出/访问 agent）+ tools（模型工具注册，0.27.0 起声明）。
 * 声明 'tools' 让插件 fiber 等 tools 服务激活后再 apply——fresh boot 时插件 fiber
 * 常早于 tools 服务激活，不声明的话 reflect.get('tools') 拿到 undefined，
 * restart_harness / register_restart_recovery 两处注册被静默跳过、工具从不下发。
 * sessionController 不注入，仍运行时防御式探测。 */
const inject = ['agents', 'tools'];

const DEFAULTS = {
  enabled: true,
  stateDir: '.resume-on-restart',
  target: 'primary',
  wakeup: true,
  notice: '',
  // 关闭前"活跃即视为与任务相关"的宽限窗口（ms）
  shutdownGraceMs: 600000,
  // 活动追踪时忽略的会话 id 前缀（如多代理团队的根会话）
  ignoredSessionPrefixes: ['head-'],
  // ---- 0.3.0 新增 ----
  // 最近活跃会话列表长度上限；0 = 不限（0.20.0 起默认，会话永不因窗口挤出而
  // 丢失恢复资格）；正整数 = 旧语义按数量截断
  trackMax: 0,
  // 活动时节流落盘的间隔（ms）：窗口内只写一次盘，用 setTimeout 合并
  persistThrottleMs: 5000,
  // 重启后是否自动恢复重启前活跃的会话
  restoreSessions: true,
  // 最多恢复的会话数；0.5.0 起默认 0 = 不限（遍历全部候选，
  // 仍尊重排除名单与 ignoredSessionPrefixes），正整数 = 按活跃时间新 → 旧取前 N 个
  restoreMax: 0,
  // 恢复（resume 候选）阶段的总预算（ms）；0.5.0 起按候选数平摊（每候选最低 5s），
  // 超出预算的候选记 skipped-budget 而不是静默放弃。0.7.0 起语义收窄为
  // "候选阶段总预算"：等 sessionController 就绪不占它（等待用 serviceWaitTimeoutMs），
  // 预算自服务就绪、进入候选循环前起算
  restoreTimeoutMs: 30000,
  // ---- 0.7.0 新增 ----
  // 进入候选循环前全局等待 sessionController 就绪的独立预算（ms）：服务按依赖序
  // 晚于 agents 激活，等待总量不再按候选数平摊挤占恢复预算；轮询间隔沿用
  // SERVICE_POLL_MS。超时则跳过全部候选直接回退 fallbackWake 降级通知
  // （wake.log 记 service-wait-timeout）
  serviceWaitTimeoutMs: 30000,
  // ---- 0.26.0 新增 ----
  // 快等（serviceWaitTimeoutMs）超时后的后台续等总预算（ms）：续等层按
  // escalationDelayMs 逐级递增间隔轮询 sessionController，总耗时到本预算即放弃
  // （剩余候选逐条结算 skipped-service-timeout 并登记「上次重启无法恢复」store，
  // 可经 POST /unrestored/restore 手动恢复）
  serviceWaitMaxMs: 600000,
  // ---- 0.6.0 新增 ----
  // 投递前是否要求目标会话有过真实人工输入（0.6.0 守卫）：恢复候选与 fallback
  // 回退目标都先经 lib/session-scan.js 扫描会话记录判定，没有（或文件缺失/
  // 解压不支持/扫描失败，fail-closed）就跳过投递并记日志，避免把"自主决定
  // 下一步"的通知灌进空会话导致模型无人指示自主干活
  requireHumanPrompt: true,
  // ---- 0.8.0 新增：重启引擎（lib/restart.js） ----
  // 设置弹窗「重启」按钮 + /restart 命令 + /restart/* 路由的总开关
  enableRestart: true,
  // restart_harness 模型工具开关（名称冲突时无论如何都会自动让位）
  enableModelTool: true,
  // 响应返回后、请求退出前的延迟（ms）：给 HTTP 回包与会话 flush 留时间
  restartDelayMs: 1500,
  // 模型工具 delayMs 参数的上限（有效下限 1000ms，模型不能在自己的 turn
  // 结算前杀掉进程）
  maxDelayMs: 5000,
  // pid1-exit 模式的退出码：--restart=on-failure 策略只在非 0 退出时拉起容器；
  // always/unless-stopped 策略保持默认 0 即可
  pid1ExitCode: 0,
  // ---- 0.15.0 新增：「暂停所有会话」按钮 + POST /pause-all 路由的总开关
  // （归一化风格同 enableRestart：只有显式 false 才关闭）
  enablePauseAll: true,
  // ---- 0.22.0 新增：注册后守门自动重启 ----
  // 武装（register_restart_recovery action=add 成功）后判定「全部会话完成」、
  // 排定触发前再等的 settle 窗口（ms）：窗口内评估翻回「还有会话在干活」则取消
  // 回等待。0/非法按默认值
  autoRestartSettleMs: 10000,
};

/** 回退路径（通知主会话）轮询等待 agent 出现的最长时间（ms），与 0.2.0 保持一致。 */
const FALLBACK_MAX_WAIT_MS = 20000;
const FALLBACK_POLL_MS = 500;

// ---- 0.5.2 新增：sessionController 就绪等待 ----
/** 等待 sessionController 服务就绪的轮询间隔（ms）：服务按依赖序晚于 agents 激活。
 *  0.7.0 起只用于 restoreCandidates 进入候选循环前的全局等待（serviceWaitTimeoutMs）。 */
const SERVICE_POLL_MS = 500;

// ---- 0.26.0 新增：快等超时后的逐级递增续等 ----
/** 续等首轮等待时长（ms）：之后每轮翻倍，直到 SERVICE_ESCALATION_MAX_MS 封顶。 */
const SERVICE_ESCALATION_BASE_MS = 2000;
/** 续等等待时长封顶（ms）：递增到该值后每轮固定等待。 */
const SERVICE_ESCALATION_MAX_MS = 30000;

/**
 * 续等层的逐级递增等待时长（0.26.0，纯函数，导出供单测）：
 * escalationDelayMs(attempt) = min(2000 * 2^(attempt-1), 30000)——
 * attempt=1 → 2000、2 → 4000、3 → 8000、4 → 16000、≥5 → 30000 封顶。
 * attempt 非正数/非法按 1 处理（首轮 2s），绝不抛错。
 * @param {unknown} attempt 续等轮次（1 起计）
 * @returns {number} 本轮等待时长（ms）
 */
export function escalationDelayMs(attempt) {
  const n = Math.floor(Number(attempt));
  const round = Number.isFinite(n) && n >= 1 ? n : 1;
  return Math.min(SERVICE_ESCALATION_BASE_MS * 2 ** (round - 1), SERVICE_ESCALATION_MAX_MS);
}

// ---- 0.4.0 新增：web 会话顶栏开关的状态路由与排除集合 ----
/** 插件自有 API 前缀（比宿主 `/api` 长，不会经过宿主围栏，需自带信任判断）。 */
const HTTP_BASE = '/api/dsh-resume-on-restart';
/** 单个 sessionId 的长度上限（超出直接 400）。 */
const MAX_SESSION_ID_LEN = 200;
/** 排除集合条目上限，超出丢最旧（按 excludedAt 时间）。 */
const MAX_EXCLUSIONS = 1000;
/** POST body 大小上限（字节），防止异常客户端撑内存。 */
const MAX_BODY_BYTES = 64 * 1024;

// ---- 0.5.0 新增：重启日志与全量恢复 ----
/** restarts.ndjson 条目上限，超出丢最旧（重写时顺带剔除损坏行）。 */
const MAX_RESTART_LOG_ENTRIES = 200;
/** 恢复预算平摊时单个候选的最低时长（ms）：预算再紧也保证单候选可用下限。 */
const MIN_RESTORE_CANDIDATE_MS = 5000;

// ---- 0.9.1：subagent routing 所有权拒绝的识别（宿主 dsh-api-session-controller
//      apiSessionSubagentOwnershipError 的稳定文案，resolveAgent 冷会话路径） ----
const SUBAGENT_ROUTING_ERROR = /\bis owned by subagent routing\b/;

// ---- 0.18.0：待恢复列表工作区分组的 id → 工作区路径解析（纯函数，可单测） ----
//
// 背景：/restart/info 候选明细行新增 workspace 字段（会话所属工作区 = 项目目录
// 完整路径，未知为 ''），客户端据此把「待重启恢复会话列表」按工作区分组展示。
//
// 关键事实：会话记录落盘在 `<DSH_HOME>/sessions/<项目目录slug>/[session-]<id>/`，
// 项目目录 slug 形如 `--code-www-my-github-dsh-resume-on-restart--`。slug → 路径
// **不能可靠反解**（路径里的 `-` 与分隔符替换出的 `-` 无法区分）；可靠方向是
// 正解：拿工作区路径清单，逐个编码成 slug 与目录名**精确匹配**。
// 工作区清单来源优先级（sessionWorkspaceLookup 的回退链）：
// 1. 宿主 `ctx.reflect.get('workspaceRegistry').list()`——Workspace 实体的
//    `path`（canonical 目录路径）+ `sessionIds`（header 验证过 canonical cwd 的
//    官方口径；0.15.0 起已用同一 registry 拿 archivedSessionIds）；类型定义见
//    `@deepseek-ai/dsh-workspace/lib/types/index.d.ts`（Workspace.path /
//    Workspace.sessionIds / WorkspaceRegistry.list）。
// 2. 只读解析 `<DSH_HOME>/storages/workspace.json`（unit v2，
//    `tables.workspaces` 为 `{ [wsId]: { path, title?, sessionIds? } }`，实测
//    条目同样带 sessionIds）。**只读，绝不写。**
// 3. 都拿不到 → 全部归「未知工作区」（workspace = ''）。
// 有 sessionIds 时直接构建 id → path 映射（零 fs 扫描）；只有 path 时才枚举
// `<DSH_HOME>/sessions` 目录名做 slug 正解匹配（一次扫描）。

/**
 * 项目目录 slug 编码（自写实现，与宿主 dsh-session-persistence-jsonl 的
 * `projectKey` 等价——插件不 import 任何 `@deepseek-ai/dsh-*` 内部包，出处：
 * `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
 * 的 `projectKey(cwd)`）。规则：
 * - `/` `\` `:` → `-`，且连续分隔符合并为一个 `-`；
 * - `[A-Za-z0-9._-]` 原样；`~` 与其余字符 → `~XXXX`（4 位大写十六进制码元）；
 * - 前导 `-` 全部剥掉（剥空则用 `root`），截断到 251 字符，首尾包 `--`。
 * 该编码**有损**（分隔符与 `-` 混同），只能正解不能反解——调用方必须拿真实
 * 路径编码后与目录名精确比对，绝不按目录名猜路径。
 * @param {unknown} cwd 工作区（项目目录）完整路径
 * @returns {string} slug；非法输入返回 ''
 */
export function projectKeyOf(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * 工作区条目归一化：registry `list()` 数组 / workspace.json 条目集合的统一形状。
 * 只收 `{ path: 非空字符串 }`；sessionIds 是数组才保留（直映射的依据），否则条目
 * 只带 path（走 slug 正解匹配）。非法条目跳过，绝不抛错。
 * @param {unknown} raw 工作区条目集合
 * @returns {Array<{path: string, sessionIds?: unknown[]}>}
 */
export function normalizeWorkspaceEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const path = typeof item.path === 'string' && item.path ? item.path : '';
    if (!path) continue;
    const sessionIds = Array.isArray(item.sessionIds) ? item.sessionIds : null;
    entries.push(sessionIds !== null ? { path, sessionIds } : { path });
  }
  return entries;
}

/**
 * 由工作区条目构建 sessionId → workspacePath 一次扫描映射（纯 fs 只读）：
 * 1. 带 sessionIds 的条目直接映射（registry list() 的 header 验证口径，零扫描；
 *    同 id 多条目以先到为准）；2. 只有 path 的条目把路径编码成 slug 与
 * sessionsRoot 的目录名**精确匹配**，命中目录下的全部会话目录名（主会话
 * `session-<uuid>`、子代理裸 `<uuid>`，目录名即会话 id）映射到该 path。
 * sessionsRoot 不可读/目录缺失 → 该层拿不到映射，不抛错。
 * @param {Array<{path: string, sessionIds?: unknown[]}>} entries normalizeWorkspaceEntries 的输出
 * @param {string} sessionsRoot 会话根目录（`<DSH_HOME>/sessions`）
 * @returns {Map<string, string>}
 */
export function buildWorkspaceIdMap(entries, sessionsRoot) {
  const map = new Map();
  const pathOnly = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.path !== 'string' || !entry.path) continue;
    if (Array.isArray(entry.sessionIds)) {
      for (const id of entry.sessionIds) {
        if (typeof id === 'string' && id && !map.has(id)) map.set(id, entry.path);
      }
    } else {
      pathOnly.push(entry.path);
    }
  }
  if (pathOnly.length > 0 && typeof sessionsRoot === 'string' && sessionsRoot) {
    let projectDirs = null;
    try {
      projectDirs = new Set(
        readdirSync(sessionsRoot, { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => item.name),
      );
    } catch {
      projectDirs = new Set(); // sessionsRoot 不存在/不可读 → slug 层拿不到映射
    }
    for (const path of pathOnly) {
      const slug = projectKeyOf(path);
      if (!slug || !projectDirs.has(slug)) continue;
      let sessionDirs;
      try {
        sessionDirs = readdirSync(join(sessionsRoot, slug), { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => item.name);
      } catch {
        continue; // 项目目录此刻不可读：跳过该工作区，不影响其余
      }
      for (const id of sessionDirs) {
        if (id && !map.has(id)) map.set(id, path);
      }
    }
  }
  return map;
}

/**
 * 只读解析 `<DSH_HOME>/storages/workspace.json`（workspace registry 的落盘 unit：
 * `{ unit: { name: 'workspace', version: 2 }, tables: { workspaces: ... } }`，
 * tables.workspaces 为 `{ [wsId]: { path, title?, sessionIds? } }` 对象，数组形状
 * 一并防御）。**只读参考，绝不写**；文件缺失/损坏/形状不对一律空数组 + warn。
 * @param {string} file workspace.json 绝对路径
 * @returns {Array<{path: string, sessionIds?: unknown[]}>}
 */
function readWorkspaceStoreEntries(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const table = parsed !== null && typeof parsed === 'object'
      ? parsed?.tables?.workspaces
      : null;
    const list = Array.isArray(table)
      ? table
      : (table !== null && typeof table === 'object' && !Array.isArray(table)
        ? Object.values(table)
        : []);
    return normalizeWorkspaceEntries(list);
  } catch (err) {
    console.warn('[resume-on-restart] workspace store read failed:', err);
    return [];
  }
}

/** 解析 DSH_HOME：优先环境变量，回退到用户主目录下的 .dsh。 */
function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 会话 id 是否以给定前缀开头（用于排除不需要追踪的会话）。 */
function ignoredByPrefix(sessionId, prefixes) {
  return (prefixes || []).some((p) => String(sessionId).startsWith(p));
}

/** 配置数值归一化：非正/非法值回退默认值。 */
function toPositiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 记录唤醒/投递/恢复结果到 markerDir/wake.log（追加，一行一条 JSON）。 */
function writeWakeLog(markerDir, deliveredTo, ok, error) {
  try {
    mkdirSync(markerDir, { recursive: true });
    appendFileSync(join(markerDir, 'wake.log'), `${JSON.stringify({
      deliveredTo, ok, error: error ?? null, at: new Date().toISOString(),
    })}\n`, 'utf8');
  } catch (e) {
    console.warn('[resume-on-restart] could not write wake.log:', e);
  }
}

// ---- 0.5.0：重启日志（restarts.ndjson）、停机归因与 origin 扫描 ----

/** 重启日志文件路径：`<stateDir>/restarts.ndjson`。 */
function restartsPathOf(markerDir) {
  return join(markerDir, 'restarts.ndjson');
}

/** 停机归因存根路径：`<stateDir>/pending-shutdown.json`。 */
function pendingShutdownPathOf(markerDir) {
  return join(markerDir, 'pending-shutdown.json');
}

/**
 * 创建 restarts.ndjson 追加写入器：热路径 appendFileSync，一行一条 JSON；
 * 条数超上限时整文件重写为最近 max 条（重写顺带剔除损坏行）。
 * 返回 `(entry) => void`；写失败只告警——日志缺失绝不影响恢复流程本身。
 */
function createRestartLogWriter(file, max = MAX_RESTART_LOG_ENTRIES) {
  // 启动时数一次非空行数（含损坏行，保证裁剪时机正确）；文件不存在 = 首次使用
  let lines = 0;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    lines = 0; // ENOENT 属预期（首次部署）
  }
  return (entry) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
      lines += 1;
      if (lines > max) {
        const compacted = compactNdjson(readFileSync(file, 'utf8'), max);
        writeFileSync(file, compacted.text, 'utf8');
        lines = compacted.kept;
      }
    } catch (e) {
      console.warn('[resume-on-restart] could not append restarts.ndjson:', e);
    }
  };
}

/** 读取 restarts.ndjson 全部条目（跳过损坏行；文件尚不存在 = 空数组属预期）。 */
function readRestarts(file) {
  try {
    return parseNdjson(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn('[resume-on-restart] could not read restarts.ndjson:', e);
    return [];
  }
}

/**
 * 读取并解析 JSON 文件（容忍缺失/损坏）。缺失（ENOENT）属预期不打日志；
 * 存在但损坏才 warn（此时也返回 null，由调用方回退归因）。
 */
function readJsonFileIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[resume-on-restart] could not read ${basename(file)}:`, e);
    return null;
  }
}

/** 尽力删除文件（ENOENT 静默；其余 warn——删除失败只影响下次归因，不阻断启动）。 */
function removeFileBestEffort(file) {
  try {
    unlinkSync(file);
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn(`[resume-on-restart] could not remove ${basename(file)}:`, e);
  }
}

/**
 * 扫描 `~/.dsh/power-restart/*.status.json` 并解析为对象数组。
 * 目录不存在（从未经 power-button 重启过）属预期返回 []；
 * 单个文件缺失/损坏只丢该文件（外部数据源，规划要求容错扫描），不丢其它记录。
 */
function readPowerRestartRecords(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn('[resume-on-restart] could not list power-restart dir:', e);
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.status.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 0.8.0：带上来源文件名——origin.source 据此区分本插件（ror- 前缀）与
        // dsh-power-button 的记录（reason 标签 restart-button vs power-button）
        records.push({ ...parsed, _file: name });
      }
    } catch (e) {
      console.warn(`[resume-on-restart] could not read power-restart status ${name}:`, e);
    }
  }
  return records;
}

/**
 * 从命中的 origin status 记录推导 source（0.8.0）：
 * 记录自带 source 字段（本插件写入）优先；否则按文件名前缀 ror- 判定为本插件；
 * 其余（无前缀、dsh-power-button 旧记录）归 power-button。
 * @param {object} record pickOriginRecord 命中的记录（含 _file）
 * @returns {string}
 */
function originSourceOf(record) {
  if (typeof record?.source === 'string' && record.source) return record.source;
  if (typeof record?._file === 'string' && record._file.startsWith('ror-')) return SOURCE;
  return 'power-button';
}

/**
 * 启动时清理本插件的重启工件（0.8.0，best-effort，照抄 power-button 的 7 天窗）：
 * helper 脚本（内嵌 relaunch argv）与其日志、ror-*.commit.json、power-restart 下的
 * ror-*.status.json。只清理本插件前缀，不碰 power-button 的记录；rolling 的
 * last-restart-status.json 与 restart-identity.json（启动即消费）不在清理范围。
 */
function pruneRestartArtifacts(markerDir, powerRestartDir, maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  const prune = (dir, claim) => {
    let entryNames;
    try {
      entryNames = readdirSync(dir);
    } catch {
      return;
    }
    for (const entryName of entryNames) {
      if (!claim(entryName)) continue;
      const full = join(dir, entryName);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch { /* 单个文件清理失败不影响其余 */ }
    }
  };
  prune(markerDir, (n) =>
    (n.startsWith('restart-helper-') && (n.endsWith('.log') || n.endsWith('.cjs')))
    || (n.startsWith('ror-') && n.endsWith('.commit.json')));
  prune(powerRestartDir, (n) => n.startsWith('ror-') && n.endsWith('.status.json'));
}

// ---- 0.4.0：web 会话顶栏开关的宿主 half ----

/** 排除集合文件路径：`<stateDir>/excluded-sessions.json`。 */
function exclusionsPathOf(markerDir) {
  return join(markerDir, 'excluded-sessions.json');
}

/**
 * 把任意解析结果归一化为 `{ [sessionId]: excludedAtISO }`：
 * 非对象/键为空串/值非字符串的条目一律丢弃；损坏文件按空集合处理。
 * @param {unknown} raw JSON.parse 的结果
 * @returns {Record<string, string>}
 */
function normalizeExclusions(raw) {
  const sessions = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.sessions : null;
  const out = {};
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return out;
  for (const [id, at] of Object.entries(sessions)) {
    if (typeof id === 'string' && id && typeof at === 'string') out[id] = at;
  }
  return out;
}

/** 读取排除集合（容忍文件缺失/损坏，绝不抛错）。 */
function readExclusions(file) {
  try {
    return normalizeExclusions(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/** 写入排除集合（风格与 marker.json 一致：mkdir + writeFileSync；失败只告警）。 */
function writeExclusions(file, sessions) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn('[resume-on-restart] could not write excluded-sessions.json:', e);
    return false;
  }
}

// ---- 0.15.0：暂停集合（pause-all 写入），文件格式与防御风格照抄排除集合 ----

/** 暂停集合文件路径：`<stateDir>/paused-sessions.json`。 */
function pausedSessionsPathOf(markerDir) {
  return join(markerDir, 'paused-sessions.json');
}

/** 主动注册重启恢复集合文件路径（0.19.0）：`<stateDir>/proactive-restore.json`。 */
function proactiveRestorePathOf(markerDir) {
  return join(markerDir, 'proactive-restore.json');
}

/** 自动重启武装文件路径（0.22.0）：`<stateDir>/pending-auto-restart.json`。 */
function pendingAutoRestartPathOf(markerDir) {
  return join(markerDir, 'pending-auto-restart.json');
}

/** 「上次重启无法恢复」集合文件路径（0.26.0）：`<stateDir>/unrestored.json`。 */
function unrestoredPathOf(markerDir) {
  return join(markerDir, 'unrestored.json');
}

/**
 * 把任意解析结果归一化为 `{ [sessionId]: pausedAtISO }`（normalizeExclusions 同款）：
 * 非对象/键为空串/值非字符串的条目一律丢弃；损坏文件按空集合处理。
 * @param {unknown} raw JSON.parse 的结果
 * @returns {Record<string, string>}
 */
function normalizePausedSessions(raw) {
  const sessions = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.sessions : null;
  const out = {};
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return out;
  for (const [id, at] of Object.entries(sessions)) {
    if (typeof id === 'string' && id && typeof at === 'string') out[id] = at;
  }
  return out;
}

/** 读取暂停集合（容忍文件缺失/损坏，绝不抛错；风格同 readExclusions）。 */
function readPausedSessions(file) {
  try {
    return normalizePausedSessions(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/** 写入暂停集合（风格同 writeExclusions；失败只告警——下次暂停会重写）。 */
function writePausedSessions(file, sessions) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn('[resume-on-restart] could not write paused-sessions.json:', e);
    return false;
  }
}

/** 输出 JSON 响应（no-store：开关状态必须实时）。 */
function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/** 读取并解析 JSON body（有大小上限；非法/超限返回 null）。 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/** 渲染请求头值用于日志：去掉控制字符防伪行，并截断。 */
function logSafeHeader(value) {
  if (typeof value !== 'string') return '<absent>';
  return value.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 120);
}

/** cid（客户端标签页随机标识）的清洗上限：与 lib/client.js 的生成立约一致。 */
const WS_CID_MAX_LEN = 64;

/**
 * 从 ws 升级请求解析客户端 cid（0.11.1，lib/client.js 每标签页在页面加载时生成
 * 一次的随机 id）：ws 升级层没有会话概念，拒绝日志靠它区分来源标签页。
 * 缺失/非法/清洗后为空一律按 '<absent>'；只保留 URL 安全字符并截断 ≤64
 * （防御异常超长或特殊字符混进日志行与节流 key）。
 */
function wsUpgradeCid(req) {
  let raw = null;
  try {
    raw = new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('cid');
  } catch {
    return '<absent>';
  }
  if (typeof raw !== 'string') return '<absent>';
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, WS_CID_MAX_LEN);
  return cleaned.length > 0 ? cleaned : '<absent>';
}

/** ws 升级拒绝日志的节流窗口（ms）：同 key 60 秒内只打首条完整明细。 */
const WS_REJECT_LOG_WINDOW_MS = 60_000;
/** 节流表条目上限：伪造海量不同 cid/来源时的内存兜底（超出丢最旧开窗）。 */
const WS_REJECT_LOG_MAX_KEYS = 256;

/**
 * ws 升级拒绝日志（0.11.1 节流去重）：key = `${reason}|${remoteAddress}|${cid}`。
 * 修复前客户端按既定设计无限重试（1s~5s 退避）× 服务端每次拒绝一行日志 =
 * 每 1~5 秒刷一行、会话恢复完成后仍持续刷屏。现同 key 首次输出完整明细；
 * 60 秒窗口内静默（只累计抑制数）；窗口后的下一次触发补一行并带累计抑制数
 * （如 `(suppressed 12 in last 60s)`）后重新开窗。每条输出（首条与补报）都带
 * 区分明细：reason、来源 socket 地址、Host、Origin（头值一律过 logSafeHeader
 * 防伪行）、cid；缺失项显示 '<absent>'——去重不丢「谁被拒」的信息。
 */
function createWsUpgradeRejectLogger() {
  /** key -> { lastAt: epoch ms, suppressed: 窗口内被静默的条数 } */
  const seen = new Map();
  return (req, reason, cid) => {
    const remote = logSafeHeader(req.socket?.remoteAddress);
    const host = logSafeHeader(req.headers?.host);
    const origin = logSafeHeader(req.headers?.origin);
    const key = `${reason}|${remote}|${cid}`;
    const now = Date.now();
    const entry = seen.get(key);
    if (entry && now - entry.lastAt < WS_REJECT_LOG_WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    const suffix = entry && entry.suppressed > 0
      ? ` (suppressed ${entry.suppressed} in last 60s)`
      : '';
    if (entry) seen.delete(key); // 重开窗并维持近似 LRU（Map 保持插入序）
    seen.set(key, { lastAt: now, suppressed: 0 });
    if (seen.size > WS_REJECT_LOG_MAX_KEYS) seen.delete(seen.keys().next().value);
    console.warn(`[resume-on-restart] ws upgrade rejected: ${reason}${suffix} remote=${remote} host=${host} origin=${origin} cid=${cid}`);
  };
}

/**
 * ws/HTTP 围栏使用的宿主可信名单，按优先级读取（0.11.1 起对齐宿主生效名单）：
 * 1. 优先 `ctx.get('connection').trustedHosts`——宿主围栏 requestRejection 的
 *    Host/Origin 检查实际使用的那份生效名单（dsh-client-connection
 *    HostConnectionService 公开字段），由 dsh-web-app 启动时经 resolveLanTrust
 *    合成：webServer 绑 0.0.0.0 时自动并入本机全部非内部 IPv4（局域网/容器部署下
 *    即 172.x 等地址）+ CLI --trusted-host。不能只读 webStartup：那里的
 *    trustedHosts 仅含 CLI 声明参数、缺自动派生名单，LAN 部署未配 --trusted-host
 *    时它为空数组 → 插件围栏比宿主严、页面从局域网 IP 打开时 ws 永远
 *    host-untrusted（客户端按既定设计无限重试，拒绝日志节流后仍每分钟一条）；
 *    GUI 能从该 IP 正常打开即证明该地址在宿主生效名单内，插件对齐它才与宿主
 *    裁决一致。
 * 2. 回退 `ctx.get('webStartup').trustedHosts`（CLI --trusted-host 声明）——宿主
 *    未提供 connection 服务或其无该字段时，围栏仍不松于 CLI 声明。
 * 3. 都没有则空数组。防御式取值：仅收字符串数组元素，脏值/缺失一律剔除。
 */
function declaredTrustedHosts(ctx) {
  const pickStrings = (list) => (Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : []);
  const effective = pickStrings(ctx?.get?.('connection')?.trustedHosts);
  if (effective.length > 0) return effective;
  return pickStrings(ctx?.get?.('webStartup')?.trustedHosts);
}

/** 本服务监听地址：仅当宿主明确绑定 127.0.0.1 时才认为不存在跨机来源。
 *  接收动态注入回调拿到的服务对象，绝不直接读 ctx（避免注入管控抛错）。 */
function boundHostOf(webServer) {
  return webServer?.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
}

/**
 * 宿主连接围栏（认证等）。本插件路由比宿主 `/api` 长、不会自动经过宿主围栏，
 * 因此显式借用宿主 `connection.requestRejection` 的裁决：
 * 返回 401/403（拒绝原因）、undefined（放行）或 null（宿主未提供该服务）。
 */
function connectionRejection(ctx, req) {
  const connection = ctx?.get?.('connection');
  if (typeof connection?.requestRejection !== 'function') return null;
  try {
    const rejection = connection.requestRejection({ headers: req.headers });
    if (rejection === 401 || rejection === 403) return rejection;
    return rejection === undefined ? undefined : null;
  } catch {
    return null;
  }
}

/** 本围栏接受的 loopback 主机名（与 DSH 自身的窄集合一致）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * 最小浏览器信任围栏（范式复制自 dsh-power-button，规则与 DSH 官方一致）：
 * Host 必须是 loopback 或宿主 --trusted-host 声明的 authority（防 DNS rebinding）；
 * 全接口绑定时要求来源 socket 在本机；拒绝 sec-fetch-site: cross-site；
 * 带 Origin 时必须与 Host 同源。返回 `{ trusted }` 或 `{ trusted: false, reason }`。
 */
function explainStateRequestTrust(req, trustedHosts = [], boundHost = '0.0.0.0') {
  const { host, origin, 'sec-fetch-site': secFetchSite } = req.headers ?? {};
  if (typeof host !== 'string') return { trusted: false, reason: 'host-missing' };
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return { trusted: false, reason: 'host-unparseable' };
  }
  const loopbackHost = LOOPBACK_HOSTNAMES.has(hostUrl.hostname);
  if (!loopbackHost && !matchesTrustedAuthority(hostUrl, trustedHosts)) {
    return { trusted: false, reason: 'host-untrusted' };
  }
  if (loopbackHost && boundHost === '0.0.0.0') {
    const address = req.socket?.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
      return { trusted: false, reason: 'socket-not-loopback' };
    }
  }
  if (typeof secFetchSite === 'string' && secFetchSite === 'cross-site') {
    return { trusted: false, reason: 'cross-site' };
  }
  if (origin === undefined) return { trusted: true };
  if (typeof origin !== 'string' || origin === 'null') return { trusted: false, reason: 'origin-null' };
  try {
    return new URL(origin).host === hostUrl.host ? { trusted: true } : { trusted: false, reason: 'origin-mismatch' };
  } catch {
    return { trusted: false, reason: 'origin-mismatch' };
  }
}

/** Host authority 是否命中宿主声明的可信项（带端口精确匹配，不带端口匹配主机名）。 */
function matchesTrustedAuthority(hostUrl, trustedHosts) {
  for (const entry of trustedHosts) {
    let entryUrl;
    try {
      entryUrl = new URL(`http://${entry}`);
    } catch {
      continue;
    }
    if (entryUrl.port !== '' ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname) return true;
  }
  return false;
}

/** ws 升级的 Host 可信判断：按主机名匹配可信条目（ws 端口是随机值，不能按带端口 authority 精确匹配）。 */
function matchesTrustedHostname(hostUrl, trustedHosts) {
  for (const entry of trustedHosts) {
    let entryUrl;
    try {
      entryUrl = new URL(`http://${entry}`);
    } catch {
      continue;
    }
    if (entryUrl.hostname === hostUrl.hostname) return true;
  }
  return false;
}

/**
 * ws 升级信任围栏（0.11.0）：explainStateRequestTrust 的 ws 拓扑适配版。
 * 0.12.0 起 ws 与页面同源同端口（宿主主端口 /api/dsh-resume-on-restart/ws），
 * 正常握手会先命中宿主围栏放行的快速分支（verifyWsUpgrade 的 undefined 路径），
 * 本函数保留为 403/宿主服务缺失时的回退防御，不再有任何常规命中路径；
 * 下述适配是随机端口时代（ws 监听独立随机端口，跨端口握手必上报
 * `sec-fetch-site: cross-site`、Origin 是「页面来源」而非 ws 自身 Host authority）
 * 的口径，规则本身不变：
 * - Host 主机名仍必须是 loopback 或宿主 `--trusted-host` 声明（按主机名匹配，
 *   防 DNS rebinding；全接口绑定时仍要求来源 socket 在本机）；
 * - `sec-fetch-site` 不再作为 ws 的否决项，同侧防护改由「随机 token（ws-state 内
 *   timing-safe 校验，本函数不重复做）+ Origin 必须是页面来源」承担：
 *   Origin 缺失按非浏览器客户端放行（与 HTTP 围栏一致，仍需 token）；
 *   Origin 存在时必须与 ws 同主机名、且端口等于宿主 webServer 端口。
 * 0.11.1：`inContainer`（apply() 里 stat 一次 '/.dockerenv'）为 true 时跳过
 * socket-not-loopback 检查——docker 部署经端口发布 NAT 进来的合法浏览器，其来源
 * socket 必非 127.0.0.1（是 docker 网桥地址），保留该条会把所有合法标签页拒之
 * 门外；跳过后仍有三道闸：Host 主机名信任（loopback 或宿主生效可信名单——
 * declaredTrustedHosts 优先读 connection 服务的生效名单、CLI --trusted-host 仅回退）、
 * Origin 必须与 ws 同主机名且端口等于页面端口、随机 token timing-safe 校验
 * （ws-state 内 handleUpgrade，见 lib/ws-state.js）。
 * 返回 `{ trusted }` 或 `{ trusted: false, reason }`。
 */
function explainWsUpgradeTrust(req, trustedHosts = [], boundHost = '0.0.0.0', pagePort = null, inContainer = false) {
  const { host, origin } = req.headers ?? {};
  if (typeof host !== 'string') return { trusted: false, reason: 'host-missing' };
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return { trusted: false, reason: 'host-unparseable' };
  }
  const loopbackHost = LOOPBACK_HOSTNAMES.has(hostUrl.hostname);
  if (!loopbackHost && !matchesTrustedHostname(hostUrl, trustedHosts)) {
    return { trusted: false, reason: 'host-untrusted' };
  }
  // 容器 NAT 适配（0.11.1）：容器内跳过 socket-not-loopback——端口发布（-p 3080:3080）
  // 的 NAT 改写使合法浏览器来源必非 loopback，非容器环境维持原检查不变。
  if (loopbackHost && boundHost === '0.0.0.0' && !inContainer) {
    const address = req.socket?.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
      return { trusted: false, reason: 'socket-not-loopback' };
    }
  }
  if (origin === undefined) return { trusted: true };
  if (typeof origin !== 'string' || origin === 'null') return { trusted: false, reason: 'origin-null' };
  try {
    const originUrl = new URL(origin);
    const portOk = pagePort === null || originUrl.port === String(pagePort);
    return originUrl.hostname === hostUrl.hostname && portOk
      ? { trusted: true }
      : { trusted: false, reason: 'origin-mismatch' };
  } catch {
    return { trusted: false, reason: 'origin-mismatch' };
  }
}

function apply(ctx, cfg = {}) {
  const config = { ...DEFAULTS, ...cfg };
  if (!config.enabled) return;

  // 0.20.0：trackMax 与 restoreMax 同一归一化口径（normalizeRestoreMax）——
  // 缺省/0/非法 → 不限（MAX_SAFE_INTEGER，传 pickRestoreTargets 事实全量）；
  // 正整数 → floor 后按数量截断（旧语义，显式配置仍生效）
  const trackMax = normalizeRestoreMax(config.trackMax);
  const persistThrottleMs = toPositiveInt(config.persistThrottleMs, DEFAULTS.persistThrottleMs);
  // 0.5.0：restoreMax=0（默认）= 不限；正整数 = 上限（normalizeRestoreMax 保证 pickRestoreTargets 可用）
  const restoreMax = normalizeRestoreMax(config.restoreMax);
  const restoreTimeoutMs = toPositiveInt(config.restoreTimeoutMs, DEFAULTS.restoreTimeoutMs);
  // 0.7.0：等服务就绪的独立预算（与 restoreTimeoutMs 互不挤占）
  const serviceWaitTimeoutMs = toPositiveInt(config.serviceWaitTimeoutMs, DEFAULTS.serviceWaitTimeoutMs);
  // 0.26.0：快等超时后的续等总预算（读法照 serviceWaitTimeoutMs 同款 toPositiveInt）
  const serviceWaitMaxMs = toPositiveInt(config.serviceWaitMaxMs, DEFAULTS.serviceWaitMaxMs);
  // 0.6.0：requireHumanPrompt 布尔归一化——只有显式 false 才关闭守卫，
  // 其余（含缺失/脏值）一律开启（fail-closed 方向）
  const requireHumanPrompt = config.requireHumanPrompt !== false;
  // 0.8.0：重启引擎配置归一化——布尔开关只有显式 false 才关闭；
  // delay 皆为正整数回退默认；pid1ExitCode 取 0-255 整数，非法回退 0
  const enableRestart = config.enableRestart !== false;
  // 0.15.0：暂停所有会话开关——归一化风格同 enableRestart（只有显式 false 才关闭）
  const enablePauseAll = config.enablePauseAll !== false;
  const enableModelTool = config.enableModelTool !== false;
  const restartDelayMs = toPositiveInt(config.restartDelayMs, DEFAULTS.restartDelayMs);
  const maxDelayMs = toPositiveInt(config.maxDelayMs, DEFAULTS.maxDelayMs);
  const pid1ExitCodeRaw = Math.floor(Number(config.pid1ExitCode));
  const pid1ExitCode = Number.isFinite(pid1ExitCodeRaw) && pid1ExitCodeRaw >= 0 && pid1ExitCodeRaw <= 255
    ? pid1ExitCodeRaw
    : DEFAULTS.pid1ExitCode;
  // 0.22.0：注册后守门自动重启的 settle 窗口（全部会话完成 → 再等这么多毫秒
  // 才真正触发重启；窗口内评估翻回「还有会话在干活」则取消回等待）
  const autoRestartSettleMs = toPositiveInt(config.autoRestartSettleMs, DEFAULTS.autoRestartSettleMs);

  // 当前进程的启动时刻（epoch 毫秒）：写入 marker 供下次启动对比。
  // Docker 容器内 DSH 恒为 PID 1，pid 无法区分两次运行，只能靠它判断重启。
  const startAtMs = computeProcessStartAtMs();

  const dshHome = resolveDshHome();
  const markerDir = join(dshHome, config.stateDir);
  const markerPath = join(markerDir, 'marker.json');
  // 0.4.0：用户排除集合（web 顶栏开关写入），重启后仍生效
  const exclusionsFile = exclusionsPathOf(markerDir);
  // 0.5.0：重启日志与停机归因存根
  const restartsFile = restartsPathOf(markerDir);
  const pendingShutdownFile = pendingShutdownPathOf(markerDir);
  // 0.15.0：暂停集合（pause-all 写入）。启动读入内存 Map（缺失/损坏 = 空）；
  // 只有 wasRestart 的开机恢复流程才"消费"它（并入恢复候选后删文件 + 清内存，
  // 只发生一次），非重启启动只读入不删
  const pausedSessionsFile = pausedSessionsPathOf(markerDir);
  const pausedSessions = new Map(Object.entries(readPausedSessions(pausedSessionsFile)));
  // 0.19.0：主动注册重启恢复集合（register_restart_recovery 模型工具写入）。
  // 启动读入内存 Map（缺失/损坏 = 空）；**不随开机一次性消费**——只移除已成功
  // 恢复的会话（失败保留下次重启再试），跨重启持久。上限 100 条超出丢最旧。
  const proactiveRestoreFile = proactiveRestorePathOf(markerDir);
  const proactiveRestore = new Map(Object.entries(readProactiveRestore(proactiveRestoreFile)));
  // 0.26.0：「上次重启无法恢复」集合（续等放弃时逐条登记、恢复成功自动移除；
  // 读写纯函数在 lib/unrestored.js，登记= upsert、移除= 精确 id 过滤）
  const unrestoredFile = unrestoredPathOf(markerDir);
  // 0.22.0：注册后守门自动重启的武装文件（工具 add 成功写入、开机一次性消费、
  // remove 且无注册时删除；读写纯函数在 lib/auto-restart.js）
  const autoRestartFile = pendingAutoRestartPathOf(markerDir);
  const powerRestartDir = join(dshHome, 'power-restart');
  // 重启日志追加写入器（boot/restore 记录共用；上限 200 条超出丢最旧）
  const appendRestartLog = createRestartLogWriter(restartsFile);

  // 1. 读取上次 marker（容忍缺失/损坏）
  let marker = null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'));
    // lastBootAt/pid 必须存在；startAt 是 0.2.0 新增的可选字段，
    // 旧版 marker 没有它时不丢弃整个 marker（detectRestart 会回退用 lastBootAt 对比）
    if (raw && typeof raw.lastBootAt === 'string' && typeof raw.pid === 'number') {
      marker = raw;
    }
  } catch {
    marker = null; // 首次启动或损坏
  }

  const bootAt = new Date().toISOString();
  const { wasRestart, downtimeMs } = detectRestart(marker, Date.now(), process.pid, startAtMs);
  const prevBootAt = marker?.lastBootAt ?? null;
  // 上次启动时刻（epoch ms）：origin 匹配时间窗的下界；缺失/不可解析 → null（视为无下界）
  const prevBootMs = typeof prevBootAt === 'string' && prevBootAt ? Date.parse(prevBootAt) : null;
  const lastSessionId = marker?.lastSessionId ?? null;
  const lastActiveAt = marker?.lastActiveAt ?? null;

  // ---- 0.22.0：自动重启武装文件的一次性消费（marker 读取后立刻做） ----
  // pending-auto-restart.json 非空 = 上个进程武装过「全部会话完成后自动重启」，
  // 本次启动就是那次重启（或其后任何一次启动）的产物：归因打点后立刻删除，
  // 守门器不在新进程自动续期（会话恢复由 proactive-restore.json 承载、开机恢复
  // 流程照常消费）——不消费会把「等会话完成 → 重启」变成每次开机再重启的死循环。
  const consumedAutoRestartArm = readAutoRestartArm(autoRestartFile);
  if (consumedAutoRestartArm) {
    console.log(`[resume-on-restart] pending auto-restart consumed (one-shot): armedAt=${consumedAutoRestartArm.armedAt}, by=${consumedAutoRestartArm.by} - the armed restart has fired; registrations still restore via boot flow`);
    removeAutoRestartArm(autoRestartFile);
  }

  // 2. 活动追踪：内存维护最近活跃列表 [{id, at(epoch ms), running}]，最新在前。
  //    启动时用上次 marker 播种（兼容 ISO/毫秒时间；0.10.0 起 pickRestoreTargets
  //    不再按 running 过滤——留下的就是上次活跃窗口内的全部条目，含手动停止/
  //    正常结束的会话），延续旧上下文，避免启动即用空列表覆盖掉上一进程留下的记录。
  //    播种条目沿用 marker 里最后已知的 running 标记（0.10.0 起 running 只是
  //    记录性字段，不再参与候选过滤，如实保留即可）；marker 没有该信息的条目
  //    （纯字符串旧格式 / legacy lastSessionId 路径）按 true 回填，此后该标记
  //    只由 agent/status 事件更新。
  const seedRunningOf = (() => {
    const lastKnown = new Map();
    if (marker && Array.isArray(marker.recentSessions)) {
      for (const entry of marker.recentSessions) {
        if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
          lastKnown.set(entry.id, entry.running === true);
        }
      }
    }
    return (id) => lastKnown.get(id) ?? true;
  })();
  // 0.17.0：记录性字段 lastTurnEndKind 的播种（marker 里有就沿用，仅供观测；
  // 恢复过滤绝不依赖它——崩溃会丢，旧 marker 无该字段完全兼容）
  const seedLastTurnEndKindOf = (() => {
    const lastKnown = new Map();
    if (marker && Array.isArray(marker.recentSessions)) {
      for (const entry of marker.recentSessions) {
        if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id
          && typeof entry.lastTurnEndKind === 'string' && entry.lastTurnEndKind) {
          lastKnown.set(entry.id, entry.lastTurnEndKind);
        }
      }
    }
    return (id) => lastKnown.get(id) ?? null;
  })();
  const recentSessions = pickRestoreTargets(marker, trackMax)
    .map((e) => {
      const item = { ...e, running: seedRunningOf(e.id) };
      const lastKind = seedLastTurnEndKindOf(e.id);
      if (lastKind) item.lastTurnEndKind = lastKind;
      return item;
    });

  // 3. 持久化状态：启动写一次 + 活动时节流写 + 关闭兜底写
  const writeState = (extra = {}) => {
    try {
      mkdirSync(markerDir, { recursive: true });
      const latest = recentSessions[0] ?? null;
      const doc = {
        lastBootAt: bootAt,
        pid: process.pid,
        // 当前进程启动时刻（epoch 毫秒）：容器内 pid 恒为 1 时靠它判定重启
        startAt: startAtMs,
        // 兼容旧字段语义：列表第一个即"最近活跃会话"
        lastSessionId: latest?.id ?? marker?.lastSessionId ?? null,
        lastActiveAt: latest && latest.at > 0
          ? new Date(latest.at).toISOString()
          : marker?.lastActiveAt ?? null,
        // 0.3.0 新增：最近活跃会话列表（最新在前；at 为 ISO，未知为 ''）。
        // 0.4.0 新增：running 记录条目最后已知是否运行中（boolean；缺失写 false）；
        // 0.10.0 起 running 只是记录性字段（供重启日志与旧版本兼容），
        // 不再作为恢复候选的过滤条件。
        // 0.17.0 新增：lastTurnEndKind 记录条目最后一条真实 turn/end 的 kind
        //（由 session/event 监听维护，仅供观测；恢复过滤绝不依赖它，崩溃会丢；
        // 恢复过滤的判据是重启后的日志扫描）。缺失时省略字段，旧版完全兼容。
        recentSessions: recentSessions.map((e) => {
          const item = {
            id: e.id,
            at: e.at > 0 ? new Date(e.at).toISOString() : '',
            running: e.running === true,
          };
          if (typeof e.lastTurnEndKind === 'string' && e.lastTurnEndKind) {
            item.lastTurnEndKind = e.lastTurnEndKind;
          }
          return item;
        }),
        ...extra,
      };
      writeFileSync(markerPath, JSON.stringify(doc, null, 2));
    } catch (err) {
      console.warn('[resume-on-restart] could not write marker:', err);
    }
  };
  writeState();

  // 活动节流落盘：窗口内的多次活动合并为一次写盘，不再只靠 SIGTERM
  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeState();
    }, persistThrottleMs);
    // 不因待落盘的定时器阻止进程退出
    persistTimer.unref?.();
  };

  // ---- 0.17.0：正常结束门的判定源与运行期候选显示口径 ----

  // 会话记录根目录（<DSH_HOME>/sessions）：正常结束门扫描（boot 恢复候选与
  // 运行期 completedSessions 播种）与 0.6.0 human-prompt 守卫共用。
  const sessionsRoot = join(dshHome, 'sessions');

  // 最后已知 turn 状态的 memoized 扫描：同一会话每进程只扫一次（重启后日志已
  // 完整、不会再变；运行期新变化由 session/event 事件维护）。boot 恢复门、
  // fallbackWake 门与 completedSessions 播种共用同一份结果，避免重复解压。
  const lastTurnStateCache = new Map();
  const lastTurnStateOf = (id) => {
    if (!lastTurnStateCache.has(id)) {
      lastTurnStateCache.set(id, scanSessionLastTurnState(sessionsRoot, id));
    }
    return lastTurnStateCache.get(id);
  };

  // 运行期「正常结束」集合：/state、ws 快照与 /restart/info 的候选显示口径
  // （只含"最后已知状态不是正常结束"的会话）。播种 = 开机对播种的 recentSessions
  // 逐个扫描一次（memoized，boot 恢复门复用同一结果，无重复解压）；运行期由
  // session/event（turn/end completed 加入、turn/start 与其他 kind 移出）与
  // agent/status running（移出）维护。boot 记录 runningSessions 不受它影响
  // （重启前快照如实记录，不过滤）。
  const completedSessions = new Set();
  for (const entry of recentSessions) {
    const verdict = classifyCompletedRestoreGate(lastTurnStateOf(entry.id));
    if (!verdict.restore) completedSessions.add(entry.id);
  }

  /** 候选显示口径（GET /state、ws 快照、/restart/info 共用）：最近活跃列表
   *  （0.20.0 起默认不限量）∪ 暂停集合（0.15.0），0.17.0 起再剔除最后已知
   *  状态为正常结束的会话。 */
  const visibleRestoreCandidateIds = () => unionRestoreCandidateIds(
    [...collectRestoreCandidateIds(recentSessions)],
    [...pausedSessions.keys()],
  ).filter((id) => !completedSessions.has(id));

  // ---- 0.11.0：ws 状态推送（lib/ws-state.js）的广播入口与快照口径 ----
  // 顶栏开关的候选/排除状态改由 websocket 快照广播（取代客户端 15 秒轮询）。
  // ws 服务本身随 webServer 激活（见第 5 节 inject），激活前/降级时广播入口必须
  // 无害空转，故先以空实现占位，服务启动后替换为真实广播；高频活动事件由
  // ws-state 内部做 300ms 首发立即 + 窗口合并节流，快照内容没变不重发。
  let wsPush = null;
  /** 广播一帧全量快照（POST /state 成功与 recordActivity 都调它）。 */
  const pushStateSnapshot = () => {
    wsPush?.broadcast();
  };

  /** ws 快照：与 GET /state 全量口径一致（候选 = visibleRestoreCandidateIds，
   *  排除 = 全集）。 */
  const buildWsSnapshot = () => ({
    restoreCandidates: Object.fromEntries(
      visibleRestoreCandidateIds().map((id) => [id, true]),
    ),
    excluded: readExclusions(exclusionsFile),
  });

  /**
   * 记录活动并维护最近活跃列表（同 id 去重挪到最前；trackMax 正整数时按数量
   * 截断，0.20.0 起默认 0 = 不限、条目只增不减）。
   * agent/status 事件额外传 status：'running' → running:true、'idle' → running:false
   * （仅作为"最后已知是否运行中"的记录写入 marker，供重启日志与旧版本兼容）；
   * 其余事件不带 status，沿用同 id 条目已有值；新条目缺省 false。
   * 0.10.0 起 running 不再影响恢复候选——手动停止（idle）的会话重启后同样恢复。
   */
  const recordActivity = (agent, status) => {
    const sid = String(agent?.id ?? '');
    if (!sid || ignoredByPrefix(sid, config.ignoredSessionPrefixes)) return;
    const idx = recentSessions.findIndex((e) => e.id === sid);
    const prev = idx >= 0 ? recentSessions[idx] : null;
    if (idx >= 0) recentSessions.splice(idx, 1);
    const running = status === 'running' ? true : status === 'idle' ? false : prev?.running === true;
    // 0.17.0：lastTurnEndKind 是条目的记录性字段，活动挪位时沿用旧值（不因
    // 重建条目而丢）；由 session/event 监听按 turn/end 事件更新
    const entry = { id: sid, at: Date.now(), running };
    if (prev && typeof prev.lastTurnEndKind === 'string' && prev.lastTurnEndKind) {
      entry.lastTurnEndKind = prev.lastTurnEndKind;
    }
    recentSessions.unshift(entry);
    if (recentSessions.length > trackMax) recentSessions.length = trackMax;
    // 0.17.0：会话重新运行（turn 开着）= 最后已知状态不再是"正常结束"，
    // 移出运行期 completedSessions（候选显示口径随下方广播刷新）
    if (status === 'running') completedSessions.delete(sid);
    schedulePersist();
    // 0.11.0：候选集可能变化 → 广播一帧 ws 快照（id 集合没变时由 ws-state 的
    // 内容去重跳过，不产生实际帧）
    pushStateSnapshot();
  };

  // 正常关闭（SIGTERM/SIGINT）时兜底 flush 最近活跃列表，供下次重启参考
  const flushOnShutdown = (signal) => {
    const at = new Date().toISOString();
    try {
      // 取消尚未触发的节流定时器，同步写盘后重发信号走原有退出流程
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // when 字段保留：0.5.0 前版本的停机归因回退依据（marker 里读到即视为 signal）
      writeState({ when: at });
    } catch (e) {
      console.warn('[resume-on-restart] shutdown flush failed:', e);
    }
    // 0.5.0：停机归因存根——下次开机读取归因后删除，用于区分 signal 与 crash。
    // 独立于 marker：marker 在下次启动即被覆盖，when 字段不足以长期承载归因。
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(pendingShutdownFile, `${JSON.stringify({ signal, at }, null, 2)}\n`, 'utf8');
    } catch (e) {
      console.warn('[resume-on-restart] could not write pending-shutdown.json:', e);
    }
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    process.kill(process.pid, signal);
  };
  const onSigterm = () => flushOnShutdown('SIGTERM');
  const onSigint = () => flushOnShutdown('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  // ---- 0.8.0：重启引擎（lib/restart.js）的启动接线 ----

  // 3.1 本进程 instanceId（每次启动随机）：/restart/health 的身份锚点。helper
  //     等新进程就绪、客户端判断"确实换了个实例"都靠它必须**变更**。
  const instanceId = randomUUID();
  // 3.2 重启模式：PID=1（容器标准形态）走 pid1-exit；否则走 detach helper。
  const restartMode = resolveRestartMode();
  // 3.2.1 容器环境判定（0.11.1，进程内只 stat 一次）：容器部署经端口发布 NAT
  //      进来的合法浏览器来源 socket 必非 loopback——ws 升级围栏的
  //      socket-not-loopback 检查据此跳过；/restart/info 的 isContainer 同源复用。
  const inContainer = existsSync('/.dockerenv');
  // 3.3 防重入闩：重启会终结本进程，命令/按钮/工具并发触发只允许第一个生效。
  const restartLatch = createTransitionLatch();
  // 3.3.1（0.15.0）暂停所有会话的防重入闩：与 restartLatch 双向互斥（/pause-all 与
  //     /restart 互相检查对方闩），防止边暂停边重启的中间态。
  const pauseLatch = createTransitionLatch();

  // 3.4 启动即消费重启身份记录：读 env 启动令牌（读后即删，不泄漏给 MCP 子进程），
  //     与 restart-identity.json 匹配才认领"本进程就是那次重启的产物"。
  //     记录无论是否认领都删除：身份只属于一次启动。认领结果供 /restart/health
  //     暴露（helper 就绪门控 + 客户端「已重启」toast），不参与 detectRestart。
  const restartIdentityFile = join(markerDir, 'restart-identity.json');
  const launchToken = process.env[LAUNCH_TOKEN_ENV];
  delete process.env[LAUNCH_TOKEN_ENV];
  const restartIdentity = matchRestartIdentity(
    readJsonFileIfExists(restartIdentityFile),
    launchToken,
    instanceId,
  );
  removeFileBestEffort(restartIdentityFile);
  // toast 标记与身份分离：ack 只清标记，身份保留整个进程生命周期
  let restartNoticePending = restartIdentity !== null;

  // 3.5 启动 housekeeping：清理 7 天前的重启工件（helper 脚本/日志、commit、
  //     本插件的 ror-*.status.json），不碰 power-button 的记录
  pruneRestartArtifacts(markerDir, powerRestartDir);

  // 3.6 端口解析：优先 webServer 实际绑定地址，回退 --port argv，再回退 3080
  //    （防御式 reflect 探测，服务缺失/形状变化一律回退，绝不抛错）。
  const resolveWebPort = () => {
    try {
      const bound = ctx.reflect?.get?.('webServer')?.server?.address?.();
      if (bound && typeof bound === 'object' && typeof bound.port === 'number' && bound.port > 0) return bound.port;
    } catch { /* 服务缺失属预期 */ }
    const argv = process.argv;
    const portIndex = argv.indexOf('--port');
    if (portIndex >= 0 && portIndex + 1 < argv.length) {
      const port = Number(argv[portIndex + 1]);
      if (Number.isFinite(port) && port > 0) return port;
    }
    return 3080;
  };

  // 3.7 退出前的持久化兜底（两种重启模式共用，由 restartDsh 在安排退出前调用）：
  //     同步固化检测 marker（recentSessions/running 标记是恢复流程的唯一数据源）+
  //     写停机归因存根（合成 signal 'restart-exit'：区分 crash，又诚实于"主动退出"）。
  const writeRestartShutdownStub = () => {
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(pendingShutdownFile, `${JSON.stringify({ signal: 'restart-exit', at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    } catch (e) {
      console.warn('[resume-on-restart] could not write pending-shutdown.json:', e);
    }
  };
  const flushMarkerState = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    writeState();
  };

  // 3.8 重启路径 helper 脚本与日志（每次重启唯一名，7 天后由 housekeeping 清理）
  const restartHelperFile = join(markerDir, `restart-helper-${process.pid}-${Date.now()}.cjs`);
  const restartHelperLogFile = join(markerDir, `restart-helper-${process.pid}.log`);
  const restartRelaunchLog = join(markerDir, 'restart-relaunch.log');
  const lastRestartStatusFile = join(markerDir, 'last-restart-status.json');

  /**
   * 组装一次重启的 deps（origin 由入口决定：按钮 settings-ui / 命令 command /
   * 模型工具 model-tool；GUI 点击没有因果会话，sessionId 为空）。
   * @param {{kind: string, sessionId?: string}|undefined} origin
   * @param {number|undefined} [delayMsOverride] 模型工具的延迟参数（已 clamp）
   */
  const buildRestartDeps = (origin, delayMsOverride) => ({
    mode: restartMode,
    delayMs: delayMsOverride ?? restartDelayMs,
    exitCode: pid1ExitCode,
    origin,
    oldInstanceId: instanceId,
    port: resolveWebPort(),
    paths: {
      stateDir: markerDir,
      powerRestartDir,
      helperFile: restartHelperFile,
      logFile: restartHelperLogFile,
      lastStatusFile: lastRestartStatusFile,
      identityFile: restartIdentityFile,
      pendingShutdownFile,
      serverLog: restartRelaunchLog,
      sessionsRoot: join(dshHome, 'sessions'),
      healthPath: `${HTTP_BASE}/restart/health`,
    },
    flushMarkerState,
    writePendingShutdown: writeRestartShutdownStub,
  });

  /** 幂等执行一次重启；返回统一结果（HTTP/命令/工具三个入口共用）。 */
  const performRestart = async (origin, delayMsOverride) => {
    return restartDsh(ctx, buildRestartDeps(origin, delayMsOverride));
  };

  // 3.9 /restart/health 的响应体：身份块（helper 就绪门控依据）与 toast 标记
  const appExitState = () => {
    try {
      return typeof ctx?.get?.('appExit') === 'function' ? 'available' : 'missing';
    } catch {
      return 'missing';
    }
  };
  const restartHealthPayload = () => {
    const body = {
      ok: true,
      instanceId,
      pid: process.pid,
      mode: restartMode,
      lifecycle: restartLatch.current() ?? 'ready',
      appExit: appExitState(),
    };
    if (restartIdentity !== null) {
      body.restart = {
        restartId: restartIdentity.restartId,
        fromInstanceId: restartIdentity.fromInstanceId,
      };
      if (restartNoticePending) {
        body.restarted = true;
        body.fromInstanceId = restartIdentity.fromInstanceId;
      }
    }
    return body;
  };

  // ---- 0.9.0：归档会话过滤（防御式探测，服务缺失一律退化为"不过滤" = 现状） ----
  // 权威归档名单在宿主 workspaceRegistry（archivedSessionIds 持久化在 workspace
  // spec，跨重启保留）；归档是用户主动行为，unarchive 之前会话不可能正常干活，
  // 因此恢复候选与 /restart/info 的候选数都按它剔除（DSH 侧的
  // ArchivedSessionGate 也会拒绝归档会话跑模型步骤，这里在更早的候选阶段拦截）。

  /**
   * 防御式读归档名单：ctx.reflect.get 非阻塞探测（未提供/未激活返回 undefined，
   * 不触发启动、不阻塞加载）；registry 缺失/形状异常 → 空 Set，调用方
   * （filterArchivedCandidates）据此不过滤任何候选（维持现口径）。
   */
  const readArchivedSessionIds = () => {
    try {
      return normalizeArchivedSessionIds(ctx.reflect?.get?.('workspaceRegistry')?.archivedSessionIds);
    } catch (err) {
      console.warn('[resume-on-restart] workspaceRegistry probe failed:', err);
      return new Set();
    }
  };

  /**
   * 防御式取 session store 的 header 读取器（与 ArchivedSessionGate 同源：
   * sessions.get(id).header）：store 缺失/异常 → null，归档过滤退化为只查
   * 直系名单（不追 subagent lineage）。单个会话读取失败只影响它自己的
   * lineage 判定（该层返回 null），不阻断整个过滤。
   */
  const sessionHeaderLookup = () => {
    let store = null;
    try {
      const candidate = ctx.reflect?.get?.('sessions');
      if (candidate && typeof candidate.get === 'function') store = candidate;
    } catch (err) {
      console.warn('[resume-on-restart] session store probe failed:', err);
      return null;
    }
    if (!store) return null;
    return (id) => {
      try {
        const header = store.get(id)?.header;
        return header && typeof header === 'object' ? header : null;
      } catch (err) {
        console.warn('[resume-on-restart] session header lookup failed:', err);
        return null;
      }
    };
  };

  /**
   * 防御式取会话标题读取器（/restart/info 候选明细的 title 字段）：store 缺失/异常
   * → null（明细一律不带 title 字段）。单个会话读取失败/形状不对也只影响它自己的
   * title，绝不阻塞路由——title 纯属展示加分项。
   *
   * 标题读取链（0.13.0 初版只读 record.title/header.title，实测几乎必落空——DSH
   * 宿主的会话标题不在 header，而是 session projection：`session/title` 事件的
   * last-wins 投影；正确读取口是 ctx.sessionProjections.stateOf(session, 'title')，
   * 同步、物化到该 Session 当前游标）：
   * 1. 首选 `ctx.reflect.get('sessionProjections').stateOf(sessions.get(id), 'title')`
   *    ——非空字符串才采纳（null = title 未落地、undefined = 服务/键未注册，都不要）；
   *    stateOf 只接受 sessions store 拿到的活 Session 对象，绝不自己造对象去调；
   * 2. 次选 `record.title` / `record.header.title` 回退（无害防御，万一未来 header
   *    带标题）；store.get(id) 为 undefined（未入 store/被逐出）时两层都无从取值，
   *    直接放弃；
   * 3. 都没有 → 不带 title 字段。
   * 任何一层缺失/异常都静默降级到下一层（服务探测失败、stateOf 抛异常只
   * console.warn 一次），绝不阻塞 /restart/info 路由。
   */
  const sessionTitleLookup = () => {
    let store = null;
    try {
      const candidate = ctx.reflect?.get?.('sessions');
      if (candidate && typeof candidate.get === 'function') store = candidate;
    } catch (err) {
      console.warn('[resume-on-restart] session store probe failed:', err);
      return null;
    }
    if (!store) return null;
    // 投影服务探测（防御式，与 sessions store 同款 reflect.get 非阻塞口径）：
    // 缺失/形状不对 → null，静默降级到 record/header 回退；探测抛异常只 warn 一次
    let projectionStateOf = null;
    try {
      const service = ctx.reflect?.get?.('sessionProjections');
      if (service && typeof service.stateOf === 'function') projectionStateOf = service.stateOf.bind(service);
    } catch (err) {
      console.warn('[resume-on-restart] sessionProjections probe failed:', err);
    }
    return (id) => {
      try {
        const record = store.get(id);
        if (record === null || typeof record !== 'object') return null;
        if (projectionStateOf !== null) {
          let projected = null;
          try {
            projected = projectionStateOf(record, 'title');
          } catch (err) {
            console.warn('[resume-on-restart] session title projection failed:', err);
          }
          if (typeof projected === 'string' && projected) return projected;
        }
        if (typeof record.title === 'string' && record.title) return record.title;
        const header = record.header;
        if (header !== null && typeof header === 'object'
          && typeof header.title === 'string' && header.title) return header.title;
        return null;
      } catch (err) {
        console.warn('[resume-on-restart] session title lookup failed:', err);
        return null;
      }
    };
  };

  /**
   * 防御式取会话所属工作区读取器（/restart/info 候选明细的 workspace 字段，
   * 0.18.0）：返回 `(id) => path`（未知为 ''）；整条链路拿不到任何工作区信息时
   * 返回 null（调用方候选一律 workspace = ''，绝不阻塞路由）。lookup 每次调用
   * 只构建一次映射（sessionTitleLookup 同款风格），候选循环里逐个查表——
   * 目录枚举与 slug 匹配都是一次扫描，绝无每候选重复 readdir。
   *
   * 工作区清单回退链（每层缺失/异常静默降级到下一层，只 console.warn）：
   * 1. 宿主 `ctx.reflect.get('workspaceRegistry').list()`（Workspace 实体的
   *    `path` + `sessionIds`——header 验证过 canonical cwd 的官方口径；list()
   *    缺失/抛异常/没有有效条目 → 下一层）；
   * 2. 只读解析 `<DSH_HOME>/storages/workspace.json`（unit v2，
   *    tables.workspaces；**只读，绝不写**；读取失败 → 下一层）；
   * 3. 两层条目带 sessionIds 的直接映射；只有 path 的条目经 projectKeyOf 编码
   *    与 sessionsRoot 目录名正解匹配（buildWorkspaceIdMap，一次扫描）；
   * 4. 依然没有任何映射 → null（全部归「未知工作区」）。
   */
  const sessionWorkspaceLookup = () => {
    let entries = [];
    try {
      const registry = ctx.reflect?.get?.('workspaceRegistry');
      if (registry && typeof registry.list === 'function') {
        entries = normalizeWorkspaceEntries(registry.list());
      }
    } catch (err) {
      console.warn('[resume-on-restart] workspaceRegistry probe failed:', err);
    }
    if (entries.length === 0) {
      entries = readWorkspaceStoreEntries(join(dshHome, 'storages', 'workspace.json'));
    }
    if (entries.length === 0) return null;
    const map = buildWorkspaceIdMap(entries, sessionsRoot);
    if (map.size === 0) return null;
    return (id) => {
      try {
        return map.get(id) ?? '';
      } catch (err) {
        console.warn('[resume-on-restart] session workspace lookup failed:', err);
        return '';
      }
    };
  };

  /**
   * /restart/info 的候选明细（0.13.0）：`[{ id, at, running, title?, workspace, source }]`。
   * 候选集合与过滤口径完全不变（directRestorableCandidates：归档剔除 + subagent
   * 拆分）；升级点是把此前丢弃的真实数据带回来——
   * - `at`：回查内存 recentSessions 的真实最后活跃毫秒时间戳，输出 ISO 字符串
   *   （未知为 ''，与 boot 记录 runningSessions 同款口径），客户端可读格式化；
   * - `running`：条目最后已知运行态（与 boot 记录同款 boolean）；
   * - `title`：sessionTitleLookup 防御式探测（session projection 优先、
   *   record/header 回退），零成本拿到才带。
   * 0.17.0：候选池先经 visibleRestoreCandidateIds 剔除最后已知状态为正常结束的
   * 会话（与 GET /state、ws 快照、恢复流程的日志扫描门同口径）。
   * 0.18.0：明细行新增 `workspace`（会话所属工作区完整路径字符串，未知为 ''，
   * **总是携带**）——sessionWorkspaceLookup 防御式解析（registry list() 实体的
   * path+sessionIds 直映射优先、`<DSH_HOME>/storages/workspace.json` 只读回退、
   * 只有 path 时 slug 正解匹配），映射一次构建、候选逐个查表；纯展示字段，
   * 候选集合与过滤口径完全不变。
   * 0.19.0：候选池 = 自动候选（visibleRestoreCandidateIds）∪ 主动注册候选
   * （proactiveRestore——即使不再活跃甚至结束也总是出现，除非被用户排除）；
   * 每个明细行新增 `source`（'skill' = 主动注册，'auto' = 其余自动候选）。
   * 主动注册会话的 `at` = 注册时间（proactive store 的 at）、`running` 回查
   * recentSessions（查不到 = false）、`workspace` 同一查表。
   * 0.23.0：明细行再增 `activate:false`（仅注册但不激活条目携带、值恒 false——
   * true/缺失一律不带，供客户端「注册·不激活」徽标）。
   */
  const restartInfoCandidates = () => {
    const byId = new Map(recentSessions.map((entry) => [entry.id, entry]));
    const titleOf = sessionTitleLookup();
    // 0.18.0：候选行带 workspace（会话所属工作区完整路径，未知为 ''）；映射
    // 一次构建（registry 实体 → workspace.json 只读回退 → 未知），候选逐个查表
    const workspaceOf = sessionWorkspaceLookup();
    // 0.19.0：候选池 = 自动候选（at=0 占位，真实 at 下方回查）∪ 主动注册候选
    // （at = 注册时间）；去重主动注册优先、主动注册命中排除则丢弃。
    // 0.23.0：注册但不激活（activate:false）仅 false 才透传（true/缺失一律不带）
    const pool = mergeProactiveCandidatePool(
      visibleRestoreCandidateIds().map((id) => ({ id, at: 0 })),
      [...proactiveRestore.entries()].map(([id, value]) => {
        const row = {
          id,
          at: typeof value?.at === 'string' && value.at && Number.isFinite(Date.parse(value.at))
            ? Date.parse(value.at)
            : 0,
        };
        if (value?.activate === false) row.activate = false;
        return row;
      }),
      readExclusions(exclusionsFile),
    );
    // 0.15.0：候选池并入暂停集合；0.17.0：再剔正常结束，
    // 归档剔除 + subagent 拆分口径不变
    return directRestorableCandidates(pool).map((candidate) => {
      const entry = byId.get(candidate.id);
      // 0.19.0：主动注册会话的 at = 注册时间（候选池已携带）；自动候选维持
      // 0.15.0 口径——at 优先 recentSessions 条目的真实值，否则用暂停集合的 atISO
      let atMs = candidate.at;
      if (candidate.source !== 'skill') {
        const pausedAt = pausedSessions.get(candidate.id);
        const pausedAtMs = typeof pausedAt === 'string' && pausedAt
          ? (Number.isFinite(Date.parse(pausedAt)) ? Date.parse(pausedAt) : 0)
          : 0;
        atMs = entry && typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 0
          ? entry.at
          : pausedAtMs;
      }
      const detail = {
        id: candidate.id,
        at: atMs > 0 ? new Date(atMs).toISOString() : '',
        running: entry ? entry.running === true : false,
        // 0.18.0：所属工作区完整路径字符串（未知为 ''——lookup 整链缺失或该 id
        // 不在任何工作区映射里）；客户端据此按工作区分组展示
        workspace: typeof workspaceOf === 'function' ? workspaceOf(candidate.id) : '',
        // 0.19.0：候选来源标识（'skill' = 主动注册重启恢复，'auto' = 自动候选）
        source: candidate.source,
      };
      // 0.23.0：注册但不激活标记——仅 false 才带（供客户端「注册·不激活」徽标）；
      // 候选池与过滤（归档/subagent 拆分）保持对象引用，activate 原样流到这里
      if (candidate.activate === false) detail.activate = false;
      const title = typeof titleOf === 'function' ? titleOf(candidate.id) : null;
      if (title) detail.title = title;
      return detail;
    });
  };

  /**
   * 把候选列表按归档名单过滤（0.9.0）：候选阶段与 /restart/info 共用的唯一口径。
   * 名单为空（registry 缺失）→ 原样返回全部候选（现口径）。
   */
  const filterArchivedRestoreCandidates = (candidates) =>
    filterArchivedCandidates(candidates, readArchivedSessionIds(), sessionHeaderLookup());

  /**
   * 候选列表 → 可被 agents.resumeSession 直接恢复的主会话候选（0.9.1）：
   * 归档剔除（0.9.0 口径）之后再用 session store header 拆掉 subagent routing
   * 持有的候选——宿主 resolveAgent 对它们一律拒绝，直接恢复必然失败；
   * /restart/info 的候选数与设置弹窗「重启后将自动恢复 N 个」据此收窄。
   * store 缺失 → 无法识别，全部保留（退化 = 现状，由恢复流程的 RemoteError
   * 兜底结算，绝不静默）。
   */
  const directRestorableCandidates = (candidates) => {
    const { kept } = filterArchivedRestoreCandidates(candidates);
    return partitionSubagentCandidates(kept, sessionHeaderLookup()).kept;
  };

  // ---- 0.26.0：「上次重启无法恢复」store 的登记/移除（lib/unrestored.js 纯函数接线） ----
  // 登记时机：续等总预算耗尽时逐条登记（title/workspace 从防御式探测拿，拿不到省略）；
  // 移除时机：正常路径 / 续等补跑 / 手动恢复成功某会话时移除同 id 条目。
  // 读 → 变更 → cap → 写，每次一个文件原子写（best-effort，失败只 warn）。

  /**
   * 把若干条目登记进「无法恢复」store（同 id 重复登记 = 原位更新不新增）：
   * 条目形状 `{ id, at(登记时刻ISO), bootAt?, title?, workspace?, error? }`
   * （见 lib/unrestored.js 模块头）。
   * @param {Array<{id: string, at: string, bootAt?: string, title?: string, workspace?: string, error?: string}>} entries 待登记条目
   */
  const registerUnrestoredSessions = (entries) => {
    let rows = readUnrestored(unrestoredFile);
    for (const entry of entries) rows = upsertUnrestored(rows, entry);
    writeUnrestored(unrestoredFile, capUnrestored(rows, MAX_UNRESTORED));
  };

  /**
   * 从「无法恢复」store 移除指定会话（恢复成功即自动移除）：无变化不写盘。
   * @param {string|string[]} ids 已成功恢复的会话 id（单个或数组）
   */
  const removeUnrestoredSessions = (ids) => {
    const rows = readUnrestored(unrestoredFile);
    const next = removeUnrestoredIds(rows, ids);
    if (next.length === rows.length) return;
    writeUnrestored(unrestoredFile, capUnrestored(next, MAX_UNRESTORED));
  };

  /**
   * 已成功恢复的会话从主动注册 store 移除（0.19.0 既有收尾的共享抽出，0.26.0 起
   * 开机路径与续等补跑同一实现）：失败/被过滤的条目保留（下次重启再试），
   * 绝不误删其他主动注册条目；无可移除条目不写盘。
   * @param {string[]} restoredIds 本轮成功恢复（投递成功）的会话 id
   */
  const removeRestoredFromProactiveStore = (restoredIds) => {
    if (!Array.isArray(restoredIds) || restoredIds.length === 0) return;
    let removedAny = false;
    for (const id of restoredIds) {
      if (proactiveRestore.delete(id)) removedAny = true;
    }
    if (removedAny) {
      writeProactiveRestore(proactiveRestoreFile, capProactiveRestore(Object.fromEntries(proactiveRestore), MAX_PROACTIVE_RESTORE));
    }
  };

  /**
   * 续等放弃时为单个候选构建登记条目：title/workspace 防御式探测（与
   * /restart/info 候选明细同一 lookup），拿不到省略字段。lookup 由调用方
   * 预构建一次传入（sessionTitleLookup / sessionWorkspaceLookup 每次构建
   * 都可能做目录扫描，批量登记绝不做每候选重复构建）。
   * @param {{id: string}} candidate 候选条目
   * @param {string} errorText 放弃原因（写进条目 error 字段）
   * @param {{titleOf?: ((id: string) => string|null)|null, workspaceOf?: ((id: string) => string)|null}} [lookups]
   *        预构建的防御式 lookup（缺省 = 不探测、省略对应字段）
   * @returns {{id: string, at: string, bootAt?: string, title?: string, workspace?: string, error?: string}}
   */
  const buildUnrestoredEntry = (candidate, errorText, lookups = {}) => {
    const entry = { id: candidate.id, at: new Date().toISOString(), bootAt, error: errorText };
    const titleOf = typeof lookups.titleOf === 'function' ? lookups.titleOf : null;
    if (titleOf) {
      const title = titleOf(candidate.id);
      if (title) entry.title = title;
    }
    const workspaceOf = typeof lookups.workspaceOf === 'function' ? lookups.workspaceOf : null;
    if (workspaceOf) {
      const workspace = workspaceOf(candidate.id);
      if (workspace) entry.workspace = workspace;
    }
    return entry;
  };

  // ---- 0.26.0：恢复通道共用工具（自开机恢复的 agents effect 上移） ----
  //
  // withTimeout / sessionController 探测与等待 / resumeSession / deliver 原本定义在
  // 开机恢复的 agents effect 闭包里；0.26.0 起「快等超时后的续等补跑」与
  // POST /unrestored/restore 手动恢复路由要与候选循环共用同一实现（不新造逻辑），
  // 而路由闭包在 webServer inject 里拿不到 effect 私有作用域——故整体上移到
  // apply 层。逻辑逐字未动（deadline 的赋值方仍只有候选循环、deliver 仍是唯一
  // 投递出口）。

  // 恢复候选阶段的总预算：0.7.0 起在 sessionController 就绪后才起算
  // （restoreCandidates 进入候选循环前先做全局等待，等待耗时不占本预算）。
  // deadline 为 0 表示候选阶段尚未开始，此时 remainingMs 恒为 0
  let deadline = 0;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  // 0.26.0：本 boot 内已成功投递过通知的会话 id（fallbackWake / 升级回退 / 候选
  // 循环 / 手动恢复共用 deliver，deliver 成功即登记）。续等补跑按它按会话 id
  // 去重：fallback 在 restoreCandidates 返回后才执行（deliver 登记发生在补跑
  // 过滤读取之前——补跑过滤发生在续等任务就绪后的未来时刻，时序天然成立），
  // 不向已投递会话重复投递；反方向（补跑先、fallback 后）同理——fallback 两处
  // 投递点与升级回退投递前也查本集合（passesDeliveredGate），服务恰在 fallback
  // 等待/轮询进行中就绪时，补跑可能先恢复并投递同一会话，fallback 再投就重复
  const deliveredTo = new Set();

  /** 给 promise 套超时；无论谁先完成都清掉定时器。 */
  const withTimeout = (promise, ms, label) => {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };

  /**
   * 防御式探测 sessionController 服务：
   * 用 ctx.reflect.get 非阻塞读取（未提供/未激活返回 undefined，不触发启动、不阻塞加载），
   * 且要求其具备 resolveAgent 方法；拿不到由 restoreCandidates 的全局等待轮询
   * （0.7.0，serviceWaitTimeoutMs 预算），resumeSession 只做即时检查兜底。
   */
  const getSessionController = () => {
    try {
      const controller = ctx.reflect?.get?.('sessionController');
      return controller && typeof controller.resolveAgent === 'function' ? controller : null;
    } catch (err) {
      console.warn('[resume-on-restart] sessionController probe failed:', err);
      return null;
    }
  };

  /**
   * 全局等待 sessionController 服务就绪（0.7.0）：restoreCandidates 进入候选
   * 循环前一次性调用，预算独立（serviceWaitTimeoutMs），不占候选恢复预算；
   * 每 SERVICE_POLL_MS 轮询一次。返回 `{ controller, waitedMs }`——
   * controller 为 null 表示预算内始终未就绪（调用方记日志后放弃全部候选）。
   * 0.26.0 起续等补跑与 POST /unrestored/restore 手动恢复也用它等服务就绪。
   */
  const waitForSessionController = async (budgetMs) => {
    const startedAt = Date.now();
    const waitDeadline = startedAt + Math.max(1, budgetMs);
    let controller = getSessionController();
    while (!controller) {
      const waitLeftMs = waitDeadline - Date.now();
      if (waitLeftMs <= 0) break;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(SERVICE_POLL_MS, waitLeftMs));
        timer.unref?.();
      });
      controller = getSessionController();
    }
    return { controller, waitedMs: Date.now() - startedAt };
  };

  /**
   * 通过 sessionController.resolveAgent(sessionId) 恢复会话为 live Agent。
   * 返回判别：成功 `{ agent }` / 失败 `{ error }`（stable failure union）。
   * budgetMs 为该候选的预算切片（ms，>0 时与候选阶段剩余总预算取更小者），
   * 只用于给 resolveAgent 调用套 withTimeout；失败（超时/异常/意外形状）
   * 一律 throw，由调用方记录并继续下一个候选。
   *
   * 0.7.0：等服务已上移到 restoreCandidates 的全局等待（serviceWaitTimeoutMs），
   * 这里只做一次防御式即时检查——立即取到服务就用，取不到不再轮询等待。
   * 0.9.1：候选阶段 deadline 未设（deadline===0，如 fallbackWake 的升级
   * 解析路径）时以 budgetMs/restoreTimeoutMs 为准，不再退化为 1ms 即超时。
   */
  const resumeSession = async (sessionId, budgetMs = 0, { ignoreStageDeadline = false } = {}) => {
    const controller = getSessionController();
    if (!controller) throw new Error('sessionController service unavailable');
    const limits = [budgetMs > 0 ? budgetMs : restoreTimeoutMs];
    // 候选阶段 deadline 只约束候选循环内的调用；fallback 升级路径
    // （ignoreStageDeadline）是独立阶段，不继承候选阶段已耗尽的预算
    if (!ignoreStageDeadline && deadline > 0) limits.push(remainingMs());
    const limitMs = Math.max(1, Math.min(...limits));
    const result = await withTimeout(
      controller.resolveAgent(sessionId),
      limitMs,
      `resolveAgent(${sessionId})`,
    );
    if (result && typeof result === 'object' && result.agent) return result.agent;
    const reason = result && typeof result === 'object' && 'error' in result
      ? String(result.error)
      : 'unexpected resolveAgent result';
    throw new Error(reason);
  };

  /** 投递通知；restored 非空时文案命中"已自动恢复"。返回 `{ ok, error }`（stable union）。 */
  const deliver = (target, restored = null) => {
    const text = buildNotice({
      bootAt,
      prevBootAt,
      downtimeMs,
      lastSessionId,
      lastActiveAt,
      customNotice: config.notice,
      restoredSessionId: restored?.id ?? undefined,
      restoredActiveAt: restored && restored.at > 0
        ? new Date(restored.at).toISOString()
        : undefined,
    });
    // 0.3.1：source 用 producer-owned kind（裸插件名），替代已废弃的 v3 写法
    // `{ kind: 'plugin', plugin: ... }`——后者会被 DSH 会话格式 v4 校验拒绝
    // （SessionFormatError: format v4 message requires a producer-owned source kind）。
    const msg = createNoticeMessage({ text, bootAt });
    try {
      if (config.wakeup !== false) {
        target.followup(msg);
      } else {
        target.inject(msg);
      }
      console.log('[resume-on-restart] notice delivered to', String(target.id));
      // 0.26.0：投递成功即登记 deliveredTo——续等补跑按它去重，不重复投递
      deliveredTo.add(String(target.id));
      writeWakeLog(markerDir, String(target.id), true, null);
      return { ok: true, error: null };
    } catch (err) {
      console.warn('[resume-on-restart] deliver failed:', err);
      const reason = String(err);
      writeWakeLog(markerDir, String(target.id), false, reason);
      return { ok: false, error: reason };
    }
  };

  /**
   * 「上次重启无法恢复」的手动恢复执行体（0.26.0，POST /unrestored/restore）：
   * 等服务就绪（≤ serviceWaitTimeoutMs，同一 waitForSessionController）后按候选
   * 循环同款恢复该会话（resumeSession + deliver 投递继续提示；手动恢复是独立
   * 阶段，ignoreStageDeadline 不占候选阶段 deadline，与 fallback 升级路径同款）；
   * 会话已活跃则不重复投递、直接按成功处理。成功 → `{ok:true}` + store 移除该条
   * + restarts.ndjson 记 restore 行 result:'resumed'（error:null）+ wake.log
   * （deliver 内部 / 已活跃分支显式补记）；失败 → `{ok:false,error}`（响应风格
   * 照 POST /state），同样落一条 failed 结算（不静默，与本插件日志口径一致）。
   * @param {string} sessionId 待手动恢复的会话 id（路由层已做长度/非空校验）
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  const performUnrestoredRestore = async (sessionId) => {
    // 会话已活跃则不重复投递：防御式查已 live agent（agents 在 inject 里，
    // 仍保持防御形状校验，风格同 performPauseAll 的枚举）
    let liveAgent = null;
    try {
      const agents = ctx.get('agents');
      liveAgent = agents && typeof agents.get === 'function' ? (agents.get(sessionId) ?? null) : null;
    } catch (err) {
      console.warn('[resume-on-restart] unrestored restore: agents lookup failed:', err);
    }
    if (liveAgent) {
      console.log('[resume-on-restart] unrestored restore: session already live, skip deliver:', sessionId);
      writeWakeLog(markerDir, sessionId, true, 'manual restore: session already live, notice not re-delivered');
      appendRestartLog({
        type: 'restore',
        bootAt,
        id: sessionId,
        result: 'resumed',
        error: null,
        at: new Date().toISOString(),
      });
      removeUnrestoredSessions(sessionId);
      return { ok: true };
    }
    // 等服务就绪（等 ≤ serviceWaitTimeoutMs，与快等同预算）
    const wait = await waitForSessionController(serviceWaitTimeoutMs);
    if (!wait.controller) {
      const error = `sessionController not ready within ${serviceWaitTimeoutMs}ms`;
      console.warn('[resume-on-restart] unrestored restore:', error);
      return { ok: false, error };
    }
    // 候选循环同款恢复通道（resumeSession）
    let agent = null;
    try {
      agent = await resumeSession(sessionId, serviceWaitTimeoutMs, { ignoreStageDeadline: true });
      console.log('[resume-on-restart] unrestored restore: session resumed via sessionController:', sessionId);
    } catch (err) {
      const reason = err?.message ?? String(err);
      console.warn('[resume-on-restart] unrestored restore: resume session', sessionId, 'failed:', reason);
      appendRestartLog({
        type: 'restore',
        bootAt,
        id: sessionId,
        result: 'failed',
        error: `resume failed: ${reason}`,
        at: new Date().toISOString(),
      });
      return { ok: false, error: reason };
    }
    // 投递继续提示（deliver 内部记 wake.log + deliveredTo）
    const outcome = deliver(agent);
    appendRestartLog({
      type: 'restore',
      bootAt,
      id: sessionId,
      result: outcome.ok ? 'resumed' : 'failed',
      error: outcome.error,
      at: new Date().toISOString(),
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    // 成功：store 移除该条（手动恢复成功即不再「无法恢复」）
    removeUnrestoredSessions(sessionId);
    return { ok: true };
  };

  // ---- 0.15.0：暂停所有会话（POST /pause-all）的执行体 ----

  /**
   * 防御式探测 sessionController（cancel 通道，0.15.0）：要求 resolveAgent + cancel
   * 两个方法都存在，任一缺失/形状不对 → null。与恢复路径的探测（0.5.2 起的
   * getSessionController，只要求 resolveAgent）**分开实现**——恢复语义完全不动，
   * 暂停路径的要求单独收紧。
   */
  const getCancelSessionController = () => {
    try {
      const controller = ctx.reflect?.get?.('sessionController');
      return controller && typeof controller.resolveAgent === 'function' && typeof controller.cancel === 'function'
        ? controller
        : null;
    } catch (err) {
      console.warn('[resume-on-restart] sessionController (cancel) probe failed:', err);
      return null;
    }
  };

  /**
   * 暂停全部运行中会话（0.15.0，POST /pause-all 的执行体）：
   * - agents 在 inject 里，仍保持防御形状校验（try/catch + list() 类型检查）；
   * - 枚举运行中会话（selectRunningAgentIds：status==='running' 且不被
   *   ignoredSessionPrefixes 排除），逐个经 sessionController.cancel({ sessionId })
   *   停止——「用户点停止」的同一实现（keepInbox，已排队输入保留）；
   * - 成功 → stopped.push({id, title?}) + recordActivity(id, 'idle')（立即更新内存
   *   视图与 marker）；subagent routing 持有（稳定错误文案）→ subagent（不算失败）；
   *   其余失败 → failed；
   * - 循环结束后把 stopped 的 id 并入内存暂停集合（at=本次时刻 ISO）+ 一次写盘 +
   *   广播 ws 快照（候选集变化，顶栏开关可见）。下次重启由开机恢复流程消费。
   */
  const performPauseAll = async () => {
    let runningIds = [];
    try {
      const agents = ctx.get('agents');
      const list = agents && typeof agents.list === 'function' ? agents.list() : [];
      runningIds = selectRunningAgentIds(list, config.ignoredSessionPrefixes);
    } catch (err) {
      console.warn('[resume-on-restart] pause-all: agents lookup failed:', err);
      return { ok: false, error: 'agents service unavailable' };
    }
    const controller = getCancelSessionController();
    if (!controller) {
      return { ok: false, error: 'sessionController service unavailable' };
    }
    const titleOf = sessionTitleLookup();
    const stopped = [];
    const subagentIds = [];
    const failed = [];
    for (const id of runningIds) {
      try {
        await controller.cancel({ sessionId: id });
        const entry = { id };
        const title = typeof titleOf === 'function' ? titleOf(id) : null;
        if (title) entry.title = title;
        stopped.push(entry);
        // 立即更新内存视图与 marker：该会话已停止（recordActivity 内部会广播 ws 快照）
        recordActivity({ id }, 'idle');
      } catch (err) {
        const reason = err?.message ?? String(err);
        if (SUBAGENT_ROUTING_ERROR.test(reason)) {
          console.warn('[resume-on-restart] pause-all: session', id, 'owned by subagent routing, skipped');
          subagentIds.push(id);
          continue;
        }
        console.warn('[resume-on-restart] pause-all: cancel session', id, 'failed:', reason);
        failed.push({ id, error: reason });
      }
    }
    // 停止成功的并入暂停集合并一次写盘：下一次重启（无论按钮/crash/signal）
    // 的开机恢复流程把它们并入候选（并集兜底机制，列表默认不限量后通常已在其内）
    const pausedAt = new Date().toISOString();
    for (const entry of stopped) pausedSessions.set(entry.id, pausedAt);
    writePausedSessions(pausedSessionsFile, Object.fromEntries(pausedSessions));
    pushStateSnapshot();
    return { ok: true, stopped, subagent: subagentIds, failed };
  };

  // ---- 0.22.0：注册后守门自动重启（register_restart_recovery 武装后生效） ----
  //
  // 会话经模型工具 action=add 成功登记后，插件武装一次「所有会话都完成时自动
  // 触发一次 DSH 重启」的守门器（详见文件头 0.22.0 段）：
  // - 完成口径：会话不在 running 即算完成；正在向用户提问等待回答（提问中）
  //   的会话也算完成；
  // - 评估入口：武装成功后延迟 2s 首评（注册那一刻本会话必然 running，天然等待
  //   一轮）；agent/status 事件顺带调度 ~1s 去抖评估；30s 兜底重估防事件丢失。
  //   全部 timer unref，绝不反过来拖住进程退出；
  // - 判定 done:false → 取消已排定的触发继续等；done:true → 排定
  //   autoRestartSettleMs 窗口后触发，窗口内评估翻回 done:false 则取消回等待；
  // - 触发与 /restart 三入口共用同一 restartLatch 防重入：pauseLatch 非空 /
  //   claim 失败（已有重启在途）= 本轮放弃、武装保留等下轮；performRestart
  //   失败 → release + warn，武装保留；武装文件只在开机一次性消费（防重启
  //   死循环），触发路径不删——失败分支留给下一轮评估重试。

  /** 武装成功后的首次评估延迟（ms）：注册那一刻本会话必然 running，天然等一轮。 */
  const AUTO_RESTART_FIRST_EVAL_DELAY_MS = 2000;
  /** agent/status 事件触发的去抖评估合并窗口（ms）。 */
  const AUTO_RESTART_EVAL_DEBOUNCE_MS = 1000;
  /** 无事件时的兜底重估间隔（ms）：防事件丢失导致武装后永远不评估。 */
  const AUTO_RESTART_FALLBACK_EVAL_MS = 30000;

  // 武装状态（内存态与武装文件同步；/restart/info 的 autoRestart 字段读这里）
  let autoRestartArmed = false;
  let autoRestartArmState = null;
  let autoRestartEvaluateTimer = null;
  let autoRestartTriggerTimer = null;
  let autoRestartFallbackTimer = null;
  // 等待日志去重：同一批未完成会话只打一行，不随 30s 兜底重估刷屏
  let autoRestartWaitingSignature = null;

  /**
   * 防御式探测「会话正在向用户提问等待回答」（提问中）：宿主链路
   * ctx.reflect.get('sessionProjections').stateOf(agent.session,
   * 'userQuestions')?.questions?.active 数组里存在 state==='continued' 的条目
   * 即提问中（口径核对自宿主 @deepseek-ai/dsh-user-questions 的实现，插件
   * 绝不 import 它，全程 reflect 防御式探测）。任一层缺失/形状不对/抛异常
   * → false（= 不在提问）：保守方向是继续等（该会话仍 running），绝不因探测
   * 失败把「可能在等用户回答」的会话当完成提前重启。
   */
  const agentAskingUserQuestion = (agent) => {
    try {
      const session = agent?.session;
      if (!session) return false;
      const service = ctx.reflect?.get?.('sessionProjections');
      if (!service || typeof service.stateOf !== 'function') return false;
      const view = service.stateOf(session, 'userQuestions');
      const active = view?.questions?.active;
      if (!Array.isArray(active)) return false;
      return active.some(
        (question) => question !== null && typeof question === 'object' && question.state === 'continued',
      );
    } catch (err) {
      console.warn('[resume-on-restart] auto-restart: user-question probe failed:', err);
      return false;
    }
  };

  /** 取消已排定的触发（评估翻回 done:false 时回到等待）。 */
  const cancelAutoRestartTrigger = () => {
    if (autoRestartTriggerTimer) {
      clearTimeout(autoRestartTriggerTimer);
      autoRestartTriggerTimer = null;
    }
  };

  /** 解除武装：清内存态与全部守门器 timer（remove 成功且已无注册时调用）。 */
  const disarmAutoRestart = () => {
    autoRestartArmed = false;
    autoRestartArmState = null;
    autoRestartWaitingSignature = null;
    if (autoRestartEvaluateTimer) {
      clearTimeout(autoRestartEvaluateTimer);
      autoRestartEvaluateTimer = null;
    }
    cancelAutoRestartTrigger();
    if (autoRestartFallbackTimer) {
      clearInterval(autoRestartFallbackTimer);
      autoRestartFallbackTimer = null;
    }
  };

  /** 守门评估：全部会话完成（不在 running；提问中亦算完成）才排定触发。 */
  const evaluateAutoRestartGate = () => {
    if (!autoRestartArmed) return;
    let runningIds = [];
    const agentById = new Map();
    try {
      const agents = ctx.get('agents');
      const list = agents && typeof agents.list === 'function' ? agents.list() : null;
      // 枚举结果形状不对 = 判定不了完成，保守方向是继续等
      //（绝不把「枚举不出来」当「全部完成」提前重启）
      if (!Array.isArray(list)) {
        console.warn('[resume-on-restart] auto-restart: agents.list() unavailable, keep waiting');
        return;
      }
      // 枚举口径与 performPauseAll 完全一致（selectRunningAgentIds：
      // status==='running' 且不被 ignoredSessionPrefixes 排除）
      runningIds = selectRunningAgentIds(list, config.ignoredSessionPrefixes);
      for (const entry of list) {
        if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
          agentById.set(entry.id, entry);
        }
      }
    } catch (err) {
      // agents 枚举失败 = 判定不了完成，保守方向是继续等（绝不提前重启）
      console.warn('[resume-on-restart] auto-restart: agents lookup failed:', err);
      return;
    }
    // 对每个 running 会话防御式探测「提问中」；探测不出的会话不算提问（保守等）
    const askingIds = new Set();
    for (const id of runningIds) {
      const agent = agentById.get(id);
      if (agent && agentAskingUserQuestion(agent)) askingIds.add(id);
    }
    const verdict = classifyAutoRestartGate(runningIds, askingIds);
    if (!verdict.done) {
      // 还有会话在干活：取消已排定的触发（settle 窗口被打断 = 回等待）
      cancelAutoRestartTrigger();
      const signature = verdict.running.join(',');
      if (signature !== autoRestartWaitingSignature) {
        autoRestartWaitingSignature = signature;
        console.log(`[resume-on-restart] auto-restart: waiting for ${verdict.running.length} running session(s): ${signature}`);
      }
      return;
    }
    autoRestartWaitingSignature = null;
    if (autoRestartTriggerTimer) return; // settle 窗口已排定，保持最早的一次
    console.log(`[resume-on-restart] auto-restart: all sessions settled, restart scheduled in ${autoRestartSettleMs}ms`);
    autoRestartTriggerTimer = setTimeout(() => {
      autoRestartTriggerTimer = null;
      if (!autoRestartArmed) return; // 窗口内被解除武装（remove 成功且无注册）
      // 触发与既有入口共用防重入闩：暂停进行中 / 已有重启在途都本轮放弃
      //（武装保留，下一轮评估再试；已有重启在途时新进程会消费武装文件）
      if (pauseLatch.current() !== null) {
        console.log('[resume-on-restart] auto-restart: pause-all in progress, keep armed and wait');
        return;
      }
      if (!restartLatch.claim('restart')) {
        console.log('[resume-on-restart] auto-restart: restart already in progress, keep armed');
        return;
      }
      console.log('[resume-on-restart] auto-restart: triggering restart (origin=auto)');
      void performRestart(buildOriginRecord('auto', null), restartDelayMs).then((result) => {
        if (result.ok) return; // 武装文件留给新进程开机一次性消费（防死循环）
        restartLatch.release();
        console.warn('[resume-on-restart] auto-restart trigger failed:', result.error);
        // 武装保留：下一轮评估（事件去抖或 30s 兜底）再试
      });
    }, autoRestartSettleMs);
    autoRestartTriggerTimer.unref?.();
  };

  /** 调度一次守门评估（去抖合并：已有排定的评估不重排；未武装时空转）。 */
  const scheduleAutoRestartEvaluate = (delayMs = AUTO_RESTART_EVAL_DEBOUNCE_MS) => {
    if (!autoRestartArmed || autoRestartEvaluateTimer) return;
    autoRestartEvaluateTimer = setTimeout(() => {
      autoRestartEvaluateTimer = null;
      evaluateAutoRestartGate();
    }, delayMs);
    autoRestartEvaluateTimer.unref?.();
  };

  /**
   * 武装自动重启（工具 action=add 成功路径调用，幂等）：文件已武装时保留最早
   * armedAt、by 更新为最新注册者（mergeAutoRestartArm）；本进程尚未武装时启动
   * 守门器（2s 首评 + agent/status 去抖 + 30s 兜底）。写盘失败 → 不武装：
   * 武装文件是开机一次性消费的凭据，缺了它自动重启会变成每次开机再重启的
   * 死循环；此时只告警，不影响登记结果。
   * @param {string} by 发起本次武装的会话 id
   * @returns {boolean} 是否武装成功
   */
  const armAutoRestart = (by) => {
    const existing = readAutoRestartArm(autoRestartFile);
    const next = {
      schemaVersion: AUTO_RESTART_SCHEMA_VERSION,
      armedAt: new Date().toISOString(),
      by,
    };
    const merged = mergeAutoRestartArm(existing, next) ?? next;
    const unchanged = existing !== null
      && existing.armedAt === merged.armedAt
      && existing.by === merged.by;
    if (!unchanged && !writeAutoRestartArm(autoRestartFile, merged)) return false;
    autoRestartArmState = merged;
    if (autoRestartArmed) return true;
    autoRestartArmed = true;
    console.log(`[resume-on-restart] auto-restart armed: will restart once all sessions settle (armedAt=${merged.armedAt}, by=${merged.by})`);
    scheduleAutoRestartEvaluate(AUTO_RESTART_FIRST_EVAL_DELAY_MS);
    if (!autoRestartFallbackTimer) {
      autoRestartFallbackTimer = setInterval(() => evaluateAutoRestartGate(), AUTO_RESTART_FALLBACK_EVAL_MS);
      autoRestartFallbackTimer.unref?.();
    }
    return true;
  };

  // 4. 监听真实存在的 agent 活动事件（0.2.0 监听的 agent/session-start、
  //    agent/pre-step 在 DSH 中不存在，导致追踪从未生效）：
  //    - agent/status：生命周期 idle⇄running 翻转（payload { agent, status }，
  //      status ∈ 'idle' | 'running'；用它维护条目的 running 标记）
  //    - agent/inbox/inserted：有新消息进入收件箱
  //    - agent/assistant-stream：模型流式输出进行中
  //    三者 payload 均被 dsh-agent 的 dispatcher 融合进 agent 对象。
  ctx.on('agent/status', (payload) => {
    recordActivity(payload?.agent, payload?.status);
    // 0.22.0：会话状态翻转是守门器评估的触发源之一（~1s 去抖合并；未武装时空转）
    scheduleAutoRestartEvaluate();
  });
  ctx.on('agent/inbox/inserted', (payload) => recordActivity(payload?.agent));
  ctx.on('agent/assistant-stream', (payload) => recordActivity(payload?.agent));
  // 0.17.0：turn 事件监听（宿主 dsh-session 在 session.append 时经 cordis 派发
  // `session/event`，监听器收到 (session, event)，event 与会话日志记录同形状
  // { type, seq, time, data }；session.id 即会话 id——已核对宿主源码的派发实现）。
  // 低成本维护两件事：
  // 1. 记录性字段 lastTurnEndKind（recentSessions 条目上，随节流落盘进 marker，
  //    仅供观测；恢复过滤绝不依赖它——崩溃会丢，判据是重启后的日志扫描）；
  // 2. 运行期 completedSessions 集合（候选显示口径）：turn/end completed → 加入；
  //    turn/start（新 turn 开着）与其他 kind → 移出。集合变化才广播 ws 快照
  //    （内容去重在 ws-state，快照没变不产生实际帧）。
  ctx.on('session/event', (session, event) => {
    const sid = String(session?.id ?? '');
    if (!sid || ignoredByPrefix(sid, config.ignoredSessionPrefixes)) return;
    if (isTurnStartRecord(event)) {
      if (completedSessions.delete(sid)) pushStateSnapshot();
      return;
    }
    const kind = turnEndKindOf(event);
    if (kind === null) return;
    const entry = recentSessions.find((e) => e.id === sid);
    if (entry && entry.lastTurnEndKind !== kind) {
      entry.lastTurnEndKind = kind;
      schedulePersist();
    }
    if (kind === 'completed') {
      if (!completedSessions.has(sid)) {
        completedSessions.add(sid);
        pushStateSnapshot();
      }
    } else if (completedSessions.delete(sid)) {
      pushStateSnapshot();
    }
  });

  // 5. web 会话顶栏开关（lib/client.js）的状态路由：
  //    GET  /ws-info      — 0.11.0：ws 推送接入信息（一次性拉取，非轮询）；
  //                         0.12.0 起 { ok, token }（不再有 port，见 5.1）
  //    GET  /state?ids=a,b — 查询排除状态与恢复候选（缺 ids 时返回全部，条目有上限）
  //    POST /state         — body { sessionId, excluded: boolean } 标记/取消（成功后广播 ws 快照）
  //    GET  /restarts      — 0.5.0：只读重启日志（restarts.ndjson 条目 + 上限）
  //    GET  /unrestored    — 0.26.0：「上次重启无法恢复」只读列表（enableRestart 门控）
  //    POST /unrestored/restore — 0.26.0：手动恢复一条无法恢复的会话（同上门控）
  //    本路由前缀比宿主 `/api` 长，宿主的浏览器围栏不会覆盖它，因此自带：
  //    先借用宿主 connection.requestRejection（未认证 401 等），宿主未提供
  //    该服务时回退到本插件复刻的最小围栏（同 Host、Origin 同源、拒绝 cross-site）。
  //    webServer 经动态 ctx.inject(['webServer'], ...) 等服务激活后再注册
  //    （与第 6 节 agents 的动态注入模式一致）：apply 执行时 webServer 服务往往
  //    尚未激活，静态探测必拿不到；不把 webServer 加入插件 inject（不阻塞加载），
  //    服务不可用则回调不执行、路由不注册，插件加载与恢复流程不受影响。
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope?.webServer;
    if (!webServer || typeof webServer.register !== 'function') return;
    // 服务已激活，注册状态路由；effect 回调用闭包里的 webServer，不读 ctx.webServer
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: HTTP_BASE,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.local');
        const sub = url.pathname.slice(HTTP_BASE.length).replace(/\/+$/, '') || '/';
        const method = req.method ?? 'GET';

        /** 拒绝并说明原因（reason 供客户端/排查定位是哪条规则拦的）。 */
        const refuse = (reason, status) => json(res, status, {
          ok: false,
          error: 'forbidden: untrusted state request',
          reason,
        });

        // 浏览器信任围栏（对 GET/POST 一视同仁，与宿主 /api 的整体口径一致）
        const hostRejection = connectionRejection(ctx, req);
        if (hostRejection === null) {
          const verdict = explainStateRequestTrust(req, declaredTrustedHosts(ctx), boundHostOf(webServer));
          if (!verdict.trusted) return refuse(verdict.reason, 403);
        } else if (hostRejection !== undefined) {
          return refuse(hostRejection === 401 ? 'not-authenticated' : 'host-fence', hostRejection);
        }

        try {
          if (sub === '/ws-info' && method === 'GET') {
            // 0.11.0：ws 推送接入信息（客户端一次性拉取，非轮询）。ws 服务不可用
            // （未注册升级路由：旧版宿主缺 registerUpgrade/注册失败）返回 503——
            // 客户端保持无限重试（不回退轮询），开关退化为挂载时的一次性 GET /state。
            // 0.12.0：ws 改挂宿主主端口同源路径，不再返回 port
            const info = wsPush?.info();
            if (!info) return json(res, 503, { ok: false, error: 'websocket push unavailable' });
            return json(res, 200, { ok: true, token: info.token });
          }

          if (sub === '/state' && method === 'GET') {
            const sessions = readExclusions(exclusionsFile);
            const ids = (url.searchParams.get('ids') ?? '')
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
              .slice(0, MAX_EXCLUSIONS);
            const excluded = {};
            if (ids.length === 0) {
              Object.assign(excluded, sessions);
            } else {
              for (const id of ids) {
                if (Object.prototype.hasOwnProperty.call(sessions, id)) excluded[id] = sessions[id];
              }
            }
            return json(res, 200, {
              ok: true,
              excluded,
              // 0.10.0 口径：内存视图的恢复候选（最近活跃列表全部条目——0.20.0 起
              // 默认不限量，含手动停止/正常结束的会话——running 不再过滤），
              // 顶栏开关只对这些会话渲染；
              // 不看排除集合——被排除但仍是候选的会话仍要显示灰色开关。
              // 0.15.0：候选并入暂停集合（暂停所有会话写入的）。
              // 0.17.0：再剔除最后已知状态为正常结束的会话（visibleRestoreCandidateIds
              // 的统一口径，与恢复流程的日志扫描门同向——运行期部分由 session/event
              // 维护，不逐请求扫日志）
              restoreCandidates: Object.fromEntries(
                visibleRestoreCandidateIds().map((id) => [id, true]),
              ),
            });
          }

          if (sub === '/state' && method === 'POST') {
            const body = await readJsonBody(req, MAX_BODY_BYTES);
            const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
            if (!sessionId || sessionId.length > MAX_SESSION_ID_LEN) {
              return json(res, 400, { ok: false, error: `sessionId must be a non-empty string of at most ${MAX_SESSION_ID_LEN} chars` });
            }
            if (!body || typeof body.excluded !== 'boolean') {
              return json(res, 400, { ok: false, error: 'excluded must be a boolean' });
            }
            const sessions = readExclusions(exclusionsFile);
            let excludedAt = null;
            if (body.excluded) {
              excludedAt = new Date().toISOString();
              sessions[sessionId] = excludedAt;
              // 上限裁剪：超出丢最旧（excludedAt 解析失败按 0，即最早）
              const ids = Object.keys(sessions);
              if (ids.length > MAX_EXCLUSIONS) {
                ids.sort((a, b) => (Date.parse(sessions[a]) || 0) - (Date.parse(sessions[b]) || 0));
                for (const id of ids.slice(0, ids.length - MAX_EXCLUSIONS)) delete sessions[id];
              }
            } else {
              delete sessions[sessionId];
            }
            if (!writeExclusions(exclusionsFile, sessions)) {
              return json(res, 500, { ok: false, error: 'could not persist excluded-sessions.json' });
            }
            // 0.11.0：排除集合变化 → 广播 ws 快照（首发立即，各标签页自动对齐；
            // 本请求的发起方也经广播确认，与乐观更新收敛到同一服务端口径）
            pushStateSnapshot();
            return json(res, 200, { ok: true, sessionId, excluded: body.excluded, excludedAt });
          }

          if (sub === '/restarts' && method === 'GET') {
            // 0.5.0：只读重启日志（时间正序返回，客户端自行倒序展示）
            return json(res, 200, { ok: true, entries: readRestarts(restartsFile), max: MAX_RESTART_LOG_ENTRIES });
          }

          // ---- 0.8.0：重启引擎路由（enableRestart=false 时整体不存在） ----
          if (enableRestart && sub === '/restart/info' && method === 'GET') {
            // 供设置弹窗「重启」section 展示：模式（helper / pid1-exit）、
            // 优雅退出通道是否可用、重启后将自动恢复的会话明细。
            // 0.9.0：候选与恢复流程同口径剔除归档会话（含其 subagent 后代），
            // 拿不到 workspaceRegistry 时维持现口径。
            // 0.13.0：runningCandidates 从 string[] 升级为对象数组
            // [{ id, at, running, title? }]（真实最后活跃时间/运行态/防御式标题），
            // 客户端「确认重启」后据此展示待恢复会话列表；归档剔除口径不变
            // 0.18.0：明细行再加 workspace（所属工作区完整路径，未知 ''），
            // 客户端待恢复列表按工作区分组展示；其余字段与口径零改动
            return json(res, 200, {
              ok: true,
              mode: restartMode,
              pid: process.pid,
              instanceId,
              appExit: appExitState(),
              isContainer: inContainer,
              restartDelayMs,
              pid1ExitCode,
              runningCandidates: restartInfoCandidates(),
              // 0.15.0：「暂停所有会话」按钮的渲染开关（客户端仅 info.pauseAll === false 时隐藏）
              pauseAll: enablePauseAll,
              // 0.22.0：注册后守门自动重启的武装状态（排障用便宜字段，读现值；
              // armed=true = 本进程武装了「全部会话完成后自动重启」守门器）
              autoRestart: {
                armed: autoRestartArmed,
                armedAt: autoRestartArmState?.armedAt ?? null,
              },
            });
          }

          if (enableRestart && sub === '/restart/health' && method === 'GET') {
            // helper 的就绪门控（instanceId 变更 + restartId 匹配）与客户端
            // 重启回执轮询都打这里；无需任何参数，围栏与本前缀其余路由一致
            return json(res, 200, restartHealthPayload());
          }

          if (enableRestart && sub === '/restart' && method === 'POST') {
            // 二次确认在客户端（默认焦点「取消」的确认框）；服务端只负责
            // 防重入与围栏。幂等入口：按钮、命令、模型工具共用一个闩。
            // 0.15.0 反向互斥：暂停进行中拒绝重启（防止边暂停边重启的中间态；
            // 重启进行中 /pause-all 侧同样会拒绝）
            if (pauseLatch.current() !== null) {
              return json(res, 409, { ok: false, error: 'pause-all already in progress' });
            }
            if (!restartLatch.claim('restart')) {
              return json(res, 409, { ok: false, error: 'restart already in progress' });
            }
            const result = await performRestart(buildOriginRecord('settings-ui'));
            if (!result.ok) restartLatch.release();
            return json(res, result.ok ? 200 : 500, result);
          }

          if (enableRestart && sub === '/restart/ack' && method === 'POST') {
            // 客户端展示「已重启」toast 后回执：只清 toast 标记，
            // /restart/health 的 restart 身份块保留整个进程生命周期
            restartNoticePending = false;
            return json(res, 200, { ok: true, action: 'ack' });
          }

          // ---- 0.15.0：暂停所有会话（enablePauseAll=false 时路由不存在） ----
          if (enablePauseAll && sub === '/pause-all' && method === 'POST') {
            // 双向互斥：重启进行中（进程即将退出）拒绝暂停；
            // 暂停进行中并发请求被 pauseLatch 拦下（409 + 稳定文案）
            if (restartLatch.current() !== null) {
              return json(res, 409, { ok: false, error: 'restart already in progress' });
            }
            if (!pauseLatch.claim('pause-all')) {
              return json(res, 409, { ok: false, error: 'pause-all already in progress' });
            }
            try {
              const result = await performPauseAll();
              return json(res, result.ok ? 200 : 503, result);
            } finally {
              pauseLatch.release();
            }
          }

          // ---- 0.26.0：「上次重启无法恢复」store（enableRestart=false 时整体不存在，
          //      与 /restart/* 同一门控；围栏与本前缀其余路由一致） ----
          if (enableRestart && sub === '/unrestored' && method === 'GET') {
            // 只读列表（store 倒序 = 新在前；空 → rows: []）。客户端 404 =
            // 混合版本窗口静默不显示（照 /restarts 404 口径）
            return json(res, 200, { ok: true, rows: readUnrestored(unrestoredFile) });
          }

          if (enableRestart && sub === '/unrestored/restore' && method === 'POST') {
            // 手动恢复：body { sessionId }（校验与响应风格照 POST /state）
            const body = await readJsonBody(req, MAX_BODY_BYTES);
            const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
            if (!sessionId || sessionId.length > MAX_SESSION_ID_LEN) {
              return json(res, 400, { ok: false, error: `sessionId must be a non-empty string of at most ${MAX_SESSION_ID_LEN} chars` });
            }
            const result = await performUnrestoredRestore(sessionId);
            return json(res, result.ok ? 200 : 500, result);
          }

          return json(res, 404, { ok: false, error: `no dsh-resume-on-restart endpoint ${sub}` });
        } catch (err) {
          return json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    }), 'dsh-resume-on-restart: http state routes');

    // 5.1 ws 状态推送服务（0.11.0，lib/ws-state.js；0.12.0 起迁移宿主主端口）：
    //     零依赖最小 RFC6455 服务端逻辑（升级处理器 + 推送 hub），经宿主
    //     webServer.registerUpgrade 挂在主端口的精确路径 HTTP_BASE + '/ws' 上
    //     （宿主 'upgrade' 事件按 pathname 精确分发、对升级路由不做围栏/认证，
    //     由 handler 全权负责），不再自建 http.Server bind 0.0.0.0 + 随机端口——
    //     随机端口曾迫使整套跨端口拓扑补丁（跨端口围栏误拒回退、容器 NAT 跳过、
    //     端口经 /ws-info 下发与重启后重拉），同源后一并成为纯防御；
    //     - 升级握手校验随机 token（ws-state 内 timing-safe）+ 本闭包注入的信任围栏
    //       （verifyWsUpgrade，0.11.1 重构裁决顺序：宿主 connection 认证 401 直接
    //       拒绝；403 不再照单全收——宿主围栏的 sec-fetch-site 与 Origin host:port
    //       精确匹配两条规则为同端口 HTTP API 设计，随机端口时代用于回退裁决；
    //       0.12.0 同源后正常路径先命中「宿主围栏放行」的快速分支，该回退保留为
    //       防御；undefined=宿主放行维持放行；null=宿主未提供服务，回退本插件
    //       围栏 explainWsUpgradeTrust），不信任直接 destroy；
    //     - 拒绝日志经节流去重（同 reason|socket|cid 60s 窗口一条 + 累计抑制数补报，
    //       每条带 reason/remote/Host/Origin/cid 明细），客户端既定设计的无限重试
    //       不再把服务端日志刷屏；
    //     - 宿主不支持 registerUpgrade（旧版宿主）或注册失败只 console.warn 降级
    //       （wsPush 保持 null，/ws-info 相应 503，客户端保持无限重试，开关退化为
    //       挂载时的一次性 GET /state），绝不炸插件加载；
    //     - 生命周期跟着本 effect 走：dispose 时移除升级路由（registerUpgrade 的
    //       disposer）+ 关闭全部连接（wsPush.close()）。
    ctx.effect(() => {
      // 防御式探测：registerUpgrade 是宿主较新的升级路由能力，旧版宿主没有——
      // 只降级（wsPush 保持 null、/ws-info 503），绝不炸插件加载
      if (typeof webServer.registerUpgrade !== 'function') {
        console.warn('[resume-on-restart] ws: host webServer.registerUpgrade unavailable, state push disabled');
        return;
      }
      /** ws 升级拒绝日志节流器（本插件实例生命周期内一份节流表）。 */
      const warnWsUpgradeRejected = createWsUpgradeRejectLogger();
      /** ws 升级围栏：token 在 ws-state 内校验，这里只做信任判断，false = 直接 destroy。
       *  boundHost 维持传 '0.0.0.0'（最严口径：宿主全接口绑定时仍要求来源 socket
       *  在本机；宿主只绑 loopback 时远程来源本就不可达）。
       *  0.11.1 起容器内（apply 时 stat 一次 /.dockerenv）跳过 socket-not-loopback
       *  检查（端口发布 NAT 下合法浏览器来源必非 127.0.0.1），其余规则不变。 */
      const verifyWsUpgrade = (req) => {
        const cid = wsUpgradeCid(req);
        const hostRejection = connectionRejection(ctx, req);
        // 宿主 connection.requestRejection 裁决（connectionRejection 归一为
        // 401/403/undefined/null 四值）：
        // - undefined：宿主围栏放行 → 维持现状直接放行（0.12.0 同源后为正常路径）；
        // - 401：未认证，语义不变 → 拒绝（走节流日志）；
        // - 403 / null（宿主未提供该服务）：403 不再直接拒绝——宿主 HTTP 围栏要求
        //   Origin 与请求 host:port 精确同源、且对跨端口 ws 必报的
        //   sec-fetch-site: cross-site 一票否决，两条都为同端口 HTTP API 设计，
        //   随机端口时代原样套用导致每次握手必 403（ws 永远连不上，客户端按既定
        //   设计无限重试 → 拒绝日志每 1~5 秒刷屏）；一律回退本插件的 ws 拓扑适配
        //   围栏（explainWsUpgradeTrust）裁决。0.12.0 同源后 403 应不再出现，
        //   回退保留为防御（对宿主围栏规则变化的兜底）。
        if (hostRejection === undefined) return true;
        if (hostRejection === 401) {
          warnWsUpgradeRejected(req, 'not-authenticated', cid);
          return false;
        }
        const verdict = explainWsUpgradeTrust(req, declaredTrustedHosts(ctx), '0.0.0.0', resolveWebPort(), inContainer);
        if (verdict.trusted) return true;
        warnWsUpgradeRejected(req, verdict.reason, cid);
        return false;
      };
      wsPush = createWsStatePush({ snapshot: buildWsSnapshot, verifyUpgrade: verifyWsUpgrade });
      let disposeUpgrade;
      try {
        // 同名精确路径被占（理论上只有本插件自己）等注册失败：只降级，不炸插件加载
        disposeUpgrade = webServer.registerUpgrade({
          path: `${HTTP_BASE}/ws`,
          handler: (req, socket, head) => wsPush?.handleUpgrade(req, socket, head),
        });
      } catch (err) {
        console.warn('[resume-on-restart] ws: registerUpgrade failed, state push disabled:', err);
        wsPush?.close();
        wsPush = null;
        return;
      }
      console.log(`[resume-on-restart] ws: state push serving at ${HTTP_BASE}/ws (host web server port)`);
      return () => {
        disposeUpgrade();
        wsPush?.close();
        wsPush = null;
      };
    }, 'dsh-resume-on-restart: ws state push');
  });

  // 5.5 /restart 命令（0.8.0，对齐 dsh-power-button 的入口集合）：与按钮共用
  //     同一个防重入闩，命令与按钮点击不会各自起一次重启。因果会话取发起命令
  //     的 agent（origin.kind='command'），重启日志因此能标注来源。名称冲突
  //     （其他插件已注册 restart）记日志让位，不影响本插件其余能力。
  if (enableRestart) {
    ctx.effect(() => {
      // 防御式探测（同 sessionController）：commands 不在静态 inject（['agents']）里，
      // cordis v4 对未声明服务属性的裸读必抛（cannot get property "commands" without
      // inject），会把 apply 炸断；reflect.get 非阻塞读取，服务缺失/未激活返回
      // undefined → 直接 return 跳过注册（缺服务不阻塞、优雅降级）。
      const commands = ctx.reflect?.get?.('commands');
      if (typeof commands?.register !== 'function') return;
      try {
        commands.register({
          name: 'restart',
          description: '重启 DeepSeek Harness（重载插件与配置；会话将在重启后自动恢复）',
          recordInput: false,
          async handler(invocation) {
            if (!restartLatch.claim('restart')) {
              return { kind: 'error', text: '重启已在进行中，请勿重复触发' };
            }
            const sessionId = invocation?.agent?.session?.id;
            const result = await performRestart(buildOriginRecord('command', sessionId));
            if (!result.ok) restartLatch.release();
            return result.ok
              ? { kind: 'success', text: result.note ?? 'DeepSeek Harness 正在重启' }
              : { kind: 'error', text: result.error ?? '重启失败' };
          },
        });
      } catch (error) {
        if (!String(error).includes('already registered')) throw error;
        console.log('[resume-on-restart] command "restart" already registered by another plugin, skip');
      }
    }, 'dsh-resume-on-restart: restart command');

    // 5.6 restart_harness 模型工具（0.8.0，名称与 dsh-power-button / anweat/dsh-restart
    //     一致，先到先得；被占用即让位）。delayMs 下限 1000ms：模型绝不能在自身
    //     turn 结算前杀掉进程。因果会话取 exec.agent（origin.kind='model-tool'）。
    if (enableModelTool) {
      ctx.effect(() => {
        // tools 已在静态 inject（['agents', 'tools']，0.27.0 起）里声明，插件 fiber
        // 等 tools 服务激活后才 apply，fresh boot 时这里的注册必成功；reflect.get
        // 非阻塞读取保留作双保险/防御式探测——服务缺失/未激活返回 undefined →
        // 直接 return 跳过注册（缺服务不阻塞、优雅降级，warn 可见不静默）。
        const tools = ctx.reflect?.get?.('tools');
        if (typeof tools?.register !== 'function') {
          console.warn('[resume-on-restart] tools service unavailable at apply, skip restart_harness model tool registration');
          return;
        }
        try {
          tools.register({
            name: 'restart_harness',
            description: '重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。'
              + '由 dsh-resume-on-restart 提供：普通进程经 detach helper 握手后原命令行原端口拉起；'
              + '容器内 PID=1 时进程优雅退出、由容器重启策略拉起。'
              + '触发后当前连接短暂中断，网页轮询到新实例后自动刷新；重启前运行中的会话会被本插件自动恢复。'
              + '返回 ok 与说明文本。',
            parameters: {
              type: 'object',
              properties: {
                delayMs: {
                  type: 'number',
                  description: `旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 ${restartDelayMs}，上限 ${maxDelayMs}。`,
                },
              },
            },
            output: {
              // 空 schema（仅注解）：raw register 会把 schema 直接交给
              // assertSupportedJsonSchema，它不认识 'json' 这类作者侧标记值
              schema: {},
              render(_args, value) {
                return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
              },
            },
            async execute(args, exec) {
              const clamped = clampModelDelayMs(Number(args?.delayMs), maxDelayMs);
              if (!restartLatch.claim('restart')) {
                return { ok: false, error: 'restart already in progress' };
              }
              const sessionId = exec?.agent?.session?.id;
              const result = await performRestart(buildOriginRecord('model-tool', sessionId), clamped);
              if (!result.ok) restartLatch.release();
              return result;
            },
          });
        } catch (error) {
          if (!String(error).includes('already registered')) throw error;
          console.log('[resume-on-restart] tool "restart_harness" already registered by another plugin, skip');
        }
      }, 'dsh-resume-on-restart: restart_harness tool');
    }

    // 5.7 register_restart_recovery 模型工具 + register-restart-recovery 技能（0.19.0）：
    //     会话主动登记「重启后自动恢复」资格。技能正文指导模型调用模型工具；
    //     tools 已在静态 inject（['agents', 'tools']，0.27.0 起）里声明，ctx.reflect.get
    //     保留作双保险/防御式探测（缺服务不阻塞、优雅降级，warn 可见不静默），
    //     只降级不炸插件加载（同 restart_harness）；skills 仍不在静态 inject，运行时探测。
    if (enableModelTool) {
      ctx.effect(() => {
        // 模型工具：add（默认，登记）/ remove（取消登记）。登记当前会话为主动
        // 注册重启恢复，写入 proactive-restore.json（内存 Map + 写回，上限裁剪）。
        const tools = ctx.reflect?.get?.('tools');
        if (typeof tools?.register === 'function') {
          try {
            tools.register({
              name: 'register_restart_recovery',
              description: '注册当前会话的重启恢复行为（dsh-resume-on-restart 提供），两种模式由 activate 参数选择：'
                + '① 默认（activate 不传或 true）＝重启后自动恢复本会话：重启完成后自动恢复本会话并注入继续提示，'
                + '接着之前的工作继续；适合重启后还要回到本会话继续干的场景（如安装/更新插件、修改需重启的配置，'
                + '等待重启生效后继续干活）。② activate=false＝注册但不激活本会话：同样会在所有会话完成后自动触发'
                + '一次重启，但重启后本会话保持关闭，不会被自动拉起、不注入任何继续提示；会话仍登记在待恢复列表'
                + '（带「不激活」徽标），需要时可手动恢复；适合工作已收尾、只需触发重启让改动生效，或不想重启后'
                + '本会话抢焦点的场景。两种模式口径一致：注册后插件会等所有会话完成（会话不在 running 即算完成，'
                + '正在向用户提问等待回答也算完成）自动触发一次重启；action=remove 取消登记（不区分模式，'
                + '全部取消后自动解除自动重启）。返回 { ok, sessionId, activate, ... }。',
              parameters: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['add', 'remove'],
                    description: 'add=注册（默认），remove=取消注册',
                  },
                  activate: {
                    type: 'boolean',
                    description: '重启后是否自动激活本会话（仅 action=add 生效，默认 true）。'
                      + 'true=重启后自动恢复本会话并注入继续提示（默认行为）；'
                      + 'false=注册但不激活：重启照常自动触发，但本会话不被拉起、不注入继续提示，'
                      + '保留在待恢复列表（带「不激活」徽标）可手动恢复',
                  },
                },
              },
              output: {
                // 空 schema（仅注解）：与 restart_harness 同款（raw register 直接把
                // schema 交给 assertSupportedJsonSchema，不识别作者侧标记值）
                schema: {},
                render(_args, value) {
                  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
                },
              },
              async execute(args, exec) {
                // ////////////////  校验参数  start  ////////////////////////////////////////////////
                const sessionId = exec?.agent?.session?.id;
                if (typeof sessionId !== 'string' || !sessionId) {
                  return { ok: false, error: 'no session context' };
                }
                const action = args?.action === 'remove' ? 'remove' : 'add';
                // ////////////////  校验参数  end ////////////////////////////////////////////////

                // ////////////////  核心逻辑  start  ////////////////////////////////////////////////
                if (action === 'remove') {
                  // 取消登记：已登记才移除并写回；未登记幂等返回（不写盘）
                  if (!proactiveRestore.has(sessionId)) {
                    // 0.22.0：remove 成功且已无任何主动注册 → 解除武装（删武装文件
                    // + 清守门器；未登记分支同样结清，避免「零注册却仍武装」的悬空态）
                    if (proactiveRestore.size === 0) {
                      removeAutoRestartArm(autoRestartFile);
                      disarmAutoRestart();
                      console.log('[resume-on-restart] auto-restart disarmed: no proactive registration left');
                    }
                    return { ok: true, sessionId, action, removed: false, message: 'not proactively registered' };
                  }
                  proactiveRestore.delete(sessionId);
                  writeProactiveRestore(proactiveRestoreFile, capProactiveRestore(Object.fromEntries(proactiveRestore), MAX_PROACTIVE_RESTORE));
                  // 0.22.0：remove 成功且已无任何主动注册 → 解除自动重启武装
                  //（删武装文件 + 清守门器 timer；武装文件缺失/删除失败只影响
                  // 下次开机的消费打点，不影响本次登记移除）
                  if (proactiveRestore.size === 0) {
                    removeAutoRestartArm(autoRestartFile);
                    disarmAutoRestart();
                    console.log('[resume-on-restart] auto-restart disarmed: no proactive registration left');
                  }
                  return { ok: true, sessionId, action, removed: true };
                }
                // 登记（add）：当前时间为注册时间，best-effort 拿标题（拿不到不带）。
                // 0.23.0：activate 仅显式 false（注册但不激活）时落盘 entry.activate=false，
                // true/缺失一律不写该字段（旧文件字节不变），恢复流程据此跳过自动恢复
                const registeredAt = new Date().toISOString();
                const activate = args?.activate !== false;
                const entry = { at: registeredAt };
                if (!activate) entry.activate = false;
                const titleOf = sessionTitleLookup();
                const title = typeof titleOf === 'function' ? titleOf(sessionId) : null;
                if (typeof title === 'string' && title) entry.title = title;
                proactiveRestore.set(sessionId, entry);
                // 超上限丢最旧；内存 Map 与写盘同一份（裁剪后的），两者始终一致
                const capped = capProactiveRestore(Object.fromEntries(proactiveRestore), MAX_PROACTIVE_RESTORE);
                proactiveRestore.clear();
                for (const [id, value] of Object.entries(capped)) proactiveRestore.set(id, value);
                writeProactiveRestore(proactiveRestoreFile, capped);
                // 0.22.0：登记成功路径末尾武装「全部会话完成后自动重启」守门器
                //（幂等；写盘失败只告警不武装、不影响登记结果，见 armAutoRestart）
                const autoRestartArmedNow = armAutoRestart(sessionId);
                return { ok: true, sessionId, action, registeredAt, activate, title: entry.title, autoRestartArmed: autoRestartArmedNow };
                // ////////////////  核心逻辑  end ////////////////////////////////////////////////
              },
            });
          } catch (error) {
            if (!String(error).includes('already registered')) {
              console.warn('[resume-on-restart] tool "register_restart_recovery" register failed:', error);
            } else {
              console.log('[resume-on-restart] tool "register_restart_recovery" already registered by another plugin, skip');
            }
          }
        } else {
          console.warn('[resume-on-restart] tools service unavailable at apply, skip register_restart_recovery model tool registration');
        }

        // 技能：ctx.skills.register 注册全局技能（agent 技能目录可见），正文指导模型
        // 调用 register_restart_recovery。注册返回的 disposer 不随本插件 ctx 自动失效，
        // 用 effect 返回的清理函数显式挂回（同 rules-auto 模式）——任务给的
        // `ctx.effect(() => dispose())` 会在注册后立即 dispose（effect 体立即执行），
        // 这里改为把 dispose 作为 effect 的清理函数返回，卸载时再调用。
        const skills = ctx.reflect?.get?.('skills');
        if (typeof skills?.register === 'function') {
          let disposeSkill = null;
          try {
            disposeSkill = skills.register({
              name: 'register-restart-recovery',
              description: '注册当前会话的重启恢复行为（注册后等所有会话完成自动触发一次重启）：默认「重启后自动恢复并继续」；activate=false 则「重启但不激活本会话」',
              // dsh-skill validateDefinition 强制要求 source 为字符串，缺失则 skill 工具加载正文报错；'runtime' 是官方 SkillSource 枚举值
              source: 'runtime',
              whenToUse: '当前会话需要主动登记重启恢复资格（重启后继续或不激活），或用户要求会话重启后继续/不激活；'
                + '任何需要等待 DSH 重启或 agent 重启的场景都应调用本工具注册',
              content: [
                '# 注册重启恢复',
                '',
                '当前会话可以主动登记重启恢复行为，并让插件在所有会话完成后自动触发一次 DSH 重启。',
                '调用 `register_restart_recovery` 模型工具完成注册，两种模式由 `activate` 参数选择。',
                '',
                '## 模式一：重启后自动恢复（默认，activate 不传或 true）',
                '',
                '登记「重启后自动恢复」：重启完成后本会话会被自动恢复并注入继续提示，接着之前的工作继续。',
                '适合重启后还要回到本会话继续干的场景：装插件/更新插件、修改需重启的配置等，等待重启生效后继续干活；',
                '也适合长任务希望重启后自动续跑、用户明确要求「重启后恢复本会话」的场景。',
                '',
                '## 模式二：注册但不激活（activate=false）',
                '',
                '登记「重启但不激活本会话」：同样会在所有会话完成后自动触发重启，但重启后本会话保持关闭，',
                '不会被自动拉起、不注入任何继续提示；会话仍登记在待恢复列表（带「不激活」徽标），需要时可手动恢复。',
                '适合工作已收尾、只需触发重启让改动生效，或不想重启后本会话抢焦点的场景。',
                '',
                '## 注册后的行为（两种模式一致）',
                '',
                '注册（action=add）成功后，插件会监视**所有**会话；当所有会话都完成时，自动触发一次 DSH 重启。',
                '「完成」的口径：会话不在 running 即算完成；**正在向用户提问等待回答（提问中）的会话也算完成**。',
                '工作流建议：需要等待重启的操作（装插件/改配置等）完成后立即调用本工具注册，',
                '然后继续当前会话的其余工作；全部会话收尾（含挂起的用户提问）后重启会自动发生，无需手动触发。',
                '',
                '## 操作',
                '',
                '模式一（默认，无需参数）：',
                '',
                '```',
                'register_restart_recovery',
                '```',
                '',
                '模式二（注册但不激活）：',
                '',
                '```',
                'register_restart_recovery { "activate": false }',
                '```',
                '',
                '返回 `{ ok: true, sessionId, registeredAt, activate }`，activate 回显本次登记的模式。',
                '如需取消注册，调用 `register_restart_recovery` 并传 `{ action: "remove" }`',
                '（不区分模式；所有登记都取消后自动解除自动重启）。',
              ].join('\n'),
              // 宿主 skills/list（Web 技能菜单）与用户点名注入按 userInvocable 过滤，false=界面不显示、仅模型目录与 skill 工具可用
              invocation: { modelInvocable: true, userInvocable: false },
            });
            console.log('[resume-on-restart] skill "register-restart-recovery" registered');
          } catch (err) {
            console.warn('[resume-on-restart] skill "register-restart-recovery" register failed:', err);
          }
          // 卸载时清理注册（disposer 不随 ctx 自动失效，须显式挂回）
          return () => {
            if (typeof disposeSkill === 'function') {
              try { disposeSkill(); } catch { /* 卸载期清理失败只降级 */ }
            }
          };
        }
        return undefined;
      }, 'dsh-resume-on-restart: register_restart_recovery tool & skill');
    }
  }

  // 6. 若发生重启：先写一条 boot 记录（重启日志），再尝试自动恢复重启前活跃的
  //    会话（每个候选结算时追加 restore 记录），全部失败再回退旧行为
  if (wasRestart) {
    // 6a. 停机归因：读 pending-shutdown.json（本插件 SIGTERM/SIGINT 兜底 flush 时写入），
    //     读不到回退旧 marker 的 when 字段（0.4.x 兼容），都没有 = crash / 强杀 / 容器重启。
    //     文件读后即删：归因只消费一次，避免遗留存根把后续 crash 误归因为 signal。
    const pendingShutdown = readJsonFileIfExists(pendingShutdownFile);
    const shutdown = attributeShutdown(pendingShutdown, marker?.when);
    removeFileBestEffort(pendingShutdownFile);
    // 6b. origin 匹配：committedAt 落在 [上次启动, 本次启动] 的最近一条 power-restart 记录；
    //     没有命中 → null（原因归 shutdown 侧：signal / crash）
    const originRecord = pickOriginRecord(readPowerRestartRecords(powerRestartDir), prevBootMs, Date.parse(bootAt));
    const origin = originRecord ? {
      // 0.8.0：source 由记录本身决定（本插件 ror- 前缀 → restart-button 标签；
      // 其余 → 既有 power-button 标签），detect.shutdownReasonOf 据此区分
      source: originSourceOf(originRecord),
      restartId: typeof originRecord.restartId === 'string' ? originRecord.restartId : null,
      kind: typeof originRecord.origin?.kind === 'string' ? originRecord.origin.kind : null,
      sessionId: typeof originRecord.origin?.sessionId === 'string' ? originRecord.origin.sessionId : null,
      requestedAt: typeof originRecord.requestedAt === 'string' ? originRecord.requestedAt : null,
    } : null;
    // 6c. boot 记录先落盘，restore 记录才会紧随其后（设置弹窗按此顺序分组展示）
    appendRestartLog({
      type: 'boot',
      at: bootAt,
      prevBootAt,
      downtimeMs,
      pid: process.pid,
      prevPid: marker?.pid ?? null,
      startAt: startAtMs,
      prevStartAt: typeof marker?.startAt === 'number' ? marker.startAt : null,
      detectBasis: detectBasisOf(marker, process.pid),
      reason: shutdownReasonOf(shutdown, origin),
      shutdown,
      origin,
      // 本次参与恢复的候选（播种自上次 marker 的全部有效条目，含手动停止的；
      // running 如实取条目最后已知值，仅作记录）
      runningSessions: recentSessions.map((e) => ({
        id: e.id,
        at: e.at > 0 ? new Date(e.at).toISOString() : '',
        running: e.running === true,
      })),
    });
    ctx.inject(['agents'], (scope) => {
      ctx.effect(() => {
        // 0.26.0：恢复通道共用工具（withTimeout / sessionController 探测与等待 /
        // resumeSession / deliver / deliveredTo / 候选阶段 deadline）已上移 apply 层
        // （见「恢复通道共用工具」段）——续等补跑与 POST /unrestored/restore 手动
        // 恢复要与候选循环共用同一实现（不新造逻辑），且路由闭包在 webServer
        // inject 里拿不到本 effect 的私有作用域。
        /** 给 promise 套超时；无论谁先完成都清掉定时器。 */
        const findTarget = () => {
          try {
            const roots = scope.agents.roots?.() ?? [];
            if (config.target === 'primary') {
              return roots[0] ?? scope.agents.list?.()[0] ?? null;
            }
            return scope.agents.get?.(config.target) ?? null;
          } catch (err) {
            console.warn('[resume-on-restart] agent lookup failed:', err);
            return null;
          }
        };

        // 0.6.0：会话记录根目录复用 apply 层的 sessionsRoot（<DSH_HOME>/sessions），
        // human-prompt 守卫与 0.17.0 正常结束门共用同一目录；正常结束门的扫描器
        // 也复用 apply 层 memoized 的 lastTurnStateOf（completedSessions 播种已
        // 扫过一次的结果直接命中缓存，不重复解压）。
        // 回退：现有行为（config.target 解析 roots[0]，轮询等待最长 20 秒），保证不劣化。
        // 0.6.0：回退目标（roots[0]）可能是一个从未有过用户输入的空会话——向它投递
        // "自主决定下一步"的通知会让模型无人指示自主干活（0.5.x 事故）。因此 deliver
        // 前加门槛：目标会话必须有过真实人工输入，没有（或扫描失败，fail-closed）就
        // 不投递、本轮回退就此收尾，不向 roots 更深处找补。
        // 轮询期间目标不变就一直拦：被拦目标记住 id，不再重复扫描
        let blockedFallbackId = null;
        /** deliver 前的门槛；被拦时记 wake.log + console.warn，返回 false。 */
        const passesHumanPromptGuard = (target) => {
          if (!requireHumanPrompt) return true;
          const id = String(target.id);
          if (id === blockedFallbackId) return false;
          const guard = classifyHumanPromptGuard(
            scanSessionHasHumanPrompt(sessionsRoot, target.id),
            requireHumanPrompt,
          );
          if (guard.deliver) return true;
          blockedFallbackId = id;
          writeWakeLog(markerDir, id, false, guard.error);
          console.warn(`[resume-on-restart] fallback wake skipped for session ${id}: ${guard.error}`);
          return false;
        };

        // 0.17.0：deliver 前的第二道门（正常结束门，与恢复候选同口径）——回退唤醒
        // 目标最后已知状态为「正常结束」（memoized 日志扫描判定）就不投递，不为
        // 正常收工的会话吵它。轮询期间同样按 id 去重：被拦目标不再重复扫描与记日志。
        let blockedCompletedFallbackId = null;
        const passesCompletedGate = (target) => {
          const id = String(target.id);
          if (id === blockedCompletedFallbackId) return false;
          const verdict = classifyCompletedRestoreGate(lastTurnStateOf(id));
          if (verdict.restore) return true;
          blockedCompletedFallbackId = id;
          writeWakeLog(markerDir, id, false, 'fallback wake skipped: session completed normally');
          console.warn(`[resume-on-restart] fallback wake skipped for session ${id}: completed normally`);
          return false;
        };

        // 0.26.0：deliver 前的第三道门——fallback 投递同样按 deliveredTo 防重
        // （防续等补跑与 fallback 并发窗口的重复投递）。补跑侧的去重只覆盖
        // 「fallback 先、补跑后」方向；反方向存在并发窗口：服务恰在 fallback
        // 等待/轮询进行中就绪时，补跑可能先恢复并投递某候选（含最后活跃会话），
        // fallback 随后仍会向同一会话重复投递继续提示。已登记过的不重复投递：
        // wake.log + console.log 留痕（判定是纯 Set 查询，无副作用，无需像
        // 另两道门那样按 id memoize）。
        /** deliver 前的门槛；deliveredTo 已登记过该会话（本 boot 已投递过）返回 false。 */
        const passesDeliveredGate = (target) => {
          const id = String(target.id);
          if (!deliveredTo.has(id)) return true;
          writeWakeLog(markerDir, id, false, 'fallback wake skipped: already delivered (deferred restore)');
          console.log(`[resume-on-restart] fallback wake skipped for session ${id}: already delivered (deferred restore)`);
          return false;
        };

        /**
         * 0.9.1：live 目标轮询落空后的可靠降级。宿主 agents.roots() 只返回"已 live"
         * 的顶层 agent（AgentRegistry.roots），开机若没有任何会话被恢复或打开，
         * 轮询必然落空（历史 wake.log 多条 "no target agent after wait"——降级通知
         * 从此没有出口）。改为升级到 sessionController（与恢复候选同一恢复通道）：
         * 等服务就绪后把 lastSessionId（重启前最近活跃会话；subagent 会话先沿
         * parentSession 上溯到主会话祖先）解析成 live agent 再投递。尊重用户排除、
         * 归档与 human-prompt 守卫（fail-closed），每一步 wake.log 留痕。
         */
        const escalateFallbackWake = async () => {
          try {
            const wait = await waitForSessionController(serviceWaitTimeoutMs);
            if (!wait.controller) {
              writeWakeLog(markerDir, null, false, `fallback wake: sessionController not ready within ${serviceWaitTimeoutMs}ms`);
              console.warn('[resume-on-restart] fallback wake: sessionController not ready within', serviceWaitTimeoutMs, 'ms');
              return;
            }
            const lastSession = typeof lastSessionId === 'string' ? lastSessionId : '';
            const targetId = lastSession ? mainAncestorSessionId(lastSession, sessionHeaderLookup()) : null;
            if (!targetId) {
              console.log('[resume-on-restart] no target agent found after wait, skip wake');
              writeWakeLog(markerDir, null, false, 'no target agent after wait');
              return;
            }
            if (Object.prototype.hasOwnProperty.call(readExclusions(exclusionsFile), targetId)) {
              writeWakeLog(markerDir, targetId, false, 'fallback wake skipped: excluded by user');
              return;
            }
            if (sessionUnderArchivedLineage(targetId, readArchivedSessionIds(), sessionHeaderLookup())) {
              writeWakeLog(markerDir, targetId, false, 'fallback wake skipped: session is archived');
              return;
            }
            // 0.17.0：升级目标同样过正常结束门（最后已知状态正常结束就不唤醒）
            if (!passesCompletedGate({ id: targetId })) return;
            if (!passesHumanPromptGuard({ id: targetId })) return;
            // 0.26.0：fallback 投递同样按 deliveredTo 防重（防续等补跑与 fallback
            // 并发窗口的重复投递）——续等补跑可能已抢先恢复并投递同一会话，
            // 就不再做无谓的 resolveAgent
            if (!passesDeliveredGate({ id: targetId })) return;
            const agent = await resumeSession(targetId, serviceWaitTimeoutMs, { ignoreStageDeadline: true });
            console.log('[resume-on-restart] fallback wake resumed last active session via sessionController:', targetId);
            deliver(agent);
          } catch (err) {
            const reason = err?.message ?? String(err);
            writeWakeLog(markerDir, null, false, `fallback wake failed: ${reason}`);
            console.warn('[resume-on-restart] fallback wake failed:', reason);
          }
        };

        const fallbackWake = () => {
          let target = findTarget();
          if (target) {
            // 0.26.0：fallback 投递同样按 deliveredTo 防重（防续等补跑与 fallback
            // 并发窗口的重复投递）；0.17.0：回退唤醒同样过正常结束门（最后已知
            // 状态正常结束就不投递）
            if (passesDeliveredGate(target) && passesCompletedGate(target) && passesHumanPromptGuard(target)) deliver(target);
            return;
          }
          let waited = 0;
          const timer = setInterval(() => {
            waited += FALLBACK_POLL_MS;
            target = findTarget();
            if (target) {
              clearInterval(timer);
              // 0.26.0：同上——投递前先查 deliveredTo（续等补跑可能已抢先投递）
              if (passesDeliveredGate(target) && passesCompletedGate(target) && passesHumanPromptGuard(target)) deliver(target);
              // 被门槛拦下：本轮不投递，轮询按既有收尾结束（不换目标、不向更深处找补）
            } else if (waited >= FALLBACK_MAX_WAIT_MS) {
              clearInterval(timer);
              console.log('[resume-on-restart] no live target agent after wait, escalate fallback wake via sessionController');
              // 0.9.1：不再就此放弃——升级到 sessionController 解析最近活跃会话投递
              void escalateFallbackWake();
            }
          }, FALLBACK_POLL_MS);
        };

        // 自动恢复候选：已 live 直接投递；未 live 经 sessionController 恢复后投递。
        // 0.5.0：总预算按候选数平摊（剩余预算 / 剩余候选数，每候选最低 5s）；
        // 超出预算的候选不再静默丢弃，逐个记 skipped-budget；失败继续下一个。
        // 0.7.0：进入候选循环前先全局等 sessionController 就绪（独立预算
        // serviceWaitTimeoutMs，不占 restoreTimeoutMs），结果与耗时记入 wake.log；
        // 服务始终未就绪则不逐候选空转，直接返回 false 交由调用方回退 fallbackWake。
        // 0.9.1：不再"首个成功即停"——全量恢复（restoreMax=0）要求每个候选都被
        // 尝试，提前 return 会让其余运行中会话既不恢复也无任何日志。
        // 0.26.0：快等超时不再就此整批放弃——起后台续等任务（逐级递增间隔、
        // serviceWaitMaxMs 总预算）就绪后补跑候选循环；`deferred` 为 true 表示
        // 本次调用本身就是续等补跑（防重入：不再嵌套起任务）。正常路径与续等
        // 补跑走同一实现（成功收尾、簿记、store 清理完全一致）。
        const restoreCandidates = async (candidates, { deferred = false } = {}) => {
          const wait = await waitForSessionController(serviceWaitTimeoutMs);
          writeWakeLog(
            markerDir,
            null,
            wait.controller !== null,
            wait.controller
              ? `sessionController ready after ${wait.waitedMs}ms`
              : `service-wait-timeout: sessionController not ready within ${serviceWaitTimeoutMs}ms`,
          );
          if (!wait.controller) {
            console.warn('[resume-on-restart] sessionController not ready within', serviceWaitTimeoutMs, 'ms, skip all restore candidates');
            // 0.26.0：保持既有返回值（fallback 照旧立即执行），但不再就此结束——
            // 起后台续等任务。仅开机路径起任务（续等补跑自身再超时不重启任务：
            // 同一 boot 只起一个续等任务）
            if (deferred !== true) startDeferredRestoreTask(candidates);
            return { restoredAny: false, restoredIds: [] };
          }
          // 服务已就绪：候选阶段总预算自此起算（全局等待已耗时间不占候选预算）
          deadline = Date.now() + restoreTimeoutMs;
          let restoredAny = false;
          // 0.19.0：记录成功投递的候选 id（主动注册会话恢复成功后从 store 移除）
          const restoredIds = [];
          for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            // 0.6.0 守卫（最前面，先于 agents.get / resumeSession）：候选会话必须有过
            // 真实人工输入才允许自动激活；没有（或扫描失败，fail-closed）就跳过并
            // 记日志，避免把通知灌进从未有用户输入的空会话。
            if (requireHumanPrompt) {
              const guard = classifyHumanPromptGuard(
                scanSessionHasHumanPrompt(sessionsRoot, candidate.id),
                requireHumanPrompt,
              );
              if (!guard.deliver) {
                console.warn('[resume-on-restart] skip restore candidate without human prompt:', candidate.id, guard.error);
                writeWakeLog(markerDir, candidate.id, false, guard.error);
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'skipped-no-human-prompt',
                  error: guard.error,
                  at: new Date().toISOString(),
                });
                continue;
              }
            }
            const remainingMsNow = remainingMs();
            if (remainingMsNow <= 0) {
              console.warn('[resume-on-restart] restore budget exhausted, skip session', candidate.id);
              appendRestartLog({
                type: 'restore',
                bootAt,
                id: candidate.id,
                result: 'skipped-budget',
                error: 'restore budget exhausted',
                at: new Date().toISOString(),
              });
              continue;
            }
            const candidateBudgetMs = Math.max(
              MIN_RESTORE_CANDIDATE_MS,
              Math.floor(remainingMsNow / (candidates.length - index)),
            );
            let agent = null;
            try {
              agent = scope.agents.get?.(candidate.id) ?? null;
            } catch (err) {
              console.warn('[resume-on-restart] live lookup failed for session', candidate.id, ':', err);
            }
            if (!agent) {
              try {
                agent = await resumeSession(candidate.id, candidateBudgetMs);
                console.log('[resume-on-restart] session resumed via sessionController:', candidate.id);
              } catch (err) {
                const reason = err?.message ?? String(err);
                // 0.9.1：subagent routing 持有的会话不能被 resolveAgent 直接恢复
                // （宿主稳定拒绝文案）。候选阶段的 header 拆分（partitionSubagentCandidates）
                // 没跑成时（如 session store 缺失）在这里兜底识别：结算为
                // result:'subagent'，不算失败、绝不记 failed。
                if (SUBAGENT_ROUTING_ERROR.test(reason)) {
                  console.warn('[resume-on-restart] resume session', candidate.id, 'owned by subagent routing, settle as subagent');
                  writeWakeLog(markerDir, candidate.id, false, `resume failed: ${reason}`);
                  appendRestartLog({
                    type: 'restore',
                    bootAt,
                    id: candidate.id,
                    result: 'subagent',
                    error: `resume failed: ${reason}`,
                    at: new Date().toISOString(),
                  });
                  continue;
                }
                console.warn('[resume-on-restart] resume session', candidate.id, 'failed:', reason);
                writeWakeLog(markerDir, candidate.id, false, `resume failed: ${reason}`);
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'failed',
                  error: `resume failed: ${reason}`,
                  at: new Date().toISOString(),
                });
                continue;
              }
            }
            // 投递结果（成功/失败）由 deliver 内部记录 wake.log
            const outcome = deliver(agent, candidate);
            appendRestartLog({
              type: 'restore',
              bootAt,
              id: candidate.id,
              result: outcome.ok ? 'resumed' : 'failed',
              error: outcome.error,
              at: new Date().toISOString(),
            });
            restoredAny = restoredAny || outcome.ok;
            if (outcome.ok) restoredIds.push(candidate.id);
          }
          // 0.26.0：恢复成功的会话从「上次重启无法恢复」store 自动移除——正常路径
          // 与续等补跑共用本函数，一处收尾两种路径同口径（无变化时内部不写盘）
          if (restoredIds.length > 0) removeUnrestoredSessions(restoredIds);
          return { restoredAny, restoredIds };
        };

        // ---- 0.26.0：续等层（service-wait 快等超时后的逐级递增续等补跑） ----
        //
        // 快等（serviceWaitTimeoutMs）超时 → restoreCandidates 保持既有返回值
        // （restoredAny:false，fallbackWake 照旧立即执行），同时本任务在后台按
        // escalationDelayMs 逐级递增（2s/4s/8s/16s/30s 封顶）轮询 sessionController，
        // 总预算 serviceWaitMaxMs。就绪 → 补跑候选循环（restoreCandidates 同一实现：
        // requireHumanPrompt 守卫、restoreTimeoutMs 预算、appendRestartLog 簿记、
        // proactive/unrestored store 清理全部一致）；补跑前按既有口径重过用户排除
        // 集合与正常结束门（等待期间状态可能变化，被剔除的按门既有口径结算、
        // 不强造 resumed），并按 deliveredTo 去重（fallback 已投递的不重复投递）。
        // 预算耗尽 → 剩余候选逐条结算 skipped-service-timeout 并登记
        // 「上次重启无法恢复」store（可经 POST /unrestored/restore 手动恢复）。
        // 防重入：同一 boot 只起一个任务（deferredRestoreStarted + timer 双保险）、
        // 无 running 候选不起；定时器随本 effect dispose 清理。

        /** 续等任务当前排定的定时器（null = 无任务在等；dispose 清理口）。 */
        let deferredRestoreTimer = null;
        /** 续等任务是否已在本 boot 起过（同一 boot 只起一个任务的硬保证）。 */
        let deferredRestoreStarted = false;

        /**
         * 续等任务的排定入口：快等超时的候选在后台等服务就绪后补跑候选循环。
         * 首轮等待 escalationDelayMs(1)=2s，逐轮翻倍封顶 30s；末轮按剩余预算收口。
         * @param {Array<{id: string, at: number, running?: boolean}>} deferredCandidates
         *        快等超时轮里已通过全部门筛选、却因服务未就绪没进循环的候选
         */
        const startDeferredRestoreTask = (deferredCandidates) => {
          // 无 running 候选时不起任务（全是停止/代理占位的候选集，快等超时对
          // 它们本就无感，fallback 照旧即可）
          if (!Array.isArray(deferredCandidates) || deferredCandidates.length === 0) return;
          if (!deferredCandidates.some((candidate) => candidate?.running === true)) return;
          // 防重入：同一 boot 只起一个续等任务（timer 存活期 + 已起过标记双保险）
          if (deferredRestoreTimer !== null || deferredRestoreStarted) return;
          deferredRestoreStarted = true;
          const startedAtMs = Date.now();
          const deadlineMs = startedAtMs + serviceWaitMaxMs;
          let attempt = 0; // 已完成的失败检查轮数（首轮排定按 escalationDelayMs(1)）
          console.log('[resume-on-restart] deferred restore task started: escalating service wait, budget', serviceWaitMaxMs, 'ms for', deferredCandidates.length, 'candidate(s)');
          writeWakeLog(markerDir, null, false, `deferred restore: fast wait timed out, escalating in background (budget ${serviceWaitMaxMs}ms)`);
          /** 排下一轮检查（逐级递增；末轮按剩余预算收口）。 */
          const scheduleNext = (leftMs) => {
            attempt += 1;
            deferredRestoreTimer = setTimeout(() => {
              deferredRestoreTimer = null;
              void tick();
            }, Math.min(escalationDelayMs(attempt), leftMs));
            deferredRestoreTimer.unref?.();
          };
          const tick = async () => {
            const leftMs = deadlineMs - Date.now();
            // 即时探测（不占预算）：服务已就绪 → 立即补跑
            const controller = leftMs > 0 ? getSessionController() : null;
            if (controller) {
              await rerunDeferredRestore(deferredCandidates, Date.now() - startedAtMs, attempt);
              return;
            }
            // 总预算耗尽 → 放弃：剩余候选逐条结算 + 登记「无法恢复」store
            if (leftMs <= 0) {
              await giveUpDeferredRestore(deferredCandidates, Date.now() - startedAtMs);
              return;
            }
            scheduleNext(leftMs);
          };
          scheduleNext(deadlineMs - startedAtMs);
        };

        /**
         * 续等总预算耗尽的放弃结算：剩余候选（deliveredTo 已投递的除外——它们
         * 已收到 fallback 降级通知，不算被静默丢弃）逐条结算
         * result:'skipped-service-timeout' 写 restarts.ndjson + wake.log，并逐条
         * 登记「上次重启无法恢复」store（title/workspace 防御式探测，拿不到省略）。
         * @param {Array<{id: string}>} deferredCandidates 快等超时的候选
         * @param {number} waitedMs 续等实际等待时长（ms）
         */
        const giveUpDeferredRestore = async (deferredCandidates, waitedMs) => {
          const errorText = `sessionController not ready within ${serviceWaitMaxMs}ms (deferred restore gave up after ${waitedMs}ms)`;
          const lookups = { titleOf: sessionTitleLookup(), workspaceOf: sessionWorkspaceLookup() };
          const entries = [];
          for (const candidate of deferredCandidates) {
            // 去重：fallbackWake 已投递过通知的会话跳过（deliveredTo 口径）
            if (deliveredTo.has(candidate.id)) continue;
            console.warn('[resume-on-restart] deferred restore gave up, settle session', candidate.id, ':', errorText);
            writeWakeLog(markerDir, candidate.id, false, `deferred restore give-up: ${errorText}`);
            appendRestartLog({
              type: 'restore',
              bootAt,
              id: candidate.id,
              result: 'skipped-service-timeout',
              error: errorText,
              at: new Date().toISOString(),
            });
            entries.push(buildUnrestoredEntry(candidate, errorText, lookups));
          }
          if (entries.length > 0) registerUnrestoredSessions(entries);
          console.warn('[resume-on-restart] deferred restore gave up after', waitedMs, 'ms:', entries.length, 'session(s) registered as unrestored');
          writeWakeLog(markerDir, null, false, `deferred restore: gave up after ${waitedMs}ms (serviceWaitMaxMs=${serviceWaitMaxMs}ms), ${entries.length} session(s) registered as unrestored`);
        };

        /**
         * 服务就绪后的续等补跑：与正常路径同一实现（restoreCandidates 复用）。
         * 补跑前：1) 重过用户排除集合与正常结束门（等待期间状态可能变化，被剔除
         * 的按门既有口径结算，不强造 resumed；主动注册 bypass 同口径保留）；
         * 2) 按 deliveredTo 去重（fallbackWake 已投递的会话不重复投递）。补跑成功
         * 照常写 resumed 结算与既有簿记（restoreCandidates 内部收尾），wake.log
         * 记一条含 deferred restore 与实际等待时长的说明。
         * @param {Array<{id: string, at: number, running?: boolean}>} deferredCandidates 快等超时的候选
         * @param {number} waitedMs 续等实际等待时长（ms）
         * @param {number} attempts 已失败的续等检查轮数（日志用）
         */
        const rerunDeferredRestore = async (deferredCandidates, waitedMs, attempts) => {
          try {
            // 等待期间可能被用户排除 → 按既有排除口径结算（与开机路径同一实现）
            const exclusions = readExclusions(exclusionsFile);
            const { kept: stillKept, excluded } = filterExcludedCandidates(deferredCandidates, exclusions);
            for (const candidate of excluded) {
              writeWakeLog(markerDir, candidate.id, false, 'excluded by user (deferred restore)');
              appendRestartLog({
                type: 'restore',
                bootAt,
                id: candidate.id,
                result: 'excluded',
                error: 'excluded by user',
                at: new Date().toISOString(),
              });
            }
            // 等待期间可能已正常结束 → 按既有正常结束门口径结算（主动注册 bypass
            // 与开机路径同口径保留）
            const { kept: gated, skipped: skippedCompleted } = filterCompletedCandidates(
              stillKept,
              (id) => lastTurnStateOf(id),
              new Set(proactiveRestore.keys()),
            );
            for (const candidate of skippedCompleted) {
              writeWakeLog(markerDir, candidate.id, false, 'session completed normally (deferred restore)');
              appendRestartLog({
                type: 'restore',
                bootAt,
                id: candidate.id,
                result: 'skipped-completed',
                error: null,
                at: new Date().toISOString(),
              });
            }
            // 按会话 id 去重：fallbackWake 已投递的（deliveredTo）跳过，不重复投递
            const toRestore = gated.filter((candidate) => !deliveredTo.has(candidate.id));
            console.log('[resume-on-restart] deferred restore: service ready after', waitedMs, 'ms (', attempts, 'escalated check(s) ), re-running candidate loop for', toRestore.length, 'session(s)');
            if (toRestore.length === 0) {
              writeWakeLog(markerDir, null, true, `deferred restore: service ready after ${waitedMs}ms, no candidate left to restore`);
              return;
            }
            const outcome = await restoreCandidates(toRestore, { deferred: true });
            // 主动注册 store 移除与正常路径同一实现（「无法恢复」store 的清理在
            // restoreCandidates 收尾内完成，两种路径同口径）
            removeRestoredFromProactiveStore(outcome.restoredIds);
            console.log('[resume-on-restart] deferred restore finished after', waitedMs, 'ms:', outcome.restoredIds.length, '/', toRestore.length, 'resumed');
            writeWakeLog(markerDir, null, true, `deferred restore finished after ${waitedMs}ms: resumed ${outcome.restoredIds.length}/${toRestore.length}`);
          } catch (err) {
            const reason = err?.message ?? String(err);
            console.warn('[resume-on-restart] deferred restore failed:', reason);
            writeWakeLog(markerDir, null, false, `deferred restore failed: ${reason}`);
          }
        };

        // 全程异步化：恢复失败/异常都回退到 fallbackWake，不阻塞插件与事件循环
        (async () => {
          try {
            if (config.restoreSessions !== false) {
              // 0.4.0：候选先按用户排除集合过滤（web 顶栏开关写入的"重启后不自动恢复"），
              // 被排除的候选不参与恢复，但记入 wake.log 便于排查。
              // 0.5.0：同时记入重启日志（result: excluded），设置弹窗可见。
              // 0.17.0：picked 按 mergePausedCandidates 的契约带上 running——
              // pickRestoreTargets 只回 { id, at }，运行态取自播种的 recentSessions
              //（seedRunningOf 同款口径：marker 无该信息回填 true = 重启时仍在运行，
              // 正常结束门据此免扫描直通）。0.15.0 起该字段无消费者所以旧口径无症状，
              // 0.17.0 的门需要它区分"运行中被重启打断"与"已停止/正常结束"。
              const runningOfSeeded = new Map(recentSessions.map((entry) => [entry.id, entry.running === true]));
              const picked = pickRestoreTargets(marker, restoreMax).map((entry) => ({
                ...entry,
                running: runningOfSeeded.get(entry.id) ?? true,
              }));
              // 0.15.0：并入暂停集合（暂停所有会话写入的条目，running:false）——
              // 并集兜底（0.20.0 前窗口时代曾兜底 trackMax 窗口外的暂停会话）；
              // 按 id 去重（recentSessions 优先）、
              // at 新 → 旧、restoreMax 截断。读取后立刻消费：删文件 + 清内存集合，
              // 只发生一次，否则下一次 crash 重启会把已恢复过的暂停会话再恢复一遍。
              const pausedEntries = [...pausedSessions.entries()].map(([id, at]) => ({
                id,
                at: typeof at === 'string' && at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : 0,
                running: false,
              }));
              // 0.19.0：并入主动注册集合（proactive-restore.json，register_restart_recovery
              // 登记的会话——即使不在 recentSessions 窗口也总是恢复候选）。优先级
              // recentSessions > 暂停 > 主动注册（同 id 保留最优先条目的 at/running，
              // 满足「主动注册会话如果被暂停集合覆盖，用暂停集合的 at」与「不在
              // recentSessions 的主动注册会话才需要并入」）；主动注册条目不受
              // restoreMax 截断（「主动注册会话总是恢复」）。
              const proactiveEntries = [...proactiveRestore.entries()].map(([id, value]) => ({
                id,
                at: typeof value?.at === 'string' && value.at && Number.isFinite(Date.parse(value.at))
                  ? Date.parse(value.at)
                  : 0,
                running: runningOfSeeded.get(id) ?? false,
              }));
              const merged = mergeProactiveRestoreCandidates(picked, pausedEntries, proactiveEntries, restoreMax);
              pausedSessions.clear();
              removeFileBestEffort(pausedSessionsFile);
              const exclusions = readExclusions(exclusionsFile);
              const { kept, excluded } = filterExcludedCandidates(merged, exclusions);
              for (const candidate of excluded) {
                writeWakeLog(markerDir, candidate.id, false, 'excluded by user');
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'excluded',
                  error: 'excluded by user',
                  at: new Date().toISOString(),
                });
              }
              // 0.9.0：再按归档名单过滤（在候选阶段就剔除，先于 human-prompt 守卫与
              // agents.get/resumeSession）。被剔除的候选与用户排除同口径结算
              // （wake.log + 重启日志 result: 'archived'，不算失败）；但回退语义不同：
              // 全是归档会话 = 用户有意归档，重启后保持安静，不触发 fallbackWake。
              // registry 缺失 → 空名单 → 不过滤（现口径）；store 缺失 → 只查直系名单。
              const { kept: restorable, archived } = filterArchivedRestoreCandidates(kept);
              for (const candidate of archived) {
                console.log('[resume-on-restart] restore candidate archived, skip session', candidate.id);
                writeWakeLog(markerDir, candidate.id, false, 'session is archived');
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'archived',
                  error: 'session is archived',
                  at: new Date().toISOString(),
                });
              }
              // 0.9.1：再按 session store header 拆出 subagent routing 持有的候选。
              // 它们不能被 resolveAgent 直接恢复（宿主一律拒绝），其工作上下文由
              // 最近的主会话祖先（lead）承载 → 结算为 result:'subagent'（不算失败），
              // 并把祖先作为代理恢复目标并入候选（用户的工作经 lead 继续）。
              // 祖先被用户排除/已归档时不代理（尊重用户意图，安静结算）；
              // store 缺失 → 无法预识别（退化 = 现状），由恢复循环的 RemoteError 兜底。
              const { kept: mainOwned, subagent } = partitionSubagentCandidates(restorable, sessionHeaderLookup());
              const archivedIds = readArchivedSessionIds();
              const proxies = [];
              for (const { candidate, ancestorId } of subagent) {
                let disposition;
                if (typeof ancestorId === 'string' && ancestorId) {
                  if (mainOwned.some((entry) => entry.id === ancestorId)) {
                    disposition = `subagent session; covered by candidate session ${ancestorId}`;
                  } else if (Object.prototype.hasOwnProperty.call(exclusions, ancestorId)) {
                    disposition = `subagent session; ancestor session ${ancestorId} excluded by user`;
                  } else if (archivedIds.has(ancestorId)) {
                    disposition = `subagent session; ancestor session ${ancestorId} is archived`;
                  } else {
                    if (!proxies.some((entry) => entry.id === ancestorId)) {
                      proxies.push({ id: ancestorId, at: candidate.at });
                    }
                    disposition = `subagent session; resume delegated to ancestor session ${ancestorId}`;
                  }
                } else {
                  disposition = 'subagent session; no resumable ancestor session found';
                }
                console.log('[resume-on-restart] restore candidate subagent-owned, settle:', candidate.id, '->', ancestorId ?? 'no ancestor');
                writeWakeLog(markerDir, candidate.id, false, disposition);
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'subagent',
                  error: disposition,
                  at: new Date().toISOString(),
                });
              }
              // 0.17.0：正常结束门——最后已知状态为「正常结束」（会话日志最后一条
              // 真实 turn/end kind === 'completed'）的候选不再恢复；running:true
              // （重启时仍在运行）免扫描直接过，running:false/未知逐个扫描，
              // 文件缺失/解压失败/解析异常保守恢复（宁可多恢复，维持旧行为）。
              // 0.6.0 human-prompt 守卫保持不变，叠加在本门之后（restoreCandidates 内）。
              // 被跳过的候选结算为 result: 'skipped-completed'（error: null，不算失败）。
              const gateInput = [...mainOwned, ...proxies].sort((a, b) => b.at - a.at);
              // 0.22.0：主动注册（proactiveRestore 的会话）免扫描直接过正常结束门——
              // 主动注册 = 用户显式要求总是恢复（技能 0.19.0 起的承诺），绕过 0.17.0
              // 正常结束门；否则「正常收工后才注册」的会话重启后会被
              // skipped-completed 拦下、注册承诺落空。提问中的会话 turn 开着本就
              // 放行，与门原语义一致。bypassIds 为空集合时门行为与 0.17.x 逐字节一致。
              const { kept: candidates, skipped: skippedCompleted } = filterCompletedCandidates(
                gateInput,
                (id) => lastTurnStateOf(id),
                new Set(proactiveRestore.keys()),
              );
              for (const candidate of skippedCompleted) {
                console.log('[resume-on-restart] restore candidate completed normally, skip session', candidate.id);
                writeWakeLog(markerDir, candidate.id, false, 'session completed normally');
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'skipped-completed',
                  error: null,
                  at: new Date().toISOString(),
                });
              }
              // 0.23.0：注册但不激活（activate:false）的候选拆出来（参照 skippedCompleted
              // 的处理模式）——其余一切照旧（登记持久化、武装守门自动重启、上面已 bypass
              // 正常结束门、待恢复列表可见），唯一差别：重启后本会话不自动恢复（不
              // resumeSession、不 deliver、不注入继续提示）。结算 result:'no-activate'
              // （error:null，不算失败）；条目保留在 proactiveRestore（下次重启同样
              // 静默跳过，待恢复列表保持带徽标、可手动恢复）；不参与 restoredAny。
              const noActivate = [];
              const activatable = [];
              for (const candidate of candidates) {
                if (proactiveRestore.get(candidate.id)?.activate === false) noActivate.push(candidate);
                else activatable.push(candidate);
              }
              for (const candidate of noActivate) {
                console.log('[resume-on-restart] restore candidate registered without activation, skip session', candidate.id);
                writeWakeLog(markerDir, candidate.id, false, 'registered without activation (activate=false)');
                appendRestartLog({
                  type: 'restore',
                  bootAt,
                  id: candidate.id,
                  result: 'no-activate',
                  error: null,
                  at: new Date().toISOString(),
                });
              }
              let restored = false;
              if (activatable.length > 0) {
                const outcome = await restoreCandidates(activatable);
                restored = outcome.restoredAny;
                // 0.19.0：已成功恢复的主动注册会话从 store 移除（已恢复不需要保留
                // 资格）；失败/被过滤（排除/归档/正常结束/human-prompt 守卫）的保留
                // （下次重启再试）。只移除成功恢复的，绝不误删其他主动注册条目。
                // 0.23.0：no-activate 条目不进恢复循环，天然不会被移除。
                // 0.26.0：收尾抽成 removeRestoredFromProactiveStore——续等补跑与
                // 开机路径同一实现。
                removeRestoredFromProactiveStore(outcome.restoredIds);
              }
              if (restored) return;
              if (activatable.length > 0) {
                console.warn('[resume-on-restart] no restore candidate succeeded, fall back to primary target');
              } else if (archived.length > 0) {
                console.log('[resume-on-restart] all restore candidates archived, stay quiet (no fallback wake)');
              } else if (skippedCompleted.length > 0) {
                console.log('[resume-on-restart] all restore candidates completed normally, stay quiet (no fallback wake)');
              } else if (noActivate.length > 0) {
                console.log('[resume-on-restart] all restore candidates registered without activation, stay quiet (no fallback wake)');
              } else if (excluded.length > 0) {
                console.warn('[resume-on-restart] all restore candidates excluded by user, fall back to primary target');
              }
              // 0.9.0：回退决策（classifyRestoreFallback）——候选全被归档剔除、或
              // 0.17.0 起全被正常结束门跳过时安静收尾；0.23.0 起全部候选均为
              // 「注册但不激活」（no-activate）结算时同样安静收尾（故意不激活的
              // 重启不吵主会话）；其余情况维持既有回退
              //（无候选/全部用户排除/可恢复候选全部失败）。keptCount 只数真正
              // 进入恢复循环的候选（no-activate 拆出后不计入，否则全部不激活的
              // 候选会错误触发回退）。
              if (!classifyRestoreFallback({
                restored,
                keptCount: activatable.length,
                archivedCount: archived.length,
                skippedCompletedCount: skippedCompleted.length,
                skippedNoActivateCount: noActivate.length,
              }).fallback) return;
            }
          } catch (err) {
            console.warn('[resume-on-restart] restore flow error:', err);
          }
          fallbackWake();
        })();

        // 0.26.0：续等任务的排定定时器随本 effect dispose 清理（插件卸载/作用域
        // 回滚时不留悬挂 timer；已在途的 await 无法中断，但下一轮检查不会排定）
        return () => {
          if (deferredRestoreTimer !== null) {
            clearTimeout(deferredRestoreTimer);
            deferredRestoreTimer = null;
          }
        };
      });
    });
  } else {
    console.log('[resume-on-restart] no restart detected, boot normal');
  }
}

// 0.18.0 的 projectKeyOf / normalizeWorkspaceEntries / buildWorkspaceIdMap、
// 0.26.0 的 escalationDelayMs 在定义处直接 export（纯函数供单测）
export { apply, inject, name };
