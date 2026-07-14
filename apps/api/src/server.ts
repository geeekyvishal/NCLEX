/**
 * Fastify server bootstrap.
 *
 * Module route-registration is pre-wired here so that parallel work on the
 * individual modules does not require editing this shared file. Each module
 * exports a `register<Name>Routes(app)` plugin; agents implement the module
 * internals under src/modules/<name>/ without touching this bootstrap.
 */
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { registerIdentityRoutes } from "./modules/identity/routes.js";
import { registerContentRoutes } from "./modules/content/routes.js";
import { registerStudyRoutes } from "./modules/study/routes.js";
import { startLifecycleScheduler } from "./modules/content/lifecycle.js";

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "development" ? "info" : "warn" },
  });

  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  await app.register(registerIdentityRoutes);
  await app.register(registerContentRoutes);
  await app.register(registerStudyRoutes);

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
    startLifecycleScheduler(app.log);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start when run directly, so tests can import buildServer().
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
