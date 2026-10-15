# Changelog

## [0.8.0] - 2026-10-15

### Added
- **重启引擎（lib/restart.js，设计参考 dsh-power-button，独立实现）**：本插件从"只观测重启"
  升级为"可以发起重启"。两种模式由 `resolveRestartMode` 判定：
  - **helper（普通进程）**：真 `.cjs` detach helper（不用 `node -e`）经
    **ARM → COMMIT → ACK** 三段握手接管拉起职责——host 等到 helper ARM 才写 COMMIT、
    等到 ACK 才 unref 并安排自身退出；helper 等旧 pid 退出（时限由 host 退出预算
    `preExitBudgetMs + 15s` 派生）、端口释放、会话记录静默（(size, mtime) 连续两次采样
    一致；正则覆盖 `session.v4.jsonl[.zstd]`，power-button 的 `/session\.jsonl/` 会漏掉
    v4 形态）后，以原 argv+cwd（`--port 0` 被 pin 成实际端口）拉起新进程，env 带
    `DSH_ROR_RESTART_ID` 启动令牌，轮询 `/restart/health` 直到 `instanceId` 变更且
    `restart.restartId` 匹配才算就绪（端口投机者冒充不了），最后自删
  - **pid1-exit（容器内 PID=1，本插件的现实部署形态）**：PID 1 退出即容器销毁、PID
    namespace 内所有进程（含 detach helper）被内核杀死，helper 方案在结构上不可能工作。
    该模式改为"退出前把全部持久化记录写齐 → 优雅退出 → 交由容器重启策略拉起"：host 依次
    写 origin status（`~/.dsh/power-restart/ror-<restartId>.status.json`，带 `committedAt`）、
    重启身份记录（`<stateDir>/restart-identity.json`，带 `requestedAt` 时效窗口
    `IDENTITY_TTL_MS=15min` 防陈旧认领）、检测 marker 兜底 flush、停机归因存根
    （合成 `signal: 'restart-exit'`），然后 `ctx.get('appExit')` 优雅退出（缺失时自发
    SIGTERM 走既有优雅路径，unref 看门狗兜底 `process.exit(pid1ExitCode)`）。容器需以
    `--restart=always/unless-stopped`（或 `on-failure` 配合非 0 退出码）运行才能自动拉起
  - **退出前的持久化兜底（两模式共用）**：取消节流定时器同步固化检测 marker
    （`recentSessions`/running 标记是恢复流程的唯一数据源）+ 写停机归因存根；恢复流程本身
    零改动，重启后照常走"boot 记录 → 自动恢复运行中的会话 → fallback 通知主会话"
- **设置弹窗左侧「重启」选项（第二个 `settings.section` 条目，order 62）**：显示模式说明
  （PID=1 时提前告知依赖容器重启策略）、优雅退出通道可用性（appExit missing 警示）与
  「重启后将自动恢复 N 个运行中的会话」（`GET /restart/info`，与顶栏开关同口径）；
  「重启 DSH」按钮先弹**二次确认**模态框（默认焦点「取消」，Esc/点遮罩取消，必须显式点
  「确认重启」），确认后先捕获基线 `instanceId` 再 `POST /restart`，随后单飞轮询
  `/restart/health`：`instanceId` 相对基线变更（或无基线时"见过挂掉 + 重新起来"）才刷新
  页面，短暂断线绝不当成功；pid1-exit 模式超时提示容器策略可能未拉起（需手动
  `docker start`），降频（5s）继续等待
- **重启回执 toast**：页面加载时查 `/restart/health`，`restarted` 标记为真（本进程确为一次
  重启的产物且未被确认）弹「已重启：……正在自动恢复」顶部通知并 `POST /restart/ack` 消费
  （只清 toast 标记，`restart` 身份块保留整个进程生命周期；身份记录由启动时
  `matchRestartIdentity` 消费——v2 令牌匹配（helper）或时效窗口（pid1）才认领，手动启动
  不能冒领）
- **`/restart` 命令与 `restart_harness` 模型工具（对齐 dsh-power-button 的入口集合）**：
  与按钮共用同一个 at-most-once 闩（第二个并发触发得 409，绝不双 helper/双退出）；
  因果会话取发起者（origin.kind = `settings-ui` / `command` / `model-tool`），重启日志据此
  标注来源；名称已被其他插件注册时记日志让位，不影响本插件其余能力；模型工具 `delayMs`
  下限 1000ms（模型不能在自身 turn 结算前杀进程）、上限 `maxDelayMs`
- **origin 归因零改动复用**：helper 握手 status 写到 `~/.dsh/power-restart/` 目录（文件名
  `ror-` 前缀与 power-button 区分），`committedAt` 落在 [上次启动, 本次启动] 窗口内即被
  既有 `pickOriginRecord` 扫描命中；boot 记录 reason 新增 **`restart-button`** 标签
  （`origin.source === 'dsh-resume-on-restart'`，其余 origin 仍是 `power-button`），重启日志
  UI 补徽标配色与 zh/en 文案；启动时顺带 7 天 housekeeping 清理本插件工件（helper 脚本/
  日志、`ror-*.commit.json`、`ror-*.status.json`），不碰 power-button 的记录
- **新路由**（均在本插件既有前缀与围栏之下，`enableRestart: false` 时整体不存在）：
  `GET /api/dsh-resume-on-restart/restart/info`（模式/候选数/appExit 状态）、
  `GET /restart/health`（instanceId + 重启身份 + lifecycle，helper 就绪门控与客户端轮询
  共用）、`POST /restart`（防重入闩）、`POST /restart/ack`
- **新配置**：`enableRestart`（默认 `true`，按钮/命令/路由总开关）、`enableModelTool`
  （默认 `true`）、`restartDelayMs`（默认 `1500`）、`maxDelayMs`（默认 `5000`）、
  `pid1ExitCode`（默认 `0`；`--restart=on-failure` 部署设非 0）
- **新测试**：lib/restart.test.js（模式判定、端口 pin、预算派生、身份认领 7 分支、防重入
  闩、delay 夹取、helper 脚本产物协议点断言、**helper 真实进程端到端**——COMMIT 前不出手/
  COMMIT 后先写身份再拉起/假目标以 health-timeout 收场而非假成功）；detect.test.js 追加
  `shutdownReasonOf` 的 restart-button 用例；tools/smoke.mjs 手动冒烟（mock ctx 启动插件 +
  GET 路由 + pid1-exit 分支 stub appExit 端到端，`DSH_HOME` 重定向隔离）

### Security
- `POST /restart` 是破坏性操作，走本插件既有最小围栏（宿主 `connection.requestRejection`
  优先，缺失时回退复刻自 DSH 官方规则的 Host/Origin/sec-fetch-site 判断）+ 防重入闩；
  二次确认在客户端强制（默认焦点「取消」）。helper 脚本内嵌 relaunch argv，写盘 `0600`
  且握手失败即删；status/身份/commit 记录原子写（temp+rename）`0600`；启动令牌读后即删，
  不泄漏给子进程

### Changed
- 检测 marker.json **绝不被重启流程覆写**（power-button 的 helper 会覆写它自己的 marker；
  本插件的身份记录独立存 `restart-identity.json`，`recentSessions` 数据源不受影响）
- `POST /restart` 成功回包语义：helper 模式 = 握手三段全部完成、helper 已接手；pid1-exit
  模式 = 记录已写齐、进程即将优雅退出。此后的 helper 失败（如 health-timeout）只能靠
  页面轮询超时暴露，与 power-button 一致

## [0.7.0] - 2026-10-14

### Fixed
- **等服务挤占候选预算（多候选时首个候选必然等待超时）**：`sessionController` 按依赖序
  晚于 `agents` 激活，0.5.2 把等待放进每个候选的预算切片后，候选一多每份切片就被摊薄
  ——实测 4 候选 × 30s 总预算 = 每候选 7.5s，而该次启动服务实际 ~13s 才就绪，首个候选
  必然以 `sessionController service not ready within 7487ms` 失败。现把"等服务"拆出
  独立总预算：`restoreCandidates()` 进入候选循环前用新配置 `serviceWaitTimeoutMs`
  （默认 `30000`，与 `restoreTimeoutMs` 相互独立）一次性全局轮询等待（间隔仍为
  `SERVICE_POLL_MS` 500ms），结果与耗时记入 `wake.log`（就绪记
  `sessionController ready after <N>ms`）。就绪后候选阶段不再等服务：`resumeSession`
  的轮询退化为一次防御式即时检查（取不到即抛 `sessionController service unavailable`，
  不再等待），`resolveAgent` 仍用 `withTimeout` 按候选剩余预算封顶；`restoreTimeoutMs`
  语义收窄为"候选阶段总预算"，自服务就绪、进入候选循环前起算（等待已耗时间不占它）。
  等待超时（服务始终未就绪）不逐候选空转：`wake.log` 记一条
  `service-wait-timeout: sessionController not ready within <N>ms` 后直接回退
  `fallbackWake` 降级通知，保证通知必达。已 live 候选（`agents.get` 直接可得）的
  处理顺序不变；marker、`/state`、restarts 只读路由与 restarts.ndjson 记录结构均不变

## [0.6.0] - 2026-10-13

### Added
- **无用户提示词的会话不再被自动激活（恢复/回退投递守卫）**：新增 lib/session-scan.js，
  投递前扫描目标会话的记录文件（`<DSH_HOME>/sessions/<项目目录>/[session-]<id>/session.v4.jsonl[.zstd]`）
  判定是否有过真实人工输入；`restoreCandidates()` 在逐个尝试候选前（先于 agents.get /
  resumeSession）、`fallbackWake()` 在拿到回退目标后（立即与轮询两条路径）都先过该守卫，
  不通过就跳过投递并记日志（wake.log `ok:false` + 重启日志 `result: 'skipped-no-human-prompt'`，
  后者经 classifyHumanPromptGuard 输出 stable union），继续处理后续候选/结束本轮回退。
  判定口径（实测）：记录为 JSONL，真实人工输入 = 存在某行 `type === 'user/message'` 且消息
  对象 `source.kind === 'user'`（消息对象通常直接在 `data` 上，少数嵌在 `data.message` 下，
  两种形状都兼容）；插件/规则注入消息的 kind（`dsh-resume-on-restart`、`dsh-rules-auto`、
  `runtime-context`、`time-context` 等）不算人工输入；`source` 缺失一律视为非人工。
  fail-closed：文件缺失（`session-file-missing`）、运行环境 zlib 无 zstd 能力（node < 23.8，
  `zstd-unsupported`）、解压/读取异常（`scan-error`）一律按"判定不了"拦截。新增配置
  `requireHumanPrompt`（默认 `true`），设为 `false` 关闭守卫 = 完全旧行为
- **多帧拼接的 zstd 会话记录解压**：实测 `session.v4.jsonl.zstd` 不是单个 zstd 流，而是每批
  追加的记录各自压缩成一帧后顺序拼接；对整文件一次 `zstdDecompressSync` 只解出第一帧
  （通常只有 `session` 头），真实会话会被整体误判成 none、守卫会把几乎所有会话都拦掉。
  解压改为按 zstd 帧魔法号切片逐帧解后拼接（个别帧解不出则合并/跳过，尽力而为——少读
  记录只往拦截方向错），并在 680+ 真实会话上验证：无真实输入的空会话判 none、有真实
  用户提示词的会话判 human

### Fixed
- **空会话被 fallback 唤醒后自主干活（0.5.x 事故）**：重启后恢复候选 `8fc70d1a`（子代理
  会话）恢复失败，回退路径 fallbackWake 取 `scope.agents.roots()[0]`，拿到一个从未有过
  任何用户输入的空会话 `session-78b03158`，把"检测到 DSH 服务已重启……请自主决定下一步"
  的通知灌进去，导致模型无人指示自主跑了一轮真实工作。现两条投递路径都要求目标会话
  有过真实人工输入（见上），没有或判定不了就跳过，该空会话在真实数据上验证为被正确拦截

### Tests
- 新增 lib/session-scan.test.js（`node --test`，无 e2e）：`isHumanPromptRecord`
  （kind=user 真、各注入 kind 与缺失 source 假、畸形输入假）、`hasHumanPromptInText`
  （坏行混入、命中即真、空/非字符串假）、`findSessionRecordFile`（mkdtemp 临时目录树下
  主会话/子代理目录命中、找不到 null、非法 id null）、`scanSessionHasHumanPrompt`
  （真实 `zlib.zstdCompressSync` 压缩 → human/none、多帧拼接形状、无压缩 jsonl、
  文件缺失 → session-file-missing、损坏 zstd → scan-error；环境无 zstd 能力时该组
  用例自动 skip）；lib/detect.test.js 追加 `classifyHumanPromptGuard` 四分支用例

## [0.5.2] - 2026-10-13

### Fixed
- **重启后恢复候选全部失败（立即失败，30s 预算从未被消耗）**：`sessionController`
  服务静态依赖 `agents` 等 11 个服务（`dsh-api-session-controller` 内 `static inject`），
  按 cordis 依赖序必然晚于 `agents` 激活；而恢复流程原先在 `ctx.inject(['agents'])`
  回调里立即经 `ctx.reflect.get('sessionController')` 非阻塞探测，拿不到即抛
  `sessionController service unavailable`——开机后百毫秒内所有候选逐个立即失败，
  只能走降级通知。现改为在候选的预算切片内每 500ms（`SERVICE_POLL_MS`）轮询等待
  服务就绪，就绪即恢复；切片耗尽才判该候选失败，error 文案区分「等待服务超时」
  （`sessionController service not ready within <N>ms`），后续候选仍按原预算平摊
  （每候选最低 5s、总预算 `restoreTimeoutMs` 封顶），全部失败仍走既有
  `fallbackWake` 降级。已 live 候选（`agents.get` 直接可得）不经过等待，照旧直接
  投递；marker、`/state`、restarts 只读路由与 wake.log / restarts.ndjson 记录结构
  均不变。 cordis 仅在提供方 fiber 启动时注册服务，无法低成本预判某环境「永不提供」
  该服务，故未加跳过等待的特判，等待总量由既有预算兜底

## [0.5.1] - 2026-10-12

### Fixed
- 设置弹窗「重启日志」对 `GET /api/dsh-resume-on-restart/restarts` 404（插件更新后
  DSH 未重启、宿主 half 尚无该路由的混合版本窗口）按空日志展示「暂无重启记录」，
  不再显示「重启日志加载失败」；日志文件不存在时宿主本就返回空数组，客户端不再
  出现报错态。401/403/5xx/网络错误等其余失败仍按「加载失败」报错，真实故障不吞

## [0.5.0] - 2026-10-12

### Added
- **重启日志 `restarts.ndjson`**（宿主 half）：`<stateDir>/restarts.ndjson`（默认
  `~/.dsh/.resume-on-restart/restarts.ndjson`），追加写、一行一条 JSON、上限 200 条
  （超出丢最旧，重写时顺带剔除损坏行）、单行损坏跳过不丢整份日志。开机
  `detectRestart === true` 时先写一条 `boot` 记录（`at`/`prevBootAt`/`downtimeMs`/
  `pid`/`prevPid`/`startAt`/`prevStartAt`/`detectBasis`/`reason`/`shutdown`/`origin`/
  `runningSessions`），恢复流程每结算一个候选再写一条 `restore` 记录
  （`{ type, bootAt, id, result: resumed|failed|excluded|skipped-budget, error, at }`）；
  `wake.log` 保留不动。设置弹窗经只读路由按 boot 分组倒序展示
- **停机归因**：SIGTERM/SIGINT 兜底 flush 时同步写 `<stateDir>/pending-shutdown.json`
  （`{ signal, at }`，marker 的 `when` 字段保留作旧版兼容）；下次开机读取归因后
  立即删除（存根只消费一次，避免遗留存根把后续 crash 误归因为 signal）。读不到
  且旧 marker 无 `when` = 崩溃 / 强杀 / 容器重启。原因标签：
  `power-button`（有 origin）/ `signal`（有 pending-shutdown 或 marker.when、无 origin）/
  `crash`（两者皆无）/ `unknown`（形状异常兜底），写入 boot 记录的 `reason` 字段
- **origin 匹配**：开机扫描 `~/.dsh/power-restart/*.status.json`（单文件损坏只丢该
  文件），取 `committedAt` 落在 [上次启动, 本次启动] 闭区间的最近一条作为本次重启
  发起方，整形为 `{ source: 'power-button', restartId, kind, sessionId, requestedAt }`
  写入 boot 记录；没有命中 → `origin: null`（原因归 shutdown 侧）
- **全量恢复（解「重启后只有打开的那个界面才回复对话」）**：`restoreMax` 默认改为
  `0` = 不限——遍历全部 `running !== false` 候选（仍尊重用户排除名单与
  `ignoredSessionPrefixes`）；正整数语义不变（按活跃时间新 → 旧取前 N 个）。
  `restoreTimeoutMs`（默认 30s）总预算按候选数平摊、每候选最低 5s；超出预算的
  候选不再静默丢弃，逐个记 `skipped-budget`；失败继续下一个候选的行为不变
- **只读路由 `GET /api/dsh-resume-on-restart/restarts`**：返回
  `{ ok, entries, max }`（entries 为 restarts.ndjson 全部条目，时间正序，客户端自行
  倒序展示）。沿用现有围栏模式：宿主 `connection.requestRejection` 优先，
  回退自带最小浏览器信任围栏（只读 GET，同 /state 的规则）
- **设置弹窗「重启日志」section**（客户端 half，slot `settings.section`，写法照抄
  dsh-prompt-history）：倒序列表，每条显示 启动时间、原因标签徽标、来源
  （origin.kind + sessionId 截断）、停机时长、恢复成功 x/y；点击展开该条 boot 详情
  （上次启动 / pid 变化 / 判定依据 / 停机归因 / origin / 恢复候选列表）与逐会话
  restore 明细（结果徽标 + 截断会话 id + 错误）。文案走宿主 locale 服务
  （`dsh-resume-on-restart` 命名空间，zh/en 字典、zh 为权威，未命中回退内置 zh），
  样式自带（一次注入 `<style>`，全部走 DSH 设计 token，明暗自适应）；
  挂载拉取一次 + 手动刷新，失败显示错误文案并 console.warn。客户端 bundle 属
  profile 产物，需下次 DSH 重启重建后才在浏览器生效

### Changed
- `restoreMax` 默认值 `1` → `0`（不限），`cordis.patch.yml` 内置配置同步改为 `0`
- 宿主 `deliver()` 返回值从 boolean 改为 `{ ok, error }`（stable union），供恢复流程
  把投递失败原因同时写入 wake.log 与重启日志

### Tests
- `lib/detect.test.js` 新增 18 例（合计 60）：`detectBasisOf`、`normalizeRestoreMax`
  （0=不限与 pickRestoreTargets 的衔接）、`attributeShutdown`（pending-shutdown 有效 /
  回退 marker.when / 都无 = crash）、`shutdownReasonOf` 四标签、`pickOriginRecord`
  时间窗匹配（窗口内取最近、窗外排除、闭区间边界、损坏记录跳过、非法输入）、
  `parseNdjson` / `serializeNdjson` / `capNdjsonEntries` / `compactNdjson`
  （损坏行跳过、超出丢最旧、互逆）

## [0.4.0] - 2026-10-12

### Added
- **web 会话顶栏开关**（客户端 half `lib/client.js`，手写 bundle、仅依赖 baseline 的 react，
  无构建链）：在会话顶栏「标准模式」标签同一个父容器（slot `conversation.session.header.actions`）
  注册兄弟条目 `resume-on-restart`（order 10，同排同款设计 token）。正常态「重启时恢复会话」，
  悬停「取消→重启时恢复会话」；点击把当前会话标记为「重启后不自动恢复」，条目变灰、
  文案「已取消恢复」，悬停「恢复→重启时恢复会话」；再点取消标记。条目仅对恢复候选会话渲染
  （见下方「恢复候选按停止时仍运行中过滤」等本轮补充条目）。
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
- **恢复候选按「停止时仍运行中」过滤**（本轮补充，恢复与开关显示同一口径）：判定口径 =
  DSH 停止那一刻该会话 status 为 `running`（干活中被打断）。`pickRestoreTargets` 只把
  `running !== false` 的 `recentSessions` 条目当候选（缺失按 true，兼容旧 marker，旧恢复行为
  不变；legacy `lastSessionId` 回退路径同样视为候选）；`recentSessions` 全部 `running: false`
  （正常结束）时不恢复，也不会经旧字段回退混回候选
- **marker `recentSessions` 条目新增 `running` 字段**（本轮补充）：由 `agent/status` 事件
  （payload `{ agent, status }`）写入——`'running'` → true、`'idle'` → false；其余活动事件
  不带 status，沿用同 id 条目已有值；新条目缺省 false，序列化时缺失写 false。启动播种自旧
  marker 的候选条目回填 `running: true`（它们正是上次停止时仍运行中的会话），避免
  「本进程 GET 显示候选、下次重启却不恢复」的口径分裂
- **`GET /state` 响应新增 `restoreCandidates`**（本轮补充）：`{ [id]: true }`，取自宿主内存
  `recentSessions` 经新纯函数 `collectRestoreCandidateIds`（lib/detect.js）的实时视图，
  不看排除集合——被排除但仍是候选的会话仍显示灰色开关
- **顶栏开关显示门控与刷新时机**（本轮补充）：客户端只在当前会话命中 `restoreCandidates`
  时渲染条目，正常结束的会话返回 null（字段缺失/响应异常/请求失败都按不显示）；
  查询时机为挂载/切换会话时、`window` `focus` 时、每 15 秒轮询一次（页面隐藏时跳过该轮，
  cancelled 标志防串态）；悬停文案、POST 标记/取消、失败回滚、防重复点击均不变

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
