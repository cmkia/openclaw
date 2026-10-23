#!/usr/bin/env python3
"""Exercise REST Drive availability and grant reporting against a broker HTTP fixture.

Run in the library image with --network none. Google credentials, PostgreSQL and
models are unnecessary: both import paths fail before database access.
"""

from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time


async def main() -> dict:
    started = time.monotonic()
    key = secrets.token_hex(32)
    broker_key = secrets.token_hex(32)
    requests = []
    whole_drive = False
    failure_status = 503

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get('Authorization') != 'Bearer ' + broker_key:
                self.send_error(401)
                return
            requests.append(self.path)
            if whole_drive and self.path == '/v1/status':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"authorized":true,"access_scope":"drive","read_only":true,"folder_id":null}')
                return
            self.send_response(failure_status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"detail":"Synthetic upstream service unavailable"}')

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
        from app.main import app

        # These errors precede database admission. ASGI routing, authentication
        # and the real Drive owner run without invoking startup migrations.
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(
            transport=transport,
            base_url='http://library.test',
            headers={'Authorization': 'Bearer ' + key},
        ) as client:
            for label, url in (
                ('file', 'https://drive.google.com/file/d/synthetic_unavailable_file/view'),
                ('folder', 'https://drive.google.com/drive/folders/synthetic_unavailable_folder'),
            ):
                response = await client.post('/v1/import/url', json={
                    'url': url, 'title': 'Synthetic unavailability contract',
                })
                assert response.status_code == 503, (
                    f'{label} import must return HTTP 503, got {response.status_code}'
                )
                detail = response.json().get('detail', '').lower()
                assert 'temporarily unavailable' in detail, f'{label} error must explain availability'
                assert 'restricted' in detail, f'{label} error must preserve private sharing'
                assert 'anyone with the link' not in detail, f'{label} error must not ask for public sharing'
            assert requests == ['/v1/files/synthetic_unavailable_file', '/v1/status'], (
                'Both cases must reach the authenticated external broker fixture'
            )
            for failure_status, explanation in ((403, 'authorized scope'), (404, 'authorized scope'),
                                                (400, 'supported downloadable document'), (413, 'size limit')):
                response = await client.post('/v1/import/url', json={
                    'url': 'https://drive.google.com/file/d/synthetic_unavailable_file/view',
                    'title': 'Synthetic inaccessible Drive file',
                })
                assert response.status_code == 400, 'A rejected file must explain the next action instead of retrying'
                detail = response.json()['detail'].lower()
                assert explanation in detail and 'restricted' in detail
            whole_drive = True
            response = await client.get('/v1/drive/status')
            assert response.status_code == 200
            state = response.json()
            assert state['authorized'] is True and state['access_scope'] == 'drive' and state['read_only'] is True
            response = await client.post('/v1/import/url', json={
                'url': 'https://drive.google.com/drive/folders/synthetic_unavailable_folder',
                'title': 'Synthetic whole-Drive folder import',
            })
            assert response.status_code == 400, 'A folder link must not queue an entire-Drive synchronization'
            assert 'file link' in response.json()['detail']
        return {
            'passed': True,
            'checks': [
                'private_file_broker_unavailable_is_actionable_503',
                'private_folder_broker_unavailable_is_actionable_503',
                'inaccessible_private_file_is_actionable_400',
                'unsupported_and_oversized_file_are_actionable_400',
                'whole_drive_readonly_grant_reported',
                'whole_drive_folder_link_does_not_queue_mass_import',
            ],
            'wall_seconds': round(time.monotonic() - started, 3),
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    try:
        report = asyncio.run(main())
    except AssertionError as error:
        report = {'passed': False, 'error': str(error)}
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report['passed'] else 1)
