"""Exercise broker grants through ASGI; Google HTTP is the only I/O stub."""

import asyncio
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import requests


SOURCE = Path(__file__).resolve().parents[1] / "app.py"
KEYS = {"folder": "f" * 32, "drive": "d" * 32}


def load_broker(directory, grants):
    directory = Path(directory)
    for name, key in KEYS.items():
        (directory / name).write_text(key)
    (directory / "grants.json").write_text(json.dumps({
        name: {**grant, "api_key_file": str(directory / name)}
        for name, grant in grants.items()
    }))
    (directory / "oauth.json").write_text(json.dumps({
        "type": "authorized_user", "client_id": "test", "client_secret": "test",
        "refresh_token": "test", "token": "synthetic-token", "expiry": "2099-01-01T00:00:00Z",
    }))
    with patch.dict(os.environ, {
        "CENTRAL_ROOT_FOLDER_ID": "central_root", "BROKER_CLIENTS_FILE": str(directory / "grants.json"),
        "GOOGLE_CREDENTIALS_FILE": str(directory / "oauth.json"),
    }):
        spec = importlib.util.spec_from_file_location("broker_scope_contract", SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


def response(data, status=200, headers=None):
    result = requests.Response()
    result.status_code = status
    result._content = data if isinstance(data, bytes) else json.dumps(data).encode()
    result._content_consumed = True
    result.headers.update(headers or {})
    return result


async def request(app, path, key):
    messages = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    await app({
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "scheme": "http", "method": "GET", "path": path,
        "raw_path": path.encode(), "query_string": b"",
        "headers": [(b"authorization", ("Bearer " + key).encode())],
        "client": ("127.0.0.1", 1234), "server": ("broker", 8090), "root_path": "",
    }, receive, send)
    status = next(message["status"] for message in messages if message["type"] == "http.response.start")
    body = b"".join(message.get("body", b"") for message in messages if message["type"] == "http.response.body")
    return status, body


class ScopeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="drive-broker-scope-")
        cls.broker = load_broker(cls.temporary.name, {
            "folder": {"folder_id": "tenant_folder"}, "drive": {"access_scope": "drive"},
        })

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def call(self, path, name="drive", google=None):
        with patch.object(self.broker.requests, "get", side_effect=google):
            return asyncio.run(request(self.broker.app, path, KEYS.get(name, name)))

    def provider(self, url, params=None, **kwargs):
        item = url.removeprefix(self.broker.API).strip("/")
        if item:
            if params.get("alt") == "media":
                return response(b"private document", headers={"Content-Length": "16"})
            parents = {"tenant_folder": ["central_root"], "outside_file": ["outside_folder"],
                       "inside_file": ["tenant_folder"]}.get(item, [])
            return response({"id": item, "name": "document.pdf", "parents": parents,
                             "mimeType": "application/pdf", "version": "1", "size": "16",
                             "modifiedTime": "2026-10-01T00:00:00Z", "capabilities": {"canDownload": True}})
        return response({"files": []})

    def test_drive_grant_can_download_outside_folder_but_default_folder_grant_cannot(self):
        self.assertEqual(self.call("/v1/files/outside_file/download", google=self.provider), (200, b"private document"))
        status, _ = self.call("/v1/files/outside_file/download", "folder", self.provider)
        self.assertEqual(status, 403)
        self.assertEqual(self.call("/v1/files/inside_file/download", "folder", self.provider), (200, b"private document"))
        self.assertEqual(self.call("/v1/files/outside_file/download", "invalid", self.provider)[0], 401)

    def test_single_lookup_works_without_inventory_and_preserves_folder_grants(self):
        def provider(url, params, **kwargs):
            self.assertNotEqual(url, self.broker.API, "A file lookup must not scan the account inventory")
            return self.provider(url, params, **kwargs)

        with patch.object(self.broker, "MAX_FILES", 0):
            status, body = self.call("/v1/files/outside_file", google=provider)
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["file"]["id"], "outside_file")
        self.assertEqual(data["file"]["version"], "1")
        self.assertEqual(data["access_scope"], "drive")
        self.assertTrue(data["read_only"])
        self.assertNotIn("complete", data)
        self.assertEqual(self.call("/v1/files/outside_file", "folder", provider)[0], 403)
        self.assertEqual(self.call("/v1/files/inside_file", "folder", provider)[0], 200)
        self.assertEqual(self.call("/v1/files/outside_file", "invalid", provider)[0], 401)

    def test_status_checks_live_drive_permission_and_exposes_read_only_scope(self):
        status, body = self.call("/v1/status", google=self.provider)
        self.assertEqual(status, 200)
        self.assertEqual({key: json.loads(body)[key] for key in ("authorized", "access_scope", "read_only", "folder_id")},
                         {"authorized": True, "access_scope": "drive", "read_only": True, "folder_id": None})
        _, denied = self.call("/v1/status", google=lambda *args, **kwargs: response({}, 403))
        self.assertFalse(json.loads(denied)["authorized"])
        _, folder = self.call("/v1/status", "folder", self.provider)
        self.assertEqual(json.loads(folder)["folder_id"], "tenant_folder")

    def test_drive_inventory_paginates_and_exports_documents_without_folder_traversal(self):
        def provider(url, params, **kwargs):
            self.assertEqual(params["spaces"], "drive")
            self.assertEqual(params["q"], "trashed = false")
            if not params.get("pageToken"):
                shared = [{"id": "outside_file", "name": "Report", "mimeType": "application/vnd.google-apps.document"}]
                # Google's user corpus omits unaccessed shared-drive items.
                return response({"nextPageToken": "second", "files": (shared if params.get("corpora") == "allDrives" else []) + [
                    {"id": "folder_1", "name": "Folder", "mimeType": self.broker.FOLDER},
                    {"id": "shortcut_1", "name": "Shortcut", "mimeType": self.broker.SHORTCUT},
                ]})
            self.assertEqual(params["pageToken"], "second")
            return response({"files": [{"id": "inside_file", "name": "file.pdf", "mimeType": "application/pdf"}]})

        status, body = self.call("/v1/files", google=provider)
        self.assertEqual(status, 200)
        inventory = json.loads(body)
        self.assertTrue(inventory["complete"])
        self.assertEqual([(item["id"], item["name"], item["mime_type"]) for item in inventory["files"]],
                         [("outside_file", "Report.pdf", "application/pdf"), ("inside_file", "file.pdf", "application/pdf")])

    def test_default_folder_inventory_keeps_ancestry_boundary(self):
        def provider(url, params, **kwargs):
            if url == self.broker.API:
                self.assertEqual(params["q"], "'tenant_folder' in parents and trashed = false")
                return response({"files": [{"id": "inside_file", "name": "file.pdf", "mimeType": "application/pdf"}]})
            return self.provider(url, params, **kwargs)

        status, body = self.call("/v1/files", "folder", provider)
        self.assertEqual(status, 200)
        inventory = json.loads(body)
        self.assertEqual(inventory["access_scope"], "folder")
        self.assertEqual([item["id"] for item in inventory["files"]], ["inside_file"])

        def moved(url, params, **kwargs):
            result = self.provider(url, params, **kwargs)
            if url.endswith("/tenant_folder"):
                result = response({**result.json(), "parents": ["outside_folder"]})
            return result

        self.assertEqual(self.call("/v1/files", "folder", moved)[0], 403)

    def test_inventory_never_publishes_partial_results(self):
        for batch, limit, expected in [
            ({"incompleteSearch": True, "files": []}, 20000, 503),
            ({"nextPageToken": "repeated", "files": []}, 20000, 503),
            ({"files": [{"id": "file_1", "name": "One", "mimeType": "application/pdf"},
                        {"id": "file_2", "name": "Two", "mimeType": "application/pdf"}]}, 1, 413),
        ]:
            with self.subTest(batch=batch), patch.object(self.broker, "MAX_FILES", limit):
                status, body = self.call("/v1/files", google=lambda *args, **kwargs: response(batch))
                self.assertEqual(status, expected)
                self.assertNotIn("complete", json.loads(body))

    def test_drive_download_still_enforces_google_permissions_size_and_version(self):
        for change, expected in [({"capabilities": {"canDownload": False}}, 403),
                                 ({"size": str(self.broker.MAX_BYTES + 1)}, 413),
                                 ({"trashed": True}, 400), ({"mimeType": self.broker.SHORTCUT}, 400)]:
            def provider(url, params, **kwargs):
                result = self.provider(url, params, **kwargs)
                if not kwargs.get("stream"):
                    result = response({**result.json(), **change})
                return result

            for suffix in ("", "/download"):
                with self.subTest(change=change, suffix=suffix):
                    self.assertEqual(self.call("/v1/files/outside_file" + suffix, google=provider)[0], expected)

        metadata_reads = 0

        def changed(url, params, **kwargs):
            nonlocal metadata_reads
            result = self.provider(url, params, **kwargs)
            if not kwargs.get("stream"):
                metadata_reads += 1
                result = response({**result.json(), "version": str(metadata_reads)})
            return result

        self.assertEqual(self.call("/v1/files/outside_file/download", google=changed)[0], 409)

    def test_invalid_or_conflicting_scope_prevents_startup(self):
        for grant in ({"access_scope": "all"}, {"access_scope": "drive", "folder_id": "tenant_folder"},
                      {"access_scope": "folder"}, {"folder_id": "invalid/path"}):
            with self.subTest(grant=grant), tempfile.TemporaryDirectory(prefix="drive-broker-invalid-") as directory:
                with self.assertRaises(RuntimeError):
                    load_broker(directory, {"drive": grant})


if __name__ == "__main__":
    unittest.main()
