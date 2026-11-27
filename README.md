# Debian desktop image

镜像为 `docker.io/cjwddtc/debian_vnc:latest`。提交到 `main` 会触发 GitHub Actions 构建发布。定时任务每 12 小时检查 Codex CLI、qBittorrent、tinyMediaManager、网盘客户端和输入法词库的版本。

## 应用依赖

- `tv_auto_web` 使用镜像内的 Python OpenAI SDK（`openai>=3.49.0`）、`pydantic-ai-slim[openai]==2.68.0` 和 `PyYAML>=6.0`。构建时验证关键导入、Responses 接口和 YAML 解析。
- `pt_index` 的 API 使用 FastAPI、Pydantic 和 Uvicorn。FastAPI 会安装 Pydantic，站点同步脚本使用 Python 标准库。
- 镜像安装 `codex.version` 记录的 Codex CLI 版本。npm 稳定版更新时，定时任务会更新版本文件并重建同一个 `latest`。Unraid 容器更新镜像后即可使用新版 CLI，登录和会话数据保存在挂载的 home 目录。
