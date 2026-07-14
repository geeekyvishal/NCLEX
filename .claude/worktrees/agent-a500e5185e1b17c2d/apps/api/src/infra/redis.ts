/**
 * Redis client as a lazily-initialised singleton (ioredis).
 *
 * The main client is shared for commands (LPUSH, publish, etc.). Pub/sub
 * subscription requires a connection in "subscriber mode" that can no longer
 * run ordinary commands, so `createSubscriber` mints a dedicated connection for
 * each subscriber and the caller is responsible for closing it.
 */
import Redis from "ioredis";
import { config } from "../config.js";

let redisSingleton: Redis | null = null;

/** Return the shared command Redis client, creating it on first call. */
export function getRedis(): Redis {
  if (redisSingleton === null) {
    redisSingleton = new Redis(config.REDIS_URL);
  }
  return redisSingleton;
}

/**
 * Create a fresh connection dedicated to pub/sub subscription.
 * ioredis puts a connection into subscriber mode once it subscribes, after
 * which it cannot issue normal commands, so subscribers must not share the
 * command client.
 */
export function createSubscriber(): Redis {
  return new Redis(config.REDIS_URL);
}

/** Close the shared client. Intended for graceful shutdown and test teardown. */
export async function closeRedis(): Promise<void> {
  if (redisSingleton !== null) {
    await redisSingleton.quit();
    redisSingleton = null;
  }
}
