/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints backed by the Claude Code CLI.
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk } from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliStreamEvent, ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import { getCache, generateCacheKey, shouldCache } from "./cache.js";

// -------------------------------------------------------------------------
// POST /v1/chat/completions
// -------------------------------------------------------------------------

export async function handleChatCompletions(req: Request, res: Response): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    const cliInput = openaiToCli(body);

    // Cache check for non-streaming deterministic requests (temperature=0)
    if (!stream && shouldCache(body)) {
      const cache = getCache();
      const cacheKey = generateCacheKey(body);
      const cached = cache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }
      const subprocess = new ClaudeSubprocess();
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId, (result) => {
        cache.set(cacheKey, result);
      });
    } else {
      const subprocess = new ClaudeSubprocess();
      if (stream) {
        await handleStreamingResponse(res, subprocess, cliInput, requestId);
      } else {
        await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);
    if (!res.headersSent) {
      res.status(500).json({
        error: { message, type: "server_error", code: null },
      });
    }
  }
}

// -------------------------------------------------------------------------
// Streaming (SSE) handler
// -------------------------------------------------------------------------

async function handleStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  // Flush headers immediately so the client knows the SSE stream has started
  res.flushHeaders();
  res.write(":ok\n\n");

  return new Promise((resolve) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;

    // Detect client disconnect via the *response* close event (not request)
    res.on("close", () => {
      if (!isComplete) subprocess.kill();
      resolve();
    });

    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text ?? "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [
            {
              index: 0,
              delta: {
                role: isFirst ? ("assistant" as const) : undefined,
                content: text,
              },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    });

    subprocess.on("assistant", (msg: ClaudeCliAssistant) => {
      lastModel = msg.message.model;
    });

    subprocess.on("result", (_result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(createDoneChunk(requestId, lastModel))}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: error.message, type: "server_error", code: null } })}\n\n`,
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          res.write(
            `data: ${JSON.stringify({ error: { message: `Process exited with code ${code}`, type: "server_error", code: null } })}\n\n`,
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((err: Error) => {
      console.error("[Streaming] Subprocess start error:", err);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: null } })}\n\n`,
        );
        res.end();
      }
      resolve();
    });
  });
}

// -------------------------------------------------------------------------
// Non-streaming handler
// -------------------------------------------------------------------------

async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  onResult?: (result: object) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let textBuffer = "";
    let lastModel = "claude-sonnet-4";
    let inputTokens = 0;
    let outputTokens = 0;
    let hasResult = false;

    // Accumulate streamed content deltas — gives us the real model output
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text ?? "";
      if (text) textBuffer += text;
    });

    // Capture actual model name from the assistant turn
    subprocess.on("assistant", (msg: ClaudeCliAssistant) => {
      lastModel = msg.message.model;
    });

    // Capture token usage + model fallback from the result event
    subprocess.on("result", (result: ClaudeCliResult) => {
      hasResult = true;
      inputTokens = result.usage?.input_tokens ?? 0;
      outputTokens = result.usage?.output_tokens ?? 0;
      if (lastModel === "claude-sonnet-4" && result.modelUsage) {
        const firstKey = Object.keys(result.modelUsage)[0];
        if (firstKey) lastModel = firstKey;
      }
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: error.message, type: "server_error", code: null },
        });
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (hasResult || textBuffer.length > 0) {
        const normalizeModel = (m: string): string => {
          if (m.includes("opus")) return "claude-opus-4";
          if (m.includes("sonnet")) return "claude-sonnet-4";
          if (m.includes("haiku")) return "claude-haiku-4";
          return m;
        };
        const responseBody = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: normalizeModel(lastModel),
          choices: [{
            index: 0,
            message: { role: "assistant" as const, content: textBuffer },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        };
        onResult?.(responseBody);
        res.json(responseBody);
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((error: Error) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: error.message, type: "server_error", code: null },
        });
      }
      resolve();
    });
  });
}

// -------------------------------------------------------------------------
// GET /v1/models
// -------------------------------------------------------------------------

export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [
      { id: "claude-opus-4",   object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
      { id: "claude-sonnet-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
      { id: "claude-haiku-4",  object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
    ],
  });
}

// -------------------------------------------------------------------------
// GET /health
// -------------------------------------------------------------------------

export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-api",
    timestamp: new Date().toISOString(),
  });
}
