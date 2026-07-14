/**
 * PostgreSQL connection pool as a lazily-initialised singleton.
 *
 * The pool is created on first use so importing this module never opens a
 * connection at load time (keeps tests and tooling that only need types cheap).
 * Every repository shares this one pool.
 */
import pg from "pg";
import { config } from "../config.js";

// pg is a CommonJS module; destructure after the default import so this
// resolves correctly under NodeNext module resolution.
const { Pool } = pg;

let poolSingleton: pg.Pool | null = null;

/** Return the shared pg Pool, creating it on first call. */
export function getPool(): pg.Pool {
  if (poolSingleton === null) {
    poolSingleton = new Pool({ connectionString: config.DATABASE_URL });
  }
  return poolSingleton;
}

/**
 * Convenience helper for a single parameterised query.
 * Callers pass positional `$1, $2, ...` placeholders and a values array so no
 * user data is ever interpolated into SQL text.
 */
export async function query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<Row>> {
  return getPool().query<Row>(text, params as unknown[]);
}

/** Close the pool. Intended for graceful shutdown and test teardown. */
export async function closePool(): Promise<void> {
  if (poolSingleton !== null) {
    await poolSingleton.end();
    poolSingleton = null;
  }
}
