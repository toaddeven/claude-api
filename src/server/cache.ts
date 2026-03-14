/**
 * Prompt-level LRU Response Cache
 *
 * Pure TypeScript implementation — no external dependencies.
 * Uses a doubly-linked list + Map for O(1) get/set operations.
 */

import type { OpenAIChatRequest } from "../types/openai.js";

// ---------------------------------------------------------------------------
// Internal node type for the doubly-linked list
// ---------------------------------------------------------------------------

interface ListNode<K, V> {
  key: K;
  value: V;
  expiresAt: number; // absolute epoch ms; 0 = no TTL
  prev: ListNode<K, V> | null;
  next: ListNode<K, V> | null;
}

// ---------------------------------------------------------------------------
// LRUCache<K, V>
// ---------------------------------------------------------------------------

export interface LRUCacheOptions {
  /** Maximum number of entries to keep. Default: 100 */
  max?: number;
  /** Time-to-live in milliseconds. 0 = no expiry. Default: 60000 */
  ttl?: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: string;
}

export class LRUCache<K, V> {
  private readonly max: number;
  private readonly ttl: number;

  /** Fast key → node lookup */
  private readonly map: Map<K, ListNode<K, V>> = new Map();

  /**
   * Doubly-linked list:
   *  head.next → most-recently-used
   *  tail.prev → least-recently-used
   */
  private readonly head: ListNode<K, V>;
  private readonly tail: ListNode<K, V>;

  private _hits = 0;
  private _misses = 0;

  constructor({ max = 100, ttl = 60_000 }: LRUCacheOptions = {}) {
    this.max = max;
    this.ttl = ttl;

    // Sentinel nodes — never hold real data
    this.head = { key: null as unknown as K, value: null as unknown as V, expiresAt: 0, prev: null, next: null };
    this.tail = { key: null as unknown as K, value: null as unknown as V, expiresAt: 0, prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Retrieve a value by key.
   * On hit: moves the node to the MRU position and returns the value.
   * On miss or expiry: returns undefined (expired entries are evicted).
   */
  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) {
      this._misses++;
      return undefined;
    }

    if (this._isExpired(node)) {
      this._removeNode(node);
      this.map.delete(key);
      this._misses++;
      return undefined;
    }

    // Move to MRU (front)
    this._removeNode(node);
    this._insertAfterHead(node);

    this._hits++;
    return node.value;
  }

  /**
   * Insert or update a key-value pair.
   * If inserting would exceed `max`, the LRU entry is evicted first.
   */
  set(key: K, value: V): void {
    const existing = this.map.get(key);

    if (existing) {
      // Update in-place and promote to MRU
      existing.value = value;
      existing.expiresAt = this._makeExpiry();
      this._removeNode(existing);
      this._insertAfterHead(existing);
      return;
    }

    // Evict LRU if at capacity
    if (this.map.size >= this.max) {
      const lru = this.tail.prev!;
      if (lru !== this.head) {
        this._removeNode(lru);
        this.map.delete(lru.key);
      }
    }

    const node: ListNode<K, V> = {
      key,
      value,
      expiresAt: this._makeExpiry(),
      prev: null,
      next: null,
    };

    this.map.set(key, node);
    this._insertAfterHead(node);
  }

  /**
   * Check whether a non-expired entry exists for the given key.
   * Expired entries are evicted as a side-effect.
   */
  has(key: K): boolean {
    const node = this.map.get(key);
    if (!node) return false;

    if (this._isExpired(node)) {
      this._removeNode(node);
      this.map.delete(key);
      return false;
    }

    return true;
  }

  /** Remove an entry unconditionally. */
  delete(key: K): void {
    const node = this.map.get(key);
    if (node) {
      this._removeNode(node);
      this.map.delete(key);
    }
  }

  /** Return hit/miss statistics. */
  getStats(): CacheStats {
    const total = this._hits + this._misses;
    const hitRate = total === 0 ? "0.00%" : `${((this._hits / total) * 100).toFixed(2)}%`;
    return {
      size: this.map.size,
      hits: this._hits,
      misses: this._misses,
      hitRate,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _makeExpiry(): number {
    return this.ttl > 0 ? Date.now() + this.ttl : 0;
  }

  private _isExpired(node: ListNode<K, V>): boolean {
    return node.expiresAt !== 0 && Date.now() > node.expiresAt;
  }

  /** Detach a node from the list (does NOT touch the map). */
  private _removeNode(node: ListNode<K, V>): void {
    const { prev, next } = node;
    if (prev) prev.next = next;
    if (next) next.prev = prev;
    node.prev = null;
    node.next = null;
  }

  /** Insert a node immediately after the head sentinel (MRU position). */
  private _insertAfterHead(node: ListNode<K, V>): void {
    const after = this.head.next!;
    node.prev = this.head;
    node.next = after;
    this.head.next = node;
    after.prev = node;
  }
}

// ---------------------------------------------------------------------------
// Cache key generation
// ---------------------------------------------------------------------------

/**
 * Compute a string cache key from the fields that affect the response:
 * model, temperature, max_tokens, and the full messages array.
 *
 * Uses a combination of djb2 and FNV-1a for low collision probability
 * without requiring the Node.js `crypto` module.
 */
export function generateCacheKey(body: OpenAIChatRequest): string {
  const { model = "", temperature = 1, max_tokens } = body;

  // Deterministic serialisation of the fields that matter
  const payload = JSON.stringify({
    model,
    temperature,
    max_tokens: max_tokens ?? null,
    messages: body.messages,
  });

  const djb2 = _djb2(payload);
  const fnv = _fnv1a(payload);

  // Combine both hashes into a single hex string
  return `${djb2.toString(16).padStart(8, "0")}${fnv.toString(16).padStart(8, "0")}`;
}

/** djb2 hash — returns an unsigned 32-bit integer */
function _djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 ^ char
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return hash;
}

/** FNV-1a (32-bit) hash — returns an unsigned 32-bit integer */
function _fnv1a(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Multiply by FNV prime (0x01000193) using safe integer arithmetic
    hash = (Math.imul(hash, 0x01000193)) >>> 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Caching eligibility
// ---------------------------------------------------------------------------

/**
 * Returns true when a request is a good candidate for caching:
 *   - Not a streaming request
 *   - temperature === 0 (deterministic output)
 *   - Total character length of all messages is under 10 000
 */
export function shouldCache(body: OpenAIChatRequest): boolean {
  if (body.stream === true) return false;

  if (body.temperature !== 0) return false;

  const totalLength = body.messages.reduce((sum, msg) => sum + msg.content.length, 0);
  if (totalLength >= 10_000) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _cacheInstance: LRUCache<string, object> | null = null;

/**
 * Return the shared cache instance (created on first call).
 * Configuration: max=100 entries, TTL=60 seconds.
 */
export function getCache(): LRUCache<string, object> {
  if (!_cacheInstance) {
    _cacheInstance = new LRUCache<string, object>({ max: 100, ttl: 60_000 });
  }
  return _cacheInstance;
}
