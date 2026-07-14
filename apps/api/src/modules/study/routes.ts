import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authGuard } from "../identity/session.js";
import { reviews } from "./reviews.repo.js";
import { decks, cards } from "../../infra/index.js";
import { exportDeckHandler } from "./export.controller.js";

/**
 * Register study module routes under the Fastify application.
 */
export async function registerStudyRoutes(app: FastifyInstance) {
  // GET /api/decks/:id/due - List all cards in a deck that are due
  app.get(
    "/api/decks/:id/due",
    { preHandler: [authGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.currentUser;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const { id } = request.params as { id: string };

      const targetDeck = await decks.findById(id);
      if (!targetDeck || targetDeck.userId !== user.id) {
        return reply.status(404).send({ error: "Deck not found." });
      }

      const dueCards = await reviews.listDue(id);
      return reply.send(dueCards);
    },
  );

  // POST /api/cards/:id/review - Log card review and update spacing
  app.post(
    "/api/cards/:id/review",
    { preHandler: [authGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.currentUser;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const { id } = request.params as { id: string };
      const { rating } = request.body as { rating: number };

      if (typeof rating !== "number" || rating < 1 || rating > 4) {
        return reply.status(400).send({
          error: "Invalid rating. Rating must be an integer between 1 and 4.",
        });
      }

      const card = await cards.findById(id);
      if (!card) {
        return reply.status(404).send({ error: "Card not found." });
      }

      const deck = await decks.findById(card.deckId);
      if (!deck || deck.userId !== user.id) {
        return reply.status(403).send({ error: "Access denied." });
      }

      const updatedCard = await reviews.logReview(user.id, id, rating);
      return reply.send(updatedCard);
    },
  );

  // GET /api/study/stats - Get user study statistics (streak, retention, etc.)
  app.get(
    "/api/study/stats",
    { preHandler: [authGuard] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.currentUser;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      const { timezone } = request.query as { timezone?: string };

      const stats = await reviews.getStats(user.id, timezone || "UTC");
      return reply.send(stats);
    },
  );

  // GET /api/decks/:id/export - Export deck in .apkg format with synced review scheduling
  app.get(
    "/api/decks/:id/export",
    { preHandler: [authGuard] },
    exportDeckHandler,
  );
}
