/**
 * Concurrency Limiter & Express Middleware
 *
 * Controls the maximum number of simultaneously running Claude subprocesses
 * to prevent resource contention and latency degradation under concurrent load.
 */

import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// ConcurrencyLimiter
// ---------------------------------------------------------------------------

interface QueueEntry<T> {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class ConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private running: number = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: QueueEntry<any>[] = [];

  constructor(maxConcurrent: number = 5) {
    if (maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be at least 1");
    }
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Run `fn` immediately if a slot is available, otherwise enqueue it (FIFO).
   * Resolves or rejects with the same value/error as `fn`.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.dispatch();
    });
  }

  getStats(): { running: number; queued: number; maxConcurrent: number } {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private dispatch(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.running++;
      entry
        .fn()
        .then((value) => {
          entry.resolve(value);
        })
        .catch((err: unknown) => {
          entry.reject(err);
        })
        .finally(() => {
          this.running--;
          this.dispatch();
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let _instance: ConcurrencyLimiter | null = null;

/**
 * Return the process-wide singleton limiter.
 * The `maxConcurrent` argument is only honoured on the first call;
 * subsequent calls return the already-created instance regardless of the argument.
 */
export function getLimiter(maxConcurrent?: number): ConcurrencyLimiter {
  if (!_instance) {
    _instance = new ConcurrencyLimiter(maxConcurrent ?? 5);
  }
  return _instance;
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

const MAX_QUEUE_DEPTH = 20;

/**
 * Express middleware that gates every request through the global
 * ConcurrencyLimiter.  A slot is acquired before `next()` is called and
 * released only after the response has finished (stream or JSON alike).
 *
 * If more than MAX_QUEUE_DEPTH requests are already waiting, the middleware
 * immediately responds with 503 and a `Retry-After: 5` header instead of
 * growing the queue unboundedly.
 */
export function concurrencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const limiter = getLimiter();
  const stats = limiter.getStats();

  if (stats.queued > MAX_QUEUE_DEPTH) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: {
        message: "Server is overloaded. Too many requests queued — please retry after 5 seconds.",
        type: "server_error",
        code: "overloaded",
      },
    });
    return;
  }

  // Wrap next() so that we hold the concurrency slot for the lifetime of the
  // response, not just the synchronous setup phase.
  limiter
    .run(
      () =>
        new Promise<void>((releaseSlot) => {
          // Release the slot as soon as the response stream is closed/finished.
          const release = (): void => releaseSlot();
          res.once("finish", release);
          res.once("close", release);

          // Hand control to the next handler while the slot is held.
          next();
        }),
    )
    .catch((err: unknown) => {
      // The limiter itself should never reject, but guard anyway.
      const message = err instanceof Error ? err.message : "Concurrency limiter error";
      console.error("[concurrencyMiddleware] Unexpected error:", message);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message, type: "server_error", code: null },
        });
      }
    });
}
