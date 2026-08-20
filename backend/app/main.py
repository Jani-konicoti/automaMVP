from __future__ import annotations

import os
import json
import math
import re
import sqlite3
from collections import Counter
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
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


class ElevenLabsConfig(BaseModel):
    api_key: str
    agents: list[ElevenLabsAgent]
    active_agent_id: str | None
    configured: bool


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
                "Siamo JK Automa. Orari: lunedi-venerdi 09:00-18:00."
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
                INSERT INTO elevenlabs_config (id, api_key, updated_at)
                VALUES (1, ?, ?)
                """,
                (os.getenv("ELEVENLABS_API_KEY", "").strip(), now),
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
            "SELECT api_key FROM elevenlabs_config WHERE id = 1"
        ).fetchone()

    api_key = config["api_key"] if config else ""
    agents = list_elevenlabs_agents()
    active_agent = next((agent for agent in agents if agent.is_active), None)
    return ElevenLabsConfig(
        api_key=api_key,
        agents=agents,
        active_agent_id=active_agent.agent_id if active_agent else None,
        configured=bool(api_key and active_agent),
    )


def get_active_elevenlabs_credentials() -> tuple[str, str]:
    config = get_elevenlabs_config_payload()
    if not config.active_agent_id:
        raise HTTPException(
            status_code=500,
            detail="Configura almeno un agent_id ElevenLabs attivo",
        )
    if not config.api_key:
        raise HTTPException(
            status_code=500,
            detail="Configura ELEVENLABS_API_KEY nella pagina Configurazione",
        )

    return config.api_key, config.active_agent_id


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


@app.on_event("startup")
def on_startup() -> None:
    ensure_storage()


@app.get("/api/health")
def health() -> dict[str, Any]:
    config = get_elevenlabs_config_payload()
    return {
        "ok": True,
        "agent_configured": bool(config.active_agent_id),
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
        conn.execute("DELETE FROM elevenlabs_agents WHERE id = ?", (agent_row_id,))
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
async def get_signed_url() -> dict[str, str]:
    api_key, agent_id = get_active_elevenlabs_credentials()

    url = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"
    headers = {"xi-api-key": api_key}
    params = {"agent_id": agent_id}

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
    api_key, agent_id = get_active_elevenlabs_credentials()

    url = "https://api.elevenlabs.io/v1/convai/conversation/token"
    headers = {"xi-api-key": api_key}
    params = {"agent_id": agent_id}

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
