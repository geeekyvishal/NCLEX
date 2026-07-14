import type { FastifyReply, FastifyRequest } from "fastify";
import { query } from "../../infra/db.js";
import { decks } from "../../infra/index.js";
import { requireUser } from "../identity/session.js";
// @ts-expect-error: anki-apkg-export lacks declaration file
import AnkiExport from "anki-apkg-export";
import JSZip from "jszip";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rowToStudyCard, type StudyCardRow } from "./reviews.repo.js";

interface AnkiExporterInstance {
  addCard(front: string, back: string): void;
  save(): Promise<Buffer>;
}
type AnkiExporterConstructor = (title: string) => AnkiExporterInstance;

/**
 * Generates an .apkg buffer for a deck by creating a base package,
 * extracting the database, updating the card spaced repetition parameters in sqlite,
 * and re-compressing the package.
 */
export async function exportDeckToAnki(deckId: string): Promise<Buffer> {
  const deck = await decks.findById(deckId);
  if (!deck) {
    throw new Error(`Deck not found: ${deckId}`);
  }

  // 1. Fetch all cards for the deck including FSRS scheduling columns
  const { rows } = await query<StudyCardRow>(
    `SELECT id, deck_id, front, back, topic, confidence, source_chunk_id, model_version, flagged, created_at,
            stability, difficulty, reps, lapses, state, due, last_review
     FROM cards
     WHERE deck_id = $1
     ORDER BY created_at ASC`,
    [deckId],
  );
  const pgCards = rows.map(rowToStudyCard);

  // 2. Initialize anki-apkg-export
  const apkgConstructor = AnkiExport as unknown as AnkiExporterConstructor & { default?: AnkiExporterConstructor };
  const apkgExporter = typeof apkgConstructor.default === "function"
    ? apkgConstructor.default
    : apkgConstructor;

  const apkg = apkgExporter(deck.title);

  // 3. Add cards to the exporter
  for (const card of pgCards) {
    apkg.addCard(card.front, card.back);
  }

  // 4. Save the base .apkg zip package
  const baseBuffer = await apkg.save();

  // 5. Extract collection.anki2 using JSZip
  const zip = await JSZip.loadAsync(baseBuffer);
  const collectionEntry = zip.file("collection.anki2");
  if (!collectionEntry) {
    throw new Error("collection.anki2 not found in generated apkg");
  }
  const dbBuffer = await collectionEntry.async("nodebuffer");

  // 6. Write the SQLite file to a temp file on disk so we can open it via node:sqlite
  const tempDir = os.tmpdir();
  const tempFilePath = path.join(
    tempDir,
    `anki_col_${Date.now()}_${Math.random().toString(36).substring(2)}.db`,
  );
  fs.writeFileSync(tempFilePath, dbBuffer);

  let db: DatabaseSync | null = null;
  let updatedDbBuffer: Buffer;

  try {
    db = new DatabaseSync(tempFilePath);

    // Get the collection's creation time to calculate due day for review cards
    const colRow = db.prepare("SELECT crt FROM col LIMIT 1").get() as { crt: number } | undefined;
    const crt = colRow?.crt ?? Math.round(Date.now() / 1000);

    // Fetch the cards from the SQLite database
    const sqliteCards = db.prepare(`
      SELECT c.id as card_id, c.nid as note_id, c.due as existing_due, n.flds as flds
      FROM cards c
      JOIN notes n ON c.nid = n.id
    `).all() as Array<{
      card_id: number;
      note_id: number;
      existing_due: number;
      flds: string;
    }>;

    const updateStmt = db.prepare(`
      UPDATE cards
      SET reps = ?,
          lapses = ?,
          due = ?,
          ivl = ?,
          type = ?,
          queue = ?
      WHERE id = ?
    `);

    for (const sqliteCard of sqliteCards) {
      const parts = sqliteCard.flds.split("\u001f");
      const front = parts[0];
      const back = parts[1] || "";

      // Match SQLite card to Postgres card using front and back content
      const matchingPgCard = pgCards.find(
        (pgCard) => pgCard.front === front && pgCard.back === back,
      );

      if (matchingPgCard) {
        // Map FSRS state (Postgres) to Anki type & queue
        let type = 0;
        let queue = 0;

        if (matchingPgCard.state === 0) { // New
          type = 0;
          queue = 0;
        } else if (matchingPgCard.state === 1 || matchingPgCard.state === 3) { // Learning / Relearning
          type = 1;
          queue = matchingPgCard.state === 1 ? 1 : 3;
        } else if (matchingPgCard.state === 2) { // Review
          type = 2;
          queue = 2;
        }

        // Calculate Interval (ivl)
        let ivl = 0;
        if (matchingPgCard.lastReview) {
          const diffMs =
            new Date(matchingPgCard.due).getTime() - new Date(matchingPgCard.lastReview).getTime();
          ivl = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
        }

        // Calculate due value
        let dueVal = 0;
        if (queue === 2) { // Review
          const dueTimeSec = Math.round(new Date(matchingPgCard.due).getTime() / 1000);
          dueVal = Math.floor((dueTimeSec - crt) / 86400);
        } else if (queue === 1 || queue === 3) { // Learning
          dueVal = Math.round(new Date(matchingPgCard.due).getTime() / 1000);
        } else { // New
          dueVal = sqliteCard.existing_due;
        }

        // Update card scheduling values in the SQLite database
        updateStmt.run(
          Number(matchingPgCard.reps),
          Number(matchingPgCard.lapses),
          Number(dueVal),
          Number(ivl),
          Number(type),
          Number(queue),
          Number(sqliteCard.card_id),
        );
      }
    }

    db.close();
    db = null;

    updatedDbBuffer = fs.readFileSync(tempFilePath);
  } finally {
    if (db) {
      try {
        (db as DatabaseSync).close();
      } catch {
        // Ignore error closing database
      }
    }
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {
      // Ignore error deleting temp file
    }
  }

  // Pack the updated sqlite database buffer back into the zip
  zip.file("collection.anki2", updatedDbBuffer);

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

/**
 * Request handler to export a deck.
 */
export async function exportDeckHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireUser(request);
  const { id } = request.params as { id: string };

  const targetDeck = await decks.findById(id);
  if (!targetDeck || targetDeck.userId !== user.id) {
    return reply.status(404).send({ error: "Deck not found." });
  }

  const fileBuffer = await exportDeckToAnki(id);
  const filename = `${targetDeck.title.replace(/[^a-zA-Z0-9-_]/g, "_")}.apkg`;

  return reply
    .header("Content-Type", "application/octet-stream")
    .header("Content-Disposition", `attachment; filename="${filename}"`)
    .send(fileBuffer);
}
