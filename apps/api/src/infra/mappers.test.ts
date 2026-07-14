/**
 * Unit tests for the pure row -> domain-type mappers.
 *
 * These exercise the snake_case -> camelCase mapping, timestamp -> ISO string
 * conversion, and Zod validation at the boundary. They require no live database
 * because the mappers are pure functions over plain row objects.
 */
import { describe, it, expect } from "vitest";
import {
  toIso,
  rowToUser,
  rowToSource,
  rowToDeck,
  rowToCard,
  type UserRow,
  type SourceRow,
  type DeckRow,
  type CardRow,
} from "./mappers.js";

const CREATED = new Date("2026-07-14T10:30:00.000Z");

describe("toIso", () => {
  it("converts a Date to an ISO-8601 string", () => {
    expect(toIso(CREATED)).toBe("2026-07-14T10:30:00.000Z");
  });

  it("normalises a string timestamp to ISO-8601", () => {
    expect(toIso("2026-07-14T10:30:00Z")).toBe("2026-07-14T10:30:00.000Z");
  });
});

describe("rowToUser", () => {
  it("maps a registered user row to the domain type", () => {
    const row: UserRow = {
      id: "11111111-1111-1111-1111-111111111111",
      kind: "registered",
      email: "nurse@example.com",
      created_at: CREATED,
    };
    expect(rowToUser(row)).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      kind: "registered",
      email: "nurse@example.com",
      createdAt: "2026-07-14T10:30:00.000Z",
    });
  });

  it("preserves a null email for anonymous users", () => {
    const row: UserRow = {
      id: "22222222-2222-2222-2222-222222222222",
      kind: "anonymous",
      email: null,
      created_at: CREATED,
    };
    expect(rowToUser(row).email).toBeNull();
  });

  it("rejects a row that violates the schema (bad enum)", () => {
    const row = {
      id: "22222222-2222-2222-2222-222222222222",
      kind: "guest",
      email: null,
      created_at: CREATED,
    } as unknown as UserRow;
    expect(() => rowToUser(row)).toThrow();
  });
});

describe("rowToSource", () => {
  it("maps storage_key/page_count and a null page count", () => {
    const row: SourceRow = {
      id: "33333333-3333-3333-3333-333333333333",
      user_id: "11111111-1111-1111-1111-111111111111",
      filename: "pharmacology.pdf",
      storage_key: "sources/abc.pdf",
      page_count: null,
      created_at: CREATED,
    };
    expect(rowToSource(row)).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      userId: "11111111-1111-1111-1111-111111111111",
      filename: "pharmacology.pdf",
      storageKey: "sources/abc.pdf",
      pageCount: null,
      createdAt: "2026-07-14T10:30:00.000Z",
    });
  });
});

describe("rowToDeck", () => {
  it("maps a deck row including a null source_id", () => {
    const row: DeckRow = {
      id: "44444444-4444-4444-4444-444444444444",
      user_id: "11111111-1111-1111-1111-111111111111",
      source_id: null,
      title: "Cardiac Meds",
      status: "generating",
      card_count: 0,
      created_at: CREATED,
    };
    expect(rowToDeck(row)).toEqual({
      id: "44444444-4444-4444-4444-444444444444",
      userId: "11111111-1111-1111-1111-111111111111",
      sourceId: null,
      title: "Cardiac Meds",
      status: "generating",
      cardCount: 0,
      createdAt: "2026-07-14T10:30:00.000Z",
    });
  });
});

describe("rowToCard", () => {
  it("maps a card row with provenance and confidence", () => {
    const row: CardRow = {
      id: "55555555-5555-5555-5555-555555555555",
      deck_id: "44444444-4444-4444-4444-444444444444",
      front: "What is the antidote for warfarin?",
      back: "Vitamin K",
      topic: "Pharmacology",
      confidence: 0.92,
      source_chunk_id: "66666666-6666-6666-6666-666666666666",
      model_version: "claude-opus-4-8+haiku-4-5/v1",
      flagged: false,
      created_at: CREATED,
    };
    expect(rowToCard(row)).toEqual(expect.objectContaining({
      id: "55555555-5555-5555-5555-555555555555",
      deckId: "44444444-4444-4444-4444-444444444444",
      front: "What is the antidote for warfarin?",
      back: "Vitamin K",
      topic: "Pharmacology",
      confidence: 0.92,
      sourceChunkId: "66666666-6666-6666-6666-666666666666",
      modelVersion: "claude-opus-4-8+haiku-4-5/v1",
      flagged: false,
      createdAt: "2026-07-14T10:30:00.000Z",
    }));
  });

  it("rejects a confidence outside the 0..1 range", () => {
    const row: CardRow = {
      id: "55555555-5555-5555-5555-555555555555",
      deck_id: "44444444-4444-4444-4444-444444444444",
      front: "front",
      back: "back",
      topic: null,
      confidence: 1.5,
      source_chunk_id: null,
      model_version: "v1",
      flagged: false,
      created_at: CREATED,
    };
    expect(() => rowToCard(row)).toThrow();
  });
});
