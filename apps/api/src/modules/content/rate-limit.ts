import type { FastifyRequest, FastifyReply } from "fastify";
import { clients } from "../../infra/index.js";
import { requireUser } from "../identity/session.js";

const UPLOAD_LIMIT = 5;
const WINDOW_SECONDS = 3600; // 1 hour

/**
 * Fastify preHandler hook to rate-limit PDF uploads by user session ID and IP.
 * Only applies to anonymous sessions to protect LLM costs.
 */
export async function rateLimitUpload(request: FastifyRequest, reply: FastifyReply) {
  const user = requireUser(request);
  if (user.kind !== "anonymous") {
    return;
  }

  const ip = request.ip;
  const redis = clients.redis();
  const userKey = `rl:upload:user:${user.id}`;
  const ipKey = `rl:upload:ip:${ip}`;

  const checkKey = async (key: string): Promise<boolean> => {
    const multi = redis.multi();
    multi.incr(key);
    multi.ttl(key);
    const results = await multi.exec();
    if (!results) {
      return false;
    }

    const countVal = results[0][1];
    const ttlVal = results[1][1];

    const count = typeof countVal === "number" ? countVal : parseInt(String(countVal), 10);
    const ttl = typeof ttlVal === "number" ? ttlVal : parseInt(String(ttlVal), 10);

    if (count === 1 || ttl === -1) {
      await redis.expire(key, WINDOW_SECONDS);
    }

    return count > UPLOAD_LIMIT;
  };

  const [userLimited, ipLimited] = await Promise.all([
    checkKey(userKey),
    checkKey(ipKey),
  ]);

  if (userLimited || ipLimited) {
    request.log.warn(
      { userId: user.id, ip, userLimited, ipLimited },
      "Upload rate limit exceeded",
    );
    return reply.status(429).send({
      error: "Upload limit exceeded. Please try again later.",
    });
  }
}
