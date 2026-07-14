import type { FastifyReply, FastifyRequest } from "fastify";
import {
  clients,
  sources,
  decks,
  cards,
  jobs,
} from "../../infra/index.js";
import {
  validatePdfUploadMetadata,
  assertPdfSizeWithinLimit,
  titleFromFilename,
  buildSourceStorageKey,
  UploadValidationError,
} from "./upload.js";
import { requireUser } from "../identity/session.js";
import { rateLimitUpload } from "./rate-limit.js";

export async function createDeckHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    await rateLimitUpload(request, reply);
    if (reply.sent) {
      return;
    }

    const part = await request.file();
    if (!part) {
      return reply.status(400).send({ error: "A PDF file is required." });
    }

    const { filename, mimetype } = validatePdfUploadMetadata({
      filename: part.filename,
      mimetype: part.mimetype,
    });

    const buffer = await part.toBuffer();
    assertPdfSizeWithinLimit(buffer.length);

    const user = requireUser(request);
    const storageKey = buildSourceStorageKey(user.id);
    await clients.putObject(storageKey, buffer, mimetype);

    const source = await sources.create(user.id, filename, storageKey);
    const title = titleFromFilename(filename);
    const deck = await decks.create(user.id, source.id, title);
    const jobId = await jobs.enqueue(deck.id, source.id, storageKey);

    return reply.status(201).send({ deck, jobId });
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}

export async function listDecksHandler(request: FastifyRequest, reply: FastifyReply) {
  const user = requireUser(request);
  const userDecks = await decks.listByUser(user.id);
  return reply.send(userDecks);
}

export async function getDeckHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const user = requireUser(request);
  const { id } = request.params as { id: string };
  const targetDeck = await decks.findById(id);
  if (!targetDeck || targetDeck.userId !== user.id) {
    return reply.status(404).send({ error: "Deck not found." });
  }
  const deckCards = await cards.listByDeck(id);
  return reply.send({ deck: targetDeck, cards: deckCards });
}

export async function flagCardHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const user = requireUser(request);
  const { id } = request.params as { id: string };
  const card = await cards.findById(id);
  if (!card) {
    return reply.status(404).send({ error: "Card not found." });
  }
  const deck = await decks.findById(card.deckId);
  if (!deck || deck.userId !== user.id) {
    return reply.status(403).send({ error: "Access denied." });
  }
  await cards.flag(id);

  // Log structured flag card metrics for product quality auditing
  request.log.info(
    {
      metric: "card_flagged",
      cardId: card.id,
      deckId: card.deckId,
      userId: user.id,
      confidence: card.confidence,
      modelVersion: card.modelVersion,
    },
    "Card flagged by user",
  );

  return reply.status(204).send();
}
