from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "centralino.sqlite3"
KNOWLEDGE_PATH = DATA_DIR / "knowledge.txt"

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID", "")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
ELEVENLABS_VERIFY_SSL = os.getenv("ELEVENLABS_VERIFY_SSL", "true").lower() not in {
    "0",
    "false",
    "no",
}
DEV_ORIGINS = {
    FRONTEND_ORIGIN,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
}

app = FastAPI(title="Centralino AI MVP")

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(DEV_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class KnowledgePayload(BaseModel):
    text: str = Field(default="", max_length=40_000)


class AppointmentIn(BaseModel):
    customer_name: str = Field(min_length=1, max_length=160)
    date: str = Field(min_length=4, max_length=32)
    time: str = Field(min_length=2, max_length=32)
    phone: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=1000)


class Appointment(AppointmentIn):
    id: int
    created_at: str


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not KNOWLEDGE_PATH.exists():
        KNOWLEDGE_PATH.write_text(
            "Siamo uno studio demo. Orari: lunedi-venerdi 09:00-18:00. "
            "Per fissare un appuntamento servono nome, data, ora e motivo.",
            encoding="utf-8",
        )

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_name TEXT NOT NULL,
                phone TEXT,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                notes TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def row_to_appointment(row: sqlite3.Row) -> Appointment:
    return Appointment(
        id=row["id"],
        customer_name=row["customer_name"],
        phone=row["phone"],
        date=row["date"],
        time=row["time"],
        notes=row["notes"],
        created_at=row["created_at"],
    )


@app.on_event("startup")
def on_startup() -> None:
    ensure_storage()


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "agent_configured": bool(ELEVENLABS_AGENT_ID),
        "signed_url_available": bool(ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY),
    }


@app.get("/api/knowledge")
def get_knowledge() -> KnowledgePayload:
    ensure_storage()
    return KnowledgePayload(text=KNOWLEDGE_PATH.read_text(encoding="utf-8"))


@app.put("/api/knowledge")
def save_knowledge(payload: KnowledgePayload) -> KnowledgePayload:
    ensure_storage()
    KNOWLEDGE_PATH.write_text(payload.text.strip(), encoding="utf-8")
    return KnowledgePayload(text=payload.text.strip())


@app.get("/api/elevenlabs/signed-url")
async def get_signed_url() -> dict[str, str]:
    if not ELEVENLABS_AGENT_ID:
        raise HTTPException(status_code=500, detail="ELEVENLABS_AGENT_ID is missing")
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY is missing")

    url = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"
    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    params = {"agent_id": ELEVENLABS_AGENT_ID}

    try:
        async with httpx.AsyncClient(timeout=15, verify=ELEVENLABS_VERIFY_SSL) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Cannot reach ElevenLabs: {exc}",
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs signed URL error: {response.text}",
        )

    data = response.json()
    signed_url = data.get("signed_url")
    if not signed_url:
        raise HTTPException(status_code=502, detail="ElevenLabs response missing signed_url")

    return {"signed_url": signed_url}


@app.get("/api/elevenlabs/conversation-token")
async def get_conversation_token() -> dict[str, str]:
    if not ELEVENLABS_AGENT_ID:
        raise HTTPException(status_code=500, detail="ELEVENLABS_AGENT_ID is missing")

    url = "https://api.elevenlabs.io/v1/convai/conversation/token"
    headers = {"xi-api-key": ELEVENLABS_API_KEY} if ELEVENLABS_API_KEY else {}
    params = {"agent_id": ELEVENLABS_AGENT_ID}

    try:
        async with httpx.AsyncClient(timeout=15, verify=ELEVENLABS_VERIFY_SSL) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Cannot reach ElevenLabs: {exc}",
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs conversation token error: {response.text}",
        )

    data = response.json()
    token = data.get("token")
    if not token:
        raise HTTPException(status_code=502, detail="ElevenLabs response missing token")

    return {"token": token}


@app.post("/api/appointments", response_model=Appointment)
def create_appointment(payload: AppointmentIn) -> Appointment:
    ensure_storage()
    created_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            """
            INSERT INTO appointments (customer_name, phone, date, time, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload.customer_name.strip(),
                payload.phone.strip() if payload.phone else None,
                payload.date.strip(),
                payload.time.strip(),
                payload.notes.strip() if payload.notes else None,
                created_at,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM appointments WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()

    return row_to_appointment(row)


@app.get("/api/appointments", response_model=list[Appointment])
def list_appointments() -> list[Appointment]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM appointments ORDER BY date ASC, time ASC, id DESC"
        ).fetchall()
    return [row_to_appointment(row) for row in rows]
