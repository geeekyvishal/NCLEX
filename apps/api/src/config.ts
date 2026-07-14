/**
 * Environment configuration, parsed and validated once at boot.
 * Every module reads config from here rather than touching process.env.
 */
import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

// Load .env from the workspace root in development.
// In production env vars are injected directly so this is a no-op.
dotenvConfig({ path: new URL("../../../.env", import.meta.url).pathname });

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  SESSION_COOKIE_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("NCLEX <noreply@nclex.local>"),
  WEB_URL: z.string().default("http://localhost:3000"),
  SOURCE_RETENTION_DAYS: z.coerce.number().default(7),
});

export const config = Env.parse(process.env);
export type Config = z.infer<typeof Env>;

/** Redis key/channel the AI worker publishes job progress to. */
export const JOB_PROGRESS_CHANNEL = "job:progress";
/** Redis list the API pushes generation jobs onto for the worker to consume. */
export const JOB_QUEUE_KEY = "job:generation:queue";
