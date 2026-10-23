#!/usr/bin/env python3
"""Prove individual Drive imports do not depend on or reconcile an entire inventory.

Run in the library image with DATABASE_URL pointing to a dedicated database named
library_scope_test_<suffix>. Uses real PostgreSQL in a temporary schema and a
loopback authenticated broker fixture. No Google credentials or models are used.
"""

from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sys
import threading
import time


async def main() -> dict:
    import psycopg
    from psycopg.conninfo import make_conninfo
    from psycopg import sql

    started = time.monotonic()
    dsn_file = os.environ.get('DATABASE_URL_FILE')
    dsn = Path(dsn_file).read_text().strip() if dsn_file else os.environ.get('DATABASE_URL', '')
    if not dsn:
        raise RuntimeError('Supply DATABASE_URL for a dedicated library_scope_test_<suffix> database')
    admin = psycopg.connect(dsn, autocommit=True)
    database = admin.execute('SELECT current_database()').fetchone()[0]
    if not re.fullmatch(r'library_scope_test_[A-Za-z0-9_]+', database):
        admin.close()
        raise RuntimeError('Refusing to mutate a database without the library_scope_test_ prefix')
    schema = 'selection_' + secrets.token_hex(8)
    admin.execute('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')
    admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
    os.environ['DATABASE_URL'] = make_conninfo(dsn, options=f'-c search_path={schema},public')
    os.environ.pop('DATABASE_URL_FILE', None)
    key, broker_key = secrets.token_hex(32), secrets.token_hex(32)
    mode = 'oversized'
    revision = '1'
    requests = []
    item = {'id': 'synthetic_selected_file', 'name': 'Selected.pdf', 'mime_type': 'application/pdf'}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get('Authorization') != 'Bearer ' + broker_key:
                self.send_error(401)
                return
            requests.append(self.path)
            if self.path == '/v1/files/synthetic_selected_file':
                code, body = 200, {'file': {**item, 'version': revision}}
            elif self.path == '/v1/files' and mode == 'oversized':
                code, body = 413, {'detail': 'Synthetic inventory exceeds its configured limit'}
            elif self.path == '/v1/files':
                code, body = 200, {'complete': mode == 'complete', 'files': [{**item, 'version': revision}]}
            else:
                code, body = 404, {'detail': 'Unknown synthetic fixture resource'}
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    os.environ['DRIVE_BROKER_URL'] = 'http://127.0.0.1:' + str(server.server_port)
    os.environ['DRIVE_BROKER_API_KEY'] = broker_key
    os.environ['LIBRARY_API_KEY'] = key
    os.environ.pop('DRIVE_BROKER_API_KEY_FILE', None)
    os.environ.pop('LIBRARY_API_KEY_FILE', None)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    try:
        import httpx
        from app import db, drive
        from app.main import app

        db.migrate()
        with db.connect() as conn:
            document = conn.execute("""INSERT INTO library_documents(sha256,title,filename,original_path,byte_size,status)
              VALUES(%s,'Existing selected source','Selected.pdf','/synthetic/selected.pdf',1,'ready') RETURNING id""",
                                    ('a' * 64,)).fetchone()['id']
            conn.execute("""INSERT INTO library_sources(source_key,provider,document_id,version) VALUES
              ('drive:synthetic_selected_file','drive',%s,'1'),('drive:synthetic_unrelated_file','drive',%s,'1')""",
                         (document, document))
            conn.execute("INSERT INTO library_settings(key,value) VALUES('drive_last_sync','{\"sentinel\":true}')")
        original_marker = db.one("SELECT * FROM library_settings WHERE key='drive_last_sync'")
        original_unrelated = db.one("SELECT * FROM library_sources WHERE source_key='drive:synthetic_unrelated_file'")
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url='http://library.test',
                                     headers={'Authorization': 'Bearer ' + key}) as client:
            payload = {'url': 'https://drive.google.com/file/d/synthetic_selected_file/view',
                       'title': 'Selected document title', 'edition': 'Selected edition'}
            response = await client.post('/v1/import/url', json=payload)
            assert response.status_code == 200, 'An individual file must import even when the full inventory exceeds its limit'
            assert response.json()['duplicate'] is True and response.json()['status'] == 'ready'
            assert 'complete' not in response.json(), 'A file lookup must not claim a complete Drive inventory'
            assert requests == ['/v1/files/synthetic_selected_file'], 'Individual import must use direct metadata only'
            revision = '2'
            response = await client.post('/v1/import/url', json=payload)
            assert response.status_code == 200 and response.json()['jobs_queued'] == 1
            job = db.one('SELECT * FROM library_jobs WHERE id=%s', (response.json()['job_id'],))
            assert job['kind'] == 'drive_file' and job['payload']['version'] == '2'
            assert job['payload']['title'] == payload['title'] and job['payload']['edition'] == payload['edition']
            assert db.one("SELECT active FROM library_sources WHERE source_key='drive:synthetic_selected_file'")['active'] is False
            assert db.one("SELECT * FROM library_sources WHERE source_key='drive:synthetic_unrelated_file'") == original_unrelated
            assert db.one("SELECT * FROM library_settings WHERE key='drive_last_sync'") == original_marker

        # The worker's full-sync owner must still reject incomplete inventories
        # and only reconcile missing sources after a complete inventory.
        mode = 'incomplete'
        try:
            drive.synchronize()
        except ValueError as error:
            assert 'incomplete' in str(error)
        else:
            raise AssertionError('An incomplete full inventory was accepted')
        assert db.one("SELECT * FROM library_sources WHERE source_key='drive:synthetic_unrelated_file'") == original_unrelated
        assert db.one("SELECT * FROM library_settings WHERE key='drive_last_sync'") == original_marker
        mode = 'complete'
        result = drive.synchronize()
        assert result['complete'] is True and result['file_count'] == 1
        assert db.one("SELECT active FROM library_sources WHERE source_key='drive:synthetic_unrelated_file'")['active'] is False
        assert db.one("SELECT value FROM library_settings WHERE key='drive_last_sync'")['value'] == {'file_count': 1, 'jobs_queued': 0}
        return {'passed': True, 'checks': ['selected_file_bypasses_oversized_inventory',
                'selected_revision_queues_job_and_retires_only_selected_source',
                'selected_import_preserves_unrelated_sources_and_sync_marker',
                'only_complete_full_sync_reconciles_absent_sources'],
                'wall_seconds': round(time.monotonic() - started, 3)}
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))
        admin.close()


if __name__ == '__main__':
    try:
        report = asyncio.run(main())
    except AssertionError as error:
        report = {'passed': False, 'error': str(error)}
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report['passed'] else 1)
