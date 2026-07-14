/**
 * Identity module entry point.
 *
 * `registerIdentityRoutes` is the plugin the server bootstrap wires in. It does
 * two things:
 *
 *  1. Installs the anonymous-session machinery (the `currentUser` decorator and
 *     the onRequest bootstrap hook) on the application, so every request across
 *     every module carries a real user.
 *  2. Registers the identity HTTP surface: GET /api/me and the magic-link
 *     upgrade endpoints.
 *
 * Encapsulation note: Fastify isolates a plugin's decorators and hooks to its
 * own child context by default. The session hook must apply to routes in other
 * modules too (e.g. Content), so this plugin opts out of encapsulation the same
 * way `fastify-plugin` does - by tagging the function with the internal
 * `skip-override` symbol. That dependency is not available to this module, so
 * we set the symbol directly rather than pulling it in. The effect is that
 * `attachSession` runs against the root instance and the session applies
 * globally.
 */
import type { FastifyInstance } from "fastify";
import { attachSession } from "./session.js";
import { registerMagicLinkRoutes } from "./magic-link.js";

export async function registerIdentityRoutes(app: FastifyInstance) {
  attachSession(app);

  // GET /api/me - the current user, created on the fly by the session hook if
  // this is a first visit. Always returns a real user row.
  app.get("/api/me", async (request) => {
    return { user: request.currentUser };
  });

  registerMagicLinkRoutes(app);
}

// Opt out of Fastify's plugin encapsulation so the session decorator and hook
// land on the root instance and cover every module's routes. This mirrors what
// `fastify-plugin` does; see the encapsulation note above.
(registerIdentityRoutes as unknown as Record<symbol, boolean>)[
  Symbol.for("skip-override")
] = true;

// Re-export the guard so sibling modules can require a session with a single
// import from the identity module surface.
export { authGuard, requireUser } from "./session.js";
