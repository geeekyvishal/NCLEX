/**
 * Anonymous session bootstrap for the no-signup demo flow.
 *
 * Every request carries a signed, httpOnly session cookie that maps to a real
 * user row. If a visitor arrives without a valid cookie, an anonymous user is
 * created on the spot and the cookie is set, so any work they do (generated
 * decks) is attached to a durable id from the very first request. That same id
 * is later upgraded in place to a registered account, which is what lets the
 * anonymous user's decks carry over on sign-in.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@nclex/domain";
import { users } from "../../infra/index.js";
import { config } from "../../config.js";

/** Name of the signed session cookie that holds the user id. */
export const SESSION_COOKIE = "sid";

/**
 * Anonymous sessions are long-lived so demo work is never lost between visits.
 * The cookie is refreshed on every request that establishes a session.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 365;

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The user for this request. Populated by the session hook before any
     * route handler runs, so handlers registered after the hook can rely on it
     * being present. Typed nullable for honesty against the decorated default.
     */
    currentUser: User | null;
  }
}

/** Cookie options shared by session creation and refresh, so they never drift. */
function sessionCookieOptions() {
  return {
    signed: true as const,
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: config.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/** Set (or refresh) the signed session cookie to point at a user id. */
export function setSessionCookie(reply: FastifyReply, userId: string): void {
  reply.setCookie(SESSION_COOKIE, userId, sessionCookieOptions());
}

/** Read and verify the user id from the signed session cookie, if present. */
function readSessionUserId(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  return unsigned.value;
}

/**
 * Wire the session decorator and the onRequest bootstrap hook onto `app`.
 *
 * Called from the identity plugin, which runs on the root instance (see the
 * skip-override note in routes.ts), so this hook applies to every route in the
 * application, including modules registered afterwards.
 */
export function attachSession(app: FastifyInstance): void {
  app.decorateRequest("currentUser", null);

  app.addHook("onRequest", async (request, reply) => {
    const userId = readSessionUserId(request);
    if (userId) {
      const existing = await users.findById(userId);
      if (existing) {
        request.currentUser = existing;
        return;
      }
    }

    // No valid session cookie: every visitor becomes a real user row. This is
    // the mechanism that makes the no-signup demo work.
    const created = await users.createAnonymous();
    request.currentUser = created;
    setSessionCookie(reply, created.id);
  });
}

/**
 * preHandler guard that other modules import to require an established session.
 * The session hook guarantees a user for normal traffic; this is a defensive
 * check that fails closed with a 401 if one is somehow absent.
 */
export async function authGuard(request: FastifyRequest): Promise<void> {
  if (!request.currentUser) {
    const err = new Error("authentication required") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
}

/** Narrow the nullable decorator to a non-null User for handler code. */
export function requireUser(request: FastifyRequest): User {
  if (!request.currentUser) {
    throw new Error("expected an established session but request.currentUser was null");
  }
  return request.currentUser;
}
