/**
 * User repository: anonymous session creation, lookup, and account upgrade.
 */
import type { User, UserKind } from "@nclex/domain";
import { query } from "./db.js";
import { rowToUser, type UserRow } from "./mappers.js";

const COLUMNS = "id, kind, email, created_at";

export const users = {
  /** Create an anonymous user row (first-class record for a demo session). */
  async createAnonymous(): Promise<User> {
    const { rows } = await query<UserRow>(
      `INSERT INTO users (kind) VALUES ('anonymous') RETURNING ${COLUMNS}`,
    );
    return rowToUser(rows[0]);
  },

  async findById(id: string): Promise<User | null> {
    const { rows } = await query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? rowToUser(rows[0]) : null;
  },

  /**
   * Upgrade an anonymous user to a registered account, attaching an email.
   * Idempotent on the target state: if the row is already registered the
   * update is a no-op and the current record is returned.
   */
  async upgradeToRegistered(id: string, email: string, kind: UserKind): Promise<User> {
    const { rows } = await query<UserRow>(
      `UPDATE users SET kind = $2, email = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, kind, email],
    );
    if (rows.length === 0) {
      throw new Error(`users.upgradeToRegistered: user ${id} not found`);
    }
    return rowToUser(rows[0]);
  },
};
