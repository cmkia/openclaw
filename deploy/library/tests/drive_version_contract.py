#!/usr/bin/env python3
"""Exercise the real Drive download adapter against a local HTTP contract fixture.

No Google credentials, database, model or network outside loopback is needed.
The fixture supplies a remote revision; the production adapter owns acceptance.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main() -> None:
    started = time.monotonic()
    body = b"Synthetic academic source, revision two.\n"
    fixture_key = secrets.token_hex(24)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/v1/files/fixture_file_42/download":
                self.send_error(404)
                return
            if self.headers.get("Authorization") != "Bearer " + fixture_key:
                self.send_error(401)
                return
            requests.append(self.path)
            self.send_response(200)
            self.send_header("X-Drive-Version", "2")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # Use the public startup configuration, and exclude inherited live keys.
        os.environ["DRIVE_BROKER_URL"] = "http://127.0.0.1:" + str(server.server_port)
        os.environ["DRIVE_BROKER_API_KEY"] = fixture_key
        os.environ.pop("DRIVE_BROKER_API_KEY_FILE", None)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from app import drive

        with tempfile.TemporaryDirectory(prefix="library-version-contract-") as directory:
            target = Path(directory) / "source.download"
            try:
                drive.download("fixture_file_42", target, expected_version="1")
            except ValueError as error:
                if "changed since inventory" not in str(error):
                    raise AssertionError("A different guard rejected the request") from error
            else:
                raise AssertionError("A different revision was accepted under the inventory revision")
            if target.exists():
                raise AssertionError("The mismatched revision left a source file behind")

            result = drive.download("fixture_file_42", target, expected_version="2")
            if target.read_bytes() != body:
                raise AssertionError("The matching revision was not downloaded intact")
            if result != {"sha256": hashlib.sha256(body).hexdigest(), "byte_size": len(body), "version": "2"}:
                raise AssertionError("Accepted bytes lost their checksum, size or revision")
            if len(requests) != 2:
                raise AssertionError("Both cases did not reach the authenticated HTTP fixture")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    print(json.dumps({
        "passed": True,
        "checks": ["mismatched_remote_revision_rejected_without_file", "matching_revision_download_integrity"],
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }))


if __name__ == "__main__":
    main()
