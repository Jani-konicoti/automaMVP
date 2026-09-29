from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, HTTPException, Request, Response


INTERNAL_API_URL = os.getenv(
    "INTERNAL_API_URL",
    "http://127.0.0.1:8001",
).rstrip("/")
MAX_REQUEST_BYTES = 5 * 1024 * 1024
PUBLIC_ROUTES = {
    "/api/tools/search-knowledge",
    "/api/tools/schedule-appointment",
    "/api/webhooks/elevenlabs/post-call",
}

public_app = FastAPI(
    title="JK Automa Webhook Gateway",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


async def forward_request(path: str, request: Request) -> Response:
    if path not in PUBLIC_ROUTES:
        raise HTTPException(status_code=404, detail="Not found")

    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="Request too large")

    headers = {"Content-Type": request.headers.get("Content-Type", "application/json")}
    tool_secret = request.headers.get("X-JK-Automa-Key")
    signature = request.headers.get("ElevenLabs-Signature")
    if tool_secret:
        headers["X-JK-Automa-Key"] = tool_secret
    if signature:
        headers["ElevenLabs-Signature"] = signature

    try:
        async with httpx.AsyncClient(timeout=35) as client:
            upstream = await client.post(
                f"{INTERNAL_API_URL}{path}",
                content=body,
                headers=headers,
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Backend JK Automa non raggiungibile") from exc

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )


@public_app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@public_app.post("/api/tools/search-knowledge")
async def search_knowledge(request: Request) -> Response:
    return await forward_request("/api/tools/search-knowledge", request)


@public_app.post("/api/tools/schedule-appointment")
async def schedule_appointment(request: Request) -> Response:
    return await forward_request("/api/tools/schedule-appointment", request)


@public_app.post("/api/webhooks/elevenlabs/post-call")
async def post_call(request: Request) -> Response:
    return await forward_request("/api/webhooks/elevenlabs/post-call", request)
