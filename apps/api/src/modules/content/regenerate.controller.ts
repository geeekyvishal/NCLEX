import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { GenerationJobRequest } from "@nclex/domain";
import { decks, cards } from "../../infra/index.js";
import { query } from "../../infra/db.js";
import { getRedis } from "../../infra/redis.js";
import { requireUser } from "../identity/session.js";
import { JOB_QUEUE_KEY } from "../../config.js";

export async function regenerateDeckHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const user = requireUser(request);

  // Validate path parameter
  const paramsSchema = z.object({
    id: z.string().uuid(),
  });
  const paramsResult = paramsSchema.safeParse(request.params);
  if (!paramsResult.success) {
    return reply.status(400).send({ error: "Invalid deck ID format." });
  }
  const deckId = paramsResult.data.id;

  // Retrieve deck metadata
  const deck = await decks.findById(deckId);
  if (!deck) {
    return reply.status(404).send({ error: "Deck not found." });
  }

  // Assert user ownership
  if (deck.userId !== user.id) {
    return reply.status(403).send({ error: "Access denied." });
  }

  // A deck must have an associated source file to regenerate from
  if (!deck.sourceId) {
    return reply.status(400).send({ error: "Deck does not have an associated source file." });
  }

  // Retrieve source storage key
  const { rows: sourceRows } = await query<{ storage_key: string }>(
    `SELECT storage_key FROM sources WHERE id = $1`,
    [deck.sourceId]
  );
  if (sourceRows.length === 0) {
    return reply.status(404).send({ error: "Source metadata not found." });
  }
  const storageKey = sourceRows[0].storage_key;

  // Validate request body parameters
  const bodySchema = z.object({
    targetCardCount: z.number().int().positive().optional(),
    prompt: z.string().optional(),
    cardId: z.string().uuid().optional(),
  });

  const bodyResult = bodySchema.safeParse(request.body || {});
  if (!bodyResult.success) {
    return reply.status(400).send({
      error: "Invalid request parameters.",
      details: bodyResult.error.format(),
    });
  }
  const { targetCardCount, prompt, cardId } = bodyResult.data;

  // If a cardId is specified, assert that it exists and belongs to the target deck
  if (cardId) {
    const card = await cards.findById(cardId);
    if (!card) {
      return reply.status(404).send({ error: "Card not found." });
    }
    if (card.deckId !== deck.id) {
      return reply.status(400).send({ error: "Card does not belong to this deck." });
    }
  }

  // Update deck status to generating
  await query(
    `UPDATE decks SET status = 'generating' WHERE id = $1`,
    [deck.id]
  );

  // Enqueue regeneration job
  const { rows: jobRows } = await query<{ id: string }>(
    `INSERT INTO generation_jobs (deck_id, source_id) VALUES ($1, $2) RETURNING id`,
    [deck.id, deck.sourceId]
  );
  const jobId = jobRows[0].id;

  const jobRequest = GenerationJobRequest.parse({
    jobId,
    deckId: deck.id,
    sourceId: deck.sourceId,
    storageKey,
    targetCardCount,
    prompt,
    cardId,
  });

  const redis = getRedis();
  await redis.lpush(JOB_QUEUE_KEY, JSON.stringify(jobRequest));

  const updatedDeck = {
    ...deck,
    status: "generating" as const,
  };

  return reply.status(200).send({ deck: updatedDeck, jobId });
}
