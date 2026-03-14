/**
 * Session Manager
 *
 * Maps client conversation IDs (via OpenAI's `user` field) to Claude CLI
 * session IDs so conversation context is preserved across requests.
 * Sessions are persisted to disk and expire after 24 hours.
 */

import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";

const SESSION_FILE = path.join(
  process.env.HOME ?? "/tmp",
  ".claude-api-sessions.json",
);

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionMapping {
  clientId: string;
  claudeSessionId: string;
  createdAt: number;
  lastUsedAt: number;
  model: string;
}

class SessionManager {
  private sessions = new Map<string, SessionMapping>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await fs.readFile(SESSION_FILE, "utf-8");
      const parsed = JSON.parse(data) as Record<string, SessionMapping>;
      this.sessions = new Map(Object.entries(parsed));
      console.log(`[SessionManager] Loaded ${this.sessions.size} sessions`);
    } catch {
      // File absent or corrupt — start fresh
      this.sessions = new Map();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const data = Object.fromEntries(this.sessions);
    await fs.writeFile(SESSION_FILE, JSON.stringify(data, null, 2));
  }

  /**
   * Return the existing Claude session ID for `clientId`, or create a new one.
   */
  getOrCreate(clientId: string, model = "sonnet"): string {
    const existing = this.sessions.get(clientId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.model = model;
      return existing.claudeSessionId;
    }

    const claudeSessionId = uuidv4();
    const mapping: SessionMapping = {
      clientId,
      claudeSessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      model,
    };
    this.sessions.set(clientId, mapping);
    console.log(`[SessionManager] New session: ${clientId} -> ${claudeSessionId}`);
    this.save().catch((err) => console.error("[SessionManager] Save error:", err));
    return claudeSessionId;
  }

  get(clientId: string): SessionMapping | undefined {
    return this.sessions.get(clientId);
  }

  delete(clientId: string): boolean {
    const deleted = this.sessions.delete(clientId);
    if (deleted) {
      this.save().catch((err) => console.error("[SessionManager] Save error:", err));
    }
    return deleted;
  }

  /** Remove sessions that haven't been used within SESSION_TTL_MS */
  cleanup(): number {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (session.lastUsedAt < cutoff) {
        this.sessions.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[SessionManager] Cleaned up ${removed} expired sessions`);
      this.save().catch((err) => console.error("[SessionManager] Save error:", err));
    }
    return removed;
  }

  getAll(): SessionMapping[] {
    return Array.from(this.sessions.values());
  }

  get size(): number {
    return this.sessions.size;
  }
}

export const sessionManager = new SessionManager();

// Load on module import
sessionManager.load().catch((err) =>
  console.error("[SessionManager] Load error:", err),
);

// Clean up expired sessions every hour
setInterval(() => sessionManager.cleanup(), 60 * 60 * 1000);
