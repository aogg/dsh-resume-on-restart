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
 * - 显示门控：只有当前会话属于恢复候选（DSH 停止那一刻仍 running 的会话，
 *   宿主 GET /state 响应的 restoreCandidates 给出）才渲染；否则组件返回 null，
 *   正常结束的会话不显示任何 DOM。
 * - 候选/排除状态查询时机：挂载/切换会话时一次，window focus 时一次，
 *   每 15 秒轮询一次（页面隐藏时跳过该轮）；restoreCandidates 未命中当前 id、
 *   字段缺失或请求失败都按「不显示」处理，只 console.warn，不抛错不弹窗。
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
		/** 候选集合轮询间隔（ms）：恢复候选随 agent/status 实时变化，需要周期刷新。 */
		const POLL_INTERVAL_MS = 15000;

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
			// ---- 0.9.0：归档结算（与用户排除并列，不算失败） ----
			"restore.archived": "已归档",
			// ---- 0.8.0：设置弹窗「重启」section 与重启回执 ----
			"restart.nav": "重启",
			"restart.title": "重启 DeepSeek Harness",
			"restart.note": "以相同参数重新拉起 DSH（重载插件与配置）。完成后页面自动刷新，重启前运行中的会话由本插件自动恢复；执行前需二次确认。",
			"restart.notePid1": "当前 DSH 以容器 PID 1 运行：重启 = 进程优雅退出，由容器重启策略（--restart=always / unless-stopped，或 on-failure 配合退出码）拉起；未配置策略时需手动 docker start。",
			"restart.candidates": "重启后将自动恢复",
			"restart.candidatesUnit": "个运行中的会话",
			"restart.appExitMissing": "提示：宿主未提供优雅退出通道（appExit missing），重启将退化为直接退出。",
			"restart.button": "重启 DSH",
			"restart.confirmTitle": "确认重启 DeepSeek Harness？",
			"restart.confirmBody": "重启期间网页会短暂断开，完成后自动刷新；重启前运行中的会话会自动恢复。确定要现在重启吗？",
			"restart.confirmBodyPid1": "PID=1 模式：进程将优雅退出，由容器重启策略拉起；未配置策略时需要手动启动容器。确定要现在重启吗？",
			"restart.confirm": "确认重启",
			"restart.cancel": "取消",
			"restart.waiting": "DSH 正在重启，等待新实例就绪后自动刷新…",
			"restart.timeoutPid1": "等待超时：容器可能未配置重启策略。请手动启动容器（docker start），本页会继续等待。",
			"restart.timeoutHelper": "等待超时：重启未按预期完成，请检查 DSH 日志或手动重启；本页会继续等待。",
			"restart.failed": "重启失败",
			"restart.done": "已重启：DSH 已恢复，重启前运行中的会话正在自动恢复。",
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
			// ---- 0.9.0: archived settlement (alongside user exclusion, not a failure) ----
			"restore.archived": "archived",
			// ---- 0.8.0: settings restart section & restart acknowledgement ----
			"restart.nav": "Restart",
			"restart.title": "Restart DeepSeek Harness",
			"restart.note": "Relaunches DSH with the same invocation (reloads plugins & config). The page refreshes automatically afterwards and sessions that were running get restored by this plugin. A second confirmation is required before restarting.",
			"restart.notePid1": "DSH currently runs as PID 1 inside a container: restart = graceful exit, brought back by the container restart policy (--restart=always / unless-stopped, or on-failure via exit code); without a policy you must start the container manually.",
			"restart.candidates": "Sessions to be restored after restart:",
			"restart.candidatesUnit": "",
			"restart.appExitMissing": "Note: the host provides no graceful exit channel (appExit missing); restart falls back to a direct exit.",
			"restart.button": "Restart DSH",
			"restart.confirmTitle": "Restart DeepSeek Harness?",
			"restart.confirmBody": "The page disconnects briefly and refreshes automatically afterwards; sessions that were running will be restored. Restart now?",
			"restart.confirmBodyPid1": "PID=1 mode: the process exits gracefully and is brought back by the container restart policy; without one, start the container manually. Restart now?",
			"restart.confirm": "Restart now",
			"restart.cancel": "Cancel",
			"restart.waiting": "DSH is restarting, waiting for the new instance before refreshing…",
			"restart.timeoutPid1": "Timed out: the container may have no restart policy. Start it manually (docker start); this page keeps waiting.",
			"restart.timeoutHelper": "Timed out: the restart did not complete as expected. Check the DSH logs or restart manually; this page keeps waiting.",
			"restart.failed": "Restart failed",
			"restart.done": "Restarted: DSH is back and previously running sessions are being restored.",
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
		 */
		function RestartConfirmDialog({ t, isPid1, busy, onConfirm, onCancel }) {
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
			return (0, react.createElement)(
				"div",
				{ className: "dsh-ror-modal-backdrop", onClick: onCancel },
				(0, react.createElement)(
					"div",
					{
						className: "dsh-ror-modal",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": t("restart.confirmTitle"),
						onClick: (e) => e.stopPropagation(),
					},
					(0, react.createElement)("h4", { className: "dsh-ror-modal-title" }, t("restart.confirmTitle")),
					(0, react.createElement)("p", { className: "dsh-ror-modal-body" }, t("restart.confirmBody")),
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
							{ type: "button", className: "dsh-ror-btn-danger", onClick: onConfirm, disabled: busy },
							t("restart.confirm"),
						),
					),
				),
			);
		}

		/**
		 * 设置弹窗左侧「重启」section（0.8.0）：
		 * - 挂载时 GET /restart/info 取模式说明与恢复候选数（请求失败只降级为
		 *   不显示计数，不阻断按钮——info 缺失时按钮仍可用）；
		 * - 按钮进入 confirm 弹窗（二次确认）→ 确认后先捕获基线 instanceId 再
		 *   POST /restart，随后单飞轮询 /restart/health：instanceId 相对基线变更
		 *   （或无基线时"见过挂掉 + 重新起来"）才刷新页面，短暂断线绝不当成功；
		 * - pid1-exit 模式超过快速轮询窗口后提示容器重启策略可能未拉起，
		 *   降频（5s）继续等待——容器策略或手动 docker start 随时把它带回来。
		 */
		function RestartSection({ t }) {
			const translate = typeof t === "function" ? t : T;
			const [info, setInfo] = (0, react.useState)(null);
			const [phase, setPhase] = (0, react.useState)("idle"); // idle | confirm | waiting
			const [errorText, setErrorText] = (0, react.useState)("");
			const [timedOut, setTimedOut] = (0, react.useState)(false);
			const runningRef = (0, react.useRef)(false);

			(0, react.useEffect)(() => {
				let cancelled = false;
				fetch(`${API_BASE}/restart/info`, { cache: "no-store" })
					.then((r) => (r.ok ? r.json().catch(() => null) : null))
					.then((j) => {
						if (!cancelled && j && typeof j === "object") setInfo(j);
					})
					.catch(() => { /* info 拿不到就只影响展示 */ });
				return () => {
					cancelled = true;
				};
			}, []);

			const isPid1 = info?.mode === "pid1-exit";
			const candidates = info && Array.isArray(info.runningCandidates) ? info.runningCandidates.length : null;

			/** 确认后的执行体：基线 → POST → 轮询 → 刷新。 */
			const startRestart = async () => {
				if (runningRef.current) return;
				runningRef.current = true;
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
				children.push((0, react.createElement)(
					"p",
					{ className: "dsh-ror-restart-status", key: "candidates" },
					`${translate("restart.candidates")} ${candidates}${unit ? ` ${unit}` : ""}`,
				));
			}
			if (phase === "waiting") {
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-restart-actions", key: "waiting" },
					(0, react.createElement)("span", { className: "dsh-ror-restart-status" }, translate("restart.waiting")),
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
				children.push((0, react.createElement)(
					"div",
					{ className: "dsh-ror-restart-actions", key: "actions" },
					(0, react.createElement)(
						"button",
						{
							type: "button",
							className: "dsh-ror-btn-danger",
							onClick: () => { setErrorText(""); setPhase("confirm"); },
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
			);
			return (0, react.createElement)("div", { className: "dsh-ror-settings" }, children);
		}

		/**
		 * 顶栏开关条目。视觉照抄同排「标准模式」标签（agent-preset 的 chip）：
		 * 同样的设计 token（--dsw-radius-xs / fill-tsp-secondary / label-tertiary、
		 * 22px 高、12px 字号、4px 间距、单行省略），但它是可点的 button，
		 * 排除态整体变灰。只对恢复候选会话渲染：当前会话不在恢复候选集合
		 * （DSH 停止那一刻仍 running 的会话）时返回 null，正常结束的会话不渲染任何 DOM。
		 * @param {{sessionId?: string}} props 框架注入的 session 标准包 props
		 */
		function ResumeToggle({ sessionId }) {
			const [excluded, setExcluded] = (0, react.useState)(false);
			const [pending, setPending] = (0, react.useState)(false);
			const [hover, setHover] = (0, react.useState)(false);
			const [candidate, setCandidate] = (0, react.useState)(false);
			const id = typeof sessionId === "string" ? sessionId : "";

			// 候选/排除状态查询：挂载/切换会话时一次，window focus 时一次，每 15 秒轮询
			// （页面隐藏时跳过该轮）。restoreCandidates 未命中当前 id、字段缺失或请求失败
			// 都按「不显示」处理；cancelled 防止上一轮查询的过期响应串态。
			(0, react.useEffect)(() => {
				let cancelled = false;
				setExcluded(false);
				setHover(false);
				setCandidate(false);
				if (!id) return undefined;
				const refresh = async () => {
					try {
						const res = await fetch(`${API_BASE}/state?ids=${encodeURIComponent(id)}`, { cache: "no-store" });
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const data = await res.json().catch(() => null);
						if (cancelled) return;
						if (!data || typeof data !== "object") {
							setCandidate(false);
							return;
						}
						const candidates = data.restoreCandidates;
						setCandidate(Boolean(candidates && typeof candidates === "object" && candidates[id]));
						if (data.excluded && Object.prototype.hasOwnProperty.call(data.excluded, id)) setExcluded(true);
					} catch (err) {
						if (!cancelled) {
							setCandidate(false);
							console.warn("[resume-on-restart] state query failed, hiding toggle:", err);
						}
					}
				};
				refresh();
				const timer = setInterval(() => {
					if (document.visibilityState !== "visible") return;
					refresh();
				}, POLL_INTERVAL_MS);
				const onFocus = () => {
					refresh();
				};
				window.addEventListener("focus", onFocus);
				return () => {
					cancelled = true;
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, [id]);

			// 点击切换标记：乐观更新 + 失败回滚；请求期间忽略再次点击
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
		return module.exports;
	},
});
