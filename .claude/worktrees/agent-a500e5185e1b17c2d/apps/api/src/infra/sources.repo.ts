/**
 * Source repository: uploaded PDFs / notes that cards are generated from.
 */
import type { Source } from "@nclex/domain";
import { query } from "./db.js";
import { rowToSource, type SourceRow } from "./mappers.js";

const COLUMNS = "id, user_id, filename, storage_key, page_count, created_at";

export const sources = {
  /**
   * Record an uploaded source. The binary already lives in object storage;
   * this stores only the storage key and metadata. `page_count` is unknown at
   * upload time and is filled in later by the AI worker during parsing.
   */
  async create(userId: string, filename: string, storageKey: string): Promise<Source> {
    const { rows } = await query<SourceRow>(
      `INSERT INTO sources (user_id, filename, storage_key)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [userId, filename, storageKey],
    );
    return rowToSource(rows[0]);
  },
};
