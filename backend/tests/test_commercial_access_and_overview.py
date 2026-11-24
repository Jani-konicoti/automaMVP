from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import main as core


class CommercialAccessAndOverviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.original_db = core.DB_PATH
        core.DB_PATH = Path(self.temp_dir.name) / "application.sqlite3"
        core.ensure_storage()
        self.tenant_context = core.CURRENT_TENANT_ID.set(1)

    def tearDown(self) -> None:
        core.CURRENT_TENANT_ID.reset(self.tenant_context)
        core.DB_PATH = self.original_db
        self.temp_dir.cleanup()

    def test_commercial_request_stores_only_password_hash(self) -> None:
        created = core.request_commercial_access(
            core.CommercialAccessRequestIn(username="commerciale.prova", password="PasswordSicura24!")
        )

        with sqlite3.connect(core.DB_PATH) as conn:
            stored = conn.execute(
                "SELECT password_hash, status_token_hash FROM commercial_access_requests WHERE id = ?",
                (created.id,),
            ).fetchone()

        self.assertNotIn("PasswordSicura24!", stored[0])
        self.assertNotEqual(created.status_token, stored[1])
        status = core.commercial_access_status(created.status_token)
        self.assertEqual(status.status, "pending")
        self.assertEqual(status.username, "commerciale.prova")

    def test_area_overview_contains_each_document(self) -> None:
        now = core.utc_now()
        with sqlite3.connect(core.DB_PATH) as conn:
            area_id = conn.execute(
                "INSERT INTO knowledge_areas (tenant_id, name, position, created_at, updated_at) VALUES (1, 'CPeople', 0, ?, ?)",
                (now, now),
            ).lastrowid
            module_id = conn.execute(
                "INSERT INTO knowledge_modules (tenant_id, area_id, name, position, created_at, updated_at) VALUES (1, ?, 'Documenti', 0, ?, ?)",
                (area_id, now, now),
            ).lastrowid
            conn.commit()

        core.index_vector_chunks("Skills.pdf", "Competenze e valutazione delle skill aziendali.")
        core.index_vector_chunks("Compass.pdf", "Welfare intelligence e informazioni per i dipendenti.")
        with sqlite3.connect(core.DB_PATH) as conn:
            conn.execute(
                "UPDATE knowledge_documents SET module_id = ? WHERE tenant_id = 1",
                (module_id,),
            )
            conn.commit()

        overview = core.scope_overview_chunks(f"area:{area_id}")

        self.assertEqual({item.source for item in overview}, {"Skills.pdf", "Compass.pdf"})


if __name__ == "__main__":
    unittest.main()
