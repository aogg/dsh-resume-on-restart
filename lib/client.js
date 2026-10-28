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
			// ---- 0.8.0：设置弹窗「重启」section 与重启回执 ----
			"restart.nav": "重启",
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
			"restart.elapsed": "重启中… 已等待 %s 秒",
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
			// ---- 0.8.0: settings restart section & restart acknowledgement ----
			"restart.nav": "Restart",
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
			"restart.elapsed": "Restarting… waited %s s",
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
		];

		/**
		 * 防御式读 localStorage 的待恢复存根：缺失/损坏 JSON/形状不对一律 null，
		 * 绝不抛错（对账视图只是锦上添花，不能干扰 section 本体）。
		 * candidates 条目归一化为 { id, at, running, title? }（at 非字符串归 ''，
		 * running 缺省 false，title 仅非空字符串才保留——对账视图标题为主、
		 * 缺失退 shortId 弱化显示）。
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
		 * 候选明细由调用方整形（startRestart：{ id, at, running, title? }，title 空省略）。
		 * @param {{setItem: (key: string, value: string) => void}|null|undefined} storage
		 * @param {{at: string, restartId?: string, candidates: Array<{id: string, at: string, running: boolean, title?: string}>}} record
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
		 * @param {unknown} runningCandidates
		 * @returns {Array<{id: string, at: string, running: boolean, title?: string}>}
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
					rows.push(row);
				}
			}
			return rows;
		}

		// ---- 0.14.0：待恢复列表的逐行 / 批量取消恢复（纯函数，返回新数组不改入参） ----

		/**
		 * 合并本地待恢复列表与新拉的服务端列表（纯函数）：
		 * - 服务端返回的行**为准**（id/at/running/title 取服务端），cancelled 字段用
		 *   本地旧值（本地点过取消的行不因重拉而丢标记；本地没有的行视为未取消）；
		 * - 本地已有但服务端不再返回的行**保留**并置 cancelled=true（服务端已把该会话
		 *   剔除出恢复候选 = 取消生效；行留在列表里用户才能「恢复」撤销）；
		 * - 按 id 去重（服务端顺序在前，本地多出的行按原顺序缀后），任何非法输入不抛错。
		 * @param {Array<{id: string, at?: string, running?: boolean, title?: string, cancelled?: boolean}>|unknown} prevRows 本地行
		 * @param {Array<{id: string, at?: string, running?: boolean, title?: string}>|unknown} nextRows normalizeCandidateDetails 的输出
		 * @returns {Array<{id: string, at: string, running: boolean, cancelled: boolean, title?: string}>}
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
			".dsh-ror-modal-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}",
			".dsh-ror-modal{width:min(420px,calc(100vw - 48px));background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:18px 18px 14px;box-shadow:0 12px 40px rgba(0,0,0,.25);}",
			".dsh-ror-modal-title{margin:0 0 8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);}",
			".dsh-ror-modal-body{margin:0 0 8px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);}",
			".dsh-ror-modal-warn{margin:0 0 8px;font-size:12px;line-height:1.7;color:rgba(176,58,46,.9);}",
			".dsh-ror-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}",
			".dsh-ror-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;cursor:pointer;}",
			".dsh-ror-btn:hover{background:var(--dsw-alias-bg-layer-3);}",
			".dsh-ror-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:10001;max-width:min(560px,calc(100vw - 40px));padding:10px 16px;border-radius:8px;background:rgba(48,132,74,.92);color:#fff;font-size:12px;line-height:1.6;box-shadow:0 8px 24px rgba(0,0,0,.28);}",
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
		 *   confirm 列表仍优先于对账视图。
		 */
		function RestartSection({ t }) {
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
			// /restart/info 自动构建（进入选项卡即见，不遮蔽对账视图）；confirm =
			// 点过「重启 DSH」（0.13.0 原语义，优先于对账视图）
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

			// 挂载时一次 GET /restart/info：模式说明与候选计数；0.16.0 起同一响应
			// 直接构建 preview 待恢复列表（进入选项卡即见，不等点按钮）
			(0, react.useEffect)(() => {
				let cancelled = false;
				fetch(`${API_BASE}/restart/info`, { cache: "no-store" })
					.then((r) => (r.ok ? r.json().catch(() => null) : null))
					.then((j) => {
						if (cancelled || !j || typeof j !== "object") return;
						setInfo(j);
						// 0.16.0：进入选项卡即构建待恢复列表（复用本次响应，不等点按钮）；
						// 竞态防抖：请求在途时用户已点「重启 DSH」→ openConfirm 已按点击
						// 时刻口径合并列表，晚到的挂载响应不得覆盖、模式不得回落 preview
						if (clickedRef.current) return;
						setPendingRows((prev) => (prev === null
							? normalizeCandidateDetails(j.runningCandidates)
							: prev));
						setPendingMode((prev) => (prev === "none" ? "preview" : prev));
					})
					.catch(() => { /* info 拿不到就只影响展示 */ });
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
				// 0.16.0：本轮点击流程开始——列表来源切 confirm（优先于对账视图），
				// 并挡住挂载请求晚到的覆盖（见挂载 effect）
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
			 * 不渲染）。重新 GET /restart/info → normalizeCandidateDetails 构建行 →
			 * mergePendingRows 合并（与 openConfirm 同一口径：服务端为准、保留本地
			 * 取消标记，服务端不再返回的行保留并置 cancelled=true）→ 同步收窄选中
			 * 集合 → 更新渲染。拉取中禁用按钮（refreshing）；失败静默——现有列表
			 * 原样保留，只 console.warn（沿用既有错误处理风格）。
			 */
			const refreshPendingList = () => {
				if (refreshing) return;
				setRefreshing(true);
				fetch(`${API_BASE}/restart/info`, { cache: "no-store" })
					.then((r) => (r.ok ? r.json().catch(() => null) : null))
					.then((j) => {
						if (!j || typeof j !== "object") return;
						setInfo(j);
						const nextRows = normalizeCandidateDetails(j.runningCandidates);
						// 首次构建（理论不可达：按钮只在列表已构建时渲染）与既有列表
						// 合并都走同一套纯函数
						const merged = pendingRows === null ? nextRows : mergePendingRows(pendingRows, nextRows);
						setPendingRows(merged);
						// 选中集合同步只保留仍存在的行（与 openConfirm 一致）
						setSelectedIds((prev) => {
							const next = new Set();
							for (const id of prev) {
								if (merged.some((row) => row.id === id)) next.add(id);
							}
							return next;
						});
					})
					.catch((err) => {
						// 刷新失败不破坏现有列表：静默保留，仅留排查痕迹
						console.warn("[resume-on-restart] pending list refresh failed, keep current rows:", err);
					})
					.finally(() => setRefreshing(false));
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
					// 新挂载的 RestartSection 据此对账逐会话恢复结果
					const rows = pendingRows !== null
						? pendingRows
						: normalizeCandidateDetails(info?.runningCandidates);
					const record = {
						at: confirmedAt,
						candidates: rows.map((c) => {
							const item = { id: c.id, at: c.at, running: c.running };
							if (c.title) item.title = c.title;
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

			const children = [
				(0, react.createElement)(
					"h4",
					{ className: "dsh-ror-title", key: "title" },
					translate("restart.title"),
				),
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
			// 0.13.0：待恢复列表（confirm/waiting/失败回 idle 都显示——失败时列表保留）
			// 优先于重启后对账视图；下次点「确认重启」覆盖存根，UI 切回列表态。
			// 0.14.0：行级/批量「取消 / 恢复」——waiting 阶段（重启已发出）转只读，
			// 隐藏 checkbox 与全部操作按钮；已取消行弱化显示并保留在列表中（可撤销）
			// 0.16.0：进入选项卡即展示（preview = 挂载 /restart/info 自动构建，与
			// confirm 列表共用同一构建 renderPendingList，逐行/批量操作直接可用）；
			// preview 不遮蔽对账视图（重启后新页面两块同时渲染，列表在上），
			// confirm 列表仍优先于对账视图（0.13.0 原语义）
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
					pendingChildren.push((0, react.createElement)(
						"div",
						{ className: "dsh-ror-restores", key: "rows" },
						// 0.13.0 修正：每行 = 运行中徽标 + 会话标题（主文本，省略号截断、
						// 全文在 title 属性）+ 最后活跃时间；title 缺失才退 shortId 弱化
						// 显示。完整 id 一律放在行容器 title 属性做悬停提示，不再作为行主文本。
						// 0.14.0：行首加选中 checkbox、行尾加「取消/恢复」小按钮（只读时都不
						// 渲染），已取消行加「已取消」徽标并弱化——行必须保留在列表中才能撤销
						pendingRows.map((row) => {
							const cancelled = row.cancelled === true;
							return (0, react.createElement)(
								"div",
								{
									className: "dsh-ror-restore"
										+ (cancelled ? " dsh-ror-pending-row-cancelled" : ""),
									key: row.id,
									title: row.id,
								},
								pendingReadonly ? null : (0, react.createElement)("input", {
									type: "checkbox",
									className: "dsh-ror-pending-check",
									checked: selectedIds.has(row.id),
									disabled: mutatingIds.has(row.id),
									"aria-label": row.title || row.id,
									onChange: () => {
										setSelectedIds((prev) => {
											const next = new Set(prev);
											if (next.has(row.id)) next.delete(row.id);
											else next.add(row.id);
											return next;
										});
									},
								}),
								row.running
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
										onClick: () => applyPendingCancelled([row.id], !cancelled),
									},
									translate(cancelled ? "restart.pendingRestore" : "restart.pendingCancel"),
								),
							);
						}),
					));
				}
				return (0, react.createElement)(
					"div",
					{ className: "dsh-ror-pending", key: "pending" },
					pendingChildren,
				);
			};
			if (showConfirmList || showPreviewList) {
				children.push(renderPendingList());
			}
			// 0.16.0：confirm 列表仍优先于对账视图（存在即不渲染它，0.13.0 原语义）；
			// preview 列表不遮蔽对账视图（重启后新页面两块同时渲染，列表在上）
			if (!showConfirmList && settlement !== null) {
				// 0.13.0：上次重启的逐会话恢复结果（无存根时什么都不显示，现状不变）
				const bootAt = settlement.boot && typeof settlement.boot.at === "string" ? settlement.boot.at : "";
				const total = settlement.pending.candidates.length;
				const restoredCount = settlement.pending.candidates
					.filter((c) => settlement.byId.get(c.id)?.result === "resumed")
					.length;
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
						settlement.pending.candidates.map((c) => {
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
							// flex:1 省略号（与标题并存时两者各自截断，排版不挤坏）
							return (0, react.createElement)(
								"div",
								{ className: "dsh-ror-restore", key: c.id, title: c.id },
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
						}),
					),
				));
			}
			if (phase === "waiting") {
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-restart-actions", key: "waiting" },
					(0, react.createElement)("span", { className: "dsh-ror-restart-status" }, translate("restart.waiting")),
					// 0.13.0：等待计时，每秒跳动
					(0, react.createElement)(
						"span",
						{ className: "dsh-ror-restart-status" },
						translate("restart.elapsed").replace("%s", String(elapsedSec)),
					),
				));
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

		/** 需要的客户端服务：slots（注册插槽条目）、locale（设置弹窗文案）。 */
		const inject = ["slots", "locale"];

		/**
		 * 客户端入口：注入自带样式、注册 locale 字典（locale seat）、
		 * 向会话顶栏 actions 插槽注册兄弟条目，并向 `settings.section` 插槽注册
		 * 「重启日志」section。slots.inject 等宿主声明对应插槽后再注册；
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
			// 设置弹窗「重启日志」section（0.5.0）：order 61 排在 dsh-prompt-history（60）之后；
			// locale: NS 让 shell 给组件注入本插件命名空间的翻译函数 t
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "resume-on-restart",
						order: 61,
						locale: NS,
						label: () => T("settings.nav"),
					},
					RestartLogSection,
				),
			);
			// 设置弹窗左侧「重启」选项（0.8.0）：order 62 紧随「重启日志」，
			// 内含重启按钮（二次确认后触发宿主重启引擎）
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "restart-now",
						order: 62,
						locale: NS,
						label: () => T("restart.nav"),
					},
					RestartSection,
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
		// 0.15.0：暂停所有会话的结果摘要纯函数导出（同上，供 node --test 单测）
		exports.formatPauseResult = formatPauseResult;
		return module.exports;
	},
});
