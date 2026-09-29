from __future__ import annotations

import os
import json
import hashlib
import hmac
import math
import re
import secrets
import sqlite3
import time
from collections import Counter
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
from pydantic import BaseModel, Field

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "centralino.sqlite3"
KNOWLEDGE_PATH = DATA_DIR / "knowledge.txt"
BEHAVIOR_PATH = DATA_DIR / "behavior.txt"
DOCUMENTATION_PATH = DATA_DIR / "documentation.txt"

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

app = FastAPI(title="JK Automa")

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(DEV_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class KnowledgePayload(BaseModel):
    behavior: str = Field(default="", max_length=20_000)
    documentation: str = Field(default="", max_length=80_000)


class DocumentationPayload(BaseModel):
    documentation: str = Field(default="", max_length=80_000)


class PdfKnowledgeResult(KnowledgePayload):
    extracted_text: str
    extracted_chars: int
    pages: int


class BotBehaviorIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    content: str = Field(default="", max_length=20_000)


class BotBehavior(BotBehaviorIn):
    id: int
    is_active: bool
    created_at: str
    updated_at: str


class ElevenLabsAgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    agent_id: str = Field(min_length=1, max_length=180)


class ElevenLabsAgent(ElevenLabsAgentIn):
    id: int
    is_active: bool
    created_at: str
    updated_at: str


class ElevenLabsConfigIn(BaseModel):
    api_key: str = Field(default="", max_length=300)


class ElevenLabsDefaultsIn(BaseModel):
    inbound_agent_id: str | None = Field(default=None, max_length=180)
    outbound_agent_id: str | None = Field(default=None, max_length=180)
    presentation_agent_id: str | None = Field(default=None, max_length=180)


class ElevenLabsConfig(BaseModel):
    api_key: str
    agents: list[ElevenLabsAgent]
    active_agent_id: str | None
    inbound_agent_id: str | None
    outbound_agent_id: str | None
    presentation_agent_id: str | None
    inbound_source: str | None
    outbound_source: str | None
    presentation_source: str | None
    public_base_url: str
    tool_webhook_secret: str
    post_call_webhook_secret: str
    configured: bool


class ElevenLabsIntegrationIn(BaseModel):
    public_base_url: str = Field(default="", max_length=500)
    post_call_webhook_secret: str = Field(default="", max_length=500)


class FlowSourceIn(BaseModel):
    flow: str = Field(pattern="^(centralino-entrata|centralino-uscita|presentazione)$")
    source: str | None = Field(default=None, max_length=500)


class ElevenLabsPhoneNumber(BaseModel):
    phone_number_id: str
    label: str
    phone_number: str
    provider: str
    supports_outbound: bool = True


class VectorStoreStats(BaseModel):
    chunks: int
    sources: int


class VectorStorePdfResult(VectorStoreStats):
    source: str
    pages: int
    extracted_chars: int


class VectorStoreSource(BaseModel):
    source: str
    chunks: int
    chars: int
    preview: str


class VectorSearchResult(BaseModel):
    id: int
    source: str
    chunk_index: int
    score: float
    text: str


class VectorSearchResponse(BaseModel):
    results: list[VectorSearchResult]


class AppointmentIn(BaseModel):
    customer_name: str = Field(min_length=1, max_length=160)
    date: str = Field(min_length=4, max_length=32)
    time: str = Field(min_length=2, max_length=32)
    phone: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=1000)


class Appointment(AppointmentIn):
    id: int
    created_at: str


class OutboundContactIn(BaseModel):
    reference: str = Field(min_length=1, max_length=160)
    phone: str = Field(min_length=3, max_length=40)


class OutboundContact(OutboundContactIn):
    id: int
    created_at: str
    updated_at: str


class OutboundCallIn(BaseModel):
    contact_id: int
    agent_id: str = Field(min_length=1, max_length=180)
    agent_phone_number_id: str = Field(min_length=1, max_length=180)
    source: str | None = Field(default=None, max_length=500)


class OutboundCall(BaseModel):
    id: int
    contact_id: int | None
    reference: str
    phone: str
    agent_id: str
    agent_phone_number_id: str | None
    source: str | None
    conversation_id: str | None
    call_sid: str | None
    status: str
    transcript: str
    error: str | None
    created_at: str
    updated_at: str
    completed_at: str | None


class ToolKnowledgeIn(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=4, ge=1, le=6)
    conversation_id: str | None = Field(default=None, max_length=180)
    agent_id: str | None = Field(default=None, max_length=180)
    knowledge_source: str | None = Field(default=None, max_length=500)


TOKEN_RE = re.compile(r"[a-zA-ZÀ-ÿ0-9]{2,}")
STOPWORDS = {
    "alla",
    "alle",
    "allo",
    "anche",
    "che",
    "con",
    "dei",
    "del",
    "della",
    "delle",
    "dello",
    "gli",
    "il",
    "in",
    "la",
    "le",
    "lo",
    "nel",
    "nella",
    "per",
    "piu",
    "puo",
    "sul",
    "sulla",
    "tra",
    "una",
    "uno",
}


def split_legacy_knowledge(text: str) -> tuple[str, str]:
    markers = [
        "Vendiamo questo software",
        "NexaFlow 3.0",
        "INTRODUZIONE",
    ]
    for marker in markers:
        index = text.find(marker)
        if index > 0:
            return text[:index].strip(), text[index:].strip()

    return (
        "Rispondi in italiano, in modo naturale, breve e professionale.",
        text.strip(),
    )


def ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not BEHAVIOR_PATH.exists() or not DOCUMENTATION_PATH.exists():
        if KNOWLEDGE_PATH.exists():
            behavior, documentation = split_legacy_knowledge(
                KNOWLEDGE_PATH.read_text(encoding="utf-8")
            )
        else:
            behavior = (
                "Rispondi in italiano, in modo naturale, breve e professionale. "
                "Per fissare un appuntamento raccogli nome, data, ora e motivo. "
                "Non dire mai l'ID dell'appuntamento."
            )
            documentation = (
                "Siamo CP DEMO. Orari: lunedi-venerdi 09:00-18:00."
            )

        if not BEHAVIOR_PATH.exists():
            BEHAVIOR_PATH.write_text(behavior, encoding="utf-8")
        if not DOCUMENTATION_PATH.exists():
            DOCUMENTATION_PATH.write_text(documentation, encoding="utf-8")

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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS outbound_contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reference TEXT NOT NULL,
                phone TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS vector_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                vector_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_vector_chunks_source
            ON vector_chunks (source)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bot_behaviors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS elevenlabs_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                api_key TEXT NOT NULL DEFAULT '',
                inbound_agent_id TEXT,
                outbound_agent_id TEXT,
                presentation_agent_id TEXT,
                inbound_source TEXT,
                outbound_source TEXT,
                presentation_source TEXT,
                public_base_url TEXT NOT NULL DEFAULT '',
                tool_webhook_secret TEXT NOT NULL DEFAULT '',
                post_call_webhook_secret TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS elevenlabs_agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        config_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(elevenlabs_config)").fetchall()
        }
        for column_name in (
            "inbound_agent_id",
            "outbound_agent_id",
            "presentation_agent_id",
            "inbound_source",
            "outbound_source",
            "presentation_source",
        ):
            if column_name not in config_columns:
                conn.execute(f"ALTER TABLE elevenlabs_config ADD COLUMN {column_name} TEXT")
        for column_name in (
            "public_base_url",
            "tool_webhook_secret",
            "post_call_webhook_secret",
        ):
            if column_name not in config_columns:
                conn.execute(
                    f"ALTER TABLE elevenlabs_config ADD COLUMN {column_name} "
                    "TEXT NOT NULL DEFAULT ''"
                )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS outbound_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id INTEGER,
                reference TEXT NOT NULL,
                phone TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                agent_phone_number_id TEXT,
                source TEXT,
                conversation_id TEXT UNIQUE,
                call_sid TEXT,
                status TEXT NOT NULL,
                transcript_json TEXT,
                transcript_text TEXT NOT NULL DEFAULT '',
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY (contact_id) REFERENCES outbound_contacts(id)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_outbound_calls_created_at
            ON outbound_calls (created_at DESC)
            """
        )
        behaviors_count = conn.execute("SELECT COUNT(*) FROM bot_behaviors").fetchone()[0]
        if behaviors_count == 0:
            now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
            content = BEHAVIOR_PATH.read_text(encoding="utf-8").strip()
            conn.execute(
                """
                INSERT INTO bot_behaviors (name, content, is_active, created_at, updated_at)
                VALUES (?, ?, 1, ?, ?)
                """,
                ("Predefinito", content, now, now),
            )
        now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        config_count = conn.execute("SELECT COUNT(*) FROM elevenlabs_config").fetchone()[0]
        if config_count == 0:
            conn.execute(
                """
                INSERT INTO elevenlabs_config (
                    id, api_key, tool_webhook_secret, updated_at
                )
                VALUES (1, ?, ?, ?)
                """,
                (
                    os.getenv("ELEVENLABS_API_KEY", "").strip(),
                    secrets.token_urlsafe(32),
                    now,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE elevenlabs_config
                SET tool_webhook_secret = ?
                WHERE id = 1 AND COALESCE(tool_webhook_secret, '') = ''
                """,
                (secrets.token_urlsafe(32),),
            )
        agents_count = conn.execute("SELECT COUNT(*) FROM elevenlabs_agents").fetchone()[0]
        env_agent_id = os.getenv("ELEVENLABS_AGENT_ID", "").strip()
        if agents_count == 0 and env_agent_id:
            conn.execute(
                """
                INSERT INTO elevenlabs_agents (name, agent_id, is_active, created_at, updated_at)
                VALUES (?, ?, 1, ?, ?)
                """,
                ("Agente principale", env_agent_id, now, now),
            )
        conn.commit()


def row_to_bot_behavior(row: sqlite3.Row) -> BotBehavior:
    return BotBehavior(
        id=row["id"],
        name=row["name"],
        content=row["content"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def list_bot_behaviors() -> list[BotBehavior]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT * FROM bot_behaviors
            ORDER BY is_active DESC, updated_at DESC, id DESC
            """
        ).fetchall()

    return [row_to_bot_behavior(row) for row in rows]


def update_active_bot_behavior(content: str) -> None:
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        active_id = conn.execute(
            "SELECT id FROM bot_behaviors WHERE is_active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if active_id:
            conn.execute(
                """
                UPDATE bot_behaviors
                SET content = ?, updated_at = ?
                WHERE id = ?
                """,
                (content, now, active_id[0]),
            )
        else:
            conn.execute(
                """
                INSERT INTO bot_behaviors (name, content, is_active, created_at, updated_at)
                VALUES (?, ?, 1, ?, ?)
                """,
                ("Predefinito", content, now, now),
            )
        conn.commit()


def row_to_elevenlabs_agent(row: sqlite3.Row) -> ElevenLabsAgent:
    return ElevenLabsAgent(
        id=row["id"],
        name=row["name"],
        agent_id=row["agent_id"],
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def list_elevenlabs_agents() -> list[ElevenLabsAgent]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT * FROM elevenlabs_agents
            ORDER BY is_active DESC, updated_at DESC, id DESC
            """
        ).fetchall()

    return [row_to_elevenlabs_agent(row) for row in rows]


def get_elevenlabs_config_payload() -> ElevenLabsConfig:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        config = conn.execute(
            "SELECT * FROM elevenlabs_config WHERE id = 1"
        ).fetchone()

    api_key = config["api_key"] if config else ""
    agents = list_elevenlabs_agents()
    active_agent = next((agent for agent in agents if agent.is_active), None)
    return ElevenLabsConfig(
        api_key=api_key,
        agents=agents,
        active_agent_id=active_agent.agent_id if active_agent else None,
        inbound_agent_id=config["inbound_agent_id"] if config else None,
        outbound_agent_id=config["outbound_agent_id"] if config else None,
        presentation_agent_id=config["presentation_agent_id"] if config else None,
        inbound_source=config["inbound_source"] if config else None,
        outbound_source=config["outbound_source"] if config else None,
        presentation_source=config["presentation_source"] if config else None,
        public_base_url=config["public_base_url"] if config else "",
        tool_webhook_secret=config["tool_webhook_secret"] if config else "",
        post_call_webhook_secret=config["post_call_webhook_secret"] if config else "",
        configured=bool(api_key and agents),
    )


def get_elevenlabs_credentials(agent_id: str | None = None) -> tuple[str, str]:
    config = get_elevenlabs_config_payload()
    selected_agent_id = agent_id.strip() if agent_id else config.active_agent_id
    if not selected_agent_id:
        raise HTTPException(
            status_code=500,
            detail="Configura almeno un agent_id ElevenLabs",
        )
    if not config.api_key:
        raise HTTPException(
            status_code=500,
            detail="Configura ELEVENLABS_API_KEY nella pagina Configurazione",
        )

    configured_agent_ids = {agent.agent_id for agent in config.agents}
    if selected_agent_id not in configured_agent_ids:
        raise HTTPException(status_code=404, detail="Agent ID non trovato in configurazione")

    return config.api_key, selected_agent_id


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


def row_to_outbound_contact(row: sqlite3.Row) -> OutboundContact:
    return OutboundContact(
        id=row["id"],
        reference=row["reference"],
        phone=row["phone"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def row_to_outbound_call(row: sqlite3.Row) -> OutboundCall:
    return OutboundCall(
        id=row["id"],
        contact_id=row["contact_id"],
        reference=row["reference"],
        phone=row["phone"],
        agent_id=row["agent_id"],
        agent_phone_number_id=row["agent_phone_number_id"],
        source=row["source"],
        conversation_id=row["conversation_id"],
        call_sid=row["call_sid"],
        status=row["status"],
        transcript=row["transcript_text"] or "",
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        completed_at=row["completed_at"],
    )


def extract_pdf_text(contents: bytes) -> tuple[str, int]:
    try:
        reader = PdfReader(BytesIO(contents))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid PDF: {exc}") from exc

    page_texts: list[str] = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot extract text from page {index}: {exc}",
            ) from exc

        cleaned = "\n".join(line.strip() for line in text.splitlines() if line.strip())
        if cleaned:
            page_texts.append(f"[Pagina {index}]\n{cleaned}")

    extracted = "\n\n".join(page_texts).strip()
    if not extracted:
        raise HTTPException(
            status_code=400,
            detail="No selectable text found in PDF. Scanned PDFs need OCR.",
        )

    return extracted, len(reader.pages)


def tokenize(text: str) -> list[str]:
    return [
        token
        for token in TOKEN_RE.findall(text.lower())
        if token not in STOPWORDS and not token.isdigit()
    ]


def embed_text(text: str) -> dict[str, float]:
    counts = Counter(tokenize(text))
    if not counts:
        return {}

    weighted = {token: 1.0 + math.log(count) for token, count in counts.items()}
    norm = math.sqrt(sum(weight * weight for weight in weighted.values()))
    if norm == 0:
        return {}

    return {token: weight / norm for token, weight in weighted.items()}


def chunk_text(text: str, max_chars: int = 1800, overlap: int = 220) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        if len(paragraph) > max_chars:
            if current:
                chunks.append(current.strip())
                current = ""
            start = 0
            while start < len(paragraph):
                chunks.append(paragraph[start : start + max_chars].strip())
                start += max_chars - overlap
            continue

        candidate = f"{current}\n\n{paragraph}".strip() if current else paragraph
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current.strip())
            current = paragraph

    if current:
        chunks.append(current.strip())

    return chunks


def index_vector_chunks(source: str, text: str, replace_source: bool = True) -> int:
    chunks = chunk_text(text)
    if not chunks:
        raise HTTPException(status_code=400, detail="No text chunks to index")

    created_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        if replace_source:
            conn.execute("DELETE FROM vector_chunks WHERE source = ?", (source,))

        inserted = 0
        for index, chunk in enumerate(chunks):
            vector = embed_text(chunk)
            if not vector:
                continue

            conn.execute(
                """
                INSERT INTO vector_chunks (source, chunk_index, text, vector_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    source,
                    index,
                    chunk,
                    json.dumps(vector, ensure_ascii=False),
                    created_at,
                ),
            )
            inserted += 1

        conn.commit()

    if inserted == 0:
        raise HTTPException(status_code=400, detail="No indexable text found")

    return inserted


def search_vector_chunks(
    query: str,
    limit: int = 5,
    source: str | None = None,
) -> list[VectorSearchResult]:
    query_vector = embed_text(query)
    if not query_vector:
        return []

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        if source:
            rows = conn.execute(
                """
                SELECT id, source, chunk_index, text, vector_json
                FROM vector_chunks
                WHERE source = ?
                """,
                (source,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, source, chunk_index, text, vector_json FROM vector_chunks"
            ).fetchall()

    scored: list[VectorSearchResult] = []
    query_terms = set(query_vector)
    for row in rows:
        vector = json.loads(row["vector_json"])
        overlap_terms = query_terms.intersection(vector)
        if not overlap_terms:
            continue

        score = sum(query_vector[term] * vector[term] for term in overlap_terms)
        if score <= 0:
            continue

        scored.append(
            VectorSearchResult(
                id=row["id"],
                source=row["source"],
                chunk_index=row["chunk_index"],
                score=round(score, 4),
                text=row["text"],
            )
        )

    scored.sort(key=lambda item: item.score, reverse=True)
    return scored[:limit]


def get_vector_store_stats() -> VectorStoreStats:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        chunks = conn.execute("SELECT COUNT(*) FROM vector_chunks").fetchone()[0]
        sources = conn.execute(
            "SELECT COUNT(DISTINCT source) FROM vector_chunks"
        ).fetchone()[0]

    return VectorStoreStats(chunks=chunks, sources=sources)


def list_vector_sources() -> list[VectorStoreSource]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT
                source,
                COUNT(*) AS chunks,
                SUM(LENGTH(text)) AS chars,
                MIN(id) AS first_id
            FROM vector_chunks
            GROUP BY source
            ORDER BY source ASC
            """
        ).fetchall()

        sources: list[VectorStoreSource] = []
        for row in rows:
            preview_row = conn.execute(
                "SELECT text FROM vector_chunks WHERE id = ?",
                (row["first_id"],),
            ).fetchone()
            preview = (preview_row["text"] if preview_row else "").strip()
            sources.append(
                VectorStoreSource(
                    source=row["source"],
                    chunks=row["chunks"],
                    chars=row["chars"] or 0,
                    preview=preview[:700],
                )
            )

    return sources


def utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def normalize_public_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if value and not value.startswith("https://"):
        raise HTTPException(
            status_code=400,
            detail="L'URL pubblico deve iniziare con https://",
        )
    return value


def ensure_known_source(source: str | None) -> str | None:
    normalized = source.strip() if source else None
    if not normalized:
        return None

    with sqlite3.connect(DB_PATH) as conn:
        found = conn.execute(
            "SELECT 1 FROM vector_chunks WHERE source = ? LIMIT 1",
            (normalized,),
        ).fetchone()
    if not found:
        raise HTTPException(status_code=400, detail="Fonte PDF non trovata")
    return normalized


def require_tool_secret(provided_secret: str | None) -> None:
    config = get_elevenlabs_config_payload()
    if not provided_secret or not hmac.compare_digest(
        provided_secret,
        config.tool_webhook_secret,
    ):
        raise HTTPException(status_code=401, detail="Webhook tool non autorizzato")


def resolve_tool_source(
    conversation_id: str | None,
    agent_id: str | None,
    requested_source: str | None,
) -> str | None:
    if requested_source:
        return ensure_known_source(requested_source)

    if conversation_id:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT source FROM outbound_calls WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        if row and row[0]:
            return row[0]

    if not agent_id:
        return None

    config = get_elevenlabs_config_payload()
    agent_source_pairs = (
        (config.inbound_agent_id, config.inbound_source),
        (config.outbound_agent_id, config.outbound_source),
        (config.presentation_agent_id, config.presentation_source),
    )
    for configured_agent_id, source in agent_source_pairs:
        if configured_agent_id == agent_id:
            return source
    return None


def verify_elevenlabs_signature(
    raw_body: bytes,
    signature_header: str | None,
    secret: str,
) -> None:
    if not secret:
        raise HTTPException(status_code=503, detail="Webhook post-call non configurato")
    if not signature_header:
        raise HTTPException(status_code=401, detail="Firma ElevenLabs mancante")

    try:
        values = dict(
            part.split("=", 1) for part in signature_header.split(",") if "=" in part
        )
        timestamp = values["t"]
        signature = values["v0"]
        if abs(time.time() - int(timestamp)) > 30 * 60:
            raise ValueError("Firma scaduta")
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Firma ElevenLabs non valida") from exc

    expected = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + raw_body,
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="Firma ElevenLabs non valida")


def transcript_to_text(transcript: Any) -> str:
    if not isinstance(transcript, list):
        return ""

    lines: list[str] = []
    for entry in transcript:
        if not isinstance(entry, dict):
            continue
        message = entry.get("message")
        if not isinstance(message, str) or not message.strip():
            continue
        role = entry.get("role")
        label = "Agente" if role in {"agent", "ai"} else "Utente"
        lines.append(f"{label}: {message.strip()}")
    return "\n\n".join(lines)


@app.on_event("startup")
def on_startup() -> None:
    ensure_storage()


@app.get("/api/health")
def health() -> dict[str, Any]:
    config = get_elevenlabs_config_payload()
    return {
        "ok": True,
        "agent_configured": bool(config.agents),
        "signed_url_available": config.configured,
    }


@app.get("/api/knowledge")
def get_knowledge() -> KnowledgePayload:
    ensure_storage()
    return KnowledgePayload(
        behavior=BEHAVIOR_PATH.read_text(encoding="utf-8"),
        documentation=DOCUMENTATION_PATH.read_text(encoding="utf-8"),
    )


@app.put("/api/knowledge")
def save_knowledge(payload: KnowledgePayload) -> KnowledgePayload:
    ensure_storage()
    behavior = payload.behavior.strip()
    documentation = payload.documentation.strip()
    BEHAVIOR_PATH.write_text(behavior, encoding="utf-8")
    update_active_bot_behavior(behavior)
    DOCUMENTATION_PATH.write_text(documentation, encoding="utf-8")
    return KnowledgePayload(behavior=behavior, documentation=documentation)


@app.put("/api/knowledge/documentation", response_model=KnowledgePayload)
def save_documentation(payload: DocumentationPayload) -> KnowledgePayload:
    ensure_storage()
    documentation = payload.documentation.strip()
    DOCUMENTATION_PATH.write_text(documentation, encoding="utf-8")
    return KnowledgePayload(
        behavior=BEHAVIOR_PATH.read_text(encoding="utf-8"),
        documentation=documentation,
    )


@app.get("/api/behaviors", response_model=list[BotBehavior])
def get_bot_behaviors() -> list[BotBehavior]:
    return list_bot_behaviors()


@app.post("/api/behaviors", response_model=BotBehavior)
def create_bot_behavior(payload: BotBehaviorIn) -> BotBehavior:
    ensure_storage()
    name = payload.name.strip()
    content = payload.content.strip()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("UPDATE bot_behaviors SET is_active = 0")
        cursor = conn.execute(
            """
            INSERT INTO bot_behaviors (name, content, is_active, created_at, updated_at)
            VALUES (?, ?, 1, ?, ?)
            """,
            (name, content, now, now),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM bot_behaviors WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()

    BEHAVIOR_PATH.write_text(content, encoding="utf-8")
    return row_to_bot_behavior(row)


@app.put("/api/behaviors/{behavior_id}", response_model=BotBehavior)
def update_bot_behavior(behavior_id: int, payload: BotBehaviorIn) -> BotBehavior:
    ensure_storage()
    name = payload.name.strip()
    content = payload.content.strip()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM bot_behaviors WHERE id = ?",
            (behavior_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Behavior not found")

        conn.execute(
            """
            UPDATE bot_behaviors
            SET name = ?, content = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, content, now, behavior_id),
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM bot_behaviors WHERE id = ?",
            (behavior_id,),
        ).fetchone()

    if updated["is_active"]:
        BEHAVIOR_PATH.write_text(content, encoding="utf-8")
    return row_to_bot_behavior(updated)


@app.post("/api/behaviors/{behavior_id}/activate", response_model=BotBehavior)
def activate_bot_behavior(behavior_id: int) -> BotBehavior:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM bot_behaviors WHERE id = ?",
            (behavior_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Behavior not found")

        now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        conn.execute("UPDATE bot_behaviors SET is_active = 0")
        conn.execute(
            """
            UPDATE bot_behaviors
            SET is_active = 1, updated_at = ?
            WHERE id = ?
            """,
            (now, behavior_id),
        )
        conn.commit()
        active = conn.execute(
            "SELECT * FROM bot_behaviors WHERE id = ?",
            (behavior_id,),
        ).fetchone()

    BEHAVIOR_PATH.write_text(active["content"], encoding="utf-8")
    return row_to_bot_behavior(active)


@app.post("/api/knowledge/pdf", response_model=PdfKnowledgeResult)
async def upload_pdf_knowledge(
    file: UploadFile = File(...),
    mode: str = Query(default="append", pattern="^(append|replace)$"),
) -> PdfKnowledgeResult:
    ensure_storage()
    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Upload must be a PDF")

    contents = await file.read()
    if len(contents) > 12 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF is too large")

    extracted_text, pages = extract_pdf_text(contents)
    behavior = BEHAVIOR_PATH.read_text(encoding="utf-8").strip()
    current_documentation = DOCUMENTATION_PATH.read_text(encoding="utf-8").strip()
    title = file.filename or "documento.pdf"
    pdf_block = f"DOCUMENTO PDF: {title}\n\n{extracted_text}".strip()

    if mode == "replace" or not current_documentation:
        documentation = pdf_block
    else:
        documentation = f"{current_documentation}\n\n---\n\n{pdf_block}".strip()

    DOCUMENTATION_PATH.write_text(documentation, encoding="utf-8")
    return PdfKnowledgeResult(
        behavior=behavior,
        documentation=documentation,
        extracted_text=extracted_text,
        extracted_chars=len(extracted_text),
        pages=pages,
    )


@app.get("/api/vector-store/stats", response_model=VectorStoreStats)
def vector_store_stats() -> VectorStoreStats:
    return get_vector_store_stats()


@app.get("/api/vector-store/sources", response_model=list[VectorStoreSource])
def vector_store_sources() -> list[VectorStoreSource]:
    return list_vector_sources()


@app.post("/api/vector-store/documentation", response_model=VectorStoreStats)
def index_documentation() -> VectorStoreStats:
    ensure_storage()
    documentation = DOCUMENTATION_PATH.read_text(encoding="utf-8")
    index_vector_chunks("Documentazione manuale", documentation)
    return get_vector_store_stats()


@app.post("/api/vector-store/pdf", response_model=VectorStorePdfResult)
async def upload_pdf_vector_store(
    file: UploadFile = File(...),
    mode: str = Query(default="replace", pattern="^(append|replace)$"),
) -> VectorStorePdfResult:
    ensure_storage()
    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Upload must be a PDF")

    contents = await file.read()
    if len(contents) > 24 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF is too large")

    extracted_text, pages = extract_pdf_text(contents)
    source = file.filename or "documento.pdf"
    chunks = index_vector_chunks(source, extracted_text, replace_source=mode == "replace")
    stats = get_vector_store_stats()
    return VectorStorePdfResult(
        chunks=stats.chunks,
        sources=stats.sources,
        source=source,
        pages=pages,
        extracted_chars=len(extracted_text),
    )


@app.get("/api/vector-store/search", response_model=VectorSearchResponse)
def search_vector_store(
    q: str = Query(min_length=2, max_length=1000),
    limit: int = Query(default=4, ge=1, le=8),
    source: str | None = Query(default=None, min_length=1, max_length=260),
) -> VectorSearchResponse:
    ensure_storage()
    return VectorSearchResponse(results=search_vector_chunks(q, limit, source))


@app.get("/api/elevenlabs/config", response_model=ElevenLabsConfig)
def get_elevenlabs_config() -> ElevenLabsConfig:
    return get_elevenlabs_config_payload()


@app.put("/api/elevenlabs/config", response_model=ElevenLabsConfig)
def save_elevenlabs_config(payload: ElevenLabsConfigIn) -> ElevenLabsConfig:
    ensure_storage()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO elevenlabs_config (id, api_key, updated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at
            """,
            (payload.api_key.strip(), now),
        )
        conn.commit()

    return get_elevenlabs_config_payload()


@app.put("/api/elevenlabs/config/defaults", response_model=ElevenLabsConfig)
def save_elevenlabs_defaults(payload: ElevenLabsDefaultsIn) -> ElevenLabsConfig:
    ensure_storage()
    defaults = {
        "inbound_agent_id": payload.inbound_agent_id.strip()
        if payload.inbound_agent_id
        else None,
        "outbound_agent_id": payload.outbound_agent_id.strip()
        if payload.outbound_agent_id
        else None,
        "presentation_agent_id": payload.presentation_agent_id.strip()
        if payload.presentation_agent_id
        else None,
    }

    configured_agent_ids = {agent.agent_id for agent in list_elevenlabs_agents()}
    unknown_ids = {
        agent_id
        for agent_id in defaults.values()
        if agent_id and agent_id not in configured_agent_ids
    }
    if unknown_ids:
        raise HTTPException(status_code=400, detail="Uno degli agenti predefiniti non esiste")

    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            UPDATE elevenlabs_config
            SET inbound_agent_id = ?, outbound_agent_id = ?,
                presentation_agent_id = ?, updated_at = ?
            WHERE id = 1
            """,
            (
                defaults["inbound_agent_id"],
                defaults["outbound_agent_id"],
                defaults["presentation_agent_id"],
                now,
            ),
        )
        conn.commit()

    return get_elevenlabs_config_payload()


@app.put("/api/elevenlabs/config/integration", response_model=ElevenLabsConfig)
def save_elevenlabs_integration(payload: ElevenLabsIntegrationIn) -> ElevenLabsConfig:
    ensure_storage()
    public_base_url = normalize_public_url(payload.public_base_url)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            UPDATE elevenlabs_config
            SET public_base_url = ?, post_call_webhook_secret = ?, updated_at = ?
            WHERE id = 1
            """,
            (
                public_base_url,
                payload.post_call_webhook_secret.strip(),
                utc_now(),
            ),
        )
        conn.commit()
    return get_elevenlabs_config_payload()


@app.put("/api/elevenlabs/config/source", response_model=ElevenLabsConfig)
def save_flow_source(payload: FlowSourceIn) -> ElevenLabsConfig:
    ensure_storage()
    source = ensure_known_source(payload.source)
    column_by_flow = {
        "centralino-entrata": "inbound_source",
        "centralino-uscita": "outbound_source",
        "presentazione": "presentation_source",
    }
    column_name = column_by_flow[payload.flow]
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            f"UPDATE elevenlabs_config SET {column_name} = ?, updated_at = ? WHERE id = 1",
            (source, utc_now()),
        )
        conn.commit()
    return get_elevenlabs_config_payload()


@app.post("/api/elevenlabs/agents", response_model=ElevenLabsAgent)
def create_elevenlabs_agent(payload: ElevenLabsAgentIn) -> ElevenLabsAgent:
    ensure_storage()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        agents_count = conn.execute("SELECT COUNT(*) FROM elevenlabs_agents").fetchone()[0]
        cursor = conn.execute(
            """
            INSERT INTO elevenlabs_agents (name, agent_id, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                payload.name.strip(),
                payload.agent_id.strip(),
                1 if agents_count == 0 else 0,
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM elevenlabs_agents WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()

    return row_to_elevenlabs_agent(row)


@app.put("/api/elevenlabs/agents/{agent_row_id}", response_model=ElevenLabsAgent)
def update_elevenlabs_agent(
    agent_row_id: int,
    payload: ElevenLabsAgentIn,
) -> ElevenLabsAgent:
    ensure_storage()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM elevenlabs_agents WHERE id = ?",
            (agent_row_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Agent not found")

        conn.execute(
            """
            UPDATE elevenlabs_agents
            SET name = ?, agent_id = ?, updated_at = ?
            WHERE id = ?
            """,
            (payload.name.strip(), payload.agent_id.strip(), now, agent_row_id),
        )
        old_agent_id = row["agent_id"]
        new_agent_id = payload.agent_id.strip()
        for column_name in (
            "inbound_agent_id",
            "outbound_agent_id",
            "presentation_agent_id",
        ):
            conn.execute(
                f"UPDATE elevenlabs_config SET {column_name} = ? WHERE {column_name} = ?",
                (new_agent_id, old_agent_id),
            )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM elevenlabs_agents WHERE id = ?",
            (agent_row_id,),
        ).fetchone()

    return row_to_elevenlabs_agent(updated)


@app.post("/api/elevenlabs/agents/{agent_row_id}/activate", response_model=ElevenLabsAgent)
def activate_elevenlabs_agent(agent_row_id: int) -> ElevenLabsAgent:
    ensure_storage()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM elevenlabs_agents WHERE id = ?",
            (agent_row_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Agent not found")

        conn.execute("UPDATE elevenlabs_agents SET is_active = 0")
        conn.execute(
            """
            UPDATE elevenlabs_agents
            SET is_active = 1, updated_at = ?
            WHERE id = ?
            """,
            (now, agent_row_id),
        )
        conn.commit()
        active = conn.execute(
            "SELECT * FROM elevenlabs_agents WHERE id = ?",
            (agent_row_id,),
        ).fetchone()

    return row_to_elevenlabs_agent(active)


@app.delete("/api/elevenlabs/agents/{agent_row_id}", response_model=ElevenLabsConfig)
def delete_elevenlabs_agent(agent_row_id: int) -> ElevenLabsConfig:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM elevenlabs_agents WHERE id = ?",
            (agent_row_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Agent not found")

        was_active = bool(row["is_active"])
        deleted_agent_id = row["agent_id"]
        conn.execute("DELETE FROM elevenlabs_agents WHERE id = ?", (agent_row_id,))
        for column_name in (
            "inbound_agent_id",
            "outbound_agent_id",
            "presentation_agent_id",
        ):
            conn.execute(
                f"UPDATE elevenlabs_config SET {column_name} = NULL WHERE {column_name} = ?",
                (deleted_agent_id,),
            )
        if was_active:
            replacement = conn.execute(
                "SELECT id FROM elevenlabs_agents ORDER BY updated_at DESC, id DESC LIMIT 1"
            ).fetchone()
            if replacement:
                conn.execute(
                    "UPDATE elevenlabs_agents SET is_active = 1 WHERE id = ?",
                    (replacement["id"],),
                )
        conn.commit()

    return get_elevenlabs_config_payload()


@app.get("/api/elevenlabs/signed-url")
async def get_signed_url(
    agent_id: str | None = Query(default=None, min_length=1, max_length=180),
) -> dict[str, str]:
    api_key, selected_agent_id = get_elevenlabs_credentials(agent_id)

    url = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"
    headers = {"xi-api-key": api_key}
    params = {"agent_id": selected_agent_id}

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
async def get_conversation_token(
    agent_id: str | None = Query(default=None, min_length=1, max_length=180),
) -> dict[str, str]:
    api_key, selected_agent_id = get_elevenlabs_credentials(agent_id)

    url = "https://api.elevenlabs.io/v1/convai/conversation/token"
    headers = {"xi-api-key": api_key}
    params = {"agent_id": selected_agent_id}

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


@app.get(
    "/api/elevenlabs/phone-numbers",
    response_model=list[ElevenLabsPhoneNumber],
)
async def list_elevenlabs_phone_numbers() -> list[ElevenLabsPhoneNumber]:
    api_key, _ = get_elevenlabs_credentials()
    url = "https://api.elevenlabs.io/v1/convai/v2/phone-numbers"
    headers = {"xi-api-key": api_key}
    params = {"provider": "twilio", "supports_outbound": "true", "page_size": 100}
    try:
        async with httpx.AsyncClient(timeout=20, verify=ELEVENLABS_VERIFY_SSL) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Cannot reach ElevenLabs: {exc}",
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs phone numbers error: {response.text}",
        )

    data = response.json()
    rows = data.get("phone_numbers", []) if isinstance(data, dict) else data
    return [
        ElevenLabsPhoneNumber(
            phone_number_id=row.get("phone_number_id", ""),
            label=row.get("label") or row.get("phone_number") or "Numero Twilio",
            phone_number=row.get("phone_number", ""),
            provider=row.get("provider", "twilio"),
            supports_outbound=bool(row.get("supports_outbound", True)),
        )
        for row in rows
        if isinstance(row, dict) and row.get("phone_number_id")
    ]


def normalize_phone_number(value: str) -> str:
    normalized = re.sub(r"[\s().-]", "", value.strip())
    if normalized.startswith("00"):
        normalized = "+" + normalized[2:]
    if not normalized.startswith("+") and re.fullmatch(r"\d{9,11}", normalized):
        normalized = "+39" + normalized
    if not re.fullmatch(r"\+[1-9]\d{7,14}", normalized):
        raise HTTPException(
            status_code=400,
            detail="Numero non valido. Usa il formato internazionale, ad esempio +393451234567.",
        )
    return normalized


@app.post("/api/outbound-calls", response_model=OutboundCall)
async def start_outbound_call(payload: OutboundCallIn) -> OutboundCall:
    api_key, agent_id = get_elevenlabs_credentials(payload.agent_id)
    source = ensure_known_source(payload.source)
    now = utc_now()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        contact = conn.execute(
            "SELECT * FROM outbound_contacts WHERE id = ?",
            (payload.contact_id,),
        ).fetchone()
    if not contact:
        raise HTTPException(status_code=404, detail="Contatto non trovato")

    phone = normalize_phone_number(contact["phone"])
    request_payload = {
        "agent_id": agent_id,
        "agent_phone_number_id": payload.agent_phone_number_id.strip(),
        "to_number": phone,
    }
    url = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=30, verify=ELEVENLABS_VERIFY_SSL) as client:
            response = await client.post(url, headers=headers, json=request_payload)
    except httpx.RequestError as exc:
        error = f"Cannot reach ElevenLabs: {exc}"
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO outbound_calls (
                    contact_id, reference, phone, agent_id, agent_phone_number_id,
                    source, status, transcript_text, error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'failed', '', ?, ?, ?)
                """,
                (
                    payload.contact_id,
                    contact["reference"],
                    phone,
                    agent_id,
                    payload.agent_phone_number_id.strip(),
                    source,
                    error,
                    now,
                    now,
                ),
            )
            conn.commit()
        raise HTTPException(status_code=502, detail=error) from exc

    data = response.json() if response.content else {}
    if response.status_code >= 400 or not data.get("success"):
        error = data.get("detail") or data.get("message") or response.text
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO outbound_calls (
                    contact_id, reference, phone, agent_id, agent_phone_number_id,
                    source, status, transcript_text, error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'failed', '', ?, ?, ?)
                """,
                (
                    payload.contact_id,
                    contact["reference"],
                    phone,
                    agent_id,
                    payload.agent_phone_number_id.strip(),
                    source,
                    str(error),
                    now,
                    now,
                ),
            )
            conn.commit()
        raise HTTPException(status_code=502, detail=f"Chiamata ElevenLabs fallita: {error}")

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            """
            INSERT INTO outbound_calls (
                contact_id, reference, phone, agent_id, agent_phone_number_id,
                source, conversation_id, call_sid, status, transcript_text,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'initiated', '', ?, ?)
            """,
            (
                payload.contact_id,
                contact["reference"],
                phone,
                agent_id,
                payload.agent_phone_number_id.strip(),
                source,
                data.get("conversation_id"),
                data.get("callSid") or data.get("call_sid"),
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM outbound_calls WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return row_to_outbound_call(row)


@app.get("/api/outbound-calls", response_model=list[OutboundCall])
def list_outbound_calls() -> list[OutboundCall]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM outbound_calls ORDER BY created_at DESC, id DESC LIMIT 100"
        ).fetchall()
    return [row_to_outbound_call(row) for row in rows]


def insert_appointment(payload: AppointmentIn) -> Appointment:
    ensure_storage()
    created_at = utc_now()
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


@app.post("/api/appointments", response_model=Appointment)
def create_appointment(payload: AppointmentIn) -> Appointment:
    return insert_appointment(payload)


@app.get("/api/appointments", response_model=list[Appointment])
def list_appointments() -> list[Appointment]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM appointments ORDER BY date ASC, time ASC, id DESC"
        ).fetchall()
    return [row_to_appointment(row) for row in rows]


@app.delete("/api/appointments")
def delete_all_appointments() -> dict[str, int]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute("DELETE FROM appointments")
        conn.commit()
    return {"deleted": cursor.rowcount}


@app.get("/api/outbound-contacts", response_model=list[OutboundContact])
def list_outbound_contacts() -> list[OutboundContact]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM outbound_contacts ORDER BY reference COLLATE NOCASE, id"
        ).fetchall()
    return [row_to_outbound_contact(row) for row in rows]


@app.post("/api/outbound-contacts", response_model=OutboundContact)
def create_outbound_contact(payload: OutboundContactIn) -> OutboundContact:
    ensure_storage()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            """
            INSERT INTO outbound_contacts (reference, phone, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (payload.reference.strip(), payload.phone.strip(), now, now),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM outbound_contacts WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return row_to_outbound_contact(row)


@app.put("/api/outbound-contacts/{contact_id}", response_model=OutboundContact)
def update_outbound_contact(
    contact_id: int,
    payload: OutboundContactIn,
) -> OutboundContact:
    ensure_storage()
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id FROM outbound_contacts WHERE id = ?",
            (contact_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Contatto non trovato")

        conn.execute(
            """
            UPDATE outbound_contacts
            SET reference = ?, phone = ?, updated_at = ?
            WHERE id = ?
            """,
            (payload.reference.strip(), payload.phone.strip(), now, contact_id),
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM outbound_contacts WHERE id = ?",
            (contact_id,),
        ).fetchone()
    return row_to_outbound_contact(updated)


@app.delete("/api/outbound-contacts/{contact_id}")
def delete_outbound_contact(contact_id: int) -> dict[str, int]:
    ensure_storage()
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            "DELETE FROM outbound_contacts WHERE id = ?",
            (contact_id,),
        )
        conn.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Contatto non trovato")
    return {"deleted": cursor.rowcount}


@app.post("/api/tools/search-knowledge")
def tool_search_knowledge(
    payload: ToolKnowledgeIn,
    x_jk_automa_key: str | None = Header(default=None, alias="X-JK-Automa-Key"),
) -> dict[str, Any]:
    require_tool_secret(x_jk_automa_key)
    source = resolve_tool_source(
        payload.conversation_id,
        payload.agent_id,
        payload.knowledge_source,
    )
    results = search_vector_chunks(payload.query.strip(), payload.limit, source)
    if not results:
        return {
            "success": True,
            "source": source or "tutte le fonti",
            "message": "Nessuna informazione pertinente trovata nella documentazione.",
            "results": [],
        }
    return {
        "success": True,
        "source": source or "tutte le fonti",
        "message": f"Trovati {len(results)} passaggi pertinenti.",
        "results": [
            {
                "source": result.source,
                "chunk": result.chunk_index + 1,
                "score": result.score,
                "text": result.text,
            }
            for result in results
        ],
    }


@app.post("/api/tools/schedule-appointment")
def tool_schedule_appointment(
    payload: AppointmentIn,
    x_jk_automa_key: str | None = Header(default=None, alias="X-JK-Automa-Key"),
) -> dict[str, Any]:
    require_tool_secret(x_jk_automa_key)
    appointment = insert_appointment(payload)
    return {
        "success": True,
        "message": (
            f"Appuntamento registrato per {appointment.customer_name} "
            f"il {appointment.date} alle {appointment.time}."
        ),
        "appointment": {
            "customer_name": appointment.customer_name,
            "phone": appointment.phone,
            "date": appointment.date,
            "time": appointment.time,
            "notes": appointment.notes,
        },
    }


def webhook_phone_details(data: dict[str, Any]) -> tuple[str, str | None]:
    metadata = data.get("metadata")
    if not isinstance(metadata, dict):
        return "Numero non disponibile", None
    body = metadata.get("body")
    if not isinstance(body, dict):
        body = metadata

    phone = (
        body.get("to_number")
        or body.get("To")
        or body.get("called_number")
        or "Numero non disponibile"
    )
    call_sid = body.get("call_sid") or body.get("CallSid")
    return str(phone), str(call_sid) if call_sid else None


@app.post("/api/webhooks/elevenlabs/post-call")
async def receive_elevenlabs_post_call(request: Request) -> dict[str, str]:
    ensure_storage()
    raw_body = await request.body()
    config = get_elevenlabs_config_payload()
    verify_elevenlabs_signature(
        raw_body,
        request.headers.get("ElevenLabs-Signature"),
        config.post_call_webhook_secret,
    )
    try:
        event = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Payload JSON non valido") from exc

    event_type = event.get("type")
    data = event.get("data")
    if not isinstance(data, dict) or event_type not in {
        "post_call_transcription",
        "call_initiation_failure",
    }:
        return {"status": "ignored"}

    conversation_id = data.get("conversation_id")
    if not conversation_id:
        return {"status": "ignored"}

    now = utc_now()
    phone, metadata_call_sid = webhook_phone_details(data)
    call_sid = data.get("call_sid") or metadata_call_sid
    agent_id = str(data.get("agent_id") or "unknown")
    agent_name = str(data.get("agent_name") or "Chiamata ElevenLabs")
    transcript = data.get("transcript")
    transcript_text = transcript_to_text(transcript)
    if event_type == "call_initiation_failure":
        status = "failed"
        error = str(data.get("failure_reason") or "Avvio chiamata fallito")
        completed_at = now
    else:
        status = str(data.get("status") or "completed")
        error = None
        completed_at = now

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        existing = conn.execute(
            "SELECT id FROM outbound_calls WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE outbound_calls
                SET call_sid = COALESCE(?, call_sid), status = ?, transcript_json = ?,
                    transcript_text = ?, error = ?, updated_at = ?, completed_at = ?
                WHERE id = ?
                """,
                (
                    call_sid,
                    status,
                    json.dumps(transcript, ensure_ascii=False) if transcript else None,
                    transcript_text,
                    error,
                    now,
                    completed_at,
                    existing["id"],
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO outbound_calls (
                    contact_id, reference, phone, agent_id, agent_phone_number_id,
                    source, conversation_id, call_sid, status, transcript_json,
                    transcript_text, error, created_at, updated_at, completed_at
                ) VALUES (NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    agent_name,
                    phone,
                    agent_id,
                    conversation_id,
                    call_sid,
                    status,
                    json.dumps(transcript, ensure_ascii=False) if transcript else None,
                    transcript_text,
                    error,
                    now,
                    now,
                    completed_at,
                ),
            )
        conn.commit()
    return {"status": "received"}
