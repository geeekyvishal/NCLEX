"""Queue consumer daemon for card generation jobs.

Continuously polls the Redis job queue and runs the generation pipeline for each enqueued request.
"""
from __future__ import annotations

import asyncio
import json
import logging
import signal
import redis.asyncio as aioredis

from .config import settings
from .schemas import GenerationJobRequest
from .pipeline import run_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


async def main() -> None:
    """Daemon entrypoint for polling Redis queue and running jobs."""
    logger.info("Starting NCLEX AI worker daemon...")

    redis_client = aioredis.from_url(settings.redis_url)

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def handle_shutdown() -> None:
        logger.info("Received shutdown signal. Stopping worker loop...")
        stop_event.set()

    # Register signal handlers for clean termination on macOS/Linux.
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_shutdown)

    logger.info("Waiting for jobs on queue: %s", settings.job_queue_key)

    while not stop_event.is_set():
        try:
            # Poll with timeout to allow check of stop_event.
            res = await redis_client.brpop(settings.job_queue_key, timeout=1)
            if res is None:
                continue

            _, raw_val = res
            logger.info("Popped job payload from Redis.")

            try:
                data = json.loads(raw_val)
                request = GenerationJobRequest.model_validate(data)
            except Exception as exc:
                logger.error(
                    "Failed to parse/validate job payload: %s. Raw: %s",
                    exc,
                    raw_val,
                )
                continue

            logger.info("Starting pipeline execution for job %s", request.job_id)
            await run_pipeline(request, redis_client=redis_client)
            logger.info("Finished pipeline execution for job %s", request.job_id)

        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.exception("Error in worker daemon loop: %s", exc)
            await asyncio.sleep(2)

    await redis_client.aclose()
    logger.info("Worker daemon stopped.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Interrupted. Exiting...")
