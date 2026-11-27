# Debian desktop image

镜像为 `docker.io/cjwddtc/debian_vnc:latest`。提交到 `main` 会触发 GitHub Actions 构建发布。定时任务每 12 小时检查 qBittorrent、tinyMediaManager、网盘客户端和输入法词库的版本。

## 应用依赖

- `tv_auto_web` 使用镜像内的 Python OpenAI SDK（`openai>=3.49.0`）、`pydantic-ai-slim[openai]==2.68.0` 和 `PyYAML>=6.0`。构建时验证关键导入、Responses 接口和 YAML 解析。
- `pt_index` 的 API 使用 FastAPI、Pydantic 和 Uvicorn。FastAPI 会安装 Pydantic，站点同步脚本使用 Python 标准库。
- Codex CLI 由需要使用它的容器在持久化 home 目录内独立维护。
