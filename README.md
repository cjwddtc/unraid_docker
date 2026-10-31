# Debian desktop image

镜像：`docker.io/cjwddtc/debian_vnc:latest`。沿用原桌面、媒体工具和版本监测流程，main 提交触发 GitHub Actions 构建发布。

## Pi / Codex 语音运行环境

镜像预装已验证版本：Node 24.22.2、Pi 1.4.0、Codex CLI 0.166.0、pi-live-codex 0.1.10、pi-subagents 0.83.1、numpy 2.4.6、sherpa-onnx 2.0.1，以及 PulseAudio/ALSA、SSH、ping、ripgrep 和 Firefox ESR。npm 使用从已验证环境导出的 package-lock.json，以 `npm ci` 安装；Node 发行包验证官方 SHA256。

- `/opt/pi-image`：镜像内运行环境；与旧持久挂载 `/opt/pi-voice-runtime` 分开，避免旧挂载遮住新版本。
- `/usr/local/share/pi-voice`：当前 WebSocket Live、本地唤醒/VAD、共享 Codex MCP 和通知桥的代码及配置样例。OpenAI/Qwen 和原 Gemini 入口均保留。
- `/usr/local/share/pi-runtime`：安装脚本、依赖锁和构建检查。构建检查不连接云端、不采集或播放音频。

通用镜像不自动启动 Pi/Codex，不改变默认用户、工作目录或 `/root/startup.sh` 入口，也不预装旧 ChatGPT 桌面应用。现有其他容器可以继续使用原启动脚本。

### 已有 chatgpt 部署

运行数据保持原有挂载：

| 宿主目录 | 容器目录 | 用途 |
| --- | --- | --- |
| `/mnt/user/appdata/chatgpt` | `/root` | 桌面和 supervisor 配置 |
| `/mnt/user/appdata/chatgpt/pi-voice/data` | `/data` | 认证、密钥、聊天、模型和运行配置 |
| `/mnt/user/fast/home_control` | 同路径 | Pi/Codex 共同项目 |

容器仍需 `/dev/snd`、字符设备 `c 116:* rwm` 和音频组17；独立IP/SSH及supervisor沿用现有Unraid模板。更新镜像不会代替配置这些设备和挂载。

更新前，将本仓库 `pi-voice/chatgpt-prepare-runtime.sh` 同步到持久的 `/root/pi-voice/chatgpt-prepare-runtime.sh`。此脚本发现 `/opt/pi-image` 时使用镜像环境，旧镜像则回退到 `/opt/pi-voice-runtime`；原 `/root/startup.sh` 已在 supervisor 前调用它。它创建运行账号并恢复 CLI 链接，不覆盖现有会话或凭据。

`/data` 中的业务脚本仍为运行副本，镜像代码不会静默覆盖它们。需要升级业务代码时，在停止 supervisor 的 `pi-voice` 后，将本仓库对应公开脚本同步到 `/data`，将 `skills/codex-control/SKILL.md` 放入 `/data/.pi/agent/skills/codex-control/`，再启动该程序；保留认证、settings、运行状态、SSH和模型目录。不要用整个目录覆盖现有 `/data`。`chatgpt-sshd_config` 对应持久 `/root/pi-voice/sshd_config`。

唤醒/VAD模型留在 `/data/models`，API Key、OAuth、SSH私钥、主机身份和用户数据不进入镜像或仓库。Pi和Codex以UID1000、HOME=/data运行，项目目录为 `/mnt/user/fast/home_control`，共用官方Codex managed daemon。桌面入口 `http://192.168.2.15:6080/vnc.html`，SSH别名 `chatgpt-unraid`。

Pi/语音依赖本次固定为已验证版本，未加入媒体软件的自动版本更新脚本；后续升级应更新 npm 锁文件并通过构建检查及语音联调。Firefox随Debian包安装，不单独监测最新版本。
