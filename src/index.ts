/**
 * Public API exports
 */

export { startServer, stopServer, getServer } from "./server/index.js";
export { ClaudeSubprocess, verifyClaude, verifyAuth } from "./subprocess/manager.js";
export { sessionManager } from "./session/manager.js";
export { openaiToCli, messagesToPrompt, extractModel } from "./adapter/openai-to-cli.js";
export { cliResultToOpenai, cliToOpenaiChunk, createDoneChunk, extractTextContent } from "./adapter/cli-to-openai.js";

export type * from "./types/openai.js";
export type * from "./types/claude-cli.js";
