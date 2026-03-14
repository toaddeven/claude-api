/**
 * Claude Code CLI Subprocess Manager
 *
 * Spawns a `claude` process per request and parses its JSON streaming output.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
  type ClaudeCliMessage,
  type ClaudeCliAssistant,
  type ClaudeCliResult,
  type ClaudeCliStreamEvent,
} from "../types/claude-cli.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export interface SubprocessOptions {
  model: string;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
}

// Typed event map
export interface ClaudeSubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  content_delta: (msg: ClaudeCliStreamEvent) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (msg: ClaudeCliResult) => void;
  raw: (line: string) => void;
  error: (err: Error) => void;
  close: (code: number | null) => void;
}

export class ClaudeSubprocess extends EventEmitter {
  private proc: ReturnType<typeof spawn> | null = null;
  private buffer = "";
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private killed = false;

  /**
   * Start the Claude CLI subprocess with the given prompt.
   * Resolves immediately once the process is spawned (streaming happens via events).
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(prompt, options);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn("claude", args, {
          cwd: options.cwd ?? process.cwd(),
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.timeoutHandle = setTimeout(() => {
          if (!this.killed) {
            this.killed = true;
            this.proc?.kill("SIGTERM");
            this.emit("error", new Error(`Request timed out after ${timeout}ms`));
          }
        }, timeout);

        this.proc.on("error", (err: NodeJS.ErrnoException) => {
          this.clearTimer();
          if (err.code === "ENOENT") {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
              ),
            );
          } else {
            reject(err);
          }
        });

        // Close stdin — prompt is passed as a CLI argument
        this.proc.stdin?.end();

        console.error(`[Subprocess] PID: ${this.proc.pid}`);

        this.proc.stdout?.on("data", (chunk: Buffer) => {
          this.buffer += chunk.toString();
          this.processBuffer();
        });

        this.proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) console.error("[Subprocess stderr]:", text.slice(0, 200));
        });

        this.proc.on("close", (code) => {
          console.error(`[Subprocess] Exited with code: ${code}`);
          this.clearTimer();
          if (this.buffer.trim()) this.processBuffer();
          this.emit("close", code);
        });

        resolve();
      } catch (err) {
        this.clearTimer();
        reject(err);
      }
    });
  }

  private buildArgs(prompt: string, options: SubprocessOptions): string[] {
    const args = [
      "--print",                        // Non-interactive mode
      "--output-format", "stream-json", // Newline-delimited JSON output
      "--verbose",                      // Required for stream-json
      "--include-partial-messages",     // Emit content_block_delta events
      "--model", options.model,
    ];

    if (options.sessionId) {
      // Session mode: attach to a named session for context reuse
      args.push("--session-id", options.sessionId);
    } else {
      // Stateless mode: no session persistence
      args.push("--no-session-persistence");
    }

    args.push(prompt);

    return args;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // Keep the last (potentially incomplete) line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as ClaudeCliMessage;
        this.emit("message", msg);

        if (isContentDelta(msg)) {
          this.emit("content_delta", msg);
        } else if (isAssistantMessage(msg)) {
          this.emit("assistant", msg);
        } else if (isResultMessage(msg)) {
          this.emit("result", msg);
        }
      } catch {
        this.emit("raw", trimmed);
      }
    }
  }

  private clearTimer(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.killed && this.proc) {
      this.killed = true;
      this.clearTimer();
      this.proc.kill(signal);
    }
  }

  isRunning(): boolean {
    return this.proc !== null && !this.killed && this.proc.exitCode === null;
  }
}

/**
 * Verify that the Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error: "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({ ok: false, error: "Claude CLI returned non-zero exit code" });
      }
    });
  });
}

/**
 * Verify that the Claude CLI is authenticated.
 *
 * Credentials are stored in the OS keychain by `claude auth login` and
 * used automatically by the CLI. We can't inspect the keychain directly,
 * so we trust the CLI is configured if it exists; auth errors surface on
 * the first real API call.
 */
export async function verifyAuth(): Promise<{ ok: true } | { ok: false; error: string }> {
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Session Registry — tracks active sessions for intelligent reuse
// ---------------------------------------------------------------------------

interface SessionInfo {
  createdAt: Date;
  lastUsedAt: Date;
  requestCount: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

class SessionRegistry {
  private sessions = new Map<string, SessionInfo>();

  /** Register a new session (no-op if already exists). */
  register(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      const now = new Date();
      this.sessions.set(sessionId, {
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1,
      });
    }
  }

  /** Update lastUsedAt and increment requestCount for an existing session. */
  touch(sessionId: string): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.lastUsedAt = new Date();
      info.requestCount += 1;
    } else {
      // Session not yet registered — register it now
      this.register(sessionId);
    }
  }

  /**
   * Remove sessions that have been idle for more than 30 minutes.
   * Returns the number of sessions removed.
   */
  cleanup(): number {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let removed = 0;
    for (const [id, info] of this.sessions) {
      if (info.lastUsedAt.getTime() < cutoff) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.error(`[SessionRegistry] Cleaned up ${removed} idle session(s).`);
    }
    return removed;
  }

  /** Return a snapshot of current session stats. */
  getStats(): { activeSessions: number; sessions: Array<{ id: string } & SessionInfo> } {
    const sessions = Array.from(this.sessions.entries()).map(([id, info]) => ({
      id,
      ...info,
    }));
    return { activeSessions: sessions.length, sessions };
  }
}

// Singleton instance
let _registry: SessionRegistry | null = null;

/**
 * Returns the shared SessionRegistry singleton.
 * On first call, also starts a background cleanup timer (every 5 minutes).
 */
export function getSessionRegistry(): SessionRegistry {
  if (!_registry) {
    _registry = new SessionRegistry();

    // Periodic cleanup — unref() so the timer does not keep the process alive
    const timer = setInterval(() => {
      _registry?.cleanup();
    }, 5 * 60 * 1000); // every 5 minutes
    timer.unref();
  }
  return _registry;
}
