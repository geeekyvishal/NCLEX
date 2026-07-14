import { describe, it, expect } from "vitest";
import { initializeCardState, rescheduleCard } from "./scheduler.js";
import { State } from "ts-fsrs";

describe("FSRS Scheduler", () => {
  describe("initializeCardState", () => {
    it("should return the default values for a new card", () => {
      const now = new Date("2026-07-14T20:30:00Z");
      const state = initializeCardState(now);

      expect(state.stability).toBe(0);
      expect(state.difficulty).toBe(0);
      expect(state.reps).toBe(0);
      expect(state.lapses).toBe(0);
      expect(state.state).toBe(State.New);
      expect(state.due).toEqual(now);
      expect(state.last_review).toBeNull();
    });
  });

  describe("rescheduleCard", () => {
    const card = {
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      state: State.New,
      due: new Date("2026-07-14T20:30:00Z"),
      last_review: null,
    };

    it("should throw an error for invalid rating", () => {
      expect(() => {
        rescheduleCard(card, 0);
      }).toThrow(/Invalid FSRS rating/);

      expect(() => {
        rescheduleCard(card, 5);
      }).toThrow(/Invalid FSRS rating/);
    });

    it("should reschedule a card with rating=Good (3)", () => {
      const reviewTime = new Date("2026-07-14T20:30:00Z");
      const record = rescheduleCard(card, 3, reviewTime);

      // Verify that card has progressed to Learning or similar state, reps incremented
      expect(record.card.reps).toBe(1);
      expect(record.card.last_review).toEqual(reviewTime);
      expect(record.card.stability).toBeGreaterThan(0);
      expect(record.card.difficulty).toBeGreaterThan(0);

      // Verify log has been built
      expect(record.log.rating).toBe(3);
      expect(record.log.review).toEqual(reviewTime);
    });

    it("should reschedule a card with custom weights and retention", () => {
      const reviewTime = new Date("2026-07-14T20:30:00Z");
      // Custom parameters to verify weights and retention don't cause crashes
      const customParams = {
        weights: [
          0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18,
          0.05, 0.34, 1.26, 0.28, 2.61,
        ],
        request_retention: 0.85,
      };

      const record = rescheduleCard(card, 3, reviewTime, customParams);

      expect(record.card.reps).toBe(1);
      expect(record.card.stability).toBeGreaterThan(0);
      expect(record.log.rating).toBe(3);
    });
  });
});
