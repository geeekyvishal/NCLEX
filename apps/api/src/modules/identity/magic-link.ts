/**
 * Magic-link upgrade flow (demo-grade).
 *
 * There is no real email delivery in this phase. `POST /api/auth/magic-link`
 * mints a short-lived token bound to the current session's user id and the
 * email being claimed, then in non-production returns the token so the flow can
 * be exercised end to end. `POST /api/auth/verify` consumes the token and
 * upgrades that same user row in place.
 *
 * The crucial property: the upgrade keeps the same user id. An anonymous
 * visitor's decks are owned by that id, so upgrading in place - rather than
 * creating a fresh account - is what makes their demo work carry over.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { users } from "../../infra/index.js";
import { config } from "../../config.js";
import { requireUser, setSessionCookie } from "./session.js";
import {
  consumeMagicToken,
  createMagicToken,
  getRedis,
  MAGIC_TOKEN_TTL_SECONDS,
} from "./tokens.js";
import { sendEmail } from "./email.js";

const MagicLinkBody = z.object({
  email: z.string().email(),
});

const VerifyBody = z.object({
  token: z.string().min(1),
});

const isProduction = config.NODE_ENV === "production";

/** Register the two magic-link endpoints on the identity route surface. */
export function registerMagicLinkRoutes(app: FastifyInstance): void {
  app.post("/api/auth/magic-link", async (request, reply) => {
    const parsed = MagicLinkBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid email" });
    }

    // Bind the token to the current session's user so the eventual upgrade
    // lands on the same row whose decks we want to preserve.
    const user = requireUser(request);
    const email = parsed.data.email.toLowerCase().trim();

    const token = await createMagicToken(getRedis(), { userId: user.id, email });

    const verificationUrl = `${config.WEB_URL}/auth/verify?token=${token}`;

    // Send the magic link email
    await sendEmail({
      to: email,
      subject: "Your NCLEX App Magic Link",
      html: `
        <p>Hello,</p>
        <p>Use the link below to sign in and save your decks:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>This link is valid for 15 minutes.</p>
      `,
    });

    request.log.info(
      { userId: user.id, email, ttlSeconds: MAGIC_TOKEN_TTL_SECONDS },
      "magic-link token issued and email sent",
    );

    const response: { sent: true; token?: string } = { sent: true };
    if (!isProduction) {
      response.token = token;
    }
    return reply.send(response);
  });

  app.post("/api/auth/verify", async (request, reply) => {
    const parsed = VerifyBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid token" });
    }

    const payload = await consumeMagicToken(getRedis(), parsed.data.token);
    if (!payload) {
      return reply.status(400).send({ error: "token invalid or expired" });
    }

    // Upgrade in place: same id, so decks and every other row keyed by userId
    // stay attached. This is the anonymous -> registered carry-over.
    const user = await users.upgradeToRegistered(payload.userId, payload.email, "registered");

    // Refresh the session cookie onto the (unchanged) id so the browser keeps a
    // valid signed session for the now-registered user.
    setSessionCookie(reply, user.id);

    return reply.send({ user });
  });
}
