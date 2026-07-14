import type { FastifyBaseLogger } from "fastify";
import { clients } from "../../infra/index.js";
import { config } from "../../config.js";
import { query } from "../../infra/db.js";

/**
 * Find and delete S3 objects for sources older than SOURCE_RETENTION_DAYS.
 * Updates their storage_key to 'purged' in the database.
 */
export async function purgeExpiredSources(log: FastifyBaseLogger): Promise<void> {
  const retentionDays = config.SOURCE_RETENTION_DAYS;
  const threshold = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Find source rows older than threshold that are not already purged
  const { rows } = await query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM sources WHERE created_at < $1 AND storage_key != 'purged'`,
    [threshold],
  );

  if (rows.length === 0) {
    return;
  }

  log.info({ count: rows.length }, "Found expired sources to purge from storage");

  for (const row of rows) {
    try {
      log.info({ sourceId: row.id, storageKey: row.storage_key }, "Purging S3 object");
      await clients.deleteObject(row.storage_key);
      await query(
        `UPDATE sources SET storage_key = 'purged' WHERE id = $1`,
        [row.id],
      );
    } catch (error) {
      log.error({ sourceId: row.id, error }, "Failed to purge source storage object");
    }
  }
}

/**
 * Starts a background interval to run the expired source purging task.
 */
export function startLifecycleScheduler(log: FastifyBaseLogger) {
  log.info("Starting lifecycle scheduler for source purging");

  // Run immediately on boot
  void purgeExpiredSources(log).catch((err) => {
    log.error({ err }, "Initial source purge failed");
  });

  // Then run every 24 hours
  const intervalMs = 24 * 60 * 60 * 1000;
  const timer = setInterval(() => {
    void purgeExpiredSources(log).catch((err) => {
      log.error({ err }, "Periodic source purge failed");
    });
  }, intervalMs);

  return () => {
    log.info("Stopping lifecycle scheduler");
    clearInterval(timer);
  };
}
