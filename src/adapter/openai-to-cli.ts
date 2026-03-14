/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIChatMessage } from "../types/openai.js";

export interface CliInput {
  prompt: string;
  model: string;
  sessionId?: string;
}

const MODEL_MAP: Record<string, string> = {
  // Direct model names
  "claude-opus-4": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-haiku-4": "haiku",
  // Aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): string {
  if (MODEL_MAP[model]) return MODEL_MAP[model];

  // Strip provider prefix if present (e.g. "claude-api/claude-opus-4")
  const stripped = model.replace(/^[^/]+\//, "");
  if (MODEL_MAP[stripped]) return MODEL_MAP[stripped];

  // Default to opus
  return "opus";
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI.
 *
 * Claude CLI in --print mode expects a single prompt string.
 * We format multi-turn conversations into a readable format that preserves context.
 */
export function messagesToPrompt(messages: OpenAIChatMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        parts.push(`<system>\n${msg.content}\n</system>\n`);
        break;
      case "user":
        parts.push(msg.content);
        break;
      case "assistant":
        parts.push(`<previous_response>\n${msg.content}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
  };
}
