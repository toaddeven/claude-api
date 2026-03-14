/**
 * Claude CLI Subprocess Pool
 *
 * Maintains a bounded pool of concurrency slots to avoid spawning a new
 * ClaudeSubprocess for every request. When all slots are busy, incoming
 * requests are queued and dispatched as slots become free.
 *
 * This does NOT pre-spawn idle processes (the CLI requires a prompt at
 * startup), but it caps concurrency and eliminates the per-request
 * queueing overhead that would otherwise pile up unbounded.
 */

import { randomUUID } from "crypto";
import { ClaudeSubprocess, type SubprocessOptions } from "./manager.js";

// Re-export for convenience
export type { SubprocessOptions };

// ---- Types ------------------------------------------------------------------

export interface PoolSlot {
  id: string;
  subprocess: ClaudeSubprocess;
}

export interface PoolStats {
  total: number;
  busy: number;
  idle: number;
  queued: number;
}

interface QueueEntry {
  prompt: string;
  options: SubprocessOptions;
  resolve: (slot: PoolSlot) => void;
  reject: (err: Error) => void;
}

// ---- SubprocessPool ---------------------------------------------------------

export class SubprocessPool {
  private readonly size: number;

  /** Number of slots currently occupied by a live subprocess */
  private busyCount = 0;

  /** Pending callers waiting for a slot */
  private readonly queue: QueueEntry[] = [];

  /** Whether shutdown() has been called */
  private dead = false;

  /** All live subprocesses currently managed by the pool */
  private readonly active = new Map<string, ClaudeSubprocess>();

  constructor(size = 3) {
    if (size < 1) throw new RangeError("Pool size must be at least 1");
    this.size = size;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Acquire a pool slot and start a ClaudeSubprocess for the given prompt.
   *
   * - If a slot is immediately available the subprocess is spawned right away.
   * - If the pool is full the caller is queued and will be served in FIFO
   *   order as existing subprocesses finish and callers call `release()`.
   *
   * The returned `id` must be passed to `release()` when the caller is done
   * consuming the subprocess output.
   */
  acquire(prompt: string, options: SubprocessOptions): Promise<PoolSlot> {
    if (this.dead) {
      return Promise.reject(new Error("SubprocessPool has been shut down"));
    }

    if (this.busyCount < this.size) {
      // Slot available — spawn immediately
      return this.spawnSlot(prompt, options);
    }

    // Pool is full — queue the request
    return new Promise<PoolSlot>((resolve, reject) => {
      this.queue.push({ prompt, options, resolve, reject });
    });
  }

  /**
   * Release a slot back to the pool.
   *
   * The caller should invoke this after the subprocess has finished (i.e.
   * after the "close" event fires) or after an unrecoverable error. The pool
   * does not listen to subprocess events itself so that callers retain full
   * control of the stream.
   *
   * After releasing, the next queued request (if any) is dispatched.
   */
  release(id: string): void {
    const sub = this.active.get(id);
    if (!sub) {
      // Already removed (e.g. double-release) — ignore silently
      return;
    }

    // Kill if still alive (defensive cleanup)
    if (sub.isRunning()) {
      sub.kill("SIGTERM");
    }

    this.active.delete(id);
    this.busyCount = Math.max(0, this.busyCount - 1);

    // Serve next queued caller if the pool is not shut down
    if (!this.dead) {
      this.drainQueue();
    }
  }

  /** Return a snapshot of current pool utilisation. */
  getStats(): PoolStats {
    const busy = this.busyCount;
    return {
      total: this.size,
      busy,
      idle: this.size - busy,
      queued: this.queue.length,
    };
  }

  /**
   * Shut the pool down.
   *
   * - All active subprocesses are killed.
   * - All queued requests are rejected with a shutdown error.
   * - Subsequent calls to `acquire()` are rejected immediately.
   */
  shutdown(): void {
    if (this.dead) return;
    this.dead = true;

    // Kill every active subprocess
    for (const [id, sub] of this.active) {
      if (sub.isRunning()) {
        sub.kill("SIGTERM");
      }
      this.active.delete(id);
    }
    this.busyCount = 0;

    // Reject every queued caller
    const err = new Error("SubprocessPool has been shut down");
    let entry: QueueEntry | undefined;
    while ((entry = this.queue.shift()) !== undefined) {
      entry.reject(err);
    }
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Spawn a new ClaudeSubprocess, register it, and return the slot.
   * Assumes the caller has already verified that a slot is available.
   */
  private async spawnSlot(prompt: string, options: SubprocessOptions): Promise<PoolSlot> {
    const id = randomUUID();
    const subprocess = new ClaudeSubprocess();

    this.busyCount++;
    this.active.set(id, subprocess);

    try {
      await subprocess.start(prompt, options);
    } catch (err) {
      // Spawn failed — release the slot and propagate
      this.active.delete(id);
      this.busyCount = Math.max(0, this.busyCount - 1);
      // Try to serve next queued caller with the freed slot
      this.drainQueue();
      throw err;
    }

    return { id, subprocess };
  }

  /**
   * Take one entry from the front of the queue (if any) and dispatch it.
   * Only called when a slot has just become free.
   */
  private drainQueue(): void {
    if (this.queue.length === 0) return;
    if (this.busyCount >= this.size) return;

    const entry = this.queue.shift();
    if (!entry) return;

    this.spawnSlot(entry.prompt, entry.options)
      .then(entry.resolve)
      .catch(entry.reject);
  }
}

// ---- Singleton helpers ------------------------------------------------------

let _pool: SubprocessPool | null = null;

/**
 * Return the shared pool instance, creating it on first call.
 *
 * The `size` argument is only honoured on the first call (or after
 * `resetPool()`). Subsequent calls with a different size are ignored.
 */
export function getPool(size = 3): SubprocessPool {
  if (!_pool) {
    _pool = new SubprocessPool(size);
  }
  return _pool;
}

/**
 * Shut down the existing pool (if any) and create a fresh one.
 *
 * Intended for tests and hot-reload scenarios. Safe to call even when
 * no pool has been created yet.
 */
export function resetPool(size = 3): SubprocessPool {
  if (_pool) {
    _pool.shutdown();
    _pool = null;
  }
  _pool = new SubprocessPool(size);
  return _pool;
}
