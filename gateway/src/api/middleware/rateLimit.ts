/**
 * Rate-Limiting pro API-Key (Fixed-Window).
 * Redis (atomares Lua) wenn REDIS_URL gesetzt, sonst In-Memory-Fallback.
 */
import type { RequestHandler } from 'express';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimitStore {
  consume(bucket: string, limit: number, windowSec: number): Promise<RateLimitResult>;
}

/** In-Memory-Fixed-Window (pro Prozess). */
export function createMemoryRateLimitStore(
  clock: () => number = () => Math.floor(Date.now() / 1000)
): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(bucket: string, limit: number, windowSec: number): Promise<RateLimitResult> {
      const now = clock();
      let entry = windows.get(bucket);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowSec };
        windows.set(bucket, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= limit;
      return {
        allowed,
        remaining: Math.max(0, limit - entry.count),
        retryAfterSec: allowed ? 0 : Math.max(1, entry.resetAt - now),
      };
    },
  };
}

export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Atomare Fixed-Window-Logik in einem Lua-Skript (INCR + EXPIRE). */
const LUA_FIXED_WINDOW = [
  "local key = KEYS[1]",
  "local limit = tonumber(ARGV[1])",
  "local window = tonumber(ARGV[2])",
  "local current = redis.call('INCR', key)",
  "if current == 1 then redis.call('EXPIRE', key, window) end",
  'if current > limit then return {0, current} end',
  'return {1, current}',
].join('\n');

export function createRedisRateLimitStore(redis: RedisEvalClient): RateLimitStore {
  return {
    async consume(bucket: string, limit: number, windowSec: number): Promise<RateLimitResult> {
      const raw = (await redis.eval(
        LUA_FIXED_WINDOW,
        1,
        `ratelimit:${bucket}`,
        String(limit),
        String(windowSec)
      )) as number[];
      const allowed = Number(raw[0]) === 1;
      const used = Number(raw[1]);
      return {
        allowed,
        remaining: Math.max(0, limit - used),
        retryAfterSec: allowed ? 0 : windowSec,
      };
    },
  };
}

export interface RateLimitOptions {
  limit: number;
  windowSec: number;
  /** Bucket-Schlüssel — Default: API-Key, sonst Quell-IP. */
  keyOf?: (req: Parameters<RequestHandler>[0]) => string;
}

export function createRateLimitMiddleware(
  store: RateLimitStore,
  opts: RateLimitOptions
): RequestHandler {
  return (req, res, next) => {
    const keyOf = opts.keyOf ?? ((r) => r.apiKey?.keyId ?? r.ip ?? 'unknown');
    void store
      .consume(keyOf(req), opts.limit, opts.windowSec)
      .then((result) => {
        res.setHeader('X-RateLimit-Limit', String(opts.limit));
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
        if (!result.allowed) {
          res.setHeader('Retry-After', String(result.retryAfterSec));
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message: `Rate-Limit überschritten — in ${result.retryAfterSec}s erneut versuchen`,
            },
          });
          return;
        }
        next();
      })
      .catch((err) => next(err));
  };
}
