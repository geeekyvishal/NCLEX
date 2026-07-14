/**
 * Unit tests for the Redis-backed magic-link token store.
 *
 * These test the create/consume contract - TTL wiring, single-use consumption,
 * and rejection of unknown/malformed tokens - against an in-memory fake Redis,
 * so no real Redis is required.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createMagicToken,
  consumeMagicToken,
  MAGIC_TOKEN_TTL_SECONDS,
  type RedisLike,
  type MagicTokenPayload,
} from "./tokens.js";

/**
 * Minimal in-memory stand-in for the slice of ioredis the token store uses.
 * It records the TTL passed to `set` so we can assert on it, and honours
 * single-use deletion.
 */
class FakeRedis implements RedisLike {
  private store = new Map<string, string>();
  public lastSet: { key: string; value: string; ttl: number } | null = null;

  async set(key: string, value: string, _mode: "EX", ttlSeconds: number): Promise<"OK"> {
    this.store.set(key, value);
    this.lastSet = { key, value, ttl: ttlSeconds };
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  /** Test helper: force a value in without going through `set`. */
  seed(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const payload: MagicTokenPayload = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "nurse@example.com",
};

describe("magic-link tokens", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it("creates an opaque token and stores the payload with the default TTL", async () => {
    const token = await createMagicToken(redis, payload);

    // 32 random bytes rendered as hex.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(redis.lastSet?.ttl).toBe(MAGIC_TOKEN_TTL_SECONDS);
    expect(redis.lastSet?.key).toContain(token);
    expect(JSON.parse(redis.lastSet?.value ?? "{}")).toEqual(payload);
  });

  it("honours a custom TTL", async () => {
    await createMagicToken(redis, payload, 42);
    expect(redis.lastSet?.ttl).toBe(42);
  });

  it("issues unique tokens across calls", async () => {
    const a = await createMagicToken(redis, payload);
    const b = await createMagicToken(redis, payload);
    expect(a).not.toBe(b);
  });

  it("round-trips a token back to its payload", async () => {
    const token = await createMagicToken(redis, payload);
    const consumed = await consumeMagicToken(redis, token);
    expect(consumed).toEqual(payload);
  });

  it("is single-use: a token cannot be consumed twice", async () => {
    const token = await createMagicToken(redis, payload);

    const first = await consumeMagicToken(redis, token);
    expect(first).toEqual(payload);

    const second = await consumeMagicToken(redis, token);
    expect(second).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const consumed = await consumeMagicToken(redis, "deadbeef");
    expect(consumed).toBeNull();
  });

  it("returns null for an empty token without touching Redis", async () => {
    const consumed = await consumeMagicToken(redis, "");
    expect(consumed).toBeNull();
  });

  it("rejects and consumes a malformed stored payload", async () => {
    redis.seed("magic:garbage", "not-json");
    const consumed = await consumeMagicToken(redis, "garbage");
    expect(consumed).toBeNull();
    // The bad entry is deleted so it cannot linger and be retried.
    expect(await redis.get("magic:garbage")).toBeNull();
  });

  it("rejects a payload that parses as JSON but fails schema validation", async () => {
    redis.seed("magic:badshape", JSON.stringify({ userId: "not-a-uuid", email: "x" }));
    const consumed = await consumeMagicToken(redis, "badshape");
    expect(consumed).toBeNull();
  });
});
