import type { FastifyInstance } from "fastify";
import { authGuard } from "../identity/routes.js";
import {
  createDeckHandler,
  listDecksHandler,
  getDeckHandler,
  flagCardHandler,
} from "./decks.controller.js";
import { regenerateDeckHandler } from "./regenerate.controller.js";
import { registerProgressSocket } from "./progress.ws.js";

export async function registerContentRoutes(app: FastifyInstance) {
  app.post("/api/decks", { preHandler: [authGuard] }, createDeckHandler);
  app.get("/api/decks", { preHandler: [authGuard] }, listDecksHandler);
  app.get("/api/decks/:id", { preHandler: [authGuard] }, getDeckHandler);
  app.post("/api/cards/:id/flag", { preHandler: [authGuard] }, flagCardHandler);
  app.post("/api/decks/:id/regenerate", { preHandler: [authGuard] }, regenerateDeckHandler);

  await registerProgressSocket(app);
}
