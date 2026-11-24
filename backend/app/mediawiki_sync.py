from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from app import main as core
from app.mediawiki_connector import CrawlResult, MediaWikiClient, WikiPage, crawl_wiki, navigation_label


@dataclass(frozen=True)
class MediaWikiSettings:
    base_url: str
    root_page: str
    username: str
    password: str
    tenant: str
    area: str
    interval_minutes: int
    full_sync_hours: int
    verify_ssl: bool = True


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_settings() -> MediaWikiSettings:
    settings = MediaWikiSettings(
        base_url=os.getenv("MEDIAWIKI_BASE_URL", "https://wikiweb.centropaghe.it").strip().rstrip("/"),
        root_page=os.getenv("MEDIAWIKI_ROOT_PAGE", "Help_On_Line").strip(),
        username=os.getenv("MEDIAWIKI_USERNAME", "").strip(),
        password=os.getenv("MEDIAWIKI_PASSWORD", ""),
        tenant=os.getenv("MEDIAWIKI_TENANT", "principale").strip(),
        area=os.getenv("MEDIAWIKI_AREA", "Paghe Web").strip(),
        interval_minutes=max(1, int(os.getenv("MEDIAWIKI_SYNC_INTERVAL_MINUTES", "15"))),
        full_sync_hours=max(1, int(os.getenv("MEDIAWIKI_FULL_SYNC_HOURS", "24"))),
        verify_ssl=os.getenv("MEDIAWIKI_VERIFY_SSL", "true").lower() not in {"0", "false", "no"},
    )
    missing = [
        name
        for name, value in (
            ("MEDIAWIKI_USERNAME", settings.username),
            ("MEDIAWIKI_PASSWORD", settings.password),
            ("MEDIAWIKI_ROOT_PAGE", settings.root_page),
            ("MEDIAWIKI_TENANT", settings.tenant),
            ("MEDIAWIKI_AREA", settings.area),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(f"Configurazione MediaWiki mancante: {', '.join(missing)}")
    return settings


def ensure_mediawiki_storage() -> None:
    core.ensure_storage()
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS mediawiki_connectors (
                tenant_id INTEGER PRIMARY KEY,
                base_url TEXT NOT NULL,
                root_page TEXT NOT NULL,
                area_name TEXT NOT NULL,
                last_sync_at TEXT,
                last_full_sync_at TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id)
            );

            CREATE TABLE IF NOT EXISTS mediawiki_pages (
                tenant_id INTEGER NOT NULL,
                page_id INTEGER NOT NULL,
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                namespace INTEGER NOT NULL DEFAULT 0,
                revision_id INTEGER,
                modified_at TEXT,
                text_hash TEXT NOT NULL,
                source_url TEXT NOT NULL,
                canonical_path_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'active',
                last_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (tenant_id, page_id),
                UNIQUE (tenant_id, source),
                FOREIGN KEY (tenant_id) REFERENCES tenants(id)
            );

            CREATE TABLE IF NOT EXISTS mediawiki_page_paths (
                tenant_id INTEGER NOT NULL,
                page_id INTEGER NOT NULL,
                path_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (tenant_id, page_id, path_json),
                FOREIGN KEY (tenant_id, page_id) REFERENCES mediawiki_pages(tenant_id, page_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS mediawiki_sync_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id INTEGER NOT NULL,
                mode TEXT NOT NULL,
                status TEXT NOT NULL,
                pages_seen INTEGER NOT NULL DEFAULT 0,
                pages_indexed INTEGER NOT NULL DEFAULT 0,
                pages_unchanged INTEGER NOT NULL DEFAULT 0,
                pages_deleted INTEGER NOT NULL DEFAULT 0,
                errors_json TEXT NOT NULL DEFAULT '[]',
                started_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id)
            );

            CREATE TABLE IF NOT EXISTS mediawiki_sync_locks (
                tenant_id INTEGER PRIMARY KEY,
                locked_at TEXT NOT NULL,
                FOREIGN KEY (tenant_id) REFERENCES tenants(id)
            );

            CREATE INDEX IF NOT EXISTS idx_mediawiki_pages_status
            ON mediawiki_pages (tenant_id, status, last_seen_at);
            """
        )
        conn.commit()


def resolve_tenant(identifier: str) -> sqlite3.Row:
    ensure_mediawiki_storage()
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            SELECT id, name, slug FROM tenants
            WHERE is_active = 1 AND (CAST(id AS TEXT) = ? OR slug = ? COLLATE NOCASE)
            """,
            (identifier, identifier),
        ).fetchone()
    if not row:
        raise RuntimeError(f"Tenant attivo non trovato: {identifier}")
    return row


def acquire_lock(tenant_id: int) -> None:
    expiry = (datetime.now(UTC) - timedelta(hours=2)).isoformat(timespec="seconds").replace("+00:00", "Z")
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.execute("DELETE FROM mediawiki_sync_locks WHERE tenant_id = ? AND locked_at < ?", (tenant_id, expiry))
        try:
            conn.execute(
                "INSERT INTO mediawiki_sync_locks (tenant_id, locked_at) VALUES (?, ?)",
                (tenant_id, utc_now()),
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            raise RuntimeError("Una sincronizzazione MediaWiki e gia in corso") from exc


def release_lock(tenant_id: int) -> None:
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.execute("DELETE FROM mediawiki_sync_locks WHERE tenant_id = ?", (tenant_id,))
        conn.commit()


def canonical_path(paths: list[tuple[str, ...]]) -> tuple[str, ...]:
    if not paths:
        return tuple()
    return min(paths, key=lambda path: (len(path), " / ".join(path).casefold()))


def module_name_for_path(path: tuple[str, ...]) -> str:
    if len(path) >= 3:
        name = f"{path[1]} / {path[2]}"
    elif len(path) == 2:
        name = f"{path[1]} / Generale"
    else:
        name = "Generale"
    return name[:120]


def source_for_page(page: WikiPage) -> str:
    title = " ".join(navigation_label(page.title).split())[:180]
    return f"WikiWeb - {title} [#{page.page_id}]"


def ensure_area_and_module(area_name: str, module_name: str) -> int:
    now = utc_now()
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        area = conn.execute(
            "SELECT id FROM knowledge_areas WHERE tenant_id = ? AND name = ? COLLATE NOCASE",
            (core.tenant_id(), area_name),
        ).fetchone()
        if area:
            area_id = int(area["id"])
        else:
            cursor = conn.execute(
                """
                INSERT INTO knowledge_areas (tenant_id, name, position, created_at, updated_at)
                VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM knowledge_areas WHERE tenant_id = ?), 0), ?, ?)
                """,
                (core.tenant_id(), area_name, core.tenant_id(), now, now),
            )
            area_id = int(cursor.lastrowid)
        module = conn.execute(
            """
            SELECT id FROM knowledge_modules
            WHERE tenant_id = ? AND area_id = ? AND name = ? COLLATE NOCASE
            """,
            (core.tenant_id(), area_id, module_name),
        ).fetchone()
        if module:
            module_id = int(module["id"])
        else:
            cursor = conn.execute(
                """
                INSERT INTO knowledge_modules (tenant_id, area_id, name, position, created_at, updated_at)
                VALUES (
                    ?, ?, ?,
                    COALESCE((SELECT MAX(position) + 1 FROM knowledge_modules WHERE tenant_id = ? AND area_id = ?), 0),
                    ?, ?
                )
                """,
                (core.tenant_id(), area_id, module_name, core.tenant_id(), area_id, now, now),
            )
            module_id = int(cursor.lastrowid)
        conn.commit()
    return module_id


def place_document(source: str, module_id: int) -> None:
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        document = conn.execute(
            "SELECT id, module_id FROM knowledge_documents WHERE tenant_id = ? AND source = ?",
            (core.tenant_id(), source),
        ).fetchone()
        if not document:
            raise RuntimeError(f"Documento indicizzato ma non registrato: {source}")
        if document["module_id"] != module_id:
            position = conn.execute(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM knowledge_documents WHERE tenant_id = ? AND module_id = ?",
                (core.tenant_id(), module_id),
            ).fetchone()[0]
            conn.execute(
                "UPDATE knowledge_documents SET module_id = ?, position = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
                (module_id, position, utc_now(), document["id"], core.tenant_id()),
            )
            conn.commit()


def delete_indexed_source(source: str) -> None:
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.execute("DELETE FROM vector_chunks WHERE tenant_id = ? AND source = ?", (core.tenant_id(), source))
        conn.execute("DELETE FROM knowledge_documents WHERE tenant_id = ? AND source = ?", (core.tenant_id(), source))
        conn.commit()


def upsert_page(page: WikiPage, paths: list[tuple[str, ...]], area_name: str, seen_at: str) -> str:
    path = canonical_path(paths)
    module_name = module_name_for_path(path)
    module_id = ensure_area_and_module(area_name, module_name)
    source = source_for_page(page)
    meaningful = len(page.text.replace(page.title, "", 1).strip()) >= 20

    with sqlite3.connect(core.DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        existing = conn.execute(
            "SELECT * FROM mediawiki_pages WHERE tenant_id = ? AND page_id = ?",
            (core.tenant_id(), page.page_id),
        ).fetchone()

    changed = not existing or existing["text_hash"] != page.text_hash
    old_source = existing["source"] if existing else None
    if not meaningful:
        if old_source:
            delete_indexed_source(old_source)
        action = "empty"
    elif changed:
        if old_source and old_source != source:
            delete_indexed_source(old_source)
        core.index_vector_chunks(source, page.text, replace_source=True)
        place_document(source, module_id)
        action = "indexed"
    else:
        if old_source != source:
            with sqlite3.connect(core.DB_PATH) as conn:
                conn.execute(
                    "UPDATE vector_chunks SET source = ? WHERE tenant_id = ? AND source = ?",
                    (source, core.tenant_id(), old_source),
                )
                conn.execute(
                    "UPDATE knowledge_documents SET source = ?, updated_at = ? WHERE tenant_id = ? AND source = ?",
                    (source, utc_now(), core.tenant_id(), old_source),
                )
                conn.commit()
        place_document(source, module_id)
        action = "unchanged"

    now = utc_now()
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO mediawiki_pages (
                tenant_id, page_id, source, title, namespace, revision_id, modified_at,
                text_hash, source_url, canonical_path_json, status, last_seen_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, page_id) DO UPDATE SET
                source = excluded.source,
                title = excluded.title,
                namespace = excluded.namespace,
                revision_id = excluded.revision_id,
                modified_at = excluded.modified_at,
                text_hash = excluded.text_hash,
                source_url = excluded.source_url,
                canonical_path_json = excluded.canonical_path_json,
                status = excluded.status,
                last_seen_at = excluded.last_seen_at,
                updated_at = excluded.updated_at
            """,
            (
                core.tenant_id(), page.page_id, source, page.title, page.namespace,
                page.revision_id, page.modified_at, page.text_hash, page.source_url,
                json.dumps(path, ensure_ascii=False), "active" if meaningful else "empty",
                seen_at, now,
            ),
        )
        conn.execute(
            "DELETE FROM mediawiki_page_paths WHERE tenant_id = ? AND page_id = ?",
            (core.tenant_id(), page.page_id),
        )
        for candidate in sorted(set(paths)):
            conn.execute(
                "INSERT INTO mediawiki_page_paths (tenant_id, page_id, path_json, created_at) VALUES (?, ?, ?, ?)",
                (core.tenant_id(), page.page_id, json.dumps(candidate, ensure_ascii=False), now),
            )
        conn.commit()
    return action


def delete_unseen_pages(seen_ids: set[int]) -> int:
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT page_id, source FROM mediawiki_pages WHERE tenant_id = ?",
            (core.tenant_id(),),
        ).fetchall()
    stale = [row for row in rows if int(row["page_id"]) not in seen_ids]
    deleted = 0
    for row in stale:
        with sqlite3.connect(core.DB_PATH) as conn:
            status = conn.execute(
                "SELECT status FROM mediawiki_pages WHERE tenant_id = ? AND page_id = ?",
                (core.tenant_id(), row["page_id"]),
            ).fetchone()[0]
            if status != "missing":
                conn.execute(
                    "UPDATE mediawiki_pages SET status = 'missing', updated_at = ? WHERE tenant_id = ? AND page_id = ?",
                    (utc_now(), core.tenant_id(), row["page_id"]),
                )
                conn.commit()
                continue
        delete_indexed_source(row["source"])
        with sqlite3.connect(core.DB_PATH) as conn:
            conn.execute(
                "DELETE FROM mediawiki_page_paths WHERE tenant_id = ? AND page_id = ?",
                (core.tenant_id(), row["page_id"]),
            )
            conn.execute(
                "DELETE FROM mediawiki_pages WHERE tenant_id = ? AND page_id = ?",
                (core.tenant_id(), row["page_id"]),
            )
            conn.commit()
        deleted += 1
    return deleted


def save_connector(settings: MediaWikiSettings, tenant_id: int, *, sync_at: str, full: bool) -> None:
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO mediawiki_connectors (
                tenant_id, base_url, root_page, area_name, last_sync_at, last_full_sync_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id) DO UPDATE SET
                base_url = excluded.base_url,
                root_page = excluded.root_page,
                area_name = excluded.area_name,
                last_sync_at = excluded.last_sync_at,
                last_full_sync_at = CASE WHEN ? THEN excluded.last_full_sync_at ELSE mediawiki_connectors.last_full_sync_at END,
                updated_at = excluded.updated_at
            """,
            (
                tenant_id, settings.base_url, settings.root_page, settings.area,
                sync_at, sync_at if full else None, utc_now(), int(full),
            ),
        )
        conn.commit()


def connector_state(tenant_id: int) -> sqlite3.Row | None:
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM mediawiki_connectors WHERE tenant_id = ?",
            (tenant_id,),
        ).fetchone()


def create_run(tenant_id: int, mode: str) -> int:
    with sqlite3.connect(core.DB_PATH) as conn:
        cursor = conn.execute(
            "INSERT INTO mediawiki_sync_runs (tenant_id, mode, status, started_at) VALUES (?, ?, 'running', ?)",
            (tenant_id, mode, utc_now()),
        )
        conn.commit()
        return int(cursor.lastrowid)


def finish_run(run_id: int, status: str, stats: dict[str, int], errors: list[str]) -> None:
    with sqlite3.connect(core.DB_PATH) as conn:
        conn.execute(
            """
            UPDATE mediawiki_sync_runs
            SET status = ?, pages_seen = ?, pages_indexed = ?, pages_unchanged = ?,
                pages_deleted = ?, errors_json = ?, completed_at = ?
            WHERE id = ?
            """,
            (
                status, stats.get("seen", 0), stats.get("indexed", 0),
                stats.get("unchanged", 0), stats.get("deleted", 0),
                json.dumps(errors, ensure_ascii=False), utc_now(), run_id,
            ),
        )
        conn.commit()


def apply_crawl(result: CrawlResult, settings: MediaWikiSettings, seen_at: str) -> dict[str, int]:
    stats = {"seen": len(result.pages), "indexed": 0, "unchanged": 0, "empty": 0, "deleted": 0}
    for crawled in result.pages.values():
        action = upsert_page(crawled.page, crawled.paths, settings.area, seen_at)
        stats[action] = stats.get(action, 0) + 1
    if not result.errors and not result.truncated:
        stats["deleted"] = delete_unseen_pages(set(result.pages))
    return stats


def print_dry_run(result: CrawlResult) -> None:
    for crawled in result.pages.values():
        page = crawled.page
        print("=" * 80)
        print(f"Titolo: {page.title}")
        print(f"Page ID: {page.page_id} | Revisione: {page.revision_id}")
        print(f"Percorso: {' > '.join(canonical_path(crawled.paths))}")
        print(f"Modulo: {module_name_for_path(canonical_path(crawled.paths))}")
        print(f"Caratteri: {len(page.text)} | Elementi scartati: {page.discarded}")
        print(page.text[:2000])
    if result.errors:
        print("\nErrori:", file=sys.stderr)
        for error in result.errors:
            print(f"- {error}", file=sys.stderr)
    print(f"\nPagine: {len(result.pages)} | Errori: {len(result.errors)} | Troncato: {result.truncated}")


def run_sync(settings: MediaWikiSettings, *, force_full: bool = False) -> dict[str, int]:
    tenant = resolve_tenant(settings.tenant)
    tenant_id = int(tenant["id"])
    acquire_lock(tenant_id)
    checkpoint = utc_now()
    mode = "full" if force_full else "incremental"
    run_id = create_run(tenant_id, mode)
    stats = {"seen": 0, "indexed": 0, "unchanged": 0, "deleted": 0}
    errors: list[str] = []
    context = core.CURRENT_TENANT_ID.set(tenant_id)
    try:
        state = connector_state(tenant_id)
        full_due = force_full or not state or not state["last_full_sync_at"]
        if state and state["last_full_sync_at"]:
            last_full = core.parse_utc(state["last_full_sync_at"])
            full_due = full_due or not last_full or datetime.now(UTC).replace(tzinfo=None) - last_full >= timedelta(hours=settings.full_sync_hours)

        with MediaWikiClient(
            settings.base_url,
            settings.username,
            settings.password,
            verify_ssl=settings.verify_ssl,
        ) as client:
            client.login()
            if not full_due and state and state["last_sync_at"]:
                changes = client.recent_changes(state["last_sync_at"])
                if not changes:
                    save_connector(settings, tenant_id, sync_at=checkpoint, full=False)
                    finish_run(run_id, "completed", stats, [])
                    return stats
            result = crawl_wiki(client, settings.root_page)

        stats = apply_crawl(result, settings, checkpoint)
        errors = result.errors
        complete = not result.errors and not result.truncated
        if complete:
            save_connector(settings, tenant_id, sync_at=checkpoint, full=True)
        finish_run(run_id, "completed" if complete else "partial", stats, errors)
        if not complete:
            raise RuntimeError(f"Sincronizzazione incompleta: {len(errors)} errori")
        return stats
    except Exception as exc:
        if not errors:
            errors = [str(exc)]
        finish_run(run_id, "failed", stats, errors)
        raise
    finally:
        core.CURRENT_TENANT_ID.reset(context)
        release_lock(tenant_id)


def run_dry_run(settings: MediaWikiSettings, limit: int) -> None:
    with MediaWikiClient(
        settings.base_url,
        settings.username,
        settings.password,
        verify_ssl=settings.verify_ssl,
    ) as client:
        client.login()
        result = crawl_wiki(client, settings.root_page, limit=limit)
    print_dry_run(result)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Importazione e sincronizzazione WikiWeb Centro Paghe")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Mostra l'estrazione senza scrivere nel database")
    mode.add_argument("--full", action="store_true", help="Forza una riconciliazione completa")
    mode.add_argument("--incremental", action="store_true", help="Controlla recentchanges prima della sincronizzazione")
    mode.add_argument("--loop", action="store_true", help="Esegue il controllo periodico")
    parser.add_argument("--limit", type=int, default=10, help="Numero massimo di pagine nel dry-run")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    settings = load_settings()
    if args.dry_run:
        run_dry_run(settings, max(1, args.limit))
        return
    if args.loop:
        while True:
            try:
                stats = run_sync(settings)
                print(f"Sincronizzazione MediaWiki completata: {stats}", flush=True)
            except Exception as exc:
                print(f"Sincronizzazione MediaWiki fallita: {exc}", file=sys.stderr, flush=True)
            time.sleep(settings.interval_minutes * 60)
    else:
        stats = run_sync(settings, force_full=args.full)
        print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
