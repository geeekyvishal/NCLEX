/**
 * Generation-job repository: the API <-> AI worker boundary.
 *
 * `enqueue` records a job row and pushes a `GenerationJobRequest` onto the
 * Redis work queue for the worker to consume. `subscribeProgress` relays the
 * worker's progress events (published on a shared pub/sub channel) for a single
 * job, which the WebSocket handler forwards to the client.
 */
import { GenerationJobRequest, JobProgress } from "@nclex/domain";
import type { JobProgress as JobProgressType } from "@nclex/domain";
import { JOB_QUEUE_KEY, JOB_PROGRESS_CHANNEL } from "../config.js";
import { query } from "./db.js";
import { getRedis, createSubscriber } from "./redis.js";

interface JobIdRow {
  id: string;
}

export const jobs = {
  /**
   * Create a job row and enqueue its request for the worker.
   *
   * The row is written first so the job is durable even if the process dies
   * before the push; the worker treats the Redis list purely as a dispatch
   * signal and reads authoritative state from Postgres.
   */
  async enqueue(deckId: string, sourceId: string, storageKey: string): Promise<string> {
    const { rows } = await query<JobIdRow>(
      `INSERT INTO generation_jobs (deck_id, source_id) VALUES ($1, $2) RETURNING id`,
      [deckId, sourceId],
    );
    const jobId = rows[0].id;

    // Validate the payload against the shared contract before it crosses the
    // language boundary to the Python worker. `.parse` also applies the
    // schema default for `targetCardCount`.
    const request = GenerationJobRequest.parse({
      jobId,
      deckId,
      sourceId,
      storageKey,
    });

    await getRedis().lpush(JOB_QUEUE_KEY, JSON.stringify(request));
    return jobId;
  },

  /**
   * Subscribe to worker progress for one job. Returns an unsubscribe function
   * that removes the listener and closes the dedicated subscriber connection.
   *
   * A fresh connection is used per subscription because ioredis puts a
   * connection into subscriber mode on subscribe, after which it can no longer
   * run ordinary commands. Messages for other jobs on the shared channel are
   * ignored, and malformed payloads are dropped rather than thrown so one bad
   * event cannot tear down the relay.
   */
  subscribeProgress(jobId: string, onEvent: (p: JobProgressType) => void): () => void {
    const subscriber = createSubscriber();

    const handleMessage = (channel: string, raw: string): void => {
      if (channel !== JOB_PROGRESS_CHANNEL) return;
      const parsed = JobProgress.safeParse(safeJson(raw));
      if (!parsed.success) return;
      if (parsed.data.jobId !== jobId) return;
      onEvent(parsed.data);
    };

    subscriber.on("message", handleMessage);
    void subscriber.subscribe(JOB_PROGRESS_CHANNEL);

    return () => {
      subscriber.off("message", handleMessage);
      void subscriber.quit();
    };
  },
};

/** Parse JSON without throwing; returns undefined on malformed input. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
