# Changelog

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
