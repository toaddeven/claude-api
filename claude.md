# llm_api_from_cli 工程总结

## 项目定位

将 LLM Max 订阅（$200/月）包装成 OpenAI 兼容的本地 HTTP API，供 Continue.dev、各类 AI 客户端等任意支持 OpenAI 格式的工具使用，无需额外支付按量计费费用。

**实现原理**：LLM CLI 工具支持通过 OAuth Token 在本地调用模型能力。本项目以 CLI 子进程为桥梁，将其输出适配为标准 OpenAI 格式，对外暴露本地 HTTP API。

---

## 架构总览

```
外部客户端 (OpenAI 格式)
        │
        │ HTTP POST /v1/chat/completions
        ▼
  Express Server (localhost:3456)
        │
        │ openai-to-cli 适配
        ▼
  LLM CLI Subprocess
  spawn("llm-cli --print --output-format stream-json ...")
        │
        │ OAuth Token (macOS Keychain)
        ▼
  LLM API
        │
        │ JSON 流 → cli-to-openai 适配
        ▼
  SSE / JSON 响应 → 外部客户端
```

---

## 目录结构

```
src/
├── index.ts                  # 公共导出入口
├── types/
│   ├── claude-cli.ts         # CLI JSON 输出的类型定义（stream_event、assistant、result 等）
│   └── openai.ts             # OpenAI API 请求/响应类型定义
├── adapter/
│   ├── openai-to-cli.ts      # OpenAI messages[] → 单条 prompt 字符串 + 模型别名
│   └── cli-to-openai.ts      # CLI 输出 → OpenAI chat.completion / chunk 格式
├── subprocess/
│   └── manager.ts            # LLMSubprocess 类：spawn、超时、JSON 行解析、事件发射
├── session/
│   └── manager.ts            # 会话 ID 映射，持久化到 ~/.llm-api-sessions.json，24h TTL
└── server/
    ├── index.ts              # Express 应用创建、startServer / stopServer
    ├── routes.ts             # 路由处理：流式（SSE）+ 非流式，/v1/models，/health
    └── standalone.ts         # 可执行入口：检查 CLI、验证认证、启动服务器
```

---

## 核心模块详解

### 1. subprocess/manager.ts — 子进程管理

实际调用的 CLI 命令：

```bash
llm-cli \
  --print \                         # 非交互模式，执行完退出
  --output-format stream-json \     # 输出换行分隔的 JSON
  --verbose \                       # stream-json 必须配合 --verbose
  --include-partial-messages \      # 输出 content_block_delta 增量事件
  --model <opus|sonnet|haiku> \
  --no-session-persistence \
  "<prompt>"
```

CLI 的每行输出是一个 JSON 对象，类型字段区分：

| `type` 值 | 含义 |
|-----------|------|
| `system` (subtype: init) | 会话初始化信息 |
| `stream_event` (content_block_delta) | 流式增量文本 |
| `assistant` | 完整 assistant 消息 |
| `result` | 最终结果，含 token 用量和费用 |

`LLMSubprocess` 继承 `EventEmitter`，解析 buffer 后按类型发射对应事件（`content_delta` / `assistant` / `result`），路由层订阅这些事件组装响应。

**安全设计**：使用 `spawn()` 而非 `exec()`，prompt 作为参数数组元素传递，彻底防止 shell 注入。

### 2. adapter/openai-to-cli.ts — 请求适配

OpenAI 的多轮 `messages[]` 被格式化成单条字符串：

```
<system>
{system 消息内容}
</system>

<previous_response>
{上一轮 assistant 回复}
</previous_response>

{最新 user 消息}
```

模型映射表：`opus` → `opus`，`sonnet` → `sonnet`，`haiku` → `haiku`，未识别时默认 `opus`。

### 3. adapter/cli-to-openai.ts — 响应适配

- **流式**：每个 `content_block_delta` 事件的 `delta.text` 封装成 `chat.completion.chunk`，通过 SSE 发送，最后写 `data: [DONE]`
- **非流式**：等待 `result` 事件，将 `result.result`（纯文本）和 `usage` 封装成 `chat.completion` 对象

### 4. server/routes.ts — 路由层

流式响应的两个关键细节：
- 立即调用 `res.flushHeaders()` + 写入 `:ok\n\n`，防止客户端等待超时
- 监听 `res.on("close")` 而非 `req.on("close")` 来检测客户端断开（Express 中 req close 在请求体接收完成时就触发，不代表连接断开）

### 5. session/manager.ts — 会话管理

利用 OpenAI 请求中的 `user` 字段作为客户端会话标识，映射到 CLI 的 `--session-id`，使得同一客户端的多次请求可以保持对话上下文。会话数据序列化为 JSON 存储在 `~/.llm-api-sessions.json`，超过 24 小时未使用自动清理。

---

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/v1/models` | 返回可用模型列表 |
| POST | `/v1/chat/completions` | 聊天补全（支持 `stream: true`） |

---

## 快速上手

```bash
cd ~/work/llm_api_from_cli
npm install
npm run build
npm start          # 默认 3456 端口
npm start 8080     # 自定义端口

# 测试
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"你好"}]}'

# 流式测试
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"opus","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

---

## 构建命令

```bash
npm run build    # 编译 TypeScript → dist/
npm run dev      # watch 模式
npm run clean    # 删除 dist/
```

---

## 依赖

| 包 | 用途 |
|----|------|
| `express` | HTTP 服务器 |
| `uuid` | 生成请求 ID 和会话 ID |
| `typescript` | 编译（devDependency） |
| `@types/*` | 类型声明（devDependency） |

运行时唯一外部依赖是系统 PATH 中的 LLM CLI 工具。
