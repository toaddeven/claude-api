# llm_api_from_cli

将 LLM CLI 工具包装成 OpenAI 兼容的本地 HTTP API。

A local HTTP server that wraps an LLM CLI tool and exposes an OpenAI-compatible API.

---

## 简介 / Introduction

**中文**

如果你订阅了某个 LLM 服务（如 Max 订阅套餐），可以通过本项目将其 CLI 工具的本地能力暴露为标准 OpenAI 格式的 HTTP API，供 Continue.dev、Cursor、各类 AI 客户端等工具直接接入，无需单独购买 API 额度。

**English**

If you have an LLM service subscription (e.g. a Max-tier plan), this project wraps the CLI tool into a local OpenAI-compatible HTTP API. Any tool that supports the OpenAI API format — Continue.dev, Cursor, custom scripts — can use it without purchasing separate API credits.

---

## 架构 / Architecture

```
External Client (OpenAI format)
        │
        │ HTTP POST /v1/chat/completions
        ▼
  Express Server (localhost:3456)
        │
        │ openai-to-cli adapter
        ▼
  LLM CLI Subprocess
  spawn("llm-cli --print --output-format stream-json ...")
        │
        │ OAuth Token (macOS Keychain)
        ▼
  LLM API
        │
        │ JSON stream → cli-to-openai adapter
        ▼
  SSE / JSON response → External Client
```

---

## 前置条件 / Prerequisites

- 已安装并登录对应的 LLM CLI 工具 / LLM CLI tool installed and authenticated
- Node.js 18+

---

## 快速上手 / Quick Start

```bash
git clone https://github.com/toaddeven/llm_api_from_cli.git
cd llm_api_from_cli
npm install
npm run build
npm start          # 默认端口 3456 / default port 3456
npm start 8080     # 自定义端口 / custom port
```

### 测试 / Test

```bash
# 非流式 / Non-streaming
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello"}]}'

# 流式 / Streaming
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"opus","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

---

## API 端点 / Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/v1/models` | List available models |
| POST | `/v1/chat/completions` | Chat completions (supports `stream: true`) |

### 支持的模型 / Supported Models

| 请求模型名 / Request Model | 实际调用 / Actual Model |
|---------------------------|------------------------|
| `opus` | opus |
| `sonnet` | sonnet |
| `haiku` | haiku |

---

## 接入示例 / Integration Examples

### Continue.dev

```json
{
  "models": [{
    "title": "LLM (Max)",
    "provider": "openai",
    "model": "opus",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Python openai SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3456/v1", api_key="x")
resp = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Hello"}]
)
print(resp.choices[0].message.content)
```

---

## 构建命令 / Build Commands

```bash
npm run build   # 编译 TypeScript → dist/ / Compile TypeScript → dist/
npm run dev     # Watch 模式 / Watch mode
npm run clean   # 删除 dist/ / Delete dist/
```

---

## 依赖 / Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `uuid` | Request/session ID generation |
| `typescript` | Compilation (devDependency) |

The only runtime external dependency is the LLM CLI tool in your system PATH.

---

## License

MIT
