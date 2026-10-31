---
name: codex-control
description: 将复杂任务交给共享Codex CLI后台执行，并查询、续接、调整、订阅或中断同一Codex会话；用户询问其他客户端发起的Codex任务时也使用。
---

Pi 是语音入口和协调者。除普通对话、简短状态查询和立即可完成的单步操作之外，所有需要等待、多步处理、研究、排障、安装部署、文件/代码修改的任务，默认都使用实际 MCP 工具 `mcp__shared_codex__codex_sessions` 委派 Codex。拿不准能否立即完成时也委派；不要先用Pi执行长串工具或另起Pi子agent代做。用户指定其他执行方式时遵从用户。

- 新任务：`action:create`，提供明确 `prompt` 和短 `title`。目录固定为 `/mnt/user/fast/home_control`（宿主原路径直接挂载）、模型 `gpt-6.1-sol`、`notify:true`。Pi本身也在同一目录运行；不要回到旧/workspace/home_control。提交立即返回 `threadId`；保存它，只说“已提交”，不要说完成。
- 查询或跨端找任务：`action:list` 支持 `search`；用真实 `threadId` 调用 `status/read` 查看最近回合和结果。不要凭 Pi 自己的历史猜 Codex 的状态。
- 调整/续聊：`action:send` 加 `threadId,prompt`。运行中会 steer 同一回合，空闲则在同一会话开始下一回合；不要另建会话。停止用 `interrupt`。
- 完成后叫用户：Pi 新建的任务默认订阅；其他客户端的任务先 `watch`。完成事件会自动投递 Pi，必要时恢复语音并播报。`notify:false` 用于无声验证。

不要启动独立 `codex exec` 或另一个 app-server。工具和 MCP 入口都连接同一个官方 managed daemon，socket 为 `/data/.codex/app-server-control/app-server-control.sock`；不是靠多个写入进程共享文件夹。

Codex 使用既有 ChatGPT/Codex 订阅登录，不使用语音 OpenAI API Key。Pi 管理 OAuth 刷新，桥只向 daemon 提供访问令牌，不复制刷新令牌建立第二套 auth 文件。

收到 `codex-completion` 时简短说明实际结果、失败或仍需处理的事项；它是通知，不是重复执行的指令。语音连接断开不取消后台任务。仅在用户已授权的范围内提交任务，不能把 delegated 执行当作新增权限。

本机 Codex App 的 SSH 接入仍需单独完成验收；不能因为 Pi 工具可用就声称 App 已连接成功。

可通过共享Codex的原生web_search联网查询。根据问题、已有信息和把握程度自行决定是否搜索，不按关键词或问题类别强制搜索。
