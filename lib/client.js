/**
 * dsh-resume-on-restart client half（web 会话顶栏开关 + 设置弹窗重启日志）。
 *
 * 手写 bundle，格式照抄 dsh-power-button/lib/client.js 的范式：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内 require("react")
 * （baseline 模块，无需 dsh.client 声明），用 react.createElement 写组件，
 * 不引 jsx-runtime、不引任何业务包、无构建链。
 *
 * 行为（需求见 README）：
 * - 注册为 `conversation.session.header.actions` 的兄弟条目（与「标准模式」标签同排），
 *   session 作用域插槽组件由框架注入标准 props `sessionId`（当前会话 id，
 *   见 @deepseek-ai/dsh-client-ui-session 对 SessionStandardProps 的 merge 声明）。
 * - 显示门控：只有当前会话属于恢复候选（最近活跃窗口内的会话——0.10.0 起
 *   含手动停止/正常结束的会话，宿主 /state 响应的 restoreCandidates 给出）
 *   才渲染；否则组件返回 null，窗口外/被忽略前缀的会话不显示任何 DOM。
 * - 候选/排除状态同步（0.11.0 起）：挂载/切换会话时一次 GET /state 一次性查询
 *   （兜底首帧，非轮询）+ 订阅宿主 ws 快照推送（lib/ws-state.js；/ws-info 一次性
 *   拿 { token }，连接建立/候选/排除变化都由服务端广播快照，按 sessionId
 *   分发到本组件）；restoreCandidates 未命中当前 id、字段缺失或请求失败
 *   都按「不显示」处理，只 console.warn，不抛错不弹窗。
 * - 点击 POST /api/dsh-resume-on-restart/state，body { sessionId, excluded }；
 *   请求期间防重复点击；失败回滚 UI 状态。
 * - 文案走宿主 locale 服务（zh/en 字典，zh 为权威；0.5.0 起，写法照抄
 *   dsh-prompt-history 的 locale seat），未命中时回退内置 zh 字典。
 *
 * 0.5.0 起新增设置弹窗「重启日志」section（slot `settings.section`，写法照抄
 * dsh-prompt-history）：经宿主只读路由 `GET /api/dsh-resume-on-restart/restarts`
 * 拉取 restarts.ndjson 条目，按 boot 分组倒序展示：时间、原因标签
 * （power-button/signal/crash/unknown）、来源（origin.kind + sessionId 截断）、
 * 停机时长、恢复成功 x/y；点击展开该条 boot 详情与逐会话 restore 明细。
 * 自带样式（一次注入 <style>，全部走 DSH 设计 token，明暗主题自适应）。
 *
 * 0.5.1 容错口径：/restarts 返回 404（插件更新后 DSH 未重启、宿主 half 尚无该路由的
 * 混合版本窗口，或 restarts.ndjson 尚未生成）按空日志展示「暂无重启记录」，不算失败；
 * 401/403/5xx/网络错误等其余失败仍走「重启日志加载失败」报错态，真实故障要暴露。
 *
 * 0.8.0 起新增设置弹窗左侧「重启」选项（第二个 settings.section 条目）+ 重启回执：
 * - section 顶部展示模式说明（helper / 容器 PID=1 的 pid1-exit）、重启后将自动恢复的
 *   会话数（GET /restart/info，与顶栏开关同口径），以及「重启 DSH」按钮；
 * - 按钮先弹**二次确认**模态框（默认焦点「取消」，Esc/点遮罩取消，必须显式点
 *   「确认重启」），确认后 POST /restart 并捕获基线 instanceId，随后轮询
 *   /restart/health——instanceId 变更（或无基线时"见过挂掉再起来"）才刷新页面，
 *   永不把短暂断线当成功；
 * - pid1-exit 模式超时提示容器重启策略未拉起（需手动 docker start），降频继续等待；
 * - 页面加载时 GET /restart/health 看到 restarted 标记（本进程确为重启产物且未被
 *   确认过）→ 顶部弹「已重启」toast 并 POST /restart/ack 消费，刷新不再重弹。
 *
 * 0.9.0：重启日志新增「已归档」结算徽标（result: archived，zh/en 文案 + 紫调
 * 徽标配色）——归档会话与归档会话的 subagent 后代在宿主 half 的候选阶段即被
 * 剔除（不算失败）；设置弹窗「重启后将自动恢复 N 个」的计数同口径剔除归档
 * （服务端 /restart/info 过滤，客户端零改动）。
 *
 * 0.9.1：重启日志新增「子代理会话」结算徽标（result: subagent，zh/en 文案 + 青调
 * 配色）——subagent routing 持有的会话在宿主 half 按主会话祖先代理恢复
 * （不算失败）；/restart/info 的候选数同口径不再包含 subagent 会话（服务端
 * 过滤，客户端零改动）。
 *
 * 0.11.0：顶栏开关的状态同步从「每 15 秒轮询 GET /state」（POLL_INTERVAL_MS +
 * setInterval，及补偿性的 window focus 查询）改为 websocket 快照推送：模块级
 * 单例 ws 管理器懒拉一次 /ws-info（经宿主既有围栏拿接入信息）→ 连接 ws 推送端点
 * （协议随页面 location.protocol）；
 * 服务端连接后立即推全量快照，此后排除集合变化（POST /state 成功）与候选集变化
 * （agent/* 活动事件）都广播同一快照（300ms 合并节流 + 内容去重）。/ws-info 拉取
 * 失败与 ws 连接失败/断开都无限重试（指数退避 1s 起、封顶 5s），永不回退轮询；
 * 重连成功后服务端快照即完成状态重建，多标签页自动对齐。「重启 dsh」功能的轮询
 * （RestartSection 的 /restart/health、checkRestartedToast）是豁免区，保持不动。
 *
 * 0.11.1：ws URL 追加每标签页随机标识 cid（页面加载时生成一次，crypto.randomUUID
 * 优先、Math.random 拼接降级，清洗为 URL 安全字符并截断 ≤64）——ws 升级层没有
 * 会话概念，服务端拒绝日志用它区分来源标签页（配合服务端拒绝日志节流去重）。
 *
 * 0.12.0：ws 从「插件自监听随机端口」迁移到宿主 webServer 主端口的同源路径
 * /api/dsh-resume-on-restart/ws（location.host 自带端口，不再有跨端口拓扑）；
 * /ws-info 不再返回 port，只拿 { ok, token }。无限重试策略不变，每轮重新拉
 * /ws-info（DSH 重启后插件实例重建、token 换新）。
 *
 * 0.13.0：设置弹窗「重启」section 的确认后流程可视化 + 重启后逐会话恢复结果对账：
 * - 「重启 DSH」按钮进入 confirm 弹窗时重新拉一次 /restart/info（点击时刻的最新
 *   口径），waiting 阶段展示「待重启恢复会话列表」：每行 = 会话标题为主（省略号
 *   截断、全文在 title 属性；缺失才退 shortId 弱化显示，完整 id 在行容器 title
 *   属性做悬停提示）+ 最后活跃本地时间（at 缺失显示 —）+ 运行中标记；列表空显示
 *   「无待恢复会话」。waiting 阶段另显示「重启中… 已等待 N 秒」（组件内
 *   setInterval 每秒跳动，离开 waiting/卸载即清理；timedOut 提示逻辑不动）；
 * - POST /restart 成功后把 { at: 确认时刻ISO, restartId?, candidates:
 *   [{id,at,running,title?}] } 覆盖写入 localStorage（key dsh-ror-pending-restore，
 *   try/catch 包裹）；POST 失败回 idle：计时器随 phase 清理，列表保留，按钮可重试；
 * - 页面（重启后自动刷新）重新挂载时读 localStorage 存根（无则什么都不显示），
 *   GET /restarts 匹配 boot 记录（pending.restartId === boot.origin.restartId 优先，
 *   回退 boot.at >= pending.at - 2min 时钟容差的最新一条），收集该 bootAt 之后的
 *   restore 记录按 id 归组，原位把列表变为「上次重启(<时间>)的恢复结果：x/y 已恢复」
 *   + 逐会话结算徽标（resumed/failed/excluded/archived/subagent/skipped-budget/
 *   skipped-no-human-prompt/待结算）；服务端结算是异步的，存在待结算会话时每 3s
 *   短轮询 /restarts（最多 20 次，全部候选有结算记录即提前停），轮询结束仍未结算的
 *   显示「未结算」；定时器卸载时清理。下次点「确认重启」覆盖 localStorage、UI 切回
 *   waiting 列表态。checkRestartedToast 判定逻辑是豁免区，保持不动。
 *   对账匹配/归组逻辑抽成可测纯函数（readPendingRestore / writePendingRestore /
 *   matchPendingBoot / collectSettlementsBySession）并从工厂导出，node --test
 *   经 window.__ModuleLoader__ 桩加载本文件后直接单测（lib/pending-restore.test.js）。
 *
 * 0.14.0：设置弹窗「重启」section 的待恢复列表增加逐行与批量「取消 / 恢复」操作：
 * - 每行行尾按钮：未取消行「取消」= 该会话标记为重启后不自动恢复（复用既有
 *   POST /state，body { sessionId, excluded: true }），乐观更新为已取消态（弱化样式
 *   + 「已取消」徽标，行保留在列表中不许消失，否则无法撤销）；已取消行「恢复」撤销
 *   标记（excluded: false）回到正常态；
 * - 批量工具条（列表标题与行之间）= 全选 checkbox（半选 indeterminate）+「已选 N 项」
 *   计数 +「取消所选」「恢复所选」，无选中行时按钮禁用；批量 = 对选中行逐个**串行**
 *   POST，每会话一次请求；乐观更新 + 失败仅回滚对应行并 console.warn（风格照抄
 *   ResumeToggle.toggle）；
 * - phase === "waiting"（重启已发出）时列表转只读：隐藏 checkbox 与全部操作按钮；
 *   重启后对账视图（settlement）保持只读不动。取消标记只存组件本地 state，不写
 *   localStorage 存根（存根 schema 不变、candidates 仍含全部行，被取消会话重启后由
 *   服务端 restore 记录结算为 excluded，对账视图已有「已被用户排除」徽标）；
 * - openConfirm 口径合并（防「取消后无法恢复」）：pendingRows 已存在时经
 *   mergePendingRows(prev, next) 合并——服务端返回的行为准（cancelled 用本地旧值），
 *   服务端不再返回的行保留并置 cancelled=true；「重启后将自动恢复 N 个」计数在列表
 *   存在时按未取消行数实时显示（activePendingCount）。合并/标记/计数抽成可测纯函数
 *   （mergePendingRows / setPendingCancelled / activePendingCount）从工厂导出，
 *   供 node --test 单测。
 *
 * 0.15.0：设置弹窗「重启」section 的 actions 行新增「暂停所有会话」按钮（「重启 DSH」
 * 左侧，中性 .dsh-ror-btn 非 danger 红；仅 info.pauseAll === false 时隐藏，info 拿不到
 * 照常显示；restart 流程非 idle 时禁用）：点击弹二次确认弹窗（RestartConfirmDialog
 * 泛化出 title/body/confirmLabel/neutral props 供两处共用——默认焦点仍是「取消」，
 * Esc/点遮罩取消，确认按钮中性色）→ 确认后 pausePhase='doing'（两个按钮都禁用 +
 * 「正在暂停…」状态）→ POST /pause-all → 成功展示 formatPauseResult 摘要
 * （stopped 与 failed 全为 0 →「没有正在运行的会话」；否则「已暂停 %s 个会话」+
 * 子代理/失败附加段），并重拉 /restart/info 刷新 info（候选计数与列表运行徽标随暂停
 * 变化；pendingRows 已存在时经 mergePendingRows 合并新口径）；失败展示
 * pause.failed + error 或 HTTP 状态。暂停流程状态（pausePhase/pauseResult/
 * pauseErrorText）与重启流程完全独立、互不覆盖；pausePhase 非 idle 时「重启 DSH」
 * 禁用（双向互斥）。被暂停的会话（含 trackMax 窗口外）由宿主 half 并入候选，
 * 此后无论何种方式重启都会被既有自动恢复流程恢复。
 *
 * 0.16.0：进入「重启」选项卡即自动展示本次待恢复的会话列表（不再等点「重启 DSH」）：
 * - 挂载时既有的 GET /restart/info 拿到响应后，直接经 normalizeCandidateDetails
 *   构建待恢复列表（新列表来源模式 pendingMode = preview）并渲染，与点「重启 DSH」
 *   后的列表（confirm）共用同一构建 renderPendingList——0.14.0 的逐行/批量
 *   「取消 / 恢复」在选项卡内直接可用，空列表照旧显示「无待恢复会话」，
 *   「重启后将自动恢复 N 个」计数按同一行数据 activePendingCount 实时联动；
 * - pendingRows 行数据语义不变（null = 列表未构建），openConfirm 点击时刻重拉 +
 *   mergePendingRows 合并口径保留：preview 阶段的取消标记随合并进入 confirm，
 *   服务端不再返回的行保留并置 cancelled=true；clickedRef 防挂载请求晚到覆盖
 *   点击时刻已合并的列表；waiting 只读、POST 失败回 idle 列表保留，均不变；
 * - 对账视图门控：confirm 列表仍优先于 settlement（0.13.0 语义不变）；preview
 *   列表不遮蔽 settlement——重启后的新页面（存根未覆盖前）两块同时渲染，
 *   列表在上、对账视图在下。
 *
 * 0.17.0：待恢复列表标题行新增「刷新」按钮（preview / confirm 皆可用；waiting
 * 只读态隐藏——该阶段隐藏全部按钮的既有约束不变）：点击重新 GET /restart/info →
 * normalizeCandidateDetails 构建行 → mergePendingRows 合并（保留本地取消标记、
 * 服务端不再返回的行保留并置 cancelled=true，与 openConfirm 同一口径）→ 同步
 * 收窄选中集合 → 更新渲染；拉取中按钮禁用并显示「刷新中…」；失败静默
 * （console.warn，现有列表原样保留，沿用既有错误处理风格）。另有结算徽标新增
 * skipped-completed（宿主 0.17.0 正常结束门的 restore 结算，不算失败）。
 *
 * 0.18.0：待恢复列表按工作区分组展示（preview / confirm / waiting / 对账前的
 * 各阶段同一构建 renderPendingList，分组只改容器结构）：
 * - 数据链路：宿主 /restart/info 候选明细行新增 `workspace`（会话所属工作区 =
 *   项目目录完整路径字符串，未知为 ''）→ normalizeCandidateDetails 透传
 *   （非空字符串才带，旧宿主/未知一律不带 = 未知工作区）→ mergePendingRows
 *   同款合并口径（服务端为准、服务端没带回退本地旧值）→ 纯函数 groupPendingRows
 *   分组：组内按 at 倒序、组间按组内最新 at 倒序、未知工作区组（workspace 缺失
 *   /空串）恒排最后；入参不被修改，从工厂导出供 node --test 单测；
 * - 渲染：行区按组渲染——组头一行 = 工作区完整路径（省略号截断、全文在 title
 *   属性，.dsh-ror-pending-group 小节标题样式），workspace 缺失/空串显示
 *   「未知工作区」（zh/en 字典 restart.pendingUnknownWorkspace）；组内行与
 *   0.13.0/0.14.0 的行完全一致（运行中徽标、标题、时间、已取消徽标与弱化行、
 *   行尾「取消 / 恢复」按钮）；批量工具条与全选语义保持既有（作用于全部组的
 *   全部行）；空列表仍显示「无待恢复会话」；标题行「刷新」按钮与 waiting 只读
 *   门控不变。
 *
 * 0.21.0：重启等待态可视化强化（两次确认后进入 waiting 阶段的感知升级——原实现
 * 只是两段 12px 灰色小字 .dsh-ror-restart-status，混在内容里很难看出已进入等待）：
 * - 醒目横幅卡片 .dsh-ror-waiting 紧跟 section 标题（restart.title 的 h4）之后、
 *   note 段之前，不滚动即可见：CSS 旋转圆环 spinner（.dsh-ror-waiting-spin，
 *   @keyframes dsh-ror-spin .8s 线性无限；prefers-reduced-motion:reduce 下
 *   animation:none）+ 主文案区（i18n restart.waitingTitle 加粗标题 +
 *   restart.waitingSub 副文案）+ 右侧大号 tabular-nums 计时（restart.elapsedBig，
 *   18px 加粗蓝，每秒跳动复用既有 elapsedSec）；
 * - 视口顶部固定提示条 .dsh-ror-waiting-fixed（position:fixed 定位与阴影写法
 *   照抄 .dsh-ror-toast，z-index 同 10001，胶囊圆角蓝底白字）：spinner（白调
 *   覆盖）+ restart.waiting + 分隔的 restart.elapsed 计时，无论滚动到哪都可见；
 * - 原两段 12px 小字 inline waiting 行移除（被横幅 + 固定条取代，不重复显示）；
 *   restart.waiting / restart.elapsed 保留复用于固定条；timedOut 超时提示与
 *   待恢复列表、对账视图、确认/暂停弹窗逻辑全部不动（横幅与固定条均为条件
 *   渲染，离开 waiting 即消失）。
 *
 * 0.23.0：「注册但不激活」模式可视化（宿主 register_restart_recovery 新增
 * activate 参数的客户端配套，仅 false 参与——true/缺失一律不带，风格同 source）：
 * - /restart/info 候选明细行新增 `activate:false`（仅注册但不激活条目携带）→
 *   normalizeCandidateDetails「拿到才带」透传、mergePendingRows 同款合并口径
 *   （服务端为准、服务端这轮没带回退本地旧值、两边都没有则不带）；
 * - 待恢复列表行徽标：source==='skill' && activate===false 优先显示
 *   「注册·不激活」徽标（restart.pendingNoActivate，琥珀调
 *   .dsh-ror-noactivate-badge，与紫调技能注册徽标区分），其余行的既有徽标
 *   逻辑不变；
 * - 结算徽标白名单 SETTLE_RESULTS 增 `no-activate`（settle.no-activate）与
 *   重启日志明细行结果标签（restore.no-activate）同名同配色
 *   （.dsh-ror-result-no-activate，zh「注册不激活」/en「no activate」）——
 *   宿主把不自动恢复的候选结算为 result:'no-activate'（error:null，不算失败）。
 *
 * 0.24.0：设置弹窗「重启」section 的两处待恢复列表行为变更：
 * - 点「重启 DSH」不再遮蔽上一次重启的对账视图：对账视图渲染门从「confirm 列表
 *   存在即不渲染」（0.13.0 语义）放宽为只要 settlement 非 null 就渲染——confirm /
 *   waiting / 失败回 idle 各阶段都是「待恢复列表在上、对账视图在下」的双块堆叠
 *   （0.16.0 preview 模式既有结构的推广）。存根数据链路（readPendingRestore /
 *   matchPendingBoot / 待结算短轮询 / startRestart 覆盖存根）语义不变——重启完成
 *   页面刷新后由新存根展示新一轮对账仍是既有预期；
 * - 进入「重启 DeepSeek Harness」选项卡 = 点下待恢复列表的「刷新」按钮：挂载
 *   effect 与 refreshPendingList 原是两条重复但不完全一致的路径（挂载只在
 *   pendingRows 为 null 时构建、不合并、不收窄选中集合），收敛为共用同一条管线
 *   syncPendingFromInfo——GET /restart/info → setInfo → normalizeCandidateDetails
 *   → mergePendingRows 合并（本地无行直接用服务端行）→ 选中集合同步收窄（只保留
 *   仍存在的行）→ 失败静默（console.warn，现有行原样保留）。挂载入口语义保留：
 *   响应到达时 clickedRef 已置位则只更新 info 不覆盖列表、pendingMode 仅从 none
 *   升为 preview 绝不降级 confirm、卸载 cancelled 防串态；刷新按钮防重入
 *   （refreshing）与「刷新中…」按钮态不变；openConfirm 保持原实现不动。
 *
 * 0.25.0：待恢复列表与对账视图的会话行支持点击跳转 + 对账视图按工作区分组：
 * - 跳转走 dsh 官方方案：工厂 inject 新增 `uiWorkspace`（dsh-client-ui-workspace
 *   的 UiWorkspace 服务，官方 chat / dsh-client-ui-conversation 同款用法），apply
 *   时经 setUiWorkspace 存模块级引用（防御式：非对象或缺 openSession 函数存
 *   null）；模块级 jumpToSession(sessionId, close) = openSession(sessionId) 成功后
 *   回调 close 关闭设置弹窗（settings.section owner props 注入 `close`，宿主 shell
 *   渲染 section 时传 { close: onClose }，RestartSection 签名扩展为 { t, close }、
 *   可能 undefined 由 jumpToSession 防御）；任何失败只 console.warn 不抛错——
 *   跳转只是锦上添花，不能让行点击炸掉设置弹窗；
 * - 待恢复列表行：非 waiting（pendingReadonly === false）阶段行容器绑 onClick
 *   跳转 + .dsh-ror-restore-click 可点样式，行 title 在原完整 id 基础上追加
 *   「点击打开会话」提示（zh/en restart.openSessionHint）；waiting 只读阶段不绑
 *   行点击、不加可点样式（与该阶段隐藏全部按钮的既有约束一致）；行内 checkbox
 *   与行尾「取消/恢复」按钮 onClick stopPropagation，避免点控件误触发行跳转；
 * - 对账视图行同样绑 onClick 跳转 + 可点样式 + title 提示（只读展示、行内无
 *   控件，无 stopPropagation 需求）；
 * - 对账视图按工作区分组：startRestart 写存根的 candidates 增带 workspace
 *   （非空字符串才带，与 title 同款「拿到才带」），readPendingRestore 归一化
 *   同步透传；渲染复用既有 groupPendingRows 分组，组头复用待恢复列表同款
 *   .dsh-ror-pending-group 结构与样式（workspace 缺失/空串显示
 *   restart.pendingUnknownWorkspace 并恒垫底、组容器 title 同款），组内行结构
 *   （结算徽标 + 标题 + error）与分组前完全一致，结算计数行与标题不变；旧存根
 *   无 workspace 字段 → 不带 → 归「未知工作区」组，天然兼容。
 *
 * 0.26.0：新增第三块「上次重启无法恢复」列表（宿主 0.26.0 续等放弃登记 +
 * POST /unrestored/restore 手动恢复的客户端配套）：
 * - RestartSection 挂载 GET /unrestored（404 = 混合版本窗口 → 静默不显示，照
 *   /restarts 404 口径）；refreshPendingList 点「刷新」时一并重拉；仅 rows 非空
 *   渲染，位置在待恢复列表之后、对账视图之前；
 * - 行结构与另两个列表一致：可点行（jumpToSession(row.id, close) +
 *   .dsh-ror-restore-click + title 追加 restart.openSessionHint）、行首结算徽标
 *   （新 key restore.skipped-service-timeout，zh「等待超时」/en "timeout"，新配色
 *   .dsh-ror-result-skipped-service-timeout）、会话标题、登记时间、行尾「恢复」
 *   按钮（复用 restart.pendingRestore）；按工作区分组（复用 groupPendingRows，
 *   组头结构与样式同待恢复列表，未知工作区垫底）；
 * - 批量工具条照 0.14.0 模式：全选 checkbox（半选）+「已选 N 项」（复用 key）+
 *   「恢复所选」（复用 restart.pendingRestoreSelected）；串行逐个 POST
 *   /unrestored/restore；乐观更新（成功移除行）+ 失败 console.warn 保留行；
 *   行级/批量在途集合防重复点击（unrestoredMutatingIds，照 mutatingIds 模式）；
 * - 对账视图 SETTLE_RESULTS 白名单增 'skipped-service-timeout'（对账视图出现该
 *   结算同样有徽标，settle.skipped-service-timeout 同配色）。
 *
 * 0.28.0：设置弹窗「重启日志」（0.5.0 起）与「重启」（0.8.0 起）两个独立的
 * settings.section 条目主题重复（设置弹窗左侧两个相近入口），合并为单个条目
 * 「重启」（label 复用既有 restart.nav；id 保留 resume-on-restart、order 61
 * 不变，原 restart-now 条目移除）：新外层组件 RestartTabsSection 持有本地
 * tab state（useState，默认 restart），tab 栏（新类名 .dsh-ror-tabs /
 * .dsh-ror-tab / .dsh-ror-tab-active，设计 token + 蓝调强调照抄
 * .dsh-ror-waiting 的用色口径，明暗主题自适应；role=tablist/tab +
 * aria-selected）切换两块内容——tab1「重启」（restart.tabRestart）= 原
 * RestartSection 全部内容与行为（默认选中），tab2「重启日志」（restart.tabLog）
 * = 原 RestartLogSection 全部内容与行为（404 容错、加载失败报错态、结算徽标
 * 原样保留）。切换按 tab 条件渲染其中一块，与原先设置弹窗左侧导航二选一的
 * 挂载语义一致；两组件内部逻辑/state/定时器/清理函数零改动，只在外面包了
 * 一层 tab。i18n 新增 restart.tabRestart / restart.tabLog（zh/en）。
 *
 * 0.29.0 起「重启」合并条目新增第三个 tab「技能与注入」（restart.tabSkills，
 * zh「技能与注入」/en "Skills & Prompts"；默认选中仍是 tab1 重启）：新组件
 * SkillsSection 挂载时并行拉 GET /skills/catalog（技能目录 + 聚合调用统计）与
 * GET /skills/usage（尾部原始条目），404 = 插件更新后 DSH 未重启的混合版本窗口
 * （宿主 half 尚无新路由）→ 等价空数据按空态展示「暂无数据」不算失败（照
 * 0.5.1「重启日志」先例），其余失败走报错态。页面内容：
 * - 顶部全局统计行：总调用次数（usage.total）/ 被调用过的技能数
 *   （usage.skills 有 count>0 的键数）/ 记录起始时间（usage.firstAt）；
 * - 搜索框按技能名称 + 描述（大小写不敏感）就地过滤；
 * - 每技能一张卡片：名称、来源（注册它的插件/runtime = provider，title 带
 *   source 来源类别）、徽标（模型可用 modelInvocable / 用户可见 userInvocable）、
 *   description、whenToUse、该技能统计（总次数、成功率 = okCount/count、最近
 *   调用时间；无记录显示「从未调用」）、「正文」折叠展开（content 经 <pre>
 *   预格式化展示，默认收起）、「按工作区」分布（路径 + 次数）、「按会话」
 *   分布（标题优先、id 兜底 + 次数，宿主已截前 10）、「最近7天」每日次数
 *   （MM-DD:count 纯文本列表，不引图表库）；
 * - 新样式类 .dsh-ror-skill*（设计 token 照既有体系，明暗主题自适应）；
 * - i18n 新增 restart.tabSkills 与 skills.* 文案组（zh/en）。
 */

window.__ModuleLoader__.load({
	id: "dsh-resume-on-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** 插件自有 API 前缀（宿主 half 注册的 prefix 路由）。 */
		const API_BASE = "/api/dsh-resume-on-restart";

		/** 文案（顶栏开关；与通知文案同风格）。 */
		const LABEL_NORMAL = "重启时恢复会话";
		const LABEL_NORMAL_HOVER = "取消→重启时恢复会话";
		const LABEL_EXCLUDED = "已取消恢复";
		const LABEL_EXCLUDED_HOVER = "恢复→重启时恢复会话";
		const TITLE_NORMAL = "点击后本会话在 DSH 重启后不再自动恢复";
		const TITLE_EXCLUDED = "本会话已标记为重启后不自动恢复，点击恢复";

		// ---- 0.5.0：locale seat（写法照抄 dsh-prompt-history） ----

		/** 本插件的 locale 命名空间。 */
		const NS = "dsh-resume-on-restart";
		/** zh 字典（权威 key 集；顶栏开关文案保留硬编码常量，不进字典）。 */
		const zh = {
			"settings.title": "重启恢复",
			"settings.nav": "重启日志",
			"settings.note": "记录每次 DSH 重启（boot）与逐会话恢复（restore）结果，倒序展示，最多 200 条。数据来自宿主 ~/.dsh/.resume-on-restart/restarts.ndjson，此处只读。改动需下次 DSH 重启后生效。",
			"log.loading": "加载中…",
			"log.empty": "暂无重启记录（本功能 0.5.0 起，下次 DSH 重启后开始记录）。",
			"log.loadFailed": "重启日志加载失败",
			"log.refresh": "刷新",
			"reason.power-button": "面板重启",
			"reason.restart-button": "重启按钮",
			"reason.signal": "正常停机",
			"reason.crash": "异常退出",
			"reason.unknown": "原因未知",
			"origin.none": "无来源",
			"label.downtime": "停机",
			"label.restored": "恢复",
			"detail.boot": "boot 详情",
			"detail.prevBoot": "上次启动",
			"detail.pid": "pid 上次 → 本次",
			"detail.detectBasis": "重启判定",
			"detail.shutdown": "停机归因",
			"detail.origin": "重启来源",
			"detail.runningSessions": "恢复候选",
			"detail.noRestores": "该次重启无恢复明细",
			"restore.resumed": "已恢复",
			"restore.failed": "失败",
			"restore.excluded": "已排除",
			"restore.skipped-budget": "预算跳过",
			"restore.skipped-no-human-prompt": "无人工输入",
			// ---- 0.17.0：正常结束门的 restore 结算（正常收工的会话不恢复，不算失败） ----
			"restore.skipped-completed": "正常结束",
			// ---- 0.9.1：subagent 会话结算（经主会话祖先恢复，不算失败） ----
			"restore.subagent": "子代理会话",
			// ---- 0.9.0：归档结算（与用户排除并列，不算失败） ----
			"restore.archived": "已归档",
			// ---- 0.23.0：注册但不激活结算（重启后不自动恢复，不算失败） ----
			"restore.no-activate": "注册不激活",
			// ---- 0.26.0：续等放弃结算（服务始终未就绪，登记后可手动恢复） ----
			"restore.skipped-service-timeout": "等待超时",
			// ---- 0.8.0：设置弹窗「重启」section 与重启回执 ----
			"restart.nav": "重启",
			// ---- 0.28.0：设置弹窗合并后的 tab 文案（原两个 section 条目标题的 tab 化；
			//      顶部 settings.section 的 label 仍用既有 restart.nav） ----
			"restart.tabRestart": "重启",
			"restart.tabLog": "重启日志",
			// ---- 0.29.0：tab3「技能与注入」（技能目录 + 技能调用统计展示） ----
			"restart.tabSkills": "技能与注入",
			"skills.loading": "加载中…",
			"skills.loadFailed": "技能与注入数据加载失败",
			"skills.empty": "暂无数据（本功能 0.29.0 起：技能调用自 DSH 带此版本重启后开始记录；技能目录暂不可用时同样显示本空态）。",
			"skills.note": "展示本 DSH 实例注册的全部技能（含注入给模型的提示词正文与调用方式徽标）及其调用统计。调用记录来自宿主 ~/.dsh/.resume-on-restart/skill-usage.ndjson，此处只读。",
			"skills.refresh": "刷新",
			"skills.searchPlaceholder": "搜索技能名称或描述…",
			"skills.filterEmpty": "没有匹配的技能",
			"skills.statTotal": "总调用次数",
			"skills.statUsed": "被调用过的技能",
			"skills.statSince": "记录起始时间",
			"skills.statNever": "暂无记录",
			"skills.badgeModel": "模型可用",
			"skills.badgeUser": "用户可见",
			"skills.labelSource": "来源",
			"skills.labelCount": "总次数",
			"skills.labelOkRate": "成功率",
			"skills.labelLastAt": "最近调用",
			"skills.labelNeverCalled": "从未调用",
			"skills.labelContent": "正文",
			"skills.contentShow": "展开",
			"skills.contentHide": "收起",
			"skills.labelByWorkspace": "按工作区",
			"skills.labelBySession": "按会话",
			"skills.labelDaily7": "最近7天",
			"skills.noUsage": "暂无调用记录",
			"restart.title": "重启 DeepSeek Harness",
			"restart.note": "以相同参数重新拉起 DSH（重载插件与配置）。完成后页面自动刷新，重启前活跃的会话（含手动停止的）由本插件自动恢复；执行前需二次确认。",
			"restart.notePid1": "当前 DSH 以容器 PID 1 运行：重启 = 进程优雅退出，由容器重启策略（--restart=always / unless-stopped，或 on-failure 配合退出码）拉起；未配置策略时需手动 docker start。",
			"restart.candidates": "重启后将自动恢复",
			"restart.candidatesUnit": "个活跃会话",
			"restart.appExitMissing": "提示：宿主未提供优雅退出通道（appExit missing），重启将退化为直接退出。",
			"restart.button": "重启 DSH",
			"restart.confirmTitle": "确认重启 DeepSeek Harness？",
			"restart.confirmBody": "重启期间网页会短暂断开，完成后自动刷新；重启前活跃的会话（含手动停止的）会自动恢复。确定要现在重启吗？",
			"restart.confirmBodyPid1": "PID=1 模式：进程将优雅退出，由容器重启策略拉起；未配置策略时需要手动启动容器。确定要现在重启吗？",
			"restart.confirm": "确认重启",
			"restart.cancel": "取消",
			"restart.waiting": "DSH 正在重启，等待新实例就绪后自动刷新…",
			"restart.timeoutPid1": "等待超时：容器可能未配置重启策略。请手动启动容器（docker start），本页会继续等待。",
			"restart.timeoutHelper": "等待超时：重启未按预期完成，请检查 DSH 日志或手动重启；本页会继续等待。",
			"restart.failed": "重启失败",
			"restart.done": "已重启：DSH 已恢复，重启前活跃的会话正在自动恢复。",
			// ---- 0.13.0：确认后的待恢复列表 / 等待计时 / 重启后恢复结果对账 ----
			"restart.pendingList": "待重启恢复会话列表",
			"restart.pendingEmpty": "无待恢复会话",
			"restart.pendingAt": "最后活跃",
			"restart.pendingRunning": "● 运行中",
			"restart.pendingSkill": "技能注册",
			// ---- 0.23.0：注册但不激活徽标（与紫调技能注册徽标区分） ----
			"restart.pendingNoActivate": "注册·不激活",
			"restart.elapsed": "重启中… 已等待 %s 秒",
			// ---- 0.21.0：等待态可视化强化（横幅标题/副文案 + 大号计时；waiting/elapsed 保留复用于固定条） ----
			"restart.waitingTitle": "DSH 正在重启",
			"restart.waitingSub": "重启指令已确认发出，新实例就绪后本页自动刷新，期间无需任何操作。",
			"restart.elapsedBig": "%s 秒",
			"settle.title": "上次重启（%s）的恢复结果",
			"settle.restoredUnit": "已恢复",
			"settle.resumed": "已恢复",
			"settle.failed": "恢复失败",
			"settle.excluded": "已被用户排除",
			"settle.archived": "已归档跳过",
			"settle.subagent": "经主会话代理恢复",
			"settle.skipped-budget": "预算耗尽跳过",
			"settle.skipped-no-human-prompt": "无人工输入跳过",
			// ---- 0.17.0：正常结束门的结算徽标 ----
			"settle.skipped-completed": "正常结束跳过",
			// ---- 0.23.0：注册但不激活结算（故意不激活的重启，不算失败） ----
			"settle.no-activate": "注册不激活",
			// ---- 0.26.0：续等放弃结算徽标（对账视图出现该结算时显示） ----
			"settle.skipped-service-timeout": "等待超时",
			"settle.pending": "待结算",
			"settle.unsettled": "未结算",
			"settle.unknown": "未知结果",
			// ---- 0.14.0：待恢复列表的逐行 / 批量「取消 / 恢复」操作 ----
			"restart.pendingCancel": "取消",
			"restart.pendingRestore": "恢复",
			"restart.pendingCancelled": "已取消",
			"restart.pendingCancelSelected": "取消所选",
			"restart.pendingRestoreSelected": "恢复所选",
			"restart.pendingSelectedCount": "已选 %s 项",
			"restart.pendingSelectAll": "全选",
			// ---- 0.17.0：待恢复列表的手动刷新 ----
			"restart.pendingRefresh": "刷新",
			"restart.pendingRefreshing": "刷新中…",
			// ---- 0.18.0：待恢复列表按工作区分组 ----
			"restart.pendingUnknownWorkspace": "未知工作区",
			// ---- 0.25.0：会话行点击跳转（可点行 title 在完整 id 基础上追加的提示） ----
			"restart.openSessionHint": "点击打开会话",
			// ---- 0.26.0：「上次重启无法恢复」列表（第三块，位置在待恢复列表之后） ----
			"unrestoredTitle": "上次重启无法恢复",
			// ---- 0.15.0：暂停所有会话（pause-all） ----
			"pause.button": "暂停所有会话",
			"pause.confirmTitle": "暂停所有会话？",
			"pause.confirmBody": "将停止全部正在运行的会话（等同逐个点「停止」，已排队的输入保留），子代理会话由其主会话接管。之后 DSH 重启时，这些会话会被自动恢复。",
			"pause.confirm": "确认暂停",
			"pause.cancel": "取消",
			"pause.doing": "正在暂停…",
			"pause.done": "已暂停 %s 个会话",
			"pause.doneNone": "没有正在运行的会话",
			"pause.doneSubagent": "%s 个子代理会话由主会话接管",
			"pause.doneFailed": "%s 个失败",
			"pause.failed": "暂停失败",
		};
		/** en 字典（与 zh 保持 key 对齐）。 */
		const en = {
			"settings.title": "Restart & Resume",
			"settings.nav": "Restart Log",
			"settings.note": "Every DSH restart (boot) with per-session restore outcomes, newest first, capped at 200 entries. Read-only view of ~/.dsh/.resume-on-restart/restarts.ndjson. Takes effect after the next DSH restart.",
			"log.loading": "Loading…",
			"log.empty": "No restarts recorded yet (logging starts with the next DSH restart).",
			"log.loadFailed": "Failed to load the restart log",
			"log.refresh": "Refresh",
			"reason.power-button": "Panel restart",
			"reason.restart-button": "Restart button",
			"reason.signal": "Graceful stop",
			"reason.crash": "Crash",
			"reason.unknown": "Unknown",
			"origin.none": "no origin",
			"label.downtime": "downtime",
			"label.restored": "restored",
			"detail.boot": "boot details",
			"detail.prevBoot": "Previous boot",
			"detail.pid": "pid prev → now",
			"detail.detectBasis": "Detection",
			"detail.shutdown": "Shutdown",
			"detail.origin": "Origin",
			"detail.runningSessions": "Restore candidates",
			"detail.noRestores": "No restore details for this restart",
			"restore.resumed": "resumed",
			"restore.failed": "failed",
			"restore.excluded": "excluded",
			"restore.skipped-budget": "skipped (budget)",
			"restore.skipped-no-human-prompt": "no human prompt",
			// ---- 0.17.0: completed-gate restore settlement (finished sessions are not restored, not a failure) ----
			"restore.skipped-completed": "completed",
			// ---- 0.9.1: subagent-owned settlement (resumed via ancestor session, not a failure) ----
			"restore.subagent": "subagent",
			// ---- 0.9.0: archived settlement (alongside user exclusion, not a failure) ----
			"restore.archived": "archived",
			// ---- 0.23.0: no-activate settlement (registered without activation, not restored, not a failure) ----
			"restore.no-activate": "no activate",
			// ---- 0.26.0: deferred give-up settlement (service never became ready; registered for manual restore) ----
			"restore.skipped-service-timeout": "timeout",
			// ---- 0.8.0: settings restart section & restart acknowledgement ----
			"restart.nav": "Restart",
			// ---- 0.28.0: merged settings tabs (tab versions of the two former section titles;
			//      the settings.section label keeps using the existing restart.nav) ----
			"restart.tabRestart": "Restart",
			"restart.tabLog": "Restart Log",
			// ---- 0.29.0: third tab "Skills & Prompts" (skill catalog + usage stats) ----
			"restart.tabSkills": "Skills & Prompts",
			"skills.loading": "Loading…",
			"skills.loadFailed": "Failed to load skills & prompts data",
			"skills.empty": "No data yet (added in 0.29.0: skill usage is recorded once DSH restarts with this version; the same empty state shows while the skill catalog is unavailable).",
			"skills.note": "All skills registered in this DSH instance (with the prompt bodies injected into the model and invocation badges) plus their invocation stats. Usage records come from ~/.dsh/.resume-on-restart/skill-usage.ndjson on the host; read-only here.",
			"skills.refresh": "Refresh",
			"skills.searchPlaceholder": "Search skills by name or description…",
			"skills.filterEmpty": "No matching skills",
			"skills.statTotal": "Total invocations",
			"skills.statUsed": "Skills invoked",
			"skills.statSince": "Recording since",
			"skills.statNever": "No records",
			"skills.badgeModel": "Model",
			"skills.badgeUser": "User",
			"skills.labelSource": "Source",
			"skills.labelCount": "Calls",
			"skills.labelOkRate": "Success rate",
			"skills.labelLastAt": "Last call",
			"skills.labelNeverCalled": "Never invoked",
			"skills.labelContent": "Body",
			"skills.contentShow": "Expand",
			"skills.contentHide": "Collapse",
			"skills.labelByWorkspace": "By workspace",
			"skills.labelBySession": "By session",
			"skills.labelDaily7": "Last 7 days",
			"skills.noUsage": "No invocations recorded",
			"restart.title": "Restart DeepSeek Harness",
			"restart.note": "Relaunches DSH with the same invocation (reloads plugins & config). The page refreshes automatically afterwards and recently active sessions (including manually stopped ones) get restored by this plugin. A second confirmation is required before restarting.",
			"restart.notePid1": "DSH currently runs as PID 1 inside a container: restart = graceful exit, brought back by the container restart policy (--restart=always / unless-stopped, or on-failure via exit code); without a policy you must start the container manually.",
			"restart.candidates": "Sessions to be restored after restart:",
			"restart.candidatesUnit": "",
			"restart.appExitMissing": "Note: the host provides no graceful exit channel (appExit missing); restart falls back to a direct exit.",
			"restart.button": "Restart DSH",
			"restart.confirmTitle": "Restart DeepSeek Harness?",
			"restart.confirmBody": "The page disconnects briefly and refreshes automatically afterwards; recently active sessions (including manually stopped ones) will be restored. Restart now?",
			"restart.confirmBodyPid1": "PID=1 mode: the process exits gracefully and is brought back by the container restart policy; without one, start the container manually. Restart now?",
			"restart.confirm": "Restart now",
			"restart.cancel": "Cancel",
			"restart.waiting": "DSH is restarting, waiting for the new instance before refreshing…",
			"restart.timeoutPid1": "Timed out: the container may have no restart policy. Start it manually (docker start); this page keeps waiting.",
			"restart.timeoutHelper": "Timed out: the restart did not complete as expected. Check the DSH logs or restart manually; this page keeps waiting.",
			"restart.failed": "Restart failed",
			"restart.done": "Restarted: DSH is back and previously active sessions are being restored.",
			// ---- 0.13.0: pending-restore list / elapsed timer / post-restart settlement ----
			"restart.pendingList": "Sessions pending restore after restart",
			"restart.pendingEmpty": "No sessions to restore",
			"restart.pendingAt": "Last active",
			"restart.pendingRunning": "● running",
			"restart.pendingSkill": "Skill registered",
			// ---- 0.23.0: registered-without-activation badge (distinct from the purple skill badge) ----
			"restart.pendingNoActivate": "no activate",
			"restart.elapsed": "Restarting… waited %s s",
			// ---- 0.21.0: waiting-phase visualization (banner title/sub + big elapsed; waiting/elapsed kept for the fixed bar) ----
			"restart.waitingTitle": "DSH is restarting",
			"restart.waitingSub": "Restart confirmed. This page refreshes automatically once the new instance is ready — no action needed.",
			"restart.elapsedBig": "%s s",
			"settle.title": "Restore results of the last restart (%s)",
			"settle.restoredUnit": "restored",
			"settle.resumed": "resumed",
			"settle.failed": "restore failed",
			"settle.excluded": "excluded by user",
			"settle.archived": "archived, skipped",
			"settle.subagent": "resumed via lead session",
			"settle.skipped-budget": "skipped (budget exhausted)",
			"settle.skipped-no-human-prompt": "skipped (no human prompt)",
			// ---- 0.17.0: completed-gate settlement badge ----
			"settle.skipped-completed": "skipped (completed)",
			// ---- 0.23.0: no-activate settlement badge (deliberately not activated, not a failure) ----
			"settle.no-activate": "no activate",
			// ---- 0.26.0: deferred give-up settlement badge (shown in the settlement view) ----
			"settle.skipped-service-timeout": "timeout",
			"settle.pending": "pending",
			"settle.unsettled": "unsettled",
			"settle.unknown": "unknown",
			// ---- 0.14.0: per-row & bulk cancel/restore actions on the pending list ----
			"restart.pendingCancel": "Cancel",
			"restart.pendingRestore": "Restore",
			"restart.pendingCancelled": "Cancelled",
			"restart.pendingCancelSelected": "Cancel selected",
			"restart.pendingRestoreSelected": "Restore selected",
			"restart.pendingSelectedCount": "%s selected",
			"restart.pendingSelectAll": "Select all",
			// ---- 0.17.0: manual refresh for the pending-restore list ----
			"restart.pendingRefresh": "Refresh",
			"restart.pendingRefreshing": "Refreshing…",
			// ---- 0.18.0: group the pending-restore list by workspace ----
			"restart.pendingUnknownWorkspace": "Unknown workspace",
			// ---- 0.25.0: row click jump (appended to the clickable row's title attribute) ----
			"restart.openSessionHint": "Click to open session",
			// ---- 0.26.0: "unrestored from last restart" list (third block, after the pending list) ----
			"unrestoredTitle": "Unrestored from last restart",
			// ---- 0.15.0: pause-all sessions ----
			"pause.button": "Pause all sessions",
			"pause.confirmTitle": "Pause all sessions?",
			"pause.confirmBody": "All running sessions will be stopped (same as clicking Stop on each one; already queued input is kept). Subagent sessions are left to their lead sessions. When DSH restarts afterwards, these sessions are restored automatically.",
			"pause.confirm": "Pause all",
			"pause.cancel": "Cancel",
			"pause.doing": "Pausing…",
			"pause.done": "Paused %s session(s)",
			"pause.doneNone": "No running sessions",
			"pause.doneSubagent": "%s subagent session(s) left to their lead",
			"pause.doneFailed": "%s failed",
			"pause.failed": "Pause failed",
		};
		let translator;
		/** 安装 locale 绑定的翻译函数（apply 时调用一次）。 */
		function setTranslator(fn) {
			translator = fn;
		}
		/** 翻译一个插件 key；宿主未命中时回退内置 zh 字典（zh 为权威文案）。 */
		function T(key) {
			if (translator !== undefined) {
				const text = translator(key);
				if (text !== key) return text;
			}
			return Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
		}

		// ---- 0.25.0：会话行点击跳转（uiWorkspace.openSession，dsh 官方跳转方案） ----
		//
		// 工厂 inject 新增 uiWorkspace（dsh-client-ui-workspace 的 UiWorkspace 服务，
		// 官方 chat / dsh-client-ui-conversation 同款用法）：apply 时经 setUiWorkspace
		// 存模块级引用；待恢复列表与对账视图的会话行点击 → jumpToSession →
		// uiWorkspace.openSession(sessionId) 打开该会话，成功后回调 close 关闭设置
		// 弹窗（settings.section owner props 注入，见 SettingsSectionOwnerProps）。

		/** uiWorkspace 服务引用（apply 时注入；null = 服务缺失，跳转降级为不可用）。 */
		let uiWorkspace = null;
		/**
		 * 保存 uiWorkspace 服务引用（apply 时调用一次）。防御式：非对象或缺
		 * openSession 函数一律存 null——跳转只是锦上添花，服务缺失时行点击只
		 * console.warn 后忽略，绝不影响其他功能。
		 * @param {unknown} svc ctx.uiWorkspace（期望带 openSession 函数的 UiWorkspace）
		 */
		function setUiWorkspace(svc) {
			uiWorkspace = svc !== null && typeof svc === "object" && typeof svc.openSession === "function"
				? svc
				: null;
		}

		/**
		 * 跳转到指定会话（待恢复列表 / 对账视图的会话行点击入口）：
		 * uiWorkspace.openSession(sessionId) 打开该会话，成功后回调 close 关闭设置
		 * 弹窗。防御式口径：sessionId 非非空字符串直接忽略；服务未注入 console.warn
		 * 后忽略；openSession 抛错也只 console.warn 不上抛——跳转只是锦上添花，
		 * 绝不能让行点击把设置弹窗炸掉（失败最多留在原处）。
		 * @param {unknown} sessionId 会话 id
		 * @param {(() => void)|undefined} [close] 关闭设置弹窗的回调
		 *   （settings.section owner props 的 close，可能 undefined）
		 */
		function jumpToSession(sessionId, close) {
			// 校验参数：id 非非空字符串不跳（防御坏数据）
			if (typeof sessionId !== "string" || sessionId === "") return;
			if (uiWorkspace === null) {
				console.warn("[resume-on-restart] jump: uiWorkspace unavailable, skip openSession");
				return;
			}
			// 核心逻辑：官方 openSession 跳转；成功后关设置弹窗。try 只包 openSession
			// 与 close 的调用——宿主导航实现抛错属运行期意外，吞掉但必须记日志
			// （行点击不该炸弹窗，也不能静默），原因见上防御式口径说明
			try {
				uiWorkspace.openSession(sessionId);
				if (typeof close === "function") close();
			} catch (err) {
				console.warn("[resume-on-restart] jump: openSession failed:", err);
			}
		}

		// ---- 0.11.0：ws 状态推送单例（取代 15 秒轮询，事件驱动） ----
		//
		// 模块级单例：懒拉一次 /ws-info（一次性，非轮询，拿 token）→ new WebSocket
		// 到宿主主端口的同源路径 API_BASE + '/ws'（0.12.0 起不再有独立随机端口；
		// 协议随页面 location.protocol，URL 带 cid）；服务端连接后立即
		// 推全量快照 { type:'state', restoreCandidates, excluded }，此后排除集合/
		// 候选集变化都广播同一快照。/ws-info 拉取失败与 ws 连接失败/断开都无限重试
		// （指数退避 1s 起、封顶 5s），永不回退轮询；重连成功后服务端快照即完成
		// 状态重建。快照按 sessionId 分发：ResumeToggle 在 useEffect 里订阅自己的 id。
		const WS_RETRY_MIN_MS = 1000;
		const WS_RETRY_MAX_MS = 5000;

		// ---- 0.11.1：每标签页随机标识 cid（模块加载 = 页面加载时生成一次）----
		// ws 升级层没有会话概念，cid 供服务端拒绝日志区分来源标签页（配合服务端
		// 拒绝日志节流去重）。crypto.randomUUID 优先，降级 Math.random 拼接；
		// 清洗为 URL 安全字符并截断 ≤64，清洗后为空兜底固定值（cid 绝不阻塞连接）。
		const WS_CID = (() => {
			let raw = "";
			try {
				if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
					raw = crypto.randomUUID();
				}
			} catch (err) {
				// randomUUID 偶发不可用（非安全上下文等实现限制）属预期降级路径，
				// 记一条日志后走 Math.random 拼接，不裸吞也不让 cid 挡住连接
				console.warn("[resume-on-restart] cid: crypto.randomUUID unavailable, fallback to Math.random:", err);
				raw = "";
			}
			if (!raw) {
				raw = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-`
					+ `${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
			}
			const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
			return cleaned.length > 0 ? cleaned : "tab";
		})();

		/** 从快照取某会话的状态（字段缺失/形状异常一律按 false 处理）。 */
		function stateOfSession(snapshot, id) {
			const candidates = snapshot && typeof snapshot === "object" ? snapshot.restoreCandidates : null;
			const excluded = snapshot && typeof snapshot === "object" ? snapshot.excluded : null;
			return {
				candidate: Boolean(candidates && typeof candidates === "object" && candidates[id]),
				excluded: Boolean(
					excluded && typeof excluded === "object"
						&& Object.prototype.hasOwnProperty.call(excluded, id),
				),
			};
		}

		function createWsStateManager() {
			/** sessionId → Set<handler({ candidate, excluded })>。 */
			const subscribers = new Map();
			let latest = null; // 最近一帧快照（新订阅者立即补发，切换会话零等待）
			let socket = null;
			let connecting = false;
			let disposed = false; // 页面卸载无感知，仅防极端时序下的重连
			let backoff = WS_RETRY_MIN_MS;

			const notifyId = (id) => {
				const handlers = subscribers.get(id);
				if (!handlers || !latest) return;
				const state = stateOfSession(latest, id);
				for (const handler of handlers) {
					try {
						handler(state);
					} catch (err) {
						console.warn("[resume-on-restart] ws subscriber failed:", err);
					}
				}
			};

			/** 指数退避排下一轮：每轮重新拉 /ws-info（DSH 重启后插件实例重建、token 换新）。 */
			const scheduleRetry = () => {
				if (disposed) return;
				const delay = backoff;
				backoff = Math.min(backoff * 2, WS_RETRY_MAX_MS);
				setTimeout(() => {
					if (!disposed && socket === null && !connecting) connect();
				}, delay);
			};

			const connect = async () => {
				if (disposed || socket !== null || connecting) return;
				connecting = true;
				let info = null;
				try {
					const res = await fetch(`${API_BASE}/ws-info`, { cache: "no-store" });
					if (res.ok) {
						const data = await res.json().catch(() => null);
						// 0.12.0：/ws-info 只返回 { ok, token }（同源路径不再需要 port）
						if (data && data.ok === true
							&& typeof data.token === "string" && data.token) info = data;
					}
					if (!info) throw new Error(res.ok ? "malformed /ws-info response" : `HTTP ${res.status}`);
				} catch (err) {
					connecting = false;
					console.warn("[resume-on-restart] ws-info fetch failed, will retry:", err);
					scheduleRetry();
					return;
				}
				connecting = false;
				if (disposed || socket !== null) return;
				openSocket(info);
			};

			const openSocket = (info) => {
				const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
				let ws;
				try {
					// 0.12.0：同源路径（宿主 webServer 主端口，location.host 自带端口）；
					// cid（0.11.1）：每标签页随机标识，服务端拒绝日志的区分明细（节流 key 组成部分）
					ws = new WebSocket(`${scheme}//${window.location.host}${API_BASE}/ws?token=${encodeURIComponent(info.token)}&cid=${encodeURIComponent(WS_CID)}`);
				} catch (err) {
					console.warn("[resume-on-restart] websocket create failed, will retry:", err);
					scheduleRetry();
					return;
				}
				socket = ws;
				ws.onopen = () => {
					backoff = WS_RETRY_MIN_MS; // 连上了就复位退避；快照由服务端立即推送
				};
				ws.onmessage = (ev) => {
					let data = null;
					try {
						data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
					} catch (err) {
						// 服务端只发 JSON 文本帧；解析失败说明对端异常，记日志后当无效帧丢弃
						console.warn("[resume-on-restart] ws: malformed frame dropped:", err);
						data = null;
					}
					if (!data || typeof data !== "object" || data.type !== "state") return;
					latest = data;
					for (const id of subscribers.keys()) notifyId(id);
				};
				ws.onclose = () => {
					if (socket === ws) socket = null;
					scheduleRetry(); // 无限重试，绝不回退轮询
				};
				ws.onerror = () => { /* onclose 随后必到，重试在那里统一排 */ };
			};

			/**
			 * 订阅某会话的状态推送；已有快照时同步补发一帧。
			 * 单例懒启动：首个订阅者触发连接，后续订阅幂等。
			 */
			const subscribe = (sessionId, handler) => {
				let handlers = subscribers.get(sessionId);
				if (!handlers) {
					handlers = new Set();
					subscribers.set(sessionId, handlers);
				}
				handlers.add(handler);
				if (latest) handler(stateOfSession(latest, sessionId));
				connect();
				return () => {
					const current = subscribers.get(sessionId);
					if (!current) return;
					current.delete(handler);
					if (current.size === 0) subscribers.delete(sessionId);
				};
			};

			return { subscribe };
		}

		let wsStateManager = null;
		/** 顶栏开关用的 ws 状态订阅入口（模块级单例，整页一条连接）。 */
		function subscribeWsState(sessionId, handler) {
			if (!wsStateManager) wsStateManager = createWsStateManager();
			return wsStateManager.subscribe(sessionId, handler);
		}

		// ---- 0.5.0：重启日志的数据整形（纯函数） ----

		/** 会话 id 展示截断（来源列与明细列表共用；空值原样返回）。 */
		function shortId(id, max = 12) {
			const text = typeof id === "string" ? id : "";
			if (!text) return "";
			return text.length > max ? `${text.slice(0, max)}…` : text;
		}

		/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm:ss`；解析失败原样返回，空值为 —。 */
		function formatTime(iso) {
			if (typeof iso !== "string" || iso === "") return "—";
			const ms = Date.parse(iso);
			if (!Number.isFinite(ms)) return iso;
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		}

		/** 毫秒 → 紧凑时长（`1h 5m` / `5m 30s` / `42s`，locale 中立）；非正数为 —。 */
		function humanizeMs(ms) {
			const n = Number(ms);
			if (!Number.isFinite(n) || n <= 0) return "—";
			const totalSec = Math.max(1, Math.round(n / 1000));
			const h = Math.floor(totalSec / 3600);
			const m = Math.floor((totalSec % 3600) / 60);
			const s = totalSec % 60;
			if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
			if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
			return `${s}s`;
		}

		/** boot 记录的原因标签（旧记录缺 reason 字段时按字段推导，口径同宿主）。 */
		function reasonOf(boot) {
			if (boot && typeof boot === "object" && typeof boot.reason === "string" && boot.reason) return boot.reason;
			if (boot && typeof boot === "object" && boot.origin && typeof boot.origin === "object") return "power-button";
			if (boot && typeof boot === "object" && boot.shutdown && typeof boot.shutdown === "object") {
				return boot.shutdown.seen === true ? "signal" : "crash";
			}
			return "unknown";
		}

		/** 来源列文本：`kind + 截断 sessionId`；无 origin 显示占位文案。 */
		function originTextOf(boot, t) {
			const origin = boot?.origin;
			if (origin === null || typeof origin !== "object") return t("origin.none");
			const kind = typeof origin.kind === "string" && origin.kind ? origin.kind : "?";
			const sid = shortId(origin.sessionId);
			return sid ? `${kind} ${sid}` : kind;
		}

		/**
		 * 把 ndjson 条目按 boot 分组：一条 boot 开启一组，其后的 restore 记录归入该组，
		 * 直到下一条 boot。boot 记录早于首个 restore 被裁剪时（200 条上限丢最旧），
		 * 孤儿 restore 自成一组（boot: null，时间取 restore.bootAt）。
		 * @param {unknown[]} entries GET /restarts 返回的条目（时间正序）
		 */
		function groupEntries(entries) {
			const groups = [];
			let current = null;
			for (const entry of Array.isArray(entries) ? entries : []) {
				if (entry === null || typeof entry !== "object") continue;
				if (entry.type === "boot") {
					current = { boot: entry, restores: [] };
					groups.push(current);
				} else if (entry.type === "restore") {
					if (current !== null) current.restores.push(entry);
					else groups.push({ boot: null, restores: [entry] });
				}
			}
			return groups.reverse(); // 倒序：最近的重启在最前
		}

		// ---- 0.13.0：重启确认后的待恢复列表与重启后恢复结果对账（纯函数） ----
		//
		// 数据流：确认重启 → POST /restart 成功 → 覆盖写 localStorage 存根
		// （at=确认时刻 ISO，restartId=响应里的 restartId，candidates=待恢复明细）；
		// 页面重启后自动刷新 → RestartSection 挂载读存根 → GET /restarts 匹配
		// boot 记录 → 收集该 bootAt 之后的 restore 记录按 id 归组 → 逐会话结算徽标。
		// 纯函数不碰 window/localStorage（storage 由调用方传入），node --test
		// 经 window.__ModuleLoader__ 桩加载后直接单测（lib/pending-restore.test.js）。

		/** localStorage 存根 key（单条覆盖式）。 */
		const PENDING_RESTORE_KEY = "dsh-ror-pending-restore";
		/** boot 匹配的时钟容差（ms）：重启期间本机时钟小幅回拨仍能对上。 */
		const PENDING_BOOT_TOLERANCE_MS = 2 * 60 * 1000;
		/** 有结算徽标文案的 restore result 白名单（其余结果/无记录走 pending/unknown）。 */
		const SETTLE_RESULTS = [
			"resumed", "failed", "excluded", "archived", "subagent",
			"skipped-budget", "skipped-no-human-prompt",
			"skipped-completed",
			// ---- 0.23.0: 注册但不激活结算（重启后不自动恢复，不算失败） ----
			"no-activate",
			// ---- 0.26.0: 续等放弃结算（服务始终未就绪，登记后可手动恢复） ----
			"skipped-service-timeout",
		];

		/**
		 * 防御式读 localStorage 的待恢复存根：缺失/损坏 JSON/形状不对一律 null，
		 * 绝不抛错（对账视图只是锦上添花，不能干扰 section 本体）。
		 * candidates 条目归一化为 { id, at, running, title?, workspace? }（at 非字符串归 ''，
		 * running 缺省 false，title / workspace（0.25.0，对账视图按工作区分组用）仅非空
		 * 字符串才保留——对账视图标题为主、缺失退 shortId 弱化显示；旧存根无 workspace
		 * 字段 → 不带 → 归「未知工作区」组，天然兼容）。
		 * @param {{getItem: (key: string) => string|null}|null|undefined} storage 通常是 window.localStorage
		 */
		function readPendingRestore(storage) {
			try {
				const raw = storage && typeof storage.getItem === "function"
					? storage.getItem(PENDING_RESTORE_KEY)
					: null;
				if (typeof raw !== "string" || raw === "") return null;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
				if (typeof parsed.at !== "string" || parsed.at === "") return null;
				const candidates = Array.isArray(parsed.candidates)
					? parsed.candidates
						.filter((c) => c !== null && typeof c === "object" && typeof c.id === "string" && c.id)
						.map((c) => {
							const item = {
								id: c.id,
								at: typeof c.at === "string" ? c.at : "",
								running: c.running === true,
							};
							// 0.13.0 修正：title 一起进存根（非空字符串才保留），对账视图标题为主
							if (typeof c.title === "string" && c.title) item.title = c.title;
							// 0.25.0：workspace 同款透传（非空字符串才保留）——对账视图据此
							// 按工作区分组；旧存根无该字段 → 不带 → 归「未知工作区」组，天然兼容
							if (typeof c.workspace === "string" && c.workspace) item.workspace = c.workspace;
							return item;
						})
					: [];
				const record = { at: parsed.at, candidates };
				if (typeof parsed.restartId === "string" && parsed.restartId) record.restartId = parsed.restartId;
				return record;
			} catch {
				return null;
			}
		}

		/**
		 * 覆盖式写入待恢复存根（单条；写失败静默——隐私模式配额等场景不阻断重启流程）。
		 * 候选明细由调用方整形（startRestart：{ id, at, running, title?, workspace? }，
		 * title / workspace（0.25.0，对账视图分组用）空省略）。
		 * @param {{setItem: (key: string, value: string) => void}|null|undefined} storage
		 * @param {{at: string, restartId?: string, candidates: Array<{id: string, at: string, running: boolean, title?: string, workspace?: string}>}} record
		 */
		function writePendingRestore(storage, record) {
			if (!record || typeof record !== "object") return;
			try {
				if (!storage || typeof storage.setItem !== "function") return;
				storage.setItem(PENDING_RESTORE_KEY, JSON.stringify(record));
			} catch {
				// 存不了就没有对账视图，其余一切照旧
			}
		}

		/**
		 * 匹配存根对应的 boot 记录（纯函数）：
		 * 1) pending.restartId 非空时优先取 origin.restartId 与之相等的 boot（并列取较新）；
		 * 2) 没有命中（或无 restartId）回退：boot.at >= pending.at - 时钟容差 的最新一条；
		 * 3) 都没有 → null（可能重启日志为空/被裁剪，调用方按"待结算"短轮询）。
		 * 任何非法输入不抛错。
		 * @param {{at: string, restartId?: string}|null|undefined} pending readPendingRestore 的输出
		 * @param {Array<{at?: string, origin?: {restartId?: string|null}|null}>|unknown} boots boot 记录数组
		 */
		function matchPendingBoot(pending, boots) {
			if (pending === null || typeof pending !== "object") return null;
			const list = Array.isArray(boots)
				? boots.filter((b) => b !== null && typeof b === "object" && b.type === "boot")
				: [];
			const bootMsOf = (boot) => Date.parse(typeof boot.at === "string" ? boot.at : "");
			const restartId = typeof pending.restartId === "string" ? pending.restartId : "";
			if (restartId) {
				let matched = null;
				for (const boot of list) {
					const origin = boot.origin && typeof boot.origin === "object" ? boot.origin : null;
					if (!origin || origin.restartId !== restartId) continue;
					if (matched === null || bootMsOf(boot) >= bootMsOf(matched)) matched = boot;
				}
				if (matched !== null) return matched;
			}
			const pendingMs = Date.parse(pending.at);
			if (!Number.isFinite(pendingMs)) return null;
			const floorMs = pendingMs - PENDING_BOOT_TOLERANCE_MS;
			let matched = null;
			for (const boot of list) {
				const bootMs = bootMsOf(boot);
				if (!Number.isFinite(bootMs) || bootMs < floorMs) continue;
				if (matched === null || bootMs >= bootMsOf(matched)) matched = boot;
			}
			return matched;
		}

		/**
		 * 收集某次 boot 之后的全部 restore 记录并按会话 id 归组（纯函数）：
		 * 返回 Map<id, entry>——同 id 多条取最后一条（restarts.ndjson 时间正序，
		 * 最后一条即最新结算）；非对象/缺 id 的条目忽略，绝不抛错。
		 * @param {Array<{id?: string, result?: string, error?: string, bootAt?: string}>|unknown} restores
		 * @returns {Map<string, object>}
		 */
		function collectSettlementsBySession(restores) {
			const byId = new Map();
			for (const entry of Array.isArray(restores) ? restores : []) {
				if (entry === null || typeof entry !== "object") continue;
				if (typeof entry.id !== "string" || entry.id === "") continue;
				byId.set(entry.id, entry);
			}
			return byId;
		}

		/**
		 * /restart/info 的 runningCandidates → 待恢复列表行（纯函数，防御式）：
		 * 对象条目取 id/at/running；字符串条目（旧版宿主的 string[] 混合版本窗口）
		 * 兼容为 { id, at: '', running: false }；其余忽略。保持输入顺序。
		 * 0.18.0：workspace（所属工作区完整路径）非空字符串才带上——旧宿主无该
		 * 字段、未知工作区为 ''，两种情况都不带（与 title 同款「拿到才带」口径），
		 * 缺失按「未知工作区」分组处理。
		 * 0.19.0：source（'skill' = 主动注册重启恢复，'auto' = 自动候选）非空
		 * 字符串才带上（旧宿主无该字段/未知一律不带，客户端据此显示技能注册徽标）。
		 * 0.23.0：activate:false（注册但不激活）仅 === false 才带上（风格同 source，
		 * true/缺失一律不带 = 默认激活模式，客户端据此显示「注册·不激活」徽标）。
		 * @param {unknown} runningCandidates
		 * @returns {Array<{id: string, at: string, running: boolean, title?: string, workspace?: string, source?: string, activate?: false}>}
		 */
		function normalizeCandidateDetails(runningCandidates) {
			if (!Array.isArray(runningCandidates)) return [];
			const rows = [];
			for (const entry of runningCandidates) {
				if (typeof entry === "string" && entry) {
					rows.push({ id: entry, at: "", running: false });
					continue;
				}
				if (entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id) {
					const row = {
						id: entry.id,
						at: typeof entry.at === "string" ? entry.at : "",
						running: entry.running === true,
					};
					if (typeof entry.title === "string" && entry.title) row.title = entry.title;
					if (typeof entry.workspace === "string" && entry.workspace) row.workspace = entry.workspace;
					if (typeof entry.source === "string" && entry.source) row.source = entry.source;
					// 0.23.0：注册但不激活标记——仅 false 才带（true/缺失一律不带）
					if (entry.activate === false) row.activate = false;
					rows.push(row);
				}
			}
			return rows;
		}

		// ---- 0.14.0：待恢复列表的逐行 / 批量取消恢复（纯函数，返回新数组不改入参） ----

		/**
		 * 合并本地待恢复列表与新拉的服务端列表（纯函数）：
		 * - 服务端返回的行**为准**（id/at/running/title/workspace/source 取服务端），
		 *   cancelled 字段用本地旧值（本地点过取消的行不因重拉而丢标记；本地没有的
		 *   行视为未取消）；title / workspace（0.18.0）/ source（0.19.0）服务端这轮
		 *   没带时回退本地旧值；activate（0.23.0，注册但不激活）同款口径——仅
		 *   false 参与合并（true/缺失一律不带 = 默认激活模式）；
		 * - 本地已有但服务端不再返回的行**保留**并置 cancelled=true（服务端已把该会话
		 *   剔除出恢复候选 = 取消生效；行留在列表里用户才能「恢复」撤销）；
		 * - 按 id 去重（服务端顺序在前，本地多出的行按原顺序缀后），任何非法输入不抛错。
		 * @param {Array<{id: string, at?: string, running?: boolean, title?: string, workspace?: string, source?: string, activate?: boolean, cancelled?: boolean}>|unknown} prevRows 本地行
		 * @param {Array<{id: string, at?: string, running?: boolean, title?: string, workspace?: string, source?: string, activate?: boolean}>|unknown} nextRows normalizeCandidateDetails 的输出
		 * @returns {Array<{id: string, at: string, running: boolean, cancelled: boolean, title?: string, workspace?: string, source?: string, activate?: false}>}
		 */
		function mergePendingRows(prevRows, nextRows) {
			const prev = Array.isArray(prevRows) ? prevRows : [];
			const next = Array.isArray(nextRows) ? nextRows : [];
			const prevById = new Map();
			for (const row of prev) {
				if (row !== null && typeof row === "object" && typeof row.id === "string" && row.id) {
					prevById.set(row.id, row);
				}
			}
			const merged = [];
			const seen = new Set();
			for (const row of next) {
				if (row === null || typeof row !== "object" || typeof row.id !== "string" || row.id === "") continue;
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				const local = prevById.get(row.id);
				const item = {
					id: row.id,
					at: typeof row.at === "string" ? row.at : "",
					running: row.running === true,
					cancelled: local ? local.cancelled === true : false,
				};
				// title 服务端为准；服务端这轮没带（投影探测偶发落空）回退本地旧值
				const title = typeof row.title === "string" && row.title
					? row.title
					: (local && typeof local.title === "string" ? local.title : "");
				if (title) item.title = title;
				// 0.18.0：workspace 同款合并口径——服务端为准，服务端这轮没带（旧宿主
				// /探测偶发缺失）回退本地旧值；两边都没有则不带（= 未知工作区分组）
				const workspace = typeof row.workspace === "string" && row.workspace
					? row.workspace
					: (local && typeof local.workspace === "string" ? local.workspace : "");
				if (workspace) item.workspace = workspace;
				// 0.19.0：source 同款合并口径——服务端为准，服务端这轮没带回退本地
				// 旧值；两边都没有则不带（= 无技能注册徽标，自动候选）
				const source = typeof row.source === "string" && row.source
					? row.source
					: (local && typeof local.source === "string" ? local.source : "");
				if (source) item.source = source;
				// 0.23.0：activate（注册但不激活）同款合并口径——仅 false 参与（true/
				// 缺失一律不带 = 默认激活模式）；服务端为准，服务端这轮没带（旧宿主）
				// 回退本地旧值，两边都没有则不带
				if (row.activate === false || (local && local.activate === false)) item.activate = false;
				merged.push(item);
			}
			for (const row of prev) {
				if (row === null || typeof row !== "object" || typeof row.id !== "string" || row.id === "") continue;
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				const item = {
					id: row.id,
					at: typeof row.at === "string" ? row.at : "",
					running: row.running === true,
					cancelled: true, // 服务端不再返回 = 该会话已被排除出恢复候选
				};
				if (typeof row.title === "string" && row.title) item.title = row.title;
				if (typeof row.workspace === "string" && row.workspace) item.workspace = row.workspace;
				if (typeof row.source === "string" && row.source) item.source = row.source;
				// 0.23.0：注册但不激活标记随本地行保留（仅 false 才带）
				if (row.activate === false) item.activate = false;
				merged.push(item);
			}
			return merged;
		}

		/**
		 * 标记待恢复列表行的取消/恢复（纯函数）：返回**新数组**，不改入参——
		 * ids 命中的行浅拷贝并覆写 cancelled，其余行原引用保留。
		 * ids 支持单个字符串或字符串数组；非法输入只生成新数组，绝不抛错。
		 * @param {Array<{id: string, cancelled?: boolean}>|unknown} rows
		 * @param {string|string[]} ids
		 * @param {boolean} cancelled
		 * @returns {Array<object>}
		 */
		function setPendingCancelled(rows, ids, cancelled) {
			const list = Array.isArray(rows) ? rows : [];
			const wanted = typeof ids === "string" && ids ? [ids] : (Array.isArray(ids) ? ids : []);
			const wantedSet = new Set(wanted.filter((id) => typeof id === "string" && id));
			return list.map((row) => {
				if (row === null || typeof row !== "object" || !wantedSet.has(row.id)) return row;
				return Object.assign({}, row, { cancelled: cancelled === true });
			});
		}

		/**
		 * 待恢复列表中未取消（仍会自动恢复）的行数（纯函数）：cancelled !== true 的
		 * 对象行都计数；非法输入按 0。
		 * @param {Array<{cancelled?: boolean}>|unknown} rows
		 * @returns {number}
		 */
		function activePendingCount(rows) {
			const list = Array.isArray(rows) ? rows : [];
			let count = 0;
			for (const row of list) {
				if (row !== null && typeof row === "object" && row.cancelled !== true) count += 1;
			}
			return count;
		}

		// ---- 0.18.0：待恢复列表按工作区分组（纯函数，返回新组数组不改入参） ----

		/**
		 * 把待恢复列表行按所属工作区分组（纯函数，防御式）：
		 * - 行的 `workspace` 非空字符串 = 所属工作区完整路径；缺失/空串/非字符串 =
		 *   「未知工作区」（组键 ''）；
		 * - 输出有序组数组 `[{ workspace, rows }]`：
		 *   - 组内按 `at` 倒序（ISO 字符串，解析失败按 0 = 最旧；相等保持输入顺序）；
		 *   - 组间按「组内最新 at」（排序后组内首行）倒序；
		 *   - 未知工作区组（workspace === ''）**恒排最后**，不参与组间排序；
		 * - 输入顺序决定同 at 行与组的稳定次序；返回新数组/新组对象，入参行不被
		 *   改写（行引用原样保留）；非法行（非对象/缺 id/空 id）跳过；非数组输入
		 *   返回 []。绝不抛错。
		 * @param {Array<{id: string, at?: string, workspace?: string}>|unknown} rows normalizeCandidateDetails / mergePendingRows 的输出
		 * @returns {Array<{workspace: string, rows: Array<object>}>}
		 */
		function groupPendingRows(rows) {
			const list = Array.isArray(rows) ? rows : [];
			const byWorkspace = new Map();
			const order = [];
			for (const row of list) {
				if (row === null || typeof row !== "object" || typeof row.id !== "string" || row.id === "") continue;
				const workspace = typeof row.workspace === "string" && row.workspace ? row.workspace : "";
				let group = byWorkspace.get(workspace);
				if (!group) {
					group = { workspace, rows: [] };
					byWorkspace.set(workspace, group);
					order.push(workspace);
				}
				group.rows.push(row);
			}
			/** at 的毫秒时间戳（ISO 解析失败/缺失按 0 = 最旧）。 */
			const atMsOf = (row) => {
				const parsed = Date.parse(typeof row.at === "string" ? row.at : "");
				return Number.isFinite(parsed) ? parsed : 0;
			};
			const groups = order.map((workspace) => byWorkspace.get(workspace));
			for (const group of groups) {
				group.rows.sort((a, b) => atMsOf(b) - atMsOf(a));
			}
			// 组间按组内最新 at（排序后首行）倒序；未知工作区组恒垫底
			groups.sort((a, b) => {
				if (a.workspace === "") return 1;
				if (b.workspace === "") return -1;
				return atMsOf(b.rows[0]) - atMsOf(a.rows[0]);
			});
			return groups;
		}

		// ---- 0.26.0：「上次重启无法恢复」列表（第三块，GET /unrestored 数据管线） ----

		/**
		 * GET /unrestored 的 rows → 列表行（纯函数，防御式）：id 非空字符串的
		 * 对象条目才保留，归一化为 { id, at, title?, workspace?, error? }（at 非字符串
		 * 归 ''——登记时间展示与分组排序都容忍；title/workspace/error 非空字符串
		 * 才带，与「拿到才带」口径一致）；保持输入顺序（服务端 store 已按新在前
		 * 排序）；非法输入返回 []，绝不抛错。
		 * @param {unknown} rows GET /unrestored 响应的 rows 字段
		 * @returns {Array<{id: string, at: string, title?: string, workspace?: string, error?: string}>}
		 */
		function normalizeUnrestoredRows(rows) {
			if (!Array.isArray(rows)) return [];
			const out = [];
			for (const row of rows) {
				if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
				if (typeof row.id !== "string" || row.id === "") continue;
				const item = { id: row.id, at: typeof row.at === "string" ? row.at : "" };
				if (typeof row.title === "string" && row.title) item.title = row.title;
				if (typeof row.workspace === "string" && row.workspace) item.workspace = row.workspace;
				if (typeof row.error === "string" && row.error) item.error = row.error;
				out.push(item);
			}
			return out;
		}

		// ---- 0.15.0：暂停所有会话（pause-all）的结果摘要（纯函数） ----

		/**
		 * 把 POST /pause-all 的成功响应摘要成一行展示文案（纯函数，防御式）：
		 * - stopped 与 failed 全为 0 → `pause.doneNone`（「没有正在运行的会话」）；
		 * - 否则主段 = `pause.done`（「已暂停 %s 个会话」），subagent/failed 计数 > 0 时
		 *   依次附加 `pause.doneSubagent` / `pause.doneFailed` 段，段间以 " · " 连接
		 *   （与 originDetail 同款分隔符，locale 中立）；
		 * - result 非对象 / 段数组缺失或非数组按 0 计，绝不抛错；
		 * - t 非函数时回退内置 zh 字典（同 T 的兜底）。
		 * @param {{stopped?: unknown, subagent?: unknown, failed?: unknown}|null|undefined} result
		 * @param {(key: string) => string} t
		 * @returns {string}
		 */
		function formatPauseResult(result, t) {
			const translate = typeof t === "function" ? t : T;
			if (result === null || typeof result !== "object") return "";
			const countOf = (list) => (Array.isArray(list) ? list.length : 0);
			const stopped = countOf(result.stopped);
			const subagent = countOf(result.subagent);
			const failed = countOf(result.failed);
			if (stopped === 0 && failed === 0) return translate("pause.doneNone");
			const segments = [translate("pause.done").replace("%s", String(stopped))];
			if (subagent > 0) segments.push(translate("pause.doneSubagent").replace("%s", String(subagent)));
			if (failed > 0) segments.push(translate("pause.doneFailed").replace("%s", String(failed)));
			return segments.join(" · ");
		}

		/** 设置弹窗 section 样式（一次注入；全部走 DSH 设计 token，明暗主题自适应）。 */
		const SETTINGS_CSS = [
			".dsh-ror-settings{padding:4px 2px;}",
			".dsh-ror-title{margin:0 0 10px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);}",
			".dsh-ror-note{margin:0 0 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-toolbar{display:flex;justify-content:flex-end;margin:0 0 6px;}",
			".dsh-ror-refresh{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;cursor:pointer;}",
			".dsh-ror-refresh:hover{background:var(--dsw-alias-bg-layer-3);}",
			".dsh-ror-refresh:disabled{opacity:.6;cursor:default;}",
			".dsh-ror-status{margin:6px 2px;font-size:12px;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-list{display:flex;flex-direction:column;gap:6px;}",
			".dsh-ror-group{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}",
			".dsh-ror-row{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;box-sizing:border-box;}",
			".dsh-ror-row:hover{background:var(--dsw-alias-bg-layer-3);}",
			".dsh-ror-time{flex:none;min-width:118px;font-variant-numeric:tabular-nums;}",
			".dsh-ror-badge{flex:none;padding:1px 7px;border-radius:999px;font-size:11px;line-height:1.5;background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.14));}",
			".dsh-ror-reason-power-button{background:rgba(48,132,74,.22);}",
			".dsh-ror-reason-signal{background:rgba(36,99,173,.22);}",
			".dsh-ror-reason-crash{background:rgba(176,58,46,.24);}",
			".dsh-ror-origin{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-downtime{flex:none;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-score{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-caret{flex:none;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-detail{padding:2px 10px 9px;border-top:1px dashed var(--dsw-alias-border-l1);}",
			".dsh-ror-detail-title{margin:7px 0 3px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-fact{display:flex;gap:8px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-fact-key{flex:none;min-width:96px;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-fact-val{flex:1;min-width:0;overflow-wrap:anywhere;}",
			".dsh-ror-restores{margin-top:5px;display:flex;flex-direction:column;gap:3px;}",
			".dsh-ror-restore{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5;}",
			".dsh-ror-restore .dsh-ror-badge{min-width:52px;text-align:center;}",
			".dsh-ror-restore-id{flex:none;font-variant-numeric:tabular-nums;}",
			".dsh-ror-restore-error{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);}",
			// ---- 0.13.0 修正：待恢复列表/对账视图行改「标题为主、id 退位」----
			// 标题占满剩余空间、省略号截断（全文在元素 title 属性）；title 缺失退
			// shortId 时加 -fallback 弱化色，提示这是占位 id 而非真实标题
			".dsh-ror-restore-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);}",
			".dsh-ror-restore-title-fallback{color:var(--dsw-alias-label-tertiary);}",
			// ---- 0.9.1：subagent 会话结算徽标（青调；经主会话祖先恢复，不算失败） ----
			".dsh-ror-result-subagent{background:rgba(32,124,124,.26);}",
			// ---- 0.9.0：归档结算徽标（紫调；不算失败，与 crash 红/failed 视觉区分） ----
			".dsh-ror-result-archived{background:rgba(114,82,178,.26);}",
			// ---- 0.8.0：重启 section / 确认弹窗 / toast ----
			".dsh-ror-reason-restart-button{background:rgba(43,124,201,.26);}",
			".dsh-ror-restart-actions{display:flex;align-items:center;gap:10px;margin:10px 0 2px;flex-wrap:wrap;}",
			".dsh-ror-btn-danger{border:1px solid rgba(176,58,46,.55);border-radius:6px;padding:6px 14px;background:rgba(176,58,46,.14);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;cursor:pointer;}",
			".dsh-ror-btn-danger:hover{background:rgba(176,58,46,.26);}",
			".dsh-ror-btn-danger:disabled{opacity:.55;cursor:default;}",
			".dsh-ror-restart-status{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-restart-warn{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);}",
			// ---- 0.13.0：待恢复列表 / 等待计时 / 恢复结果对账（复用 dsh-ror-restore 行样式） ----
			".dsh-ror-pending{margin:8px 0 2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;}",
			".dsh-ror-pending-title{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}",
			".dsh-ror-pending-score{margin:0 0 6px;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-pending-at{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-running{background:rgba(48,132,74,.22);}",
			// ---- 0.19.0：主动注册重启恢复会话徽标（紫调；与运行中绿/已取消灰区分） ----
			".dsh-ror-skill-badge{background:rgba(138,90,210,.3);}",
			// ---- 0.23.0：注册但不激活徽标（琥珀调；与紫调技能注册徽标区分） ----
			".dsh-ror-noactivate-badge{background:rgba(191,132,44,.3);}",
			// ---- 0.23.0：no-activate 结算/重启日志结果徽标（琥珀调；故意不激活，不算失败） ----
			".dsh-ror-result-no-activate{background:rgba(191,132,44,.26);}",
			// ---- 0.26.0：skipped-service-timeout 结算徽标（青灰蓝调；服务始终未就绪，
			//      与运行中绿/失败红/琥珀不激活都区分） ----
			".dsh-ror-result-skipped-service-timeout{background:rgba(84,110,160,.3);}",
			".dsh-ror-settle-pending{background:rgba(127,127,127,.2);}",
			".dsh-ror-settle-unsettled{background:rgba(176,58,46,.18);}",
			// ---- 0.14.0：待恢复列表的批量工具条 / 行内小按钮 / 已取消弱化行 ----
			".dsh-ror-pending-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
			// ---- 0.17.0：待恢复列表标题行（标题 + 右侧「刷新」按钮） ----
			".dsh-ror-pending-titlebar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;}",
			".dsh-ror-pending-titlebar .dsh-ror-pending-title{margin:0;}",
			".dsh-ror-pending-selectall{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;}",
			".dsh-ror-pending-check{margin:0;cursor:pointer;flex:none;}",
			".dsh-ror-pending-check:disabled{cursor:default;opacity:.5;}",
			".dsh-ror-pending-selected{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-pending-act{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1.4;cursor:pointer;}",
			".dsh-ror-pending-act:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);}",
			".dsh-ror-pending-act:disabled{opacity:.55;cursor:default;}",
			".dsh-ror-pending-row-cancelled .dsh-ror-restore-title,.dsh-ror-pending-row-cancelled .dsh-ror-pending-at{opacity:.55;}",
			".dsh-ror-pending-cancelled-badge{background:var(--dsw-alias-fill-tsp-secondary,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary);}",
			// ---- 0.18.0：待恢复列表工作区分组头（完整路径为主文本，省略号截断、
			//      全文在 title 属性；小节标题风格沿用既有 token） ----
			".dsh-ror-pending-group{margin:6px 0 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			// ---- 0.25.0：会话行点击跳转（待恢复列表与对账视图的可点行共用；
			//      hover 提亮写法照抄 .dsh-ror-refresh / .dsh-ror-row） ----
			".dsh-ror-restore-click{cursor:pointer;}",
			".dsh-ror-restore-click:hover{background:var(--dsw-alias-bg-layer-3);}",
			".dsh-ror-modal-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}",
			".dsh-ror-modal{width:min(420px,calc(100vw - 48px));background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:18px 18px 14px;box-shadow:0 12px 40px rgba(0,0,0,.25);}",
			".dsh-ror-modal-title{margin:0 0 8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);}",
			".dsh-ror-modal-body{margin:0 0 8px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-modal-warn{margin:0 0 8px;font-size:12px;line-height:1.7;color:rgba(176,58,46,.9);}",
			".dsh-ror-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}",
			".dsh-ror-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;cursor:pointer;}",
			".dsh-ror-btn:hover{background:var(--dsw-alias-bg-layer-3);}",
			".dsh-ror-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:10001;max-width:min(560px,calc(100vw - 40px));padding:10px 16px;border-radius:8px;background:rgba(48,132,74,.92);color:#fff;font-size:12px;line-height:1.6;box-shadow:0 8px 24px rgba(0,0,0,.28);}",
			// ---- 0.21.0：重启等待态可视化强化（横幅卡片 + 视口固定提示条 + 旋转圆环；定位/阴影写法照抄 .dsh-ror-toast） ----
			".dsh-ror-waiting{display:flex;align-items:center;gap:12px;margin:10px 0 4px;padding:10px 14px;border:1px solid rgba(43,124,201,.55);border-radius:8px;background:rgba(43,124,201,.14);}",
			".dsh-ror-waiting-spin{flex:none;width:18px;height:18px;border:2.5px solid rgba(43,124,201,.25);border-top-color:rgba(43,124,201,.95);border-radius:50%;animation:dsh-ror-spin .8s linear infinite;}",
			".dsh-ror-waiting-main{flex:1;min-width:0;}",
			".dsh-ror-waiting-title{margin:0;font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary);}",
			".dsh-ror-waiting-sub{margin:2px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-waiting-elapsed{flex:none;font-variant-numeric:tabular-nums;font-size:18px;font-weight:700;color:rgba(43,124,201,1);}",
			".dsh-ror-waiting-fixed{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:10001;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 40px));padding:10px 18px;border-radius:999px;background:rgba(43,124,201,.95);color:#fff;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.28);}",
			".dsh-ror-waiting-fixed .dsh-ror-waiting-spin{width:14px;height:14px;border-width:2px;border-color:rgba(255,255,255,.35);border-top-color:#fff;}",
			// ---- 0.28.0：设置弹窗合并后的 tab 栏（role=tablist/tab + aria-selected）：
			//      token 写法照抄 .dsh-ror-btn / .dsh-ror-refresh（明暗主题自适应），
			//      选中态蓝调强调照抄 .dsh-ror-waiting 的 rgba(43,124,201,*) 用色口径
			".dsh-ror-tabs{display:flex;gap:6px;margin:0 0 12px;}",
			".dsh-ror-tab{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.4;cursor:pointer;}",
			".dsh-ror-tab:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);}",
			".dsh-ror-tab-active,.dsh-ror-tab-active:hover{background:rgba(43,124,201,.14);border-color:rgba(43,124,201,.55);color:var(--dsw-alias-label-primary);font-weight:600;}",
			"@keyframes dsh-ror-spin{to{transform:rotate(360deg);}}",
			"@media (prefers-reduced-motion:reduce){.dsh-ror-waiting-spin{animation:none;}}",
			// ---- 0.29.0：tab3「技能与注入」（.dsh-ror-skill*；token 写法照抄既有类
			//      （.dsh-ror-btn / .dsh-ror-row / .dsh-ror-pending-act 等，明暗主题自
			//      适应），徽标蓝调/绿调照 .dsh-ror-waiting / .dsh-ror-running 用色口径） ----
			".dsh-ror-skill-stats{display:flex;gap:22px;flex-wrap:wrap;margin:0 0 10px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}",
			".dsh-ror-skill-stat{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-skill-stat-val{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}",
			".dsh-ror-skill-search{flex:1;min-width:160px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;}",
			".dsh-ror-skill-search:focus{outline:none;border-color:rgba(43,124,201,.55);}",
			".dsh-ror-skill-search::placeholder{color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-skill-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;margin:0 0 8px;}",
			".dsh-ror-skill-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".dsh-ror-skill-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}",
			".dsh-ror-skill-flag{border:none;border-radius:4px;padding:2px 7px;font-size:11px;line-height:1.4;background:rgba(43,124,201,.14);color:var(--dsw-alias-label-primary);}",
			".dsh-ror-skill-flag-user{background:rgba(48,132,74,.22);}",
			".dsh-ror-skill-provider{min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".dsh-ror-skill-desc{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}",
			".dsh-ror-skill-when{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;}",
			".dsh-ror-skill-usage{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}",
			".dsh-ror-skill-toggle{display:block;margin:8px 0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1.4;cursor:pointer;}",
			".dsh-ror-skill-toggle:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);}",
			".dsh-ror-skill-content{margin:6px 0 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;}",
			".dsh-ror-skill-dist{margin:8px 0 0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-skill-dist-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-skill-dist-row{display:flex;justify-content:space-between;gap:10px;}",
			".dsh-ror-skill-dist-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".dsh-ror-skill-dist-count{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);}",
			".dsh-ror-skill-daily{margin:8px 0 0;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}",
		].join("");

		/** 明细行（key: value）。 */
		function detailRow(key, value) {
			return (0, react.createElement)(
				"div",
				{ className: "dsh-ror-fact", key },
				(0, react.createElement)("span", { className: "dsh-ror-fact-key" }, key),
				(0, react.createElement)("span", { className: "dsh-ror-fact-val" }, value),
			);
		}

		/** 单条 restore 明细行：结果徽标 + 截断会话 id + 错误/备注。 */
		function restoreRow(entry, t) {
			const result = typeof entry.result === "string" && entry.result ? entry.result : "unknown";
			return (0, react.createElement)(
				"div",
				{ className: "dsh-ror-restore", key: `${entry.id}:${entry.at ?? result}` },
				(0, react.createElement)(
					"span",
					{ className: `dsh-ror-badge dsh-ror-result-${result}` },
					t(`restore.${result}`),
				),
				(0, react.createElement)("span", { className: "dsh-ror-restore-id", title: entry.id }, shortId(entry.id, 18)),
				(0, react.createElement)("span", { className: "dsh-ror-restore-error", title: entry.error ?? "" }, entry.error ?? ""),
			);
		}

		/** 一组（boot + restores）的展开明细：boot 事实 + 逐会话 restore 列表。 */
		function groupDetail(group, t) {
			const boot = group.boot;
			const shutdown = boot?.shutdown;
			const origin = boot?.origin;
			const children = [
				(0, react.createElement)("div", { className: "dsh-ror-detail-title", key: "title" }, t("detail.boot")),
			];
			if (boot === null) {
				children.push((0, react.createElement)("div", { className: "dsh-ror-fact", key: "orphan" }, t("log.empty")));
			} else {
				const shutdownText = shutdown && shutdown.seen === true
					? `${typeof shutdown.signal === "string" && shutdown.signal ? shutdown.signal : "?"} @ ${formatTime(shutdown.at)}`
					: t("reason.crash");
				const originDetail = origin && typeof origin === "object"
					? `${origin.kind ?? "?"} · ${origin.sessionId ?? "?"}${typeof origin.restartId === "string" ? ` · ${origin.restartId}` : ""}`
					: t("origin.none");
				children.push(detailRow(t("detail.prevBoot"), formatTime(boot.prevBootAt)));
				children.push(detailRow(t("label.downtime"), humanizeMs(boot.downtimeMs)));
				children.push(detailRow(t("detail.pid"), `${boot.prevPid ?? "—"} → ${boot.pid ?? "—"}`));
				children.push(detailRow(t("detail.detectBasis"), boot.detectBasis ?? "—"));
				children.push(detailRow(t("detail.shutdown"), shutdownText));
				children.push(detailRow(t("detail.origin"), originDetail));
				const running = Array.isArray(boot.runningSessions) ? boot.runningSessions : [];
				children.push(detailRow(
					t("detail.runningSessions"),
					running.map((e) => shortId(e?.id)).filter(Boolean).join(", ") || "—",
				));
			}
			if (group.restores.length > 0) {
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-restores", key: "restores" },
					group.restores.map((entry) => restoreRow(entry, t)),
				));
			} else {
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-restores", key: "restores" },
					t("detail.noRestores"),
				));
			}
			return (0, react.createElement)("div", { className: "dsh-ror-detail" }, children);
		}

		/**
		 * 设置弹窗「重启日志」section：倒序 boot 分组列表，点行展开明细。
		 * 挂载时拉取一次，另有手动刷新；请求失败显示错误文案并 console.warn。
		 * shell 只提供 close/t（locale: NS 时注入翻译函数），自带文案与样式。
		 */
		function RestartLogSection({ t }) {
			const translate = typeof t === "function" ? t : T;
			const [phase, setPhase] = (0, react.useState)("loading");
			const [groups, setGroups] = (0, react.useState)([]);
			const [expanded, setExpanded] = (0, react.useState)(() => new Set());
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const load = (0, react.useCallback)(async () => {
				setRefreshing(true);
				try {
					const res = await fetch(`${API_BASE}/restarts`, { cache: "no-store" });
					if (res.status === 404) {
						// 404 = 重启日志还没有：插件更新后 DSH 未重启、宿主 half 尚未加载新路由的
						// 混合版本窗口，或 restarts.ndjson 尚未生成（日志文件不存在时宿主本就
						// 返回 200 + 空数组）。等价空日志，按空态展示「暂无重启记录」，不报错。
						setGroups([]);
						setPhase("ready");
						return;
					}
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const data = await res.json().catch(() => null);
					const entries = data && Array.isArray(data.entries) ? data.entries : [];
					setGroups(groupEntries(entries));
					setPhase("ready");
				} catch (err) {
					console.warn("[resume-on-restart] restarts query failed:", err);
					setPhase("error");
				} finally {
					setRefreshing(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);
			const toggle = (key) => {
				setExpanded((prev) => {
					const next = new Set(prev);
					if (next.has(key)) next.delete(key);
					else next.add(key);
					return next;
				});
			};
			const children = [
				(0, react.createElement)(
					"h4",
					{ className: "dsh-ror-title", key: "title" },
					`${translate("settings.title")}（dsh-resume-on-restart）`,
				),
				(0, react.createElement)("p", { className: "dsh-ror-note", key: "note" }, translate("settings.note")),
				(0, react.createElement)(
					"div",
					{ className: "dsh-ror-toolbar", key: "toolbar" },
					(0, react.createElement)(
						"button",
						{ type: "button", className: "dsh-ror-refresh", disabled: refreshing, onClick: load },
						translate("log.refresh"),
					),
				),
			];
			if (phase === "loading") {
				children.push((0, react.createElement)("div", { className: "dsh-ror-status", key: "status" }, translate("log.loading")));
			} else if (phase === "error") {
				children.push((0, react.createElement)("div", { className: "dsh-ror-status", key: "status" }, translate("log.loadFailed")));
			} else if (groups.length === 0) {
				children.push((0, react.createElement)("div", { className: "dsh-ror-status", key: "status" }, translate("log.empty")));
			} else {
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-list", key: "list" },
					groups.map((group, index) => {
						const boot = group.boot;
						const reason = reasonOf(boot);
						const time = boot?.at ?? group.restores[0]?.bootAt;
						const key = `${boot ? "boot" : "orphan"}-${time ?? ""}-${index}`;
						const resumed = group.restores.filter((entry) => entry.result === "resumed").length;
						const isOpen = expanded.has(key);
						const row = (0, react.createElement)(
							"button",
							{
								type: "button",
								className: "dsh-ror-row",
								"aria-expanded": isOpen,
								onClick: () => toggle(key),
							},
							(0, react.createElement)("span", { className: "dsh-ror-time" }, formatTime(time)),
							(0, react.createElement)(
								"span",
								{ className: `dsh-ror-badge dsh-ror-reason-${reason}` },
								translate(`reason.${reason}`),
							),
							(0, react.createElement)("span", { className: "dsh-ror-origin", title: originTextOf(boot, translate) }, originTextOf(boot, translate)),
							(0, react.createElement)(
								"span",
								{ className: "dsh-ror-downtime" },
								`${translate("label.downtime")} ${humanizeMs(boot?.downtimeMs)}`,
							),
							(0, react.createElement)(
								"span",
								{ className: "dsh-ror-score", title: translate("label.restored") },
								`${resumed}/${group.restores.length}`,
							),
							(0, react.createElement)("span", { className: "dsh-ror-caret" }, isOpen ? "▾" : "▸"),
						);
						return (0, react.createElement)(
							"div",
							{ className: "dsh-ror-group", key },
							row,
							isOpen ? groupDetail(group, translate) : null,
						);
					}),
				));
			}
			return (0, react.createElement)("div", { className: "dsh-ror-settings" }, children);
		}

		/**
		 * 二次确认弹窗（0.8.0）：默认焦点在「取消」上——回车/失手只会取消；
		 * Esc 与点击遮罩同样取消，唯一前进路径是显式点「确认重启」。
		 * 纯受控组件，状态由 RestartSection 持有。
		 * 0.15.0 泛化：title/body/confirmLabel props 可覆盖重启文案（「暂停所有会话」
		 * 的确认弹窗共用同一组件与 .dsh-ror-modal 样式），neutral 为 true 时确认按钮
		 * 用中性 .dsh-ror-btn（非 danger 红）；不传时行为与 0.14.0 完全一致。
		 */
		function RestartConfirmDialog({ t, isPid1, busy, onConfirm, onCancel, title, body, confirmLabel, neutral }) {
			const cancelRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (cancelRef.current) cancelRef.current.focus();
			}, []);
			(0, react.useEffect)(() => {
				const onKey = (e) => {
					if (e.key === "Escape") onCancel();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onCancel]);
			const titleText = typeof title === "string" && title ? title : t("restart.confirmTitle");
			const bodyText = typeof body === "string" && body ? body : t("restart.confirmBody");
			const confirmText = typeof confirmLabel === "string" && confirmLabel ? confirmLabel : t("restart.confirm");
			return (0, react.createElement)(
				"div",
				{ className: "dsh-ror-modal-backdrop", onClick: onCancel },
				(0, react.createElement)(
					"div",
					{
						className: "dsh-ror-modal",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": titleText,
						onClick: (e) => e.stopPropagation(),
					},
					(0, react.createElement)("h4", { className: "dsh-ror-modal-title" }, titleText),
					(0, react.createElement)("p", { className: "dsh-ror-modal-body" }, bodyText),
					isPid1 ? (0, react.createElement)("p", { className: "dsh-ror-modal-warn" }, t("restart.confirmBodyPid1")) : null,
					(0, react.createElement)(
						"div",
						{ className: "dsh-ror-modal-actions" },
						(0, react.createElement)(
							"button",
							{ ref: cancelRef, type: "button", className: "dsh-ror-btn", onClick: onCancel, disabled: busy },
							t("restart.cancel"),
						),
						(0, react.createElement)(
							"button",
							{ type: "button", className: neutral === true ? "dsh-ror-btn" : "dsh-ror-btn-danger", onClick: onConfirm, disabled: busy },
							confirmText,
						),
					),
				),
			);
		}

		/**
		 * 设置弹窗左侧「重启」section（0.8.0，0.13.0 扩展）：
		 * - 挂载时 GET /restart/info 取模式说明与恢复候选数（请求失败只降级为
		 *   不显示计数，不阻断按钮——info 缺失时按钮仍可用）；
		 * - 按钮进入 confirm 弹窗（二次确认）→ 确认后先捕获基线 instanceId 再
		 *   POST /restart，随后单飞轮询 /restart/health：instanceId 相对基线变更
		 *   （或无基线时"见过挂掉 + 重新起来"）才刷新页面，短暂断线绝不当成功；
		 * - pid1-exit 模式超过快速轮询窗口后提示容器重启策略可能未拉起，
		 *   降频（5s）继续等待——容器策略或手动 docker start 随时把它带回来。
		 * - 0.13.0 确认后流程可视化：进入 confirm 弹窗时重拉一次 /restart/info
		 *   （点击时刻的最新口径），waiting 阶段展示「待重启恢复会话列表」（会话
		 *   标题为主——省略号截断、全文在 title 属性，缺失退 shortId 弱化显示，
		 *   完整 id 在行容器 title 属性悬停提示 + 最后活跃本地时间 + 运行中标记，
		 *   空列表显示「无待恢复会话」）与「重启中… 已等待 N 秒」每秒跳动的计时；
		 *   POST 成功覆盖写 localStorage 存根、失败回 idle（计时器随 phase 清理、
		 *   列表保留、按钮可重试）；
		 * - 0.13.0 重启后对账：挂载读 localStorage 存根（无则什么都不显示），
		 *   GET /restarts 匹配 boot（restartId 优先、时间容差回退）后按 id 归组
		 *   restore 记录，列表原位变为「上次重启(<时间>)的恢复结果：x/y 已恢复」+
		 *   逐会话结算徽标；存在待结算会话时每 3s 短轮询（最多 20 次，全部候选有
		 *   结算记录即提前停），轮询结束仍未结算的显示「未结算」。
		 * - 0.14.0 待恢复列表的逐行 / 批量「取消 / 恢复」：每行行尾按钮 + 批量工具条
		 *   （全选 checkbox 半选 +「已选 N 项」+「取消所选」「恢复所选」），复用既有
		 *   POST /state 每会话一次请求、选中行逐个串行发送；乐观更新 + 失败仅回滚
		 *   对应行并 console.warn（风格照抄 ResumeToggle.toggle）；waiting 阶段列表
		 *   转只读（隐藏 checkbox 与全部操作按钮），对账视图保持只读不动；
		 *   openConfirm 重拉经 mergePendingRows 合并（服务端不再返回的行保留并置
		 *   cancelled=true，防「取消后无法恢复」），候选计数按未取消行数实时显示
		 *   （activePendingCount）。取消标记只存组件本地 state，不写 localStorage 存根。
		 * - 0.15.0「暂停所有会话」：actions 行「重启 DSH」左侧新增中性按钮（仅
		 *   info.pauseAll === false 时隐藏；restart 非 idle 时禁用），点击弹二次确认
		 *   （RestartConfirmDialog 泛化共用）→ POST /pause-all → formatPauseResult 摘要
		 *   + 重拉 /restart/info 刷新候选计数与列表运行徽标；暂停状态（pausePhase/
		 *   pauseResult/pauseErrorText）与重启流程独立互不覆盖；pausePhase 非 idle 时
		 *   「重启 DSH」禁用（双向互斥），doing 阶段两个按钮都禁用。
		 * - 0.16.0 进入选项卡即展示本次待恢复会话：挂载时的 GET /restart/info 拿到
		 *   响应后直接经 normalizeCandidateDetails 构建列表（来源模式 pendingMode =
		 *   preview），与点「重启 DSH」后的列表（confirm）共用同一构建
		 *   renderPendingList——逐行/批量「取消 / 恢复」在选项卡内直接可用，空列表
		 *   显示「无待恢复会话」，候选计数同口径联动；openConfirm 点击时刻重拉 +
		 *   mergePendingRows 合并口径保留（preview 阶段的取消标记随合并进入
		 *   confirm；clickedRef 防挂载响应晚到覆盖点击时刻的合并结果）；waiting
		 *   只读不变；preview 列表不遮蔽对账视图（两块同时渲染，列表在上），
		 *   confirm 列表仍优先于对账视图（0.13.0 原语义，0.24.0 起废止，见下）。
		 * - 0.24.0 对账视图不再被列表遮蔽：对账视图渲染门放宽为 settlement 非 null
		 *   即渲染——点「重启 DSH」进入 confirm、waiting 等待、POST 失败回 idle 各
		 *   阶段都是「待恢复列表在上、对账视图在下」的双块堆叠（0.16.0 preview
		 *   既有结构的推广）；存根数据链路与重启后新存根展示新一轮对账不变。
		 * - 0.24.0 进入选项卡 = 点「刷新」按钮：挂载 effect 与 refreshPendingList
		 *   收敛为共用同一条管线 syncPendingFromInfo（fetch info → setInfo →
		 *   normalizeCandidateDetails → mergePendingRows 合并 → 选中集合同步收窄 →
		 *   失败静默 console.warn 保留现有行），进入页面与点刷新行为完全一致；
		 *   挂载只补入口语义（clickedRef 晚到响应不覆盖列表、pendingMode 仅从 none
		 *   升为 preview、卸载 cancelled 防串态），openConfirm 保持原实现不动。
		 * - 0.25.0 会话行点击跳转：签名扩展为 { t, close }（close = settings.section
		 *   owner props 注入的关弹窗回调，宿主 shell 渲染 section 时传
		 *   { close: onClose }，可能 undefined，jumpToSession 内部防御）。待恢复列表
		 *   行非 waiting 阶段绑 onClick → jumpToSession(row.id, close) + 可点样式 +
		 *   title 追加跳转提示；行内 checkbox 与行尾「取消 / 恢复」按钮
		 *   stopPropagation 防点控件误触发行跳转；waiting 只读阶段不绑行点击、
		 *   不加可点样式（与该阶段隐藏全部按钮的既有约束一致）。对账视图行全部
		 *   绑跳转（只读展示无控件冲突）；对账行区并改按工作区分组（groupPendingRows
		 *   复用，见 settlement 渲染块与 readPendingRestore / startRestart 的
		 *   workspace 透传）。
		 * - 0.26.0 第三块「上次重启无法恢复」列表：挂载 GET /unrestored（404 =
		 *   混合版本窗口静默不显示，照 /restarts 404 口径）、点「刷新」一并重拉
		 *   （syncUnrestored 同一管线）、仅 rows 非空渲染，位置在待恢复列表之后、
		 *   对账视图之前；行结构与另两个列表一致（可点行跳转 + 结算徽标
		 *   restore.skipped-service-timeout + 会话标题 + 登记时间 + 行尾「恢复」
		 *   按钮，按工作区分组复用 groupPendingRows），批量工具条照 0.14.0 模式
		 *   （全选半选 + 已选 N 项 + 恢复所选，复用 key）；串行逐个 POST
		 *   /unrestored/restore、乐观移除行、失败 console.warn 保留行，
		 *   在途集合 unrestoredMutatingIds 防重复点击。
		 */
		function RestartSection({ t, close }) {
			const translate = typeof t === "function" ? t : T;
			const [info, setInfo] = (0, react.useState)(null);
			const [phase, setPhase] = (0, react.useState)("idle"); // idle | confirm | waiting
			const [errorText, setErrorText] = (0, react.useState)("");
			const [timedOut, setTimedOut] = (0, react.useState)(false);
			// 0.13.0：待恢复列表行数据（进入 confirm 弹窗时拉最新口径）；0.16.0 起
			// 进入选项卡即由挂载的 /restart/info 自动构建（来源见 pendingMode）——
			// null = 列表未构建（info 未就绪或请求失败），不显示列表
			const [pendingRows, setPendingRows] = (0, react.useState)(null);
			// 0.16.0：列表来源模式 none | preview | confirm——preview = 挂载拉
			// /restart/info 自动构建（进入选项卡即见）；confirm = 点过「重启 DSH」
			// （0.13.0 原语义）；0.24.0 起 preview / confirm 都不再遮蔽对账视图
			const [pendingMode, setPendingMode] = (0, react.useState)("none");
			// 0.13.0：waiting 阶段的已等待秒数（interval 随 phase 离开/卸载清理）
			const [elapsedSec, setElapsedSec] = (0, react.useState)(0);
			// 0.13.0：重启前存根的对账视图 { pending, boot, byId, settling }；
			// null = 无存根（或存根无候选），维持现状不显示任何对账内容
			const [settlement, setSettlement] = (0, react.useState)(null);
			// 0.14.0：批量选中的行 id 集合（组件本地 state，与取消标记一样不进存根）
			const [selectedIds, setSelectedIds] = (0, react.useState)(() => new Set());
			// 0.14.0：取消/恢复请求在途的行 id 集合（在途行禁用自身按钮，防重复点击）
			const [mutatingIds, setMutatingIds] = (0, react.useState)(() => new Set());
			// 0.26.0：「上次重启无法恢复」列表行（GET /unrestored；null = 尚未拉取或
			// 404 静默，仅非空数组渲染——第三块列表不渲染空态）
			const [unrestoredRows, setUnrestoredRows] = (0, react.useState)(null);
			// 0.26.0：手动恢复请求在途的行 id 集合（行级/批量共用，防重复点击，
			// 照 mutatingIds 模式）
			const [unrestoredMutatingIds, setUnrestoredMutatingIds] = (0, react.useState)(() => new Set());
			// 0.26.0：批量选中的行 id 集合（组件本地 state，不持久化）
			const [unrestoredSelectedIds, setUnrestoredSelectedIds] = (0, react.useState)(() => new Set());
			// 0.15.0：暂停所有会话的独立状态（与重启流程 phase/errorText 互不覆盖）：
			// pausePhase: idle | confirm | doing；pauseResult 为 /pause-all 的成功响应
			const [pausePhase, setPausePhase] = (0, react.useState)("idle");
			const [pauseResult, setPauseResult] = (0, react.useState)(null);
			const [pauseErrorText, setPauseErrorText] = (0, react.useState)("");
			const runningRef = (0, react.useRef)(false);
			// 0.16.0：本轮是否点过「重启 DSH」（openConfirm 同步置位）——挂载的
			// /restart/info 晚到时不得覆盖点击时刻已合并的列表，也不得回落 preview
			const clickedRef = (0, react.useRef)(false);
			// 0.17.0：待恢复列表手动刷新的拉取中标记（按钮禁用 + 文案「刷新中…」）
			const [refreshing, setRefreshing] = (0, react.useState)(false);

			/**
			 * 0.24.0：进入选项卡（挂载）与「刷新」按钮共用的同一条数据管线（原两条
			 * 重复但不完全一致的路径收敛为一，进入页面与点刷新行为完全一致）：
			 * GET /restart/info → setInfo → normalizeCandidateDetails 构建行 → 本地
			 * 无行直接用服务端行、有行经 mergePendingRows 合并（服务端为准、保留本地
			 * 取消标记，服务端不再返回的行保留并置 cancelled=true）→ 选中集合同步
			 * 收窄（只保留仍存在的行）→ 失败静默（console.warn，现有行原样保留）。
			 * 不改 pendingMode / phase / clickedRef——来源模式等入口语义由各调用方
			 * 自理（挂载在 applied 时把 none 升为 preview；刷新不动 pendingMode）。
			 * @param {{isStale?: () => boolean, skipIfClicked?: () => boolean}} [opts]
			 *   isStale：响应到达时的放弃判定（挂载路径传 `() => cancelled`——组件已
			 *   卸载则连 setInfo 都不执行，防串态，与 0.16.0 挂载行为一致）；
			 *   skipIfClicked：响应有效时的跳过判定（挂载路径传
			 *   `() => clickedRef.current`——请求在途时用户已点「重启 DSH」，晚到的
			 *   挂载响应只更新 info、不得覆盖点击时刻已合并的列表）。
			 * @returns {Promise<boolean>} 行数据是否被本次响应更新（挂载路径据此决定
			 *   是否把 pendingMode 从 none 升为 preview；失败/响应无效/被守卫跳过时
			 *   为 false）。返回的 promise 永不 reject（失败已在内部 console.warn）。
			 */
			const syncPendingFromInfo = ({ isStale = null, skipIfClicked = null } = {}) =>
				fetch(`${API_BASE}/restart/info`, { cache: "no-store" })
					.then((r) => (r.ok ? r.json().catch(() => null) : null))
					.then((j) => {
						if (!j || typeof j !== "object") return false;
						if (isStale !== null && isStale()) return false;
						setInfo(j);
						if (skipIfClicked !== null && skipIfClicked()) return false;
						const nextRows = normalizeCandidateDetails(j.runningCandidates);
						// 本地无行直接用服务端行（挂载首建；刷新路径理论不可达的空态
						// 同样成立），有行则合并——两条路径自此同一实现
						const merged = pendingRows === null ? nextRows : mergePendingRows(pendingRows, nextRows);
						setPendingRows(merged);
						// 选中集合同步只保留仍存在的行
						setSelectedIds((prev) => {
							const next = new Set();
							for (const id of prev) {
								if (merged.some((row) => row.id === id)) next.add(id);
							}
							return next;
						});
						return true;
					})
					.catch((err) => {
						// 拉取失败不破坏现有列表：静默保留，仅留排查痕迹（挂载/刷新同一口径）
						console.warn("[resume-on-restart] pending list sync failed, keep current rows:", err);
					});

			/**
			 * 0.26.0：拉取「上次重启无法恢复」列表（挂载与点「刷新」共用同一管线）：
			 * GET /unrestored → normalizeUnrestoredRows → 全量替换（store 是服务端
			 * 权威口径，本地不缓存任何标记，乐观移除在恢复动作里即时生效）。404 =
			 * 混合版本窗口（宿主 half 尚未加载新路由）→ 静默按空处理不显示，照
			 * /restarts 404 口径；失败 console.warn 保留现有行。
			 * @param {{isStale?: () => boolean}} [opts] isStale：响应到达时的放弃判定
			 *   （挂载路径传 `() => cancelled`，组件已卸载不落 state，防串态）
			 * @returns {Promise<boolean>} 行数据是否被本次响应更新；永不 reject
			 *   （失败已在内部 console.warn）
			 */
			const syncUnrestored = ({ isStale = null } = {}) =>
				fetch(`${API_BASE}/unrestored`, { cache: "no-store" })
					.then(async (r) => {
						if (r.status === 404) return []; // 混合版本窗口：静默按空（不显示）
						if (!r.ok) throw new Error(`HTTP ${r.status}`);
						const j = await r.json().catch(() => null);
						return normalizeUnrestoredRows(j && Array.isArray(j.rows) ? j.rows : []);
					})
					.then((rows) => {
						if (isStale !== null && isStale()) return false;
						setUnrestoredRows(rows);
						return true;
					})
					.catch((err) => {
						console.warn("[resume-on-restart] unrestored list sync failed, keep current rows:", err);
						return false;
					});

			// 挂载时一次 GET /restart/info：模式说明与候选计数；0.16.0 起同一响应
			// 直接构建 preview 待恢复列表（进入选项卡即见，不等点按钮）；0.24.0 起
			// 与「刷新」按钮共用同一管线 syncPendingFromInfo（合并、选中收窄、失败
			// 静默完全一致），挂载只补入口语义：卸载防串态、点了「重启 DSH」的晚到
			// 响应不覆盖列表、pendingMode 仅从 none 升为 preview（绝不降级 confirm）
			(0, react.useEffect)(() => {
				let cancelled = false;
				syncPendingFromInfo({
					isStale: () => cancelled,
					skipIfClicked: () => clickedRef.current,
				}).then((applied) => {
					// 列表未被本次响应更新（失败/响应无效/已点「重启 DSH」）或组件
					// 已卸载时不动 pendingMode
					if (cancelled || !applied) return;
					setPendingMode((prev) => (prev === "none" ? "preview" : prev));
				});
				return () => {
					cancelled = true;
				};
			}, []);

			// 0.26.0：挂载即拉「上次重启无法恢复」列表（第三块；404 = 混合版本窗口
			// 静默不显示，失败保留现有行）——卸载 cancelled 防串态
			(0, react.useEffect)(() => {
				let cancelled = false;
				syncUnrestored({ isStale: () => cancelled });
				return () => {
					cancelled = true;
				};
			}, []);

			// 0.13.0：waiting 阶段计时——每秒跳动，离开 waiting/组件卸载即清理；
			// 用 Date.now 差值取秒，interval 抖动不累积误差
			(0, react.useEffect)(() => {
				if (phase !== "waiting") return undefined;
				const startedAt = Date.now();
				setElapsedSec(0);
				const timer = setInterval(() => {
					setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
				}, 1000);
				return () => clearInterval(timer);
			}, [phase]);

			// 0.13.0：重启后对账——读 localStorage 存根（无则什么都不显示，现状不变），
			// GET /restarts 匹配 boot 记录并按 id 归组 restore 结算；服务端结算是异步的
			// （sessionController 等待最多 30s + 逐候选），存在待结算会话时每 3s 短轮询、
			// 最多 20 次，全部候选有结算记录即提前停止；定时器卸载时清理
			(0, react.useEffect)(() => {
				// window.localStorage 的成员访问本身在隐私模式下也可能抛——存根只是
				// 锦上添花，任何异常都按"无存根"处理，绝不炸 section 本体
				let pending = null;
				try {
					pending = readPendingRestore(window.localStorage);
				} catch {
					pending = null;
				}
				if (pending === null || pending.candidates.length === 0) return undefined;
				const POLL_MS = 3000;
				const POLL_MAX = 20;
				let polls = 0;
				let timer = null;
				let cancelled = false;
				// 首帧先按"全待结算"渲染（boot 未知），随后每轮 reconcile 覆盖
				setSettlement({ pending, boot: null, byId: new Map(), settling: true });
				const reconcile = async () => {
					polls += 1;
					let entries = null;
					try {
						const res = await fetch(`${API_BASE}/restarts`, { cache: "no-store" });
						if (res.status === 404) {
							// 404 = 混合版本窗口（插件更新后 DSH 未重启）或日志尚未生成：
							// 按空日志处理，继续走待结算轮询
							entries = [];
						} else if (res.ok) {
							const data = await res.json().catch(() => null);
							entries = data && Array.isArray(data.entries) ? data.entries : [];
						}
					} catch {
						entries = null; // 网络错误：本轮空过，轮询继续（不算结算完成）
					}
					if (cancelled) return;
					if (entries !== null) {
						const boot = matchPendingBoot(pending, entries);
						const restores = boot !== null && typeof boot.at === "string"
							? entries.filter((e) => e !== null && typeof e === "object"
								&& e.type === "restore" && e.bootAt === boot.at)
							: [];
						const byId = collectSettlementsBySession(restores);
						const allSettled = pending.candidates.every((c) => byId.has(c.id));
						setSettlement({
							pending,
							boot,
							byId,
							settling: !allSettled && polls < POLL_MAX,
						});
						if (allSettled) return; // 全部候选有结算记录，提前停止
					} else if (polls >= POLL_MAX) {
						setSettlement((prev) => (prev ? { ...prev, settling: false } : prev));
						return;
					}
					if (polls >= POLL_MAX) return;
					timer = setTimeout(reconcile, POLL_MS);
				};
				reconcile();
				return () => {
					cancelled = true;
					if (timer !== null) clearTimeout(timer);
				};
			}, []);

			const isPid1 = info?.mode === "pid1-exit";
			const candidates = info && Array.isArray(info.runningCandidates) ? info.runningCandidates.length : null;

			/** 进入 confirm 弹窗：重拉一次 info，待恢复列表取点击时刻的最新口径。 */
			const openConfirm = () => {
				setErrorText("");
				setPhase("confirm");
				// 0.16.0：本轮点击流程开始——列表来源切 confirm，并挡住挂载请求晚到
				// 的覆盖（见挂载 effect）；0.24.0 起 confirm 列表不再遮蔽对账视图
				clickedRef.current = true;
				setPendingMode("confirm");
				fetch(`${API_BASE}/restart/info`, { cache: "no-store" })
					.then((r) => (r.ok ? r.json().catch(() => null) : null))
					.then((j) => {
						if (!j || typeof j !== "object") return;
						setInfo(j);
						const nextRows = normalizeCandidateDetails(j.runningCandidates);
						// 0.14.0：本地已有列表时合并（首次 null 维持现状直接用服务端列表）——
						// 服务端返回的行为准（cancelled 字段用本地旧值），服务端不再返回的行
						// （取消已生效被剔除出候选）保留并置 cancelled=true，防止重开弹窗把
						// 本地取消标记冲掉（「取消后无法恢复」）；0.16.0 起本地列表也包含
						// preview 阶段（进入选项卡即构建）的取消标记，随合并带入 confirm
						const merged = pendingRows === null ? nextRows : mergePendingRows(pendingRows, nextRows);
						setPendingRows(merged);
						// 选中集合同步只保留仍存在的行
						setSelectedIds((prev) => {
							const next = new Set();
							for (const id of prev) {
								if (merged.some((row) => row.id === id)) next.add(id);
							}
							return next;
						});
					})
					.catch(() => { /* 拿不到就沿用挂载时的 info，不阻断确认流程 */ });
			};

			/**
			 * 0.17.0：待恢复列表手动刷新（preview / confirm 皆可；waiting 阶段按钮
			 * 不渲染）。0.24.0 起与挂载共用同一管线 syncPendingFromInfo（GET
			 * /restart/info → setInfo → normalizeCandidateDetails → mergePendingRows
			 * 合并 → 选中集合同步收窄 → 失败静默 console.warn 保留现有行），点刷新
			 * 与进入选项卡行为完全一致。入口语义不变：防重入（refreshing）、拉取中
			 * 禁用按钮并显示「刷新中…」、finally 复位、不改 pendingMode。
			 */
			const refreshPendingList = () => {
				if (refreshing) return;
				setRefreshing(true);
				// 0.26.0：点「刷新」一并重拉「上次重启无法恢复」列表（同一刷新入口，
				// 两条管线各自独立失败不互相影响）
				syncUnrestored();
				syncPendingFromInfo().finally(() => setRefreshing(false));
			};

			/**
			 * 0.14.0：把指定行标记为取消/恢复（乐观更新 + 失败仅回滚对应行）。
			 * 复用既有 POST /state（每会话一次请求）；批量 = 对选中行逐个**串行**发送，
			 * 前一个结算（成功或回滚）后才发下一个。风格照抄 ResumeToggle.toggle。
			 * @param {string[]} idList 要标记的会话 id 列表
			 * @param {boolean} cancelled true=取消（重启后不自动恢复）/ false=恢复
			 */
			const applyPendingCancelled = async (idList, cancelled) => {
				const ids = Array.from(new Set((Array.isArray(idList) ? idList : [])
					.filter((id) => typeof id === "string" && id)
					.filter((id) => !mutatingIds.has(id))));
				if (ids.length === 0) return;
				setMutatingIds((prev) => {
					const next = new Set(prev);
					for (const id of ids) next.add(id);
					return next;
				});
				// 乐观更新：立即切换行状态（行保留在列表中，已取消行可随时「恢复」撤销）
				setPendingRows((prev) => (prev === null ? prev : setPendingCancelled(prev, ids, cancelled)));
				for (const id of ids) {
					try {
						const res = await fetch(`${API_BASE}/state`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ sessionId: id, excluded: cancelled }),
						});
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const data = await res.json().catch(() => null);
						if (data && typeof data === "object" && data.ok === false) {
							throw new Error(typeof data.error === "string" ? data.error : "request rejected");
						}
					} catch (err) {
						// 失败仅回滚对应行（撤销这一行的乐观标记），其余行不动
						setPendingRows((prev) => (prev === null ? prev : setPendingCancelled(prev, [id], !cancelled)));
						console.warn(`[resume-on-restart] pending ${cancelled ? "cancel" : "restore"} failed, rolled back (${id}):`, err);
					} finally {
						setMutatingIds((prev) => {
							const next = new Set(prev);
							next.delete(id);
							return next;
						});
					}
				}
			};

			/**
			 * 0.26.0：手动恢复「上次重启无法恢复」的指定行（乐观更新 + 失败仅保留
			 * 对应行并 console.warn）。POST /unrestored/restore 每会话一次请求；批量 =
			 * 对选中行逐个**串行**发送，前一个结算（成功或失败）后才发下一个
			 * （照 0.14.0 applyPendingCancelled 的批量模式）。成功移除该行并清理
			 * 选中/在途集合；行级/批量在途集合防重复点击（unrestoredMutatingIds）。
			 * @param {string[]} idList 要恢复的会话 id 列表
			 */
			const restoreUnrestoredRows = async (idList) => {
				const ids = Array.from(new Set((Array.isArray(idList) ? idList : [])
					.filter((id) => typeof id === "string" && id)
					.filter((id) => !unrestoredMutatingIds.has(id))));
				if (ids.length === 0) return;
				setUnrestoredMutatingIds((prev) => {
					const next = new Set(prev);
					for (const id of ids) next.add(id);
					return next;
				});
				for (const id of ids) {
					try {
						const res = await fetch(`${API_BASE}/unrestored/restore`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ sessionId: id }),
						});
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const data = await res.json().catch(() => null);
						if (data && typeof data === "object" && data.ok === false) {
							throw new Error(typeof data.error === "string" ? data.error : "request rejected");
						}
						// 乐观更新：成功移除该行（服务端已移除该条登记并结算 resumed）
						setUnrestoredRows((prev) => (prev === null ? prev : prev.filter((row) => row.id !== id)));
						setUnrestoredSelectedIds((prev) => {
							const next = new Set(prev);
							next.delete(id);
							return next;
						});
					} catch (err) {
						// 失败保留该行（下次可重试），仅留排查痕迹
						console.warn(`[resume-on-restart] unrestored restore failed, keep row (${id}):`, err);
					} finally {
						setUnrestoredMutatingIds((prev) => {
							const next = new Set(prev);
							next.delete(id);
							return next;
						});
					}
				}
			};

			/** 确认后的执行体：基线 → POST → 存根落 localStorage → 轮询 → 刷新。 */
			const startRestart = async () => {
				if (runningRef.current) return;
				runningRef.current = true;
				const confirmedAt = new Date().toISOString();
				setPhase("waiting");
				setErrorText("");
				setTimedOut(false);
				// 先捕获基线（不是页面加载时的旧值）：服务可能早已被手动重启过，
				// 陈旧基线会把"早就换了实例"误判成本次重启成功
				let baseline = null;
				try {
					const r = await fetch(`${API_BASE}/restart/health`, { cache: "no-store" });
					if (r.ok) {
						const j = await r.json().catch(() => null);
						if (j && typeof j.instanceId === "string") baseline = j.instanceId;
					}
				} catch { /* 基线为 null → 走"见过挂掉"兜底 */ }
				try {
					const r = await fetch(`${API_BASE}/restart`, { method: "POST", keepalive: true });
					const j = await r.json().catch(() => null);
					if (!r.ok || (j && j.ok === false)) {
						setErrorText(`${translate("restart.failed")}：${(j && j.error) || `HTTP ${r.status}`}`);
						setPhase("idle");
						runningRef.current = false;
						return;
					}
					// 0.13.0：POST 成功 → 覆盖写 localStorage 存根（确认时刻 ISO +
					// 响应 restartId（缺失省略字段）+ 待恢复明细，title 一起带入——
					// 对账视图标题为主；title 空则省略字段），重启完成后页面自动刷新，
					// 新挂载的 RestartSection 据此对账逐会话恢复结果。
					// 0.25.0：workspace 同款「拿到才带」一起进存根（非空字符串才带，
					// 与 title 同口径）——对账视图据此按工作区分组；旧存根无该字段
					// 归「未知工作区」组，天然兼容
					const rows = pendingRows !== null
						? pendingRows
						: normalizeCandidateDetails(info?.runningCandidates);
					const record = {
						at: confirmedAt,
						candidates: rows.map((c) => {
							const item = { id: c.id, at: c.at, running: c.running };
							if (c.title) item.title = c.title;
							if (c.workspace) item.workspace = c.workspace;
							return item;
						}),
					};
					if (j && typeof j.restartId === "string" && j.restartId) record.restartId = j.restartId;
					try {
						writePendingRestore(window.localStorage, record);
					} catch {
						// localStorage 访问本身抛（隐私模式等）：没有对账视图而已，不阻断重启
					}
				} catch { /* 请求发不出去也可能是进程已在退出途中——交给轮询判定 */ }
				// 单飞轮询：每轮 await 完再排下一轮，重叠轮询不会串态
				let seenDown = baseline === null;
				let upTicks = 0;
				let attempts = 0;
				const FAST_MS = 1500;
				const FAST_MAX = 90; // ~135s 快速窗口
				const SLOW_MS = 5000;
				const tick = async () => {
					attempts += 1;
					let health = null;
					try {
						const r = await fetch(`${API_BASE}/restart/health`, { cache: "no-store" });
						if (r.ok) health = await r.json().catch(() => null);
					} catch { health = null; }
					if (health && typeof health.instanceId === "string") {
						if (baseline !== null && health.instanceId !== baseline) {
							// 换了实例即成功；稍候 1.2s 让动画走完再刷新
							setTimeout(() => window.location.reload(), 1200);
							return;
						}
						if (baseline === null && seenDown) {
							upTicks += 1;
							if (upTicks >= 2) {
								setTimeout(() => window.location.reload(), 1200);
								return;
							}
						}
					} else {
						seenDown = true;
					}
					if (attempts === FAST_MAX) setTimedOut(true);
					setTimeout(tick, attempts <= FAST_MAX ? FAST_MS : SLOW_MS);
				};
				setTimeout(tick, FAST_MS);
			};

			/** 0.15.0：进入「暂停所有会话」二次确认弹窗（上一次失败文案清空）。 */
			const openPauseConfirm = () => {
				setPauseErrorText("");
				setPausePhase("confirm");
			};

			/**
			 * 0.15.0：确认暂停后的执行体 → POST /pause-all → 摘要 + 刷新 info。
			 * doing 阶段两个按钮都禁用（互斥见渲染处的 disabled）；成功后重拉
			 * /restart/info：候选计数与待恢复列表的运行徽标随暂停变化（列表已存在时
			 * 经 mergePendingRows 合并新口径，服务端为准）；失败回 idle 并展示错误。
			 */
			const startPauseAll = async () => {
				setPausePhase("doing");
				setPauseErrorText("");
				try {
					const res = await fetch(`${API_BASE}/pause-all`, { method: "POST" });
					const data = await res.json().catch(() => null);
					if (!res.ok || (data && typeof data === "object" && data.ok === false)) {
						throw new Error(
							data && typeof data === "object" && typeof data.error === "string" && data.error
								? data.error
								: `HTTP ${res.status}`,
						);
					}
					setPauseResult(data && typeof data === "object" ? data : null);
					setPausePhase("idle");
					fetch(`${API_BASE}/restart/info`, { cache: "no-store" })
						.then((r) => (r.ok ? r.json().catch(() => null) : null))
						.then((j) => {
							if (!j || typeof j !== "object") return;
							setInfo(j);
							// 列表已存在（0.16.0 起 preview/confirm 皆可）：合并暂停后的新
							// 候选口径，行的 at/running/title 取服务端（运行徽标随之变化）
							if (pendingRows !== null) {
								setPendingRows(mergePendingRows(pendingRows, normalizeCandidateDetails(j.runningCandidates)));
							}
						})
						.catch(() => { /* 刷新失败只影响展示，不阻断 */ });
				} catch (err) {
					setPauseErrorText(`${translate("pause.failed")}：${err?.message ?? String(err)}`);
					setPausePhase("idle");
				}
			};

			// 0.21.0：等待态可视化强化——横幅卡片（spinner + 标题/副文案 + 大号计时，
			// 紧跟 section 标题不滚动即可见）与视口顶部固定提示条（position:fixed
			// 定位写法照抄 .dsh-ror-toast，滚动到哪都可见）。两者均为条件渲染，离开
			// waiting 即消失；取代原两段 12px 小字 inline waiting 行（restart.waiting /
			// restart.elapsed 保留复用于固定条）。
			const renderWaitingBanner = () => (0, react.createElement)(
				"div",
				{ className: "dsh-ror-waiting", key: "waiting-banner" },
				(0, react.createElement)("span", { className: "dsh-ror-waiting-spin", key: "spin" }),
				(0, react.createElement)(
					"div",
					{ className: "dsh-ror-waiting-main", key: "main" },
					(0, react.createElement)("p", { className: "dsh-ror-waiting-title" }, translate("restart.waitingTitle")),
					(0, react.createElement)("p", { className: "dsh-ror-waiting-sub" }, translate("restart.waitingSub")),
				),
				(0, react.createElement)(
					"span",
					{ className: "dsh-ror-waiting-elapsed", key: "elapsed" },
					translate("restart.elapsedBig").replace("%s", String(elapsedSec)),
				),
			);
			const renderWaitingFixed = () => (0, react.createElement)(
				"div",
				{ className: "dsh-ror-waiting-fixed", key: "waiting-fixed" },
				(0, react.createElement)("span", { className: "dsh-ror-waiting-spin" }),
				(0, react.createElement)("span", null, translate("restart.waiting")),
				(0, react.createElement)(
					"span",
					null,
					translate("restart.elapsed").replace("%s", String(elapsedSec)),
				),
			);

			const children = [
				(0, react.createElement)(
					"h4",
					{ className: "dsh-ror-title", key: "title" },
					translate("restart.title"),
				),
				// 0.21.0：等待态醒目横幅紧跟标题（不滚动即可见；离开 waiting 即消失）
				...(phase === "waiting" ? [renderWaitingBanner()] : []),
				(0, react.createElement)("p", { className: "dsh-ror-note", key: "note" }, translate("restart.note")),
			];
			if (isPid1) {
				children.push((0, react.createElement)(
					"p",
					{ className: "dsh-ror-modal-warn", key: "pid1note" },
					translate("restart.notePid1"),
				));
			}
			if (info && info.appExit === "missing") {
				children.push((0, react.createElement)(
					"p",
					{ className: "dsh-ror-restart-warn", key: "appexit" },
					translate("restart.appExitMissing"),
				));
			}
			if (candidates !== null) {
				const unit = translate("restart.candidatesUnit");
				// 0.14.0：待恢复列表已存在时按未取消行数实时显示（行级/批量取消后即时
				// 反映；0.16.0 起进入选项卡的 preview 列表同口径联动）；列表不存在
				// （info 未就绪或请求失败）维持 /restart/info 的服务端计数
				const shown = pendingRows !== null ? activePendingCount(pendingRows) : candidates;
				children.push((0, react.createElement)(
					"p",
					{ className: "dsh-ror-restart-status", key: "candidates" },
					`${translate("restart.candidates")} ${shown}${unit ? ` ${unit}` : ""}`,
				));
			}
			// 0.13.0：待恢复列表（confirm/waiting/失败回 idle 都显示——失败时列表保留）；
			// 下次点「确认重启」覆盖存根，UI 切回列表态。
			// 0.14.0：行级/批量「取消 / 恢复」——waiting 阶段（重启已发出）转只读，
			// 隐藏 checkbox 与全部操作按钮；已取消行弱化显示并保留在列表中（可撤销）
			// 0.16.0：进入选项卡即展示（preview = 挂载 /restart/info 自动构建，与
			// confirm 列表共用同一构建 renderPendingList，逐行/批量操作直接可用）；
			// 0.24.0：preview / confirm 列表都不遮蔽对账视图——两块堆叠渲染，
			// 列表在上、对账视图在下（见下方 settlement 渲染门）
			const showConfirmList = pendingRows !== null && pendingMode === "confirm";
			const showPreviewList = pendingRows !== null && pendingMode === "preview";
			/** preview / confirm 共用的待恢复列表（同一份行构建与取消/恢复能力）。 */
			const renderPendingList = () => {
				const pendingReadonly = phase === "waiting";
				const selectedCount = pendingRows.filter((row) => selectedIds.has(row.id)).length;
				const allSelected = pendingRows.length > 0 && selectedCount === pendingRows.length;
				const mutating = mutatingIds.size > 0;
				// 全选 checkbox 的半选态必须经 DOM 属性设置（React 受控 props 不支持），
				// 用 ref 回调在挂载/更新时同步
				const selectAllRef = (el) => {
					if (el) el.indeterminate = selectedCount > 0 && !allSelected;
				};
				/** 批量操作要标记的会话 id（按列表行序，确定性串行发送）。 */
				const selectedRowsIds = () => pendingRows
					.filter((row) => selectedIds.has(row.id))
					.map((row) => row.id);
				const pendingChildren = [
					// 0.17.0：标题行改为 titlebar（标题 + 右侧「刷新」按钮）——preview /
					// confirm 皆可用；waiting 只读态不渲染（该阶段隐藏全部按钮的既有约束）
					(0, react.createElement)(
						"div",
						{ className: "dsh-ror-pending-titlebar", key: "title" },
						(0, react.createElement)(
							"h5",
							{ className: "dsh-ror-pending-title" },
							translate("restart.pendingList"),
						),
						pendingReadonly ? null : (0, react.createElement)(
							"button",
							{
								type: "button",
								className: "dsh-ror-pending-act",
								disabled: refreshing,
								onClick: refreshPendingList,
							},
							translate(refreshing ? "restart.pendingRefreshing" : "restart.pendingRefresh"),
						),
					),
				];
				// 0.14.0：批量工具条（只读时不渲染；无选中行时两个按钮禁用）
				if (!pendingReadonly && pendingRows.length > 0) {
					pendingChildren.push((0, react.createElement)(
						"div",
						{ className: "dsh-ror-pending-toolbar", key: "toolbar" },
						(0, react.createElement)(
							"label",
							{ className: "dsh-ror-pending-selectall" },
							(0, react.createElement)("input", {
								ref: selectAllRef,
								type: "checkbox",
								className: "dsh-ror-pending-check",
								checked: allSelected,
								onChange: () => {
									setSelectedIds(() => (allSelected
										? new Set()
										: new Set(pendingRows.map((row) => row.id))));
								},
							}),
							translate("restart.pendingSelectAll"),
						),
						(0, react.createElement)(
							"span",
							{ className: "dsh-ror-pending-selected" },
							translate("restart.pendingSelectedCount").replace("%s", String(selectedCount)),
						),
						(0, react.createElement)(
							"button",
							{
								type: "button",
								className: "dsh-ror-pending-act",
								disabled: selectedCount === 0 || mutating,
								onClick: () => applyPendingCancelled(selectedRowsIds(), true),
							},
							translate("restart.pendingCancelSelected"),
						),
						(0, react.createElement)(
							"button",
							{
								type: "button",
								className: "dsh-ror-pending-act",
								disabled: selectedCount === 0 || mutating,
								onClick: () => applyPendingCancelled(selectedRowsIds(), false),
							},
							translate("restart.pendingRestoreSelected"),
						),
					));
				}
				if (pendingRows.length === 0) {
					pendingChildren.push((0, react.createElement)(
						"div",
						{ className: "dsh-ror-status", key: "empty" },
						translate("restart.pendingEmpty"),
					));
				} else {
					// 0.18.0：按工作区分组渲染——组头一行（工作区完整路径，缺失/空串
					// 显示「未知工作区」文案并恒垫底），组内行与既有结构完全一致；
					// 0.13.0 修正：每行 = 运行中徽标 + 会话标题（主文本，省略号截断、
					// 全文在 title 属性）+ 最后活跃时间；title 缺失才退 shortId 弱化
					// 显示。完整 id 一律放在行容器 title 属性做悬停提示，不再作为行主文本。
					// 0.14.0：行首加选中 checkbox、行尾加「取消/恢复」小按钮（只读时都不
					// 渲染），已取消行加「已取消」徽标并弱化——行必须保留在列表中才能撤销。
					// 批量工具条与全选语义保持既有：作用于全部组的全部行（不分组筛选）
					const groups = groupPendingRows(pendingRows);
					const renderPendingRow = (row) => {
						const cancelled = row.cancelled === true;
						// 0.25.0：非 waiting（pendingReadonly === false）阶段行容器绑
						// onClick 跳转到该会话（jumpToSession → uiWorkspace.openSession，
						// 成功后回调 close 关闭设置弹窗）+ 可点样式 + title 追加跳转提示；
						// waiting 只读阶段不绑（该阶段隐藏全部按钮的既有约束，保持纯展示；
						// 行是 div 保持既有结构，键盘可达性现状如此，不新增 tab 语义）
						const clickable = !pendingReadonly;
						return (0, react.createElement)(
							"div",
							{
								className: "dsh-ror-restore"
									+ (clickable ? " dsh-ror-restore-click" : "")
									+ (cancelled ? " dsh-ror-pending-row-cancelled" : ""),
								key: row.id,
								// 0.25.0：可点行的悬停提示在原完整 id 基础上追加跳转提示文案
								title: clickable ? `${row.id} · ${translate("restart.openSessionHint")}` : row.id,
								onClick: clickable ? () => jumpToSession(row.id, close) : undefined,
							},
							pendingReadonly ? null : (0, react.createElement)("input", {
								type: "checkbox",
								className: "dsh-ror-pending-check",
								checked: selectedIds.has(row.id),
								disabled: mutatingIds.has(row.id),
								"aria-label": row.title || row.id,
								// 0.25.0：行可点跳转后 checkbox 的 click 不得冒泡到行容器
								// （勾选不该触发跳转）；选中语义仍走 onChange 不变
								onClick: (e) => e.stopPropagation(),
								onChange: () => {
									setSelectedIds((prev) => {
										const next = new Set(prev);
										if (next.has(row.id)) next.delete(row.id);
										else next.add(row.id);
										return next;
									});
								},
							}),
							// 0.19.0：候选来源徽标——主动注册会话显示「技能注册」徽标
							// （source === 'skill'），其余维持既有运行中徽标逻辑不变
							//（source !== 'skill' && running → 「● 运行中」）
							// 0.23.0：注册但不激活（source === 'skill' && activate === false）
							// 优先显示「注册·不激活」徽标（琥珀调，与紫调技能注册徽标区分）
							row.source === "skill" && row.activate === false
								? (0, react.createElement)(
										"span",
										{ className: "dsh-ror-badge dsh-ror-noactivate-badge" },
										translate("restart.pendingNoActivate"),
									)
								: row.source === "skill"
									? (0, react.createElement)(
											"span",
											{ className: "dsh-ror-badge dsh-ror-skill-badge" },
											translate("restart.pendingSkill"),
										)
									: row.running
										? (0, react.createElement)(
												"span",
												{ className: "dsh-ror-badge dsh-ror-running" },
												translate("restart.pendingRunning"),
											)
										: null,
							(0, react.createElement)(
								"span",
								{
									className: "dsh-ror-restore-title"
										+ (row.title ? "" : " dsh-ror-restore-title-fallback"),
									title: row.title || row.id,
								},
								row.title || shortId(row.id, 18),
							),
							(0, react.createElement)(
								"span",
								{ className: "dsh-ror-pending-at" },
								`${translate("restart.pendingAt")} ${formatTime(row.at)}`,
							),
							cancelled
								? (0, react.createElement)(
										"span",
										{ className: "dsh-ror-badge dsh-ror-pending-cancelled-badge" },
										translate("restart.pendingCancelled"),
									)
								: null,
							pendingReadonly ? null : (0, react.createElement)(
								"button",
								{
									type: "button",
									className: "dsh-ror-pending-act",
									disabled: mutatingIds.has(row.id),
									title: row.id,
									// 0.25.0：行可点跳转后按钮的 click 不得冒泡到行容器
									// （点「取消 / 恢复」不该触发跳转）；原有标记逻辑不变
									onClick: (e) => {
										e.stopPropagation();
										applyPendingCancelled([row.id], !cancelled);
									},
								},
								translate(cancelled ? "restart.pendingRestore" : "restart.pendingCancel"),
							),
						);
					};
					pendingChildren.push((0, react.createElement)(
						"div",
						{ className: "dsh-ror-restores", key: "rows" },
						// 组头 = 工作区完整路径（省略号截断、全文在 title 属性）；刷新按钮、
						// 「正常结束」等结算徽标、取消弱化行都在组内行/标题层，分组下行为不变
						groups.flatMap((group) => [
							(0, react.createElement)(
								"div",
								{
									className: "dsh-ror-pending-group",
									key: `group:${group.workspace}`,
									title: group.workspace || undefined,
								},
								group.workspace || translate("restart.pendingUnknownWorkspace"),
							),
							group.rows.map(renderPendingRow),
						]),
					));
				}
				return (0, react.createElement)(
					"div",
					{ className: "dsh-ror-pending", key: "pending" },
					pendingChildren,
				);
			};
			/**
			 * 0.26.0：「上次重启无法恢复」列表构建（仅 rows 非空渲染，调用方门控）。
			 * 结构照待恢复列表：标题（unrestoredTitle）+ 批量工具条（全选 checkbox
			 * 半选 +「已选 N 项」+「恢复所选」，复用 0.14.0 同款 key 与样式）+ 行区
			 * 按工作区分组（groupPendingRows 复用，组头结构/样式同款、未知工作区
			 * 恒垫底）。行 = 行首结算徽标（restore.skipped-service-timeout，新配色
			 * .dsh-ror-result-skipped-service-timeout）+ 会话标题（缺失退 shortId
			 * 弱化，完整 id 在行容器 title 悬停并追加跳转提示）+ 登记时间 + 行尾
			 * 「恢复」按钮（复用 restart.pendingRestore）；行可点跳转
			 * （jumpToSession(row.id, close)），行内按钮 stopPropagation 防误触。
			 */
			const renderUnrestoredList = () => {
				const selectedCount = unrestoredRows.filter((row) => unrestoredSelectedIds.has(row.id)).length;
				const allSelected = unrestoredRows.length > 0 && selectedCount === unrestoredRows.length;
				const mutating = unrestoredMutatingIds.size > 0;
				// 全选半选态经 ref 回调同步 DOM 属性（React 受控 props 不支持，
				// 照待恢复列表同款写法）
				const selectAllRef = (el) => {
					if (el) el.indeterminate = selectedCount > 0 && !allSelected;
				};
				/** 批量恢复要恢复的会话 id（按列表行序，确定性串行发送）。 */
				const selectedRowsIds = () => unrestoredRows
					.filter((row) => unrestoredSelectedIds.has(row.id))
					.map((row) => row.id);
				const listChildren = [
					(0, react.createElement)(
						"div",
						{ className: "dsh-ror-pending-titlebar", key: "title" },
						(0, react.createElement)(
							"h5",
							{ className: "dsh-ror-pending-title" },
							translate("unrestoredTitle"),
						),
					),
					(0, react.createElement)(
						"div",
						{ className: "dsh-ror-pending-toolbar", key: "toolbar" },
						(0, react.createElement)(
							"label",
							{ className: "dsh-ror-pending-selectall" },
							(0, react.createElement)("input", {
								ref: selectAllRef,
								type: "checkbox",
								className: "dsh-ror-pending-check",
								checked: allSelected,
								onChange: () => {
									setUnrestoredSelectedIds(() => (allSelected
										? new Set()
										: new Set(unrestoredRows.map((row) => row.id))));
								},
							}),
							translate("restart.pendingSelectAll"),
						),
						(0, react.createElement)(
							"span",
							{ className: "dsh-ror-pending-selected" },
							translate("restart.pendingSelectedCount").replace("%s", String(selectedCount)),
						),
						(0, react.createElement)(
							"button",
							{
								type: "button",
								className: "dsh-ror-pending-act",
								disabled: selectedCount === 0 || mutating,
								onClick: () => restoreUnrestoredRows(selectedRowsIds()),
							},
							translate("restart.pendingRestoreSelected"),
						),
					),
				];
				/** 单行：结算徽标 + 会话标题 + 登记时间 + 行尾「恢复」按钮（行可点跳转）。 */
				const renderUnrestoredRow = (row) => (0, react.createElement)(
					"div",
					{
						className: "dsh-ror-restore dsh-ror-restore-click",
						key: row.id,
						title: `${row.id} · ${translate("restart.openSessionHint")}`,
						onClick: () => jumpToSession(row.id, close),
					},
					(0, react.createElement)(
						"span",
						{ className: "dsh-ror-badge dsh-ror-result-skipped-service-timeout" },
						translate("restore.skipped-service-timeout"),
					),
					(0, react.createElement)(
						"span",
						{
							className: "dsh-ror-restore-title"
								+ (row.title ? "" : " dsh-ror-restore-title-fallback"),
							title: row.title || row.id,
						},
						row.title || shortId(row.id, 18),
					),
					(0, react.createElement)(
						"span",
						{ className: "dsh-ror-pending-at" },
						formatTime(row.at),
					),
					(0, react.createElement)(
						"button",
						{
							type: "button",
							className: "dsh-ror-pending-act",
							disabled: unrestoredMutatingIds.has(row.id),
							title: row.id,
							// 行可点跳转后按钮的 click 不得冒泡到行容器（点「恢复」不该
							// 触发跳转，照待恢复列表同款）
							onClick: (e) => {
								e.stopPropagation();
								restoreUnrestoredRows([row.id]);
							},
						},
						translate("restart.pendingRestore"),
					),
				);
				listChildren.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-restores", key: "rows" },
					// 按工作区分组（复用 groupPendingRows；组头结构/样式与另两个列表
					// 一致，未知工作区组恒垫底）
					groupPendingRows(unrestoredRows).flatMap((group) => [
						(0, react.createElement)(
							"div",
							{
								className: "dsh-ror-pending-group",
								key: `group:${group.workspace}`,
								title: group.workspace || undefined,
							},
							group.workspace || translate("restart.pendingUnknownWorkspace"),
						),
						group.rows.map(renderUnrestoredRow),
					]),
				));
				return (0, react.createElement)(
					"div",
					{ className: "dsh-ror-pending", key: "unrestored" },
					listChildren,
				);
			};
			if (showConfirmList || showPreviewList) {
				children.push(renderPendingList());
			}
			// 0.26.0：「上次重启无法恢复」列表（仅 rows 非空渲染；位置在待恢复列表
			// 之后、对账视图之前——三块堆叠：列表在上、无法恢复居中、对账在下）
			if (unrestoredRows !== null && unrestoredRows.length > 0) {
				children.push(renderUnrestoredList());
			}
			// 0.24.0：对账视图只要非 null 就渲染——confirm / preview / waiting /
			// 失败回 idle 各阶段都不再被待恢复列表遮蔽（0.16.0 既有 preview 双块
			// 堆叠推广到 confirm：列表在上、对账视图在下），点「重启 DSH」后上一轮
			// 重启的对账结果保持可见；存根数据链路（localStorage 存根、
			// matchPendingBoot、轮询结算、startRestart 覆盖存根）语义不变——重启
			// 完成页面刷新后由新存根展示新一轮对账仍是既有预期
			if (settlement !== null) {
				// 0.13.0：上次重启的逐会话恢复结果（无存根时什么都不显示，现状不变）
				const bootAt = settlement.boot && typeof settlement.boot.at === "string" ? settlement.boot.at : "";
				const total = settlement.pending.candidates.length;
				const restoredCount = settlement.pending.candidates
					.filter((c) => settlement.byId.get(c.id)?.result === "resumed")
					.length;
				/**
				 * 0.25.0：对账视图单行（结算徽标 + 会话标题 + failed 的 error 摘要）。
				 * 行容器绑 onClick 点击跳转到该会话（jumpToSession → uiWorkspace
				 * .openSession，成功后回调 close 关闭设置弹窗）+ 可点样式 + title 追加
				 * 跳转提示——对账视图只读展示、行内无控件，不需要 stopPropagation。
				 */
				const renderSettlementRow = (c) => {
					const entry = settlement.byId.get(c.id);
					const result = entry && typeof entry.result === "string" && entry.result
						? entry.result
						: null;
					const known = result !== null && SETTLE_RESULTS.indexOf(result) >= 0;
					const badgeKey = result === null
						? (settlement.settling ? "settle.pending" : "settle.unsettled")
						: (known ? `settle.${result}` : "settle.unknown");
					const badgeClass = result === null
						? (settlement.settling ? "dsh-ror-settle-pending" : "dsh-ror-settle-unsettled")
						: (known ? `dsh-ror-result-${result}` : "");
					// failed 展示 error 摘要（截断省略在 CSS，全文在 title）
					const error = result === "failed" && entry && typeof entry.error === "string"
						? entry.error
						: "";
					// 0.13.0 修正：结算徽标之外的行主文本改为会话标题（存根 candidates
					// 条目的 title；旧存根/未命名会话无 title 退 shortId 弱化显示），
					// 完整 id 放行容器 title 属性做悬停提示；failed 的 error 摘要仍是
					// flex:1 省略号（与标题并存时两者各自截断，排版不挤坏）。
					// 0.25.0：行可点跳转——行容器 title 在原完整 id 基础上追加跳转提示
					return (0, react.createElement)(
						"div",
						{
							className: "dsh-ror-restore dsh-ror-restore-click",
							key: c.id,
							title: `${c.id} · ${translate("restart.openSessionHint")}`,
							onClick: () => jumpToSession(c.id, close),
						},
						(0, react.createElement)(
							"span",
							{ className: `dsh-ror-badge ${badgeClass}`.trim() },
							translate(badgeKey),
						),
						(0, react.createElement)(
							"span",
							{
								className: "dsh-ror-restore-title"
									+ (c.title ? "" : " dsh-ror-restore-title-fallback"),
								title: c.title || c.id,
							},
							c.title || shortId(c.id, 18),
						),
						error
							? (0, react.createElement)(
									"span",
									{ className: "dsh-ror-restore-error", title: error },
									error,
								)
							: null,
					);
				};
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-pending", key: "settlement" },
					(0, react.createElement)(
						"h5",
						{ className: "dsh-ror-pending-title" },
						translate("settle.title").replace("%s", formatTime(bootAt)),
					),
					(0, react.createElement)(
						"div",
						{ className: "dsh-ror-pending-score" },
						`${restoredCount}/${total} ${translate("settle.restoredUnit")}`,
					),
					(0, react.createElement)(
						"div",
						{ className: "dsh-ror-restores" },
						// 0.25.0：对账视图行区同样按工作区分组——复用待恢复列表的
						// groupPendingRows 与组头结构/样式（workspace 缺失/空串显示
						// 「未知工作区」并恒垫底、组容器 title 同款），组内行结构（结算
						// 徽标 + 标题 + error）与分组前完全一致；存根 candidates 0.25.0
						// 起带 workspace（startRestart 写入、readPendingRestore 透传），
						// 旧存根无该字段 → 不带 → 归「未知工作区」组，天然兼容；
						// 结算计数行与标题不变
						groupPendingRows(settlement.pending.candidates).flatMap((group) => [
							(0, react.createElement)(
								"div",
								{
									className: "dsh-ror-pending-group",
									key: `group:${group.workspace}`,
									title: group.workspace || undefined,
								},
								group.workspace || translate("restart.pendingUnknownWorkspace"),
							),
							group.rows.map(renderSettlementRow),
						]),
					),
				));
			}
			if (phase === "waiting") {
				// 0.21.0：原两段 12px 小字 inline waiting 行由「标题后横幅 + 视口固定
				// 提示条」取代（横幅已在 children 头部插入），不再重复显示；
				// timedOut 超时提示保留原位置与样式
				children.push(renderWaitingFixed());
				if (timedOut) {
					children.push((0, react.createElement)(
						"p",
						{ className: "dsh-ror-restart-warn", key: "timeout" },
						translate(isPid1 ? "restart.timeoutPid1" : "restart.timeoutHelper"),
					));
				}
			} else {
				if (errorText) {
					children.push((0, react.createElement)(
						"p",
						{ className: "dsh-ror-modal-warn", key: "error" },
						errorText,
					));
				}
				// 0.15.0：暂停流程状态（位置与风格同 restart-status / restart-warn，都在
				// actions 行上方）：doing 进行中提示、上次结果摘要、失败文案
				if (pausePhase === "doing") {
					children.push((0, react.createElement)(
						"div",
						{ className: "dsh-ror-restart-actions", key: "pause-doing" },
						(0, react.createElement)("span", { className: "dsh-ror-restart-status" }, translate("pause.doing")),
					));
				}
				if (pauseResult !== null) {
					children.push((0, react.createElement)(
						"p",
						{ className: "dsh-ror-restart-status", key: "pause-result" },
						formatPauseResult(pauseResult, translate),
					));
				}
				if (pauseErrorText) {
					children.push((0, react.createElement)(
						"p",
						{ className: "dsh-ror-restart-warn", key: "pause-error" },
						pauseErrorText,
					));
				}
				// 0.15.0：「暂停所有会话」在「重启 DSH」左侧（中性按钮，非 danger 红；
				// 仅 info.pauseAll === false 时隐藏——info 拿不到时照常显示）；与重启流程
				// 互斥：restart 非 idle 时暂停按钮禁用，pause 非 idle 时重启按钮禁用
				const showPauseAll = !(info && info.pauseAll === false);
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-restart-actions", key: "actions" },
					showPauseAll
						? (0, react.createElement)(
								"button",
								{
									type: "button",
									className: "dsh-ror-btn",
									disabled: phase !== "idle" || pausePhase !== "idle",
									onClick: openPauseConfirm,
								},
								translate("pause.button"),
							)
						: null,
					(0, react.createElement)(
						"button",
						{
							type: "button",
							className: "dsh-ror-btn-danger",
							disabled: pausePhase !== "idle",
							onClick: openConfirm,
						},
						translate("restart.button"),
					),
				));
			}
			children.push(
				phase === "confirm"
					? (0, react.createElement)(RestartConfirmDialog, {
							key: "confirm",
							t: translate,
							isPid1,
							busy: false,
							onConfirm: startRestart,
							onCancel: () => setPhase("idle"),
						})
					: null,
				// 0.15.0：「暂停所有会话」的二次确认弹窗（泛化 props 复用同一组件；确认按钮
				// 中性色；默认焦点「取消」、Esc/点遮罩取消的既有行为不变）
				pausePhase === "confirm"
					? (0, react.createElement)(RestartConfirmDialog, {
							key: "pause-confirm",
							t: translate,
							isPid1: false,
							busy: false,
							title: translate("pause.confirmTitle"),
							body: translate("pause.confirmBody"),
							confirmLabel: translate("pause.confirm"),
							neutral: true,
							onConfirm: startPauseAll,
							onCancel: () => setPausePhase("idle"),
						})
					: null,
			);
			return (0, react.createElement)("div", { className: "dsh-ror-settings" }, children);
		}

		/**
		 * 0.29.0：tab3「技能与注入」页面组件（RestartTabsSection 第三块）。
		 * 挂载时并行拉 GET /skills/catalog（技能目录 + 聚合调用统计）与
		 * GET /skills/usage（尾部原始条目）；404 = 插件更新后 DSH 未重启的混合版本
		 * 窗口（宿主 half 尚无该路由）→ 该部分等价空数据按空态展示「暂无数据」
		 * 不算失败（照 0.5.1「重启日志」先例），其余失败走报错态 + console.warn。
		 * 页面结构：说明 note → 工具条（搜索框按名称+描述就地过滤 + 刷新按钮）→
		 * 全局统计行（总调用次数 / 被调用过的技能数 / 记录起始时间）→ 技能卡片列表
		 * （名称、来源 provider、模型可用/用户可见徽标、description、whenToUse、
		 * 该技能统计（总次数/成功率/最近调用）、「正文」折叠展开（<pre> 预格式化、
		 * 默认收起）、按工作区分布、按会话分布（宿主已截前 10）、最近7天每日次数
		 * 纯文本）。聚合统计来自 catalog 响应的 usage 字段；catalog 404 而 usage
		 * 200 时 total 用 usage 响应兜底。样式 .dsh-ror-skill*（设计 token，明暗
		 * 自适应）。
		 * @param {{t?: (key: string) => string}} props settings.section owner props
		 */
		function SkillsSection({ t }) {
			const translate = typeof t === "function" ? t : T;
			const [phase, setPhase] = (0, react.useState)("loading");
			const [skills, setSkills] = (0, react.useState)([]);
			const [stats, setStats] = (0, react.useState)(() => ({ total: 0, used: 0, firstAt: "", bySkill: {} }));
			const [query, setQuery] = (0, react.useState)("");
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const [openBodies, setOpenBodies] = (0, react.useState)(() => new Set());

			const load = (0, react.useCallback)(async () => {
				setRefreshing(true);
				try {
					/** 单响应解析：404 → fallback（等价空数据，不算失败）；其余非 2xx → 抛错。 */
					const parseResponse = async (res, fallback) => {
						if (res.status === 404) return fallback;
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						return await res.json().catch(() => fallback);
					};
					const [catalogData, usageData] = await Promise.all([
						fetch(`${API_BASE}/skills/catalog`, { cache: "no-store" }).then((res) => parseResponse(res, null)),
						fetch(`${API_BASE}/skills/usage`, { cache: "no-store" }).then((res) => parseResponse(res, null)),
					]);
					const list = catalogData !== null && Array.isArray(catalogData.skills) ? catalogData.skills : [];
					const agg = catalogData !== null && catalogData.usage !== null && typeof catalogData.usage === "object"
						? catalogData.usage
						: null;
					const bySkill = agg !== null && agg.skills !== null && typeof agg.skills === "object" ? agg.skills : {};
					// total 优先聚合值；catalog 404 而 usage 200（半边混合版本窗口）时用 usage 响应兜底
					const total = agg !== null && typeof agg.total === "number" && Number.isFinite(agg.total)
						? agg.total
						: usageData !== null && typeof usageData.total === "number" && Number.isFinite(usageData.total)
							? usageData.total
							: 0;
					let used = 0;
					for (const bucket of Object.values(bySkill)) {
						if (bucket !== null && typeof bucket === "object" && bucket.count > 0) used += 1;
					}
					setSkills(list);
					setStats({
						total,
						used,
						firstAt: agg !== null && typeof agg.firstAt === "string" ? agg.firstAt : "",
						bySkill,
					});
					setPhase("ready");
				} catch (err) {
					console.warn("[resume-on-restart] skills query failed:", err);
					setPhase("error");
				} finally {
					setRefreshing(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			const toggleBody = (name) => {
				setOpenBodies((prev) => {
					const next = new Set(prev);
					if (next.has(name)) next.delete(name);
					else next.add(name);
					return next;
				});
			};

			/** 全局统计格（label 上、值下）。 */
			const statCell = (label, value, key) => (0, react.createElement)(
				"div",
				{ className: "dsh-ror-skill-stat", key },
				(0, react.createElement)("span", null, label),
				(0, react.createElement)("span", { className: "dsh-ror-skill-stat-val" }, value),
			);

			/** 分布块（标题 + 行列表，空列表显示占位文案）。 */
			const distBlock = (label, rows, emptyText, keyPrefix) => (0, react.createElement)(
				"div",
				{ className: "dsh-ror-skill-dist", key: keyPrefix },
				(0, react.createElement)("div", { className: "dsh-ror-skill-dist-title" }, label),
				rows.length === 0
					? (0, react.createElement)("div", null, emptyText)
					: rows,
			);

			/** 单张技能卡片（防御式读字段，形状不对的条目整卡跳过）。 */
			const skillCard = (item, index) => {
				if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
				const name = typeof item.name === "string" && item.name !== "" ? item.name : `#${index}`;
				const description = typeof item.description === "string" ? item.description : "";
				const whenToUse = typeof item.whenToUse === "string" ? item.whenToUse : "";
				const provider = typeof item.provider === "string" ? item.provider : "";
				const source = typeof item.source === "string" ? item.source : "";
				const content = typeof item.content === "string" ? item.content : "";
				const modelInvocable = item.modelInvocable === true;
				const userInvocable = item.userInvocable === true;
				const rawUsage = stats.bySkill[name];
				const usage = rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage) ? rawUsage : null;
				const count = usage !== null && typeof usage.count === "number" && Number.isFinite(usage.count) ? usage.count : 0;
				const okCount = usage !== null && typeof usage.okCount === "number" && Number.isFinite(usage.okCount) ? usage.okCount : 0;
				const lastAt = usage !== null && typeof usage.lastAt === "string" ? usage.lastAt : "";
				const byWorkspace = usage !== null && usage.byWorkspace !== null && typeof usage.byWorkspace === "object"
					? Object.entries(usage.byWorkspace).filter(([path]) => typeof path === "string" && path !== "")
					: [];
				const bySession = usage !== null && Array.isArray(usage.bySession) ? usage.bySession : [];
				const daily7 = usage !== null && Array.isArray(usage.daily7) ? usage.daily7 : [];
				const bodyOpen = openBodies.has(name);

				const head = (0, react.createElement)(
					"div",
					{ className: "dsh-ror-skill-head", key: "head" },
					(0, react.createElement)("span", { className: "dsh-ror-skill-name" }, name),
					modelInvocable
						? (0, react.createElement)("span", { className: "dsh-ror-skill-flag", key: "flag-model" }, translate("skills.badgeModel"))
						: null,
					userInvocable
						? (0, react.createElement)("span", { className: "dsh-ror-skill-flag dsh-ror-skill-flag-user", key: "flag-user" }, translate("skills.badgeUser"))
						: null,
					provider !== ""
						? (0, react.createElement)(
							"span",
							{ className: "dsh-ror-skill-provider", key: "provider", title: source !== "" ? `${translate("skills.labelSource")}: ${provider} (${source})` : provider },
							`${translate("skills.labelSource")}: ${provider}`,
						)
						: null,
				);
				const usageLine = (0, react.createElement)(
					"div",
					{ className: "dsh-ror-skill-usage", key: "usage" },
					count > 0
						? [
							(0, react.createElement)("span", { key: "count" }, `${translate("skills.labelCount")} ${count}`),
							(0, react.createElement)("span", { key: "ok" }, `${translate("skills.labelOkRate")} ${Math.round((okCount / count) * 100)}%`),
							(0, react.createElement)("span", { key: "last" }, `${translate("skills.labelLastAt")} ${lastAt !== "" ? formatTime(lastAt) : "—"}`),
						]
						: (0, react.createElement)("span", null, translate("skills.labelNeverCalled")),
				);
				const bodyToggle = content !== ""
					? (0, react.createElement)(
						"button",
						{ type: "button", className: "dsh-ror-skill-toggle", key: "toggle", "aria-expanded": bodyOpen, onClick: () => toggleBody(name) },
						`${translate("skills.labelContent")}（${bodyOpen ? translate("skills.contentHide") : translate("skills.contentShow")}）`,
					)
					: null;
				const body = content !== "" && bodyOpen
					? (0, react.createElement)("pre", { className: "dsh-ror-skill-content", key: "content" }, content)
					: null;
				const workspaceRows = byWorkspace.map(([path, times], i) => (0, react.createElement)(
					"div",
					{ className: "dsh-ror-skill-dist-row", key: `ws-${i}` },
					(0, react.createElement)("span", { className: "dsh-ror-skill-dist-path", title: path }, path),
					(0, react.createElement)("span", { className: "dsh-ror-skill-dist-count" }, `×${times}`),
				));
				const sessionRows = bySession.map((row, i) => {
					if (row === null || typeof row !== "object") return null;
					const id = typeof row.id === "string" ? row.id : "";
					const title = typeof row.title === "string" && row.title !== "" ? row.title : shortId(id, 20);
					const times = typeof row.count === "number" && Number.isFinite(row.count) ? row.count : 0;
					return (0, react.createElement)(
						"div",
						{ className: "dsh-ror-skill-dist-row", key: `session-${i}` },
						(0, react.createElement)("span", { className: "dsh-ror-skill-dist-path", title: id }, title),
						(0, react.createElement)("span", { className: "dsh-ror-skill-dist-count" }, `×${times}`),
					);
				}).filter(Boolean);
				const dailyText = daily7
					.map((day) => {
						if (day === null || typeof day !== "object") return null;
						const date = typeof day.date === "string" && day.date.length >= 10 ? day.date.slice(5) : "?";
						const times = typeof day.count === "number" && Number.isFinite(day.count) ? day.count : 0;
						return `${date}:${times}`;
					})
					.filter(Boolean)
					.join("  ");

				return (0, react.createElement)(
					"div",
					{ className: "dsh-ror-skill-card", key: `skill-${name}-${index}` },
					head,
					description !== "" ? (0, react.createElement)("p", { className: "dsh-ror-skill-desc", key: "desc" }, description) : null,
					whenToUse !== "" ? (0, react.createElement)("p", { className: "dsh-ror-skill-when", key: "when" }, whenToUse) : null,
					usageLine,
					bodyToggle,
					body,
					distBlock(translate("skills.labelByWorkspace"), workspaceRows, translate("skills.noUsage"), "dist-ws"),
					distBlock(translate("skills.labelBySession"), sessionRows, translate("skills.noUsage"), "dist-session"),
					dailyText !== ""
						? (0, react.createElement)("div", { className: "dsh-ror-skill-daily", key: "daily" }, `${translate("skills.labelDaily7")}: ${dailyText}`)
						: null,
				);
			};

			const keyword = query.trim().toLowerCase();
			const visibleSkills = keyword === ""
				? skills
				: skills.filter((item) => {
					if (item === null || typeof item !== "object") return false;
					const name = typeof item.name === "string" ? item.name : "";
					const description = typeof item.description === "string" ? item.description : "";
					return name.toLowerCase().includes(keyword) || description.toLowerCase().includes(keyword);
				});

			const children = [
				(0, react.createElement)(
					"h4",
					{ className: "dsh-ror-title", key: "title" },
					`${translate("restart.tabSkills")}（dsh-resume-on-restart）`,
				),
				(0, react.createElement)("p", { className: "dsh-ror-note", key: "note" }, translate("skills.note")),
				(0, react.createElement)(
					"div",
					{ className: "dsh-ror-toolbar", key: "toolbar" },
					(0, react.createElement)("input", {
						type: "search",
						className: "dsh-ror-skill-search",
						placeholder: translate("skills.searchPlaceholder"),
						value: query,
						onChange: (event) => setQuery(typeof event?.target?.value === "string" ? event.target.value : ""),
						key: "search",
					}),
					(0, react.createElement)(
						"button",
						{ type: "button", className: "dsh-ror-refresh", disabled: refreshing, onClick: load, key: "refresh" },
						translate("skills.refresh"),
					),
				),
				(0, react.createElement)(
					"div",
					{ className: "dsh-ror-skill-stats", key: "stats" },
					statCell(translate("skills.statTotal"), String(stats.total), "total"),
					statCell(translate("skills.statUsed"), String(stats.used), "used"),
					statCell(translate("skills.statSince"), stats.firstAt !== "" ? formatTime(stats.firstAt) : translate("skills.statNever"), "since"),
				),
			];
			if (phase === "loading") {
				children.push((0, react.createElement)("div", { className: "dsh-ror-status", key: "status" }, translate("skills.loading")));
			} else if (phase === "error") {
				children.push((0, react.createElement)("div", { className: "dsh-ror-status", key: "status" }, translate("skills.loadFailed")));
			} else if (skills.length === 0) {
				children.push((0, react.createElement)("div", { className: "dsh-ror-status", key: "status" }, translate("skills.empty")));
			} else if (visibleSkills.length === 0) {
				children.push((0, react.createElement)("div", { className: "dsh-ror-status", key: "status" }, translate("skills.filterEmpty")));
			} else {
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-list", key: "list" },
					visibleSkills.map((item, index) => skillCard(item, index)).filter(Boolean),
				));
			}
			return (0, react.createElement)("div", { className: "dsh-ror-settings" }, children);
		}

		/**
		 * 0.28.0：设置弹窗「重启」合并 section 的 tab 外壳。原先「重启日志」
		 * （0.5.0）与「重启」（0.8.0）是两个独立的 settings.section 条目，主题
		 * 重复、设置弹窗左侧出现两个相近入口；0.28.0 起合并为单条目（label 复用
		 * 既有 restart.nav，注册见 apply），条目内用本地 tab state（useState，
		 * 默认 restart）切换两块内容：
		 * - tab1「重启」（restart.tabRestart）= RestartSection 原组件原样渲染
		 *   （默认选中；模式说明、待恢复列表、确认重启流程、对账视图、
		 *   「暂停所有会话」等全部内容与行为零改动）；
		 * - tab2「重启日志」（restart.tabLog）= RestartLogSection 原组件原样渲染
		 *   （404 容错、加载失败报错态、结算徽标全部原样保留）；
		 * - tab3「技能与注入」（restart.tabSkills，0.29.0 起）= SkillsSection
		 *   （技能目录 + 技能调用统计，见该组件注释）。默认选中仍是 tab1。
		 * 切换 = 按 tab 条件渲染其中一块，与原先设置弹窗左侧导航二选一的挂载语义
		 * 一致（未选中的一块不挂载，其挂载 effect 与定时器照常经既有清理函数
		 * 处理）；两块各自维护自己的根 div.dsh-ror-settings，外壳不额外包 padding，
		 * 视觉与合并前完全一致。tab 栏样式 .dsh-ror-tabs / .dsh-ror-tab /
		 * .dsh-ror-tab-active（设计 token + 蓝调强调照抄 .dsh-ror-waiting 用色），
		 * role=tablist/tab + aria-selected 提供可访问性语义。
		 * @param {{t?: (key: string) => string, close?: () => void}} props
		 *   settings.section owner props（t 由 locale: NS 注入；close 见 0.25.0，
		 *   只需透传给 RestartSection——会话行点击跳转成功后关设置弹窗）
		 */
		function RestartTabsSection({ t, close }) {
			const translate = typeof t === "function" ? t : T;
			// 本地 tab state：'restart'（tab1「重启」，默认）| 'log'（tab2「重启日志」）
			// | 'skills'（tab3「技能与注入」，0.29.0 起）
			const [tab, setTab] = (0, react.useState)("restart");
			/** 三个 tab 的 key 与文案 key（文案走本插件 locale 字典，zh/en 都有）。 */
			const tabs = [
				{ key: "restart", labelKey: "restart.tabRestart" },
				{ key: "log", labelKey: "restart.tabLog" },
				{ key: "skills", labelKey: "restart.tabSkills" },
			];
			return (0, react.createElement)(
				"div",
				null,
				(0, react.createElement)(
					"div",
					{ className: "dsh-ror-tabs", role: "tablist", key: "tabs" },
					tabs.map((item) => (0, react.createElement)(
						"button",
						{
							type: "button",
							key: item.key,
							role: "tab",
							className: "dsh-ror-tab" + (tab === item.key ? " dsh-ror-tab-active" : ""),
							"aria-selected": tab === item.key,
							onClick: () => setTab(item.key),
						},
						translate(item.labelKey),
					)),
				),
				// 条件渲染只挂载当前 tab 的一块（与原先设置弹窗导航切换的挂载语义
				// 一致）；t/close 原样透传，各组件签名与内部实现不动（0.29.0 起
				// tab3 = SkillsSection）
				tab === "restart"
					? (0, react.createElement)(
							"div",
							{ role: "tabpanel", key: "panel-restart" },
							(0, react.createElement)(RestartSection, { t: translate, close }),
						)
					: tab === "log"
						? (0, react.createElement)(
								"div",
								{ role: "tabpanel", key: "panel-log" },
								(0, react.createElement)(RestartLogSection, { t: translate }),
							)
						: (0, react.createElement)(
								"div",
								{ role: "tabpanel", key: "panel-skills" },
								(0, react.createElement)(SkillsSection, { t: translate }),
							),
			);
		}

		/**
		 * 顶栏开关条目。视觉照抄同排「标准模式」标签（agent-preset 的 chip）：
		 * 同样的设计 token（--dsw-radius-xs / fill-tsp-secondary / label-tertiary、
		 * 22px 高、12px 字号、4px 间距、单行省略），但它是可点的 button，
		 * 排除态整体变灰。只对恢复候选会话渲染：当前会话不在恢复候选集合
		 * （最近活跃窗口内的会话，0.10.0 起含手动停止/正常结束的）时返回 null，
		 * 窗口外/被忽略前缀的会话不渲染任何 DOM。
		 * @param {{sessionId?: string}} props 框架注入的 session 标准包 props
		 */
		function ResumeToggle({ sessionId }) {
			const [excluded, setExcluded] = (0, react.useState)(false);
			const [pending, setPending] = (0, react.useState)(false);
			const [hover, setHover] = (0, react.useState)(false);
			const [candidate, setCandidate] = (0, react.useState)(false);
			const id = typeof sessionId === "string" ? sessionId : "";

			// 候选/排除状态同步（0.11.0 起）：挂载/切换会话时一次 GET /state 一次性
			// 查询（兜底首帧，非轮询），其余变化全部来自 ws 快照推送（订阅自己的 id）——
			// 不再有任何周期性拉接口的定时器，window focus 补偿查询也一并移除
			// （它本来是补偿轮询的）。restoreCandidates 未命中当前 id、字段缺失或请求
			// 失败都按「不显示」处理；cancelled 防止上一轮查询的过期响应串态，
			// wsApplied 防止更晚到达的一次性查询覆盖更新的 ws 快照。
			(0, react.useEffect)(() => {
				let cancelled = false;
				let wsApplied = false;
				setExcluded(false);
				setHover(false);
				setCandidate(false);
				if (!id) return undefined;
				const apply = (state) => {
					if (cancelled) return;
					wsApplied = true;
					setCandidate(state.candidate);
					setExcluded(state.excluded);
				};
				const query = async () => {
					try {
						const res = await fetch(`${API_BASE}/state?ids=${encodeURIComponent(id)}`, { cache: "no-store" });
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const data = await res.json().catch(() => null);
						if (cancelled || wsApplied) return;
						if (!data || typeof data !== "object") {
							setCandidate(false);
							return;
						}
						const candidates = data.restoreCandidates;
						setCandidate(Boolean(candidates && typeof candidates === "object" && candidates[id]));
						setExcluded(Boolean(
							data.excluded && typeof data.excluded === "object"
								&& Object.prototype.hasOwnProperty.call(data.excluded, id),
						));
					} catch (err) {
						if (!cancelled) {
							setCandidate(false);
							console.warn("[resume-on-restart] state query failed, hiding toggle:", err);
						}
					}
				};
				query();
				const unsubscribe = subscribeWsState(id, apply);
				return () => {
					cancelled = true;
					unsubscribe();
				};
			}, [id]);

			// 点击切换标记：仍是 POST /state（乐观更新 + 失败回滚；请求期间忽略再次
			// 点击）。成功后的状态对齐交给服务端 ws 广播——各标签页（含本页）自动收敛
			// 到同一服务端口径，本组件不再主动重拉候选集合
			const toggle = async () => {
				if (pending || !id) return;
				const next = !excluded;
				setPending(true);
				setExcluded(next);
				try {
					const res = await fetch(`${API_BASE}/state`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId: id, excluded: next }),
					});
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const data = await res.json().catch(() => null);
					if (data && typeof data === "object" && data.ok === false) {
						throw new Error(typeof data.error === "string" ? data.error : "request rejected");
					}
				} catch (err) {
					setExcluded(!next);
					console.warn("[resume-on-restart] toggle failed, rolled back:", err);
				} finally {
					setPending(false);
				}
			};

			// 显示门控：非恢复候选（含查询未命中/响应缺字段/请求失败）不渲染任何 DOM
			if (!candidate) return null;

			const showExcluded = excluded;
			const label = showExcluded ? (hover ? LABEL_EXCLUDED_HOVER : LABEL_EXCLUDED) : hover ? LABEL_NORMAL_HOVER : LABEL_NORMAL;
			const style = {
				display: "inline-flex",
				alignItems: "center",
				gap: 4,
				boxSizing: "border-box",
				height: 22,
				maxWidth: 200,
				padding: "0 8px",
				border: "none",
				borderRadius: "var(--dsw-radius-xs, 4px)",
				background: showExcluded
					? "transparent"
					: hover
						? "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.18))"
						: "var(--dsw-alias-fill-tsp-secondary, rgba(127,127,127,0.12))",
				color: showExcluded
					? "var(--dsw-alias-label-quaternary, rgba(127,127,127,0.45))"
					: hover
						? "var(--dsw-alias-label-secondary, rgba(127,127,127,0.65))"
						: "var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))",
				font: "inherit",
				fontSize: 12,
				lineHeight: "22px",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
				cursor: pending ? "default" : "pointer",
				opacity: pending ? 0.7 : 1,
				flex: "none",
				transition: "background 0.12s ease, color 0.12s ease, opacity 0.12s ease",
			};
			return (0, react.createElement)(
				"button",
				{
					type: "button",
					"aria-pressed": showExcluded,
					title: showExcluded ? TITLE_EXCLUDED : TITLE_NORMAL,
					style,
					onClick: toggle,
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => setHover(false),
					onFocus: () => setHover(true),
					onBlur: () => setHover(false),
				},
				(0, react.createElement)(
					"svg",
					{
						width: 13,
						height: 13,
						viewBox: "0 0 24 24",
						fill: "none",
						"aria-hidden": "true",
						style: { flex: "0 0 auto" },
					},
					(0, react.createElement)("path", {
						d: "M20 12a8 8 0 1 1-2.34-5.66",
						stroke: "currentColor",
						strokeWidth: "2.2",
						strokeLinecap: "round",
					}),
					(0, react.createElement)("path", {
						d: "M20 3v4h-4",
						stroke: "currentColor",
						strokeWidth: "2.2",
						strokeLinecap: "round",
						strokeLinejoin: "round",
					}),
				),
				(0, react.createElement)(
					"span",
					{ style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } },
					label,
				),
			);
		}

		/**
		 * 重启回执 toast（0.8.0，模块级一次性检查）：页面加载后查一次
		 * /restart/health，restarted 标记为真（本进程确为一次重启的产物且
		 * 尚未确认过）就弹「已重启」，随后 POST /restart/ack 消费标记——
		 * 之后的刷新不再重弹。失败静默：toast 只是锦上添花。
		 */
		function checkRestartedToast() {
			fetch(`${API_BASE}/restart/health`, { cache: "no-store" })
				.then((r) => (r.ok ? r.json().catch(() => null) : null))
				.then((j) => {
					if (!j || j.restarted !== true) return;
					const el = document.createElement("div");
					el.className = "dsh-ror-toast";
					el.textContent = T("restart.done");
					document.body.appendChild(el);
					setTimeout(() => el.remove(), 8000);
					return fetch(`${API_BASE}/restart/ack`, { method: "POST" }).catch(() => { /* 尽力回执 */ });
				})
				.catch(() => { /* 宿主 half 未加载等场景，静默 */ });
		}

		/** 需要的客户端服务：slots（注册插槽条目）、locale（设置弹窗文案）、uiWorkspace（会话行点击跳转，0.25.0）。 */
		const inject = ["slots", "locale", "uiWorkspace"];

		/**
		 * 客户端入口：注入自带样式、注册 locale 字典（locale seat）、
		 * 向会话顶栏 actions 插槽注册兄弟条目，并向 `settings.section` 插槽注册
		 * 「重启」合并 section（0.28.0 起单条目，内部 tab 切换「重启」与
		 * 「重启日志」两块内容）。slots.inject 等宿主声明对应插槽后再注册；
		 * 注册声明在其它包里、apply 顺序无约束，等待由宿主完成。
		 * @param {object} ctx 客户端 cordis context
		 */
		function apply(ctx) {
			// 自带样式一次注入；全部走设计 token，明暗主题自适应
			const style = document.createElement("style");
			style.dataset.pluginCss = "dsh-ror-settings";
			style.textContent = SETTINGS_CSS;
			document.head.appendChild(style);
			// locale seat：注册 zh/en 字典并绑定翻译（写法照抄 dsh-prompt-history）
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-resume-on-restart: dictionaries");
			setTranslator(ctx.locale.bind(NS));
			// uiWorkspace（0.25.0）：会话行点击跳转用；服务缺失时 setUiWorkspace 存
			// null，行点击降级为 console.warn 后忽略，不影响其他功能
			setUiWorkspace(ctx.uiWorkspace);
			// 会话顶栏开关：id 固定 `resume-on-restart`；order 10 排在「标准模式」标签（order -10）之后、
			// 任务列表等条目（order 20）之前
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "resume-on-restart",
						order: 10,
					},
					ResumeToggle,
				),
			);
			// 设置弹窗「重启」合并 section（0.28.0 起单条目，原「重启日志」「重启」
			// 两个 settings.section 条目主题重复，合并为条目内两个 tab；原 order 62
			// restart-now 条目移除）：order 61 排在 dsh-prompt-history（60）之后；
			// locale: NS 让 shell 给组件注入本插件命名空间的翻译函数 t；label 复用
			// 既有 restart.nav（「重启」/「Restart」）。RestartTabsSection 内部
			// tab1 = RestartSection（默认选中）、tab2 = RestartLogSection，两组件
			// 的实现与行为原样保留（close 透传给 RestartSection 供跳转后关弹窗）
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "resume-on-restart",
						order: 61,
						locale: NS,
						label: () => T("restart.nav"),
					},
					RestartTabsSection,
				),
			);
			// 重启回执：本页面若是重启后的新实例所服务，弹一次「已重启」并 ack
			checkRestartedToast();
		}

		exports.inject = inject;
		exports.apply = apply;
		// 0.13.0：对账纯函数导出——node --test 经 window.__ModuleLoader__ 桩加载
		// 本文件后直接单测（lib/pending-restore.test.js），测的就是发布逻辑本身
		exports.PENDING_RESTORE_KEY = PENDING_RESTORE_KEY;
		exports.PENDING_BOOT_TOLERANCE_MS = PENDING_BOOT_TOLERANCE_MS;
		exports.SETTLE_RESULTS = SETTLE_RESULTS;
		exports.readPendingRestore = readPendingRestore;
		exports.writePendingRestore = writePendingRestore;
		exports.matchPendingBoot = matchPendingBoot;
		exports.collectSettlementsBySession = collectSettlementsBySession;
		exports.normalizeCandidateDetails = normalizeCandidateDetails;
		// 0.14.0：待恢复列表取消/恢复纯函数导出（同上，供 node --test 单测）
		exports.mergePendingRows = mergePendingRows;
		exports.setPendingCancelled = setPendingCancelled;
		exports.activePendingCount = activePendingCount;
		// 0.18.0：待恢复列表按工作区分组的纯函数导出（同上，供 node --test 单测）
		exports.groupPendingRows = groupPendingRows;
		// 0.26.0：「上次重启无法恢复」列表行归一化纯函数导出（同上，供 node --test 单测）
		exports.normalizeUnrestoredRows = normalizeUnrestoredRows;
		// 0.15.0：暂停所有会话的结果摘要纯函数导出（同上，供 node --test 单测）
		exports.formatPauseResult = formatPauseResult;
		return module.exports;
	},
});
