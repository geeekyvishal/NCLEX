import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  reviews,
  rowToStudyCard,
  getPreviousDayStr,
  type StudyCardRow,
} from "./reviews.repo.js";
import { State } from "ts-fsrs";

// Mock the db file to prevent actual database connections
vi.mock("../../infra/db.js", () => {
  return {
    query: vi.fn(),
    getPool: vi.fn(),
  };
});

// Import the mocked query and pool functions
import { query, getPool } from "../../infra/db.js";

describe("Reviews Repository", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("rowToStudyCard", () => {
    it("should correctly map StudyCardRow to StudyCard", () => {
      const row: StudyCardRow = {
        id: "c1",
        deck_id: "d1",
        front: "Front",
        back: "Back",
        topic: "Topic",
        confidence: 0.8,
        source_chunk_id: "sc1",
        model_version: "mv1",
        flagged: false,
        created_at: new Date("2026-07-14T10:00:00Z"),
        stability: 1.5,
        difficulty: 2.3,
        reps: 2,
        lapses: 0,
        state: State.Review,
        due: new Date("2026-07-15T12:00:00Z"),
        last_review: new Date("2026-07-14T10:00:00Z"),
      };

      const card = rowToStudyCard(row);

      expect(card.id).toBe("c1");
      expect(card.deckId).toBe("d1");
      expect(card.createdAt).toBe("2026-07-14T10:00:00.000Z");
      expect(card.stability).toBe(1.5);
      expect(card.state).toBe(State.Review);
      expect(card.due).toBe("2026-07-15T12:00:00.000Z");
      expect(card.lastReview).toBe("2026-07-14T10:00:00.000Z");
    });
  });

  describe("getPreviousDayStr", () => {
    it("should return the correct previous day date string", () => {
      expect(getPreviousDayStr("2026-07-14")).toBe("2026-07-13");
      expect(getPreviousDayStr("2026-07-01")).toBe("2026-06-30");
      expect(getPreviousDayStr("2026-01-01")).toBe("2025-12-31");
    });
  });

  describe("listDue", () => {
    it("should query the database for due cards and map them", async () => {
      const mockRow: StudyCardRow = {
        id: "c1",
        deck_id: "d1",
        front: "Front",
        back: "Back",
        topic: "Topic",
        confidence: 0.8,
        source_chunk_id: "sc1",
        model_version: "mv1",
        flagged: false,
        created_at: new Date("2026-07-14T10:00:00Z"),
        stability: 1.5,
        difficulty: 2.3,
        reps: 2,
        lapses: 0,
        state: State.Review,
        due: new Date("2026-07-14T12:00:00Z"),
        last_review: null,
      };

      vi.mocked(query).mockResolvedValueOnce({
        rows: [mockRow],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      });

      const now = new Date("2026-07-14T15:00:00Z");
      const result = await reviews.listDue("d1", now);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE deck_id = $1 AND due <= $2"),
        ["d1", now],
      );
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("c1");
    });
  });

  describe("logReview", () => {
    it("should perform the card update and review insert in a transaction", async () => {
      const mockCardRow: StudyCardRow = {
        id: "c1",
        deck_id: "d1",
        front: "Front",
        back: "Back",
        topic: "Topic",
        confidence: 0.8,
        source_chunk_id: "sc1",
        model_version: "mv1",
        flagged: false,
        created_at: new Date("2026-07-14T10:00:00Z"),
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        state: State.New,
        due: new Date("2026-07-14T12:00:00Z"),
        last_review: null,
      };

      const mockClient = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes("SELECT") && sql.includes("FROM cards")) {
            return Promise.resolve({ rows: [mockCardRow] });
          }
          if (sql.includes("SELECT") && sql.includes("FROM fsrs_params")) {
            return Promise.resolve({ rows: [] }); // default params
          }
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn(),
      };

      vi.mocked(getPool).mockReturnValue({
        connect: vi.fn().mockResolvedValue(mockClient),
      } as unknown as ReturnType<typeof getPool>);

      vi.mocked(query).mockResolvedValueOnce({
        rows: [{ ...mockCardRow, reps: 1, state: State.Learning }],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      });

      const updated = await reviews.logReview("u1", "c1", 3);

      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE cards"),
        expect.any(Array),
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO reviews"),
        expect.any(Array),
      );
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
      expect(updated.reps).toBe(1);
    });
  });

  describe("getStats", () => {
    it("should compute counts, retention, and streak correctly", async () => {
      vi.mocked(query).mockImplementation(((sql: string) => {
        if (sql.includes("COUNT")) {
          return Promise.resolve({
            rows: [
              {
                total_reviews: 10,
                recalled_reviews: 9,
                total_cards_studied: 5,
              },
            ],
          });
        }
        if (sql.includes("local_today")) {
          return Promise.resolve({
            rows: [
              {
                local_today: "2026-07-14",
                local_yesterday: "2026-07-13",
              },
            ],
          });
        }
        if (sql.includes("DISTINCT")) {
          // 3 days streak: today, yesterday, day before
          return Promise.resolve({
            rows: [
              { review_date: "2026-07-14" },
              { review_date: "2026-07-13" },
              { review_date: "2026-07-12" },
              { review_date: "2026-07-10" }, // gap of 1 day
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }) as unknown as typeof query);

      const stats = await reviews.getStats("u1", "UTC");

      expect(stats.totalReviews).toBe(10);
      expect(stats.totalCardsStudied).toBe(5);
      expect(stats.retentionRate).toBe(90.0);
      expect(stats.streak).toBe(3); // 14, 13, 12 is 3 days
    });
  });
});
