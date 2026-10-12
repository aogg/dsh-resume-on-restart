# Changelog

## [0.4.0] - 2026-10-12

### Added
- **web 会话顶栏开关**（客户端 half `lib/client.js`，手写 bundle、仅依赖 baseline 的 react，
  无构建链）：在会话顶栏「标准模式」标签同一个父容器（slot `conversation.session.header.actions`）
  注册兄弟条目 `resume-on-restart`（order 10，同排同款设计 token）。正常态「重启时恢复会话」，
  悬停「取消→重启时恢复会话」；点击把当前会话标记为「重启后不自动恢复」，条目变灰、
  文案「已取消恢复」，悬停「恢复→重启时恢复会话」；再点取消标记。条目任何状态下都不消失。
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
