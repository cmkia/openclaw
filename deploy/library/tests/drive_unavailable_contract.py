#!/usr/bin/env python3
"""Exercise REST availability errors against an authenticated broker HTTP fixture.

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

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get('Authorization') != 'Bearer ' + broker_key:
                self.send_error(401)
                return
            requests.append(self.path)
            self.send_response(503)
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
        assert requests == ['/v1/files', '/v1/status'], (
            'Both cases must reach the authenticated external broker fixture'
        )
        return {
            'passed': True,
            'checks': [
                'private_file_broker_unavailable_is_actionable_503',
                'private_folder_broker_unavailable_is_actionable_503',
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
