"""
AI worker service - STUB entrypoint.

The AI-worker agent implements the full pipeline under app/: PDF parse, chunk,
embed, generate (Claude), verify (separate Claude pass), rank, and publish
progress to Redis. This file only establishes the FastAPI app and a health
check so the service is runnable from day one.
"""
from fastapi import FastAPI

app = FastAPI(title="NCLEX AI Worker", version="0.1.0")


@app.get("/health")
async def health() -> dict:
    return {"ok": True}
