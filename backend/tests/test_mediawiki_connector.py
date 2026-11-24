from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import main as core
from app.mediawiki_connector import CrawlResult, CrawledPage, WikiPage, crawl_wiki, extract_document, title_from_href
from app import mediawiki_sync as sync


def make_page(page_id: int, title: str, text: str, links: tuple[str, ...] = ()) -> WikiPage:
    return WikiPage(
        page_id=page_id,
        title=title,
        namespace=0,
        revision_id=page_id,
        modified_at="2026-01-01T00:00:00Z",
        source_url=f"https://wikiweb.centropaghe.it/index.php?title={title}",
        text=text,
        text_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        links=links,
        discarded={},
    )


class FakeClient:
    def __init__(self, pages: dict[str, WikiPage]) -> None:
        self.pages = pages
        self.calls: list[str] = []

    def get_page(self, title: str) -> WikiPage:
        self.calls.append(title)
        return self.pages[title]


class MediaWikiExtractionTests(unittest.TestCase):
    def test_recognizes_mediawiki_path_info_links(self) -> None:
        self.assertEqual(
            title_from_href(
                "/index.php/Manuale_Dipendenti",
                "https://wikiweb.centropaghe.it",
            ),
            "Manuale Dipendenti",
        )

    def test_extracts_structured_content_and_removes_interface(self) -> None:
        html = """
        <div class="toc"><a href="#uno">Indice</a></div>
        <script>window.secret = true;</script>
        <style>.hidden { display: none; }</style>
        <h2>Gestione dipendenti</h2>
        <p>Accedere alla sezione <a href="/index.php?title=Anagrafica">anagrafica</a>.</p>
        <ol><li>Selezionare il dipendente.</li><li>Verificare i dati.</li></ol>
        <table><tr><th>Campo</th><th>Valore</th></tr><tr><td>Matricola</td><td>123</td></tr></table>
        <div class="ambox"><p>Attenzione: verificare prima il contratto.</p></div>
        <span class="mw-editsection">modifica</span>
        """
        text, links, discarded = extract_document(
            html,
            "Pagina prova",
            "https://wikiweb.centropaghe.it",
        )
        self.assertNotIn("window.secret", text)
        self.assertNotIn("Indice", text)
        self.assertNotIn("modifica", text)
        self.assertIn("Gestione dipendenti", text)
        self.assertIn("1. Selezionare il dipendente.", text)
        self.assertIn("2. Verificare i dati.", text)
        self.assertIn("Campo | Valore\nMatricola | 123", text)
        self.assertIn("Attenzione: verificare prima il contratto.", text)
        self.assertEqual(links, ("Anagrafica",))
        self.assertGreater(discarded.get("script", 0), 0)

    def test_crawler_deduplicates_pages_and_stops_cycles(self) -> None:
        root = make_page(1, "Help On Line", "Root documentazione", ("Manuale", "Alias Manuale"))
        manual = make_page(2, "Manuale", "Manuale paghe", ("Help On Line", "Dipendenti"))
        employees = make_page(3, "Dipendenti", "Gestione dipendenti", ("Manuale",))
        client = FakeClient(
            {
                "Help On Line": root,
                "Manuale": manual,
                "Alias Manuale": manual,
                "Dipendenti": employees,
            }
        )
        result = crawl_wiki(client, "Help_On_Line")
        self.assertEqual(set(result.pages), {1, 2, 3})
        self.assertEqual(result.errors, [])
        self.assertLessEqual(len(client.calls), 4)
        self.assertGreaterEqual(len(result.pages[2].paths), 1)


class MediaWikiStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.original_db = core.DB_PATH
        core.DB_PATH = Path(self.temp_dir.name) / "mediawiki.sqlite3"
        sync.ensure_mediawiki_storage()
        self.context = core.CURRENT_TENANT_ID.set(1)

    def tearDown(self) -> None:
        core.CURRENT_TENANT_ID.reset(self.context)
        core.DB_PATH = self.original_db
        self.temp_dir.cleanup()

    def test_page_is_updated_without_duplicate_document(self) -> None:
        first = make_page(100, "Nuova assunzione", "Nuova assunzione\n\nProcedura iniziale completa.")
        paths = [("Help On Line", "Manuale", "Dipendenti", "Nuova assunzione")]
        action = sync.upsert_page(first, paths, "Paghe Web", sync.utc_now())
        self.assertEqual(action, "indexed")

        second = make_page(100, "Nuova assunzione", "Nuova assunzione\n\nProcedura aggiornata con nuovi passaggi.")
        action = sync.upsert_page(second, paths, "Paghe Web", sync.utc_now())
        self.assertEqual(action, "indexed")

        with sqlite3.connect(core.DB_PATH) as conn:
            documents = conn.execute(
                "SELECT COUNT(*) FROM knowledge_documents WHERE tenant_id = 1 AND source LIKE 'WikiWeb%[#100]'"
            ).fetchone()[0]
            chunks = conn.execute(
                "SELECT text FROM vector_chunks WHERE tenant_id = 1 AND source LIKE 'WikiWeb%[#100]'"
            ).fetchall()
            placement = conn.execute(
                """
                SELECT a.name, m.name
                FROM knowledge_documents d
                JOIN knowledge_modules m ON m.id = d.module_id
                JOIN knowledge_areas a ON a.id = m.area_id
                WHERE d.tenant_id = 1 AND d.source LIKE 'WikiWeb%[#100]'
                """
            ).fetchone()
        self.assertEqual(documents, 1)
        self.assertTrue(any("aggiornata" in row[0] for row in chunks))
        self.assertEqual(placement, ("Paghe Web", "Manuale / Dipendenti"))

    def test_empty_page_is_recorded_but_not_indexed(self) -> None:
        page = make_page(101, "Pagina vuota", "Pagina vuota")
        action = sync.upsert_page(
            page,
            [("Help On Line", "Help", "Generale", "Pagina vuota")],
            "Paghe Web",
            sync.utc_now(),
        )
        self.assertEqual(action, "empty")
        with sqlite3.connect(core.DB_PATH) as conn:
            status = conn.execute(
                "SELECT status FROM mediawiki_pages WHERE tenant_id = 1 AND page_id = 101"
            ).fetchone()[0]
            chunks = conn.execute(
                "SELECT COUNT(*) FROM vector_chunks WHERE tenant_id = 1 AND source LIKE 'WikiWeb%[#101]'"
            ).fetchone()[0]
        self.assertEqual(status, "empty")
        self.assertEqual(chunks, 0)

    def test_partial_crawl_does_not_delete_existing_pages(self) -> None:
        page = make_page(102, "Pagina stabile", "Pagina stabile\n\nContenuto operativo completo.")
        paths = [("Help On Line", "Manuale", "Stabili", "Pagina stabile")]
        sync.upsert_page(page, paths, "Paghe Web", sync.utc_now())
        result = CrawlResult(pages={}, errors=["errore temporaneo"])
        stats = sync.apply_crawl(result, sync.MediaWikiSettings(
            base_url="https://wikiweb.centropaghe.it",
            root_page="Help_On_Line",
            username="test",
            password="test",
            tenant="principale",
            area="Paghe Web",
            interval_minutes=15,
            full_sync_hours=24,
        ), sync.utc_now())
        self.assertEqual(stats["deleted"], 0)
        with sqlite3.connect(core.DB_PATH) as conn:
            remaining = conn.execute(
                "SELECT COUNT(*) FROM mediawiki_pages WHERE tenant_id = 1 AND page_id = 102"
            ).fetchone()[0]
        self.assertEqual(remaining, 1)

    def test_missing_page_requires_two_complete_reconciliations(self) -> None:
        page = make_page(103, "Pagina rimossa", "Pagina rimossa\n\nContenuto da rimuovere in sicurezza.")
        paths = [("Help On Line", "Manuale", "Archivio", "Pagina rimossa")]
        sync.upsert_page(page, paths, "Paghe Web", sync.utc_now())
        self.assertEqual(sync.delete_unseen_pages(set()), 0)
        with sqlite3.connect(core.DB_PATH) as conn:
            status = conn.execute(
                "SELECT status FROM mediawiki_pages WHERE tenant_id = 1 AND page_id = 103"
            ).fetchone()[0]
        self.assertEqual(status, "missing")
        self.assertEqual(sync.delete_unseen_pages(set()), 1)
        with sqlite3.connect(core.DB_PATH) as conn:
            remaining = conn.execute(
                "SELECT COUNT(*) FROM mediawiki_pages WHERE tenant_id = 1 AND page_id = 103"
            ).fetchone()[0]
        self.assertEqual(remaining, 0)


if __name__ == "__main__":
    unittest.main()
