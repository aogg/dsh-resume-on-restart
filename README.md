# dsh-resume-on-restart

DSH 插件：检测 DSH 服务重启后，自动向主 agent 投递一条**信息性消息**（含中断时长、上次活跃会话等状态摘要），让 agent **自主决定**是否继续之前的工作或启动新任务。

解决"DSH 重启后会话中断、工作丢失"的问题——重启后 agent 收到提示，可自行恢复。

## 特性

- 🔄 **重启检测**：通过 marker 文件（记录上次 pid / 启动时间）判断是否发生重启
- 💬 **信息性消息**：重启后投递"检测到重启 + 中断时长 + 上次活跃会话"摘要，由 agent 自主决定下一步（而非命令式强制"继续"）
- 🎯 **活动追踪**：运行期间通过 cordis 事件（`agent/session-start`、`agent/pre-step`）追踪最近活跃会话，供重启后参考
- ✅ **兼容 DSH Desktop**：只依赖 cordis ctx 的 `agents` 服务，不 import 任何 `@deepseek-ai/dsh-*` 内部包，可在 DSH Desktop 打包环境（app.asar）运行

## 安装

```powershell
# 用 dsh CLI 装到桌面 profile（DSH Desktop 默认用 desktop）
dsh plugin --profile desktop add <本目录路径>
# 重启 DSH Desktop 生效
```

## 运行逻辑

每次 DSH 启动时：

1. 读取 marker 文件（`~/.dsh/.resume-on-restart/marker.json`），记录上次的 `pid` / `lastBootAt`
2. 判断是否重启：当前进程 `pid` ≠ marker 的 `pid` → 判定发生重启
3. 写入新的 marker（更新为当前 pid / 时间）
4. 若判定为重启，轮询等待主 agent 出现（最长 20 秒），投递信息性消息：
   ```
   [resume-on-restart] 检测到 DSH 服务已重启。
   上次运行于 ...，本次于 ... 重启完成。
   中断约 X 秒。
   重启前最近活跃的会话：<session-id>
   如需继续之前的工作，或启动新任务，请自主决定下一步。
   ```

运行期间通过 `agent/session-start` 和 `agent/pre-step` 事件持续记录最近活跃会话，下次重启时消息会包含它。

## 配置（cordis.patch.yml）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件开关 |
| `stateDir` | `.resume-on-restart` | marker/状态文件存放目录（相对 DSH_HOME） |
| `target` | `primary` | 唤醒目标（`primary`=主 agent，或指定会话 id） |
| `wakeup` | `true` | 是否真正唤醒（`false` 则只注入不唤醒） |
| `notice` | `''` | 附加到消息末尾的自定义提示 |
| `shutdownGraceMs` | `600000` | 关闭前"活跃即视为任务相关"的宽限窗口 |
| `ignoredSessionPrefixes` | `['head-']` | 不追踪的会话 id 前缀（如多代理团队的根会话） |

## License

MIT
