/**
 * dsh-resume-on-restart client half（web 会话顶栏开关）。
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
 * - 挂载/切换会话时 GET /api/dsh-resume-on-restart/state?ids=<sessionId> 查询排除状态；
 *   请求失败按「未排除」显示并 console.warn，不抛错不弹窗。
 * - 点击 POST /api/dsh-resume-on-restart/state，body { sessionId, excluded }；
 *   请求期间防重复点击；失败回滚 UI 状态。
 * - 文案固定中文（本插件无 locale 体系，与通知文案风格一致）。
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

		/** 文案（固定中文；与通知文案同风格）。 */
		const LABEL_NORMAL = "重启时恢复会话";
		const LABEL_NORMAL_HOVER = "取消→重启时恢复会话";
		const LABEL_EXCLUDED = "已取消恢复";
		const LABEL_EXCLUDED_HOVER = "恢复→重启时恢复会话";
		const TITLE_NORMAL = "点击后本会话在 DSH 重启后不再自动恢复";
		const TITLE_EXCLUDED = "本会话已标记为重启后不自动恢复，点击恢复";

		/**
		 * 顶栏开关条目。视觉照抄同排「标准模式」标签（agent-preset 的 chip）：
		 * 同样的设计 token（--dsw-radius-xs / fill-tsp-secondary / label-tertiary、
		 * 22px 高、12px 字号、4px 间距、单行省略），但它是可点的 button，
		 * 排除态整体变灰。条目在任何状态下都不消失。
		 * @param {{sessionId?: string}} props 框架注入的 session 标准包 props
		 */
		function ResumeToggle({ sessionId }) {
			const [excluded, setExcluded] = (0, react.useState)(false);
			const [pending, setPending] = (0, react.useState)(false);
			const [hover, setHover] = (0, react.useState)(false);
			const id = typeof sessionId === "string" ? sessionId : "";

			// 挂载/切换会话时查询排除状态；失败按「未排除」显示，只 warn 不打扰
			(0, react.useEffect)(() => {
				let cancelled = false;
				setExcluded(false);
				setHover(false);
				if (!id) return undefined;
				(async () => {
					try {
						const res = await fetch(`${API_BASE}/state?ids=${encodeURIComponent(id)}`, { cache: "no-store" });
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const data = await res.json().catch(() => null);
						if (cancelled || !data || typeof data !== "object") return;
						if (data.excluded && Object.prototype.hasOwnProperty.call(data.excluded, id)) setExcluded(true);
					} catch (err) {
						if (!cancelled) console.warn("[resume-on-restart] state query failed, showing as not excluded:", err);
					}
				})();
				return () => {
					cancelled = true;
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

		/** 需要的客户端服务：slots（注册顶栏插槽条目）。 */
		const inject = ["slots"];

		/**
		 * 客户端入口：向会话顶栏 actions 插槽注册兄弟条目。
		 * id 固定 `resume-on-restart`；order 10 排在「标准模式」标签（order -10）之后、
		 * 任务列表等条目（order 20）之前。slots.inject 等宿主声明该插槽后再注册。
		 * @param {object} ctx 客户端 cordis context
		 */
		function apply(ctx) {
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
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
