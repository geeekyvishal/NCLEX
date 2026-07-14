/**
 * Infrastructure contract: database pool, Redis, S3, and typed repositories.
 *
 * This file defines the SHARED INTERFACE that the Content and Identity modules
 * depend on. The Platform/DB agent implements the bodies; the module agents
 * code against these signatures. Keeping the contract here decouples the
 * parallel work streams.
 *
 * The implementations live in sibling files (db.ts, redis.ts, storage.ts, and
 * the `*.repo.ts` repositories) and are re-exported here so the public shape
 * (`clients`, `users`, `sources`, `decks`, `cards`, `jobs`) is unchanged and
 * consuming modules are unaffected.
 */
import type pg from "pg";
import { Redis } from "ioredis";
import { getPool } from "./db.js";
import { getRedis } from "./redis.js";
import { putObject } from "./storage.js";

// --- Clients ---
export const clients = {
  /** Lazily-initialised singleton pg Pool. */
  pool(): pg.Pool {
    return getPool();
  },
  /** Lazily-initialised singleton Redis client (command connection). */
  redis(): Redis {
    return getRedis();
  },
  /** Upload a buffer to object storage, returning the storage key. */
  async putObject(key: string, body: Buffer, contentType: string): Promise<string> {
    return putObject(key, body, contentType);
  },
};

// --- Repositories ---
export { users } from "./users.repo.js";
export { sources } from "./sources.repo.js";
export { decks } from "./decks.repo.js";
export { cards } from "./cards.repo.js";
export { jobs } from "./jobs.repo.js";
