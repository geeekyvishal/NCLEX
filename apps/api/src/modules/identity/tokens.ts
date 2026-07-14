/**
 * Redis-backed storage for short-lived magic-link tokens.
 *
 * A token maps to the user id that requested it plus the email being claimed.
 * Tokens are single-use (deleted on consume) and expire on their own via a
 * Redis TTL, so an unused link simply lapses. Keeping this logic in one small,
 * dependency-injected module makes it straightforward to unit test against a
 * fake Redis.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { clients } from "../../infra/index.js";

/** Magic-link tokens are deliberately short-lived. */
export const MAGIC_TOKEN_TTL_SECONDS = 15 * 60;

const KEY_PREFIX = "magic:";

/**
 * Minimal slice of the ioredis client this module needs. Declared locally so
 * tokens.ts depends on a behaviour, not on the concrete client, which keeps it
 * trivially mockable in tests.
 */
export interface RedisLike {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

const MagicTokenPayloadSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
});
export type MagicTokenPayload = z.infer<typeof MagicTokenPayloadSchema>;

/** Resolve the shared Redis client from infra, typed to what this module uses. */
export function getRedis(): RedisLike {
  return clients.redis() as RedisLike;
}

function keyFor(token: string): string {
  return `${KEY_PREFIX}${token}`;
}

/**
 * Create a token for `payload`, store it in Redis with a TTL, and return the
 * opaque token string. The token is a 256-bit random value, so it is safe to
 * hand out and infeasible to guess.
 */
export async function createMagicToken(
  redis: RedisLike,
  payload: MagicTokenPayload,
  ttlSeconds: number = MAGIC_TOKEN_TTL_SECONDS,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await redis.set(keyFor(token), JSON.stringify(payload), "EX", ttlSeconds);
  return token;
}

/**
 * Validate and consume a token. Returns the stored payload on success, or null
 * if the token is unknown, expired, or malformed. The token is deleted on any
 * hit so it can never be replayed.
 */
export async function consumeMagicToken(
  redis: RedisLike,
  token: string,
): Promise<MagicTokenPayload | null> {
  if (!token) return null;

  const key = keyFor(token);
  const raw = await redis.get(key);
  if (raw === null) return null;

  // Single-use: delete regardless of whether the payload parses cleanly.
  await redis.del(key);

  try {
    return MagicTokenPayloadSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
