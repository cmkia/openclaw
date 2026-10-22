"""Read-only Google Drive access with server-owned folder grants per client."""

import hmac
import json
import os
import re
import threading
from pathlib import Path

import requests
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from google.auth.transport.requests import Request
from google.oauth2.service_account import Credentials
from google.oauth2.credentials import Credentials as UserCredentials


SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
API = "https://www.googleapis.com/drive/v3/files"
FOLDER = "application/vnd.google-apps.folder"
SHORTCUT = "application/vnd.google-apps.shortcut"
WORKSPACE = {
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.spreadsheet",
}
MAX_FILES = int(os.getenv("MAX_INVENTORY_FILES", "20000"))
MAX_BYTES = int(os.getenv("MAX_DOWNLOAD_BYTES", str(512 * 1024 * 1024)))
ROOT = os.environ["CENTRAL_ROOT_FOLDER_ID"]
clients = json.loads(Path(os.environ["BROKER_CLIENTS_FILE"]).read_text())
for client in clients.values():
    client["key"] = Path(client["api_key_file"]).read_text().strip()
    if len(client["key"]) < 32:
        raise RuntimeError("Broker client key must be at least 32 characters")
credential_path = os.environ["GOOGLE_CREDENTIALS_FILE"]
credential_data = json.loads(Path(credential_path).read_text())
if credential_data.get("type") == "authorized_user":
    credentials = UserCredentials.from_authorized_user_file(credential_path, scopes=SCOPES)
else:
    credentials = Credentials.from_service_account_file(credential_path, scopes=SCOPES)
credential_lock = threading.Lock()
app = FastAPI(title="CMKIA private Drive broker", docs_url=None, redoc_url=None, openapi_url=None)


def client_for(authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    for name, client in clients.items():
        if token and hmac.compare_digest(token.encode("utf-8"), client["key"].encode("utf-8")):
            return {**client, "client_id": name}
    raise HTTPException(401, "Invalid broker credential")


def file_id(value):
    if not re.fullmatch(r"[A-Za-z0-9_-]{5,200}", value):
        raise HTTPException(400, "Invalid Drive file identifier")
    return value


def google(path="", params=None, stream=False):
    try:
        with credential_lock:
            if not credentials.valid:
                credentials.refresh(Request())
            token = credentials.token
        response = requests.get(
            API + path, params=params,
            headers={"Authorization": "Bearer " + token},
            timeout=(15, 120), stream=stream, allow_redirects=False,
        )
    except Exception:
        raise HTTPException(503, "Google Drive authorization or connection unavailable") from None
    if response.status_code != 200:
        code = response.status_code
        try:
            reasons = {item.get("reason") for item in response.json().get("error", {}).get("errors", [])}
        except (ValueError, TypeError, AttributeError):
            reasons = set()
        response.close()
        if "exportSizeLimitExceeded" in reasons:
            raise HTTPException(413, "Google Workspace export exceeds Google's 10 MB export limit")
        if code in (401, 403):
            raise HTTPException(503, "Drive API permission denied; check API enablement and folder sharing")
        if code == 404:
            raise HTTPException(404, "Drive item unavailable")
        raise HTTPException(502, "Google Drive did not complete the request")
    return response


def metadata(item):
    with google("/" + file_id(item), {
        "fields": "id,name,mimeType,parents,trashed,size,version,modifiedTime,webViewLink,capabilities/canDownload",
        "supportsAllDrives": "true",
    }) as response:
        return response.json()


def inside(item, ancestor):
    todo = [item]
    visited = set()
    while todo:
        current = todo.pop()
        if current == ancestor:
            return True
        if current in visited:
            continue
        visited.add(current)
        if len(visited) > 64:
            raise HTTPException(403, "Drive ancestry exceeds authorized traversal limit")
        info = metadata(current)
        if info.get("trashed"):
            return False
        todo.extend(info.get("parents", []))
    return False


def ensure_client_root(client):
    if not inside(client["folder_id"], ROOT):
        raise HTTPException(403, "Client folder is outside the central project folder")


@app.get("/healthz")
def health():
    return {"ok": True}


@app.get("/v1/status")
def status(client=Depends(client_for)):
    try:
        ensure_client_root(client)
    except HTTPException as error:
        return {"authorized": False, "folder_id": client["folder_id"], "reason": error.detail}
    return {
        "authorized": True, "folder_id": client["folder_id"],
        "account": getattr(credentials, "service_account_email", os.getenv("DRIVE_OWNER_ACCOUNT", "central-authorized-account")),
        "client_id": client["client_id"],
    }


@app.get("/v1/files")
def files(client=Depends(client_for)):
    ensure_client_root(client)
    todo = [client["folder_id"]]
    visited = set()
    output = []
    while todo:
        folder = todo.pop()
        if folder in visited:
            continue
        visited.add(folder)
        if not inside(folder, client["folder_id"]):
            raise HTTPException(409, "Folder moved during inventory; retry synchronization")
        if len(visited) + len(output) > MAX_FILES:
            raise HTTPException(413, "Folder inventory exceeds configured limit; no complete inventory published")
        page = None
        while True:
            params = {
                "q": "'" + file_id(folder) + "' in parents and trashed = false",
                "fields": "nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,version,parents,webViewLink)",
                "pageSize": 1000, "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
            }
            if page:
                params["pageToken"] = page
            with google(params=params) as response:
                batch = response.json()
            ensure_client_root(client)
            if not inside(folder, client["folder_id"]):
                raise HTTPException(409, "Folder moved during inventory; retry synchronization")
            if batch.get("incompleteSearch"):
                raise HTTPException(503, "Drive returned an incomplete inventory")
            for item in batch.get("files", []):
                if len(output) + len(visited) + len(todo) >= MAX_FILES:
                    raise HTTPException(413, "Folder inventory exceeds configured limit")
                mime = item["mimeType"]
                if mime == FOLDER:
                    todo.append(item["id"])
                elif mime != SHORTCUT:
                    exported = mime in WORKSPACE
                    output.append({
                        "id": item["id"], "name": item["name"] + (".pdf" if exported else ""),
                        "mime_type": "application/pdf" if exported else mime,
                        "original_mime_type": mime, "size": item.get("size"),
                        "modified_time": item.get("modifiedTime"), "version": item.get("version"),
                        "parents": item.get("parents", []), "web_view_link": item.get("webViewLink"),
                    })
            page = batch.get("nextPageToken")
            if not page:
                break
    ensure_client_root(client)
    return {"files": output, "complete": True, "folder_id": client["folder_id"]}


@app.get("/v1/files/{item}/download")
def download(item: str, client=Depends(client_for)):
    file_id(item)
    ensure_client_root(client)
    if not inside(item, client["folder_id"]):
        raise HTTPException(403, "File is outside this client's folder")
    info = metadata(item)
    ensure_client_root(client)
    if info.get("trashed") or info["mimeType"] in (FOLDER, SHORTCUT):
        raise HTTPException(400, "Item is not a downloadable document")
    if info.get("size") and int(info["size"]) > MAX_BYTES:
        raise HTTPException(413, "Document exceeds configured byte limit")
    if not info.get("capabilities", {}).get("canDownload", False):
        raise HTTPException(403, "Drive does not permit downloading this item")
    exported = info["mimeType"] in WORKSPACE
    response = google(
        "/" + item + ("/export" if exported else ""),
        {"mimeType": "application/pdf"} if exported else {"alt": "media", "supportsAllDrives": "true"},
        stream=True,
    )
    length = response.headers.get("Content-Length")
    if length and int(length) > MAX_BYTES:
        response.close()
        raise HTTPException(413, "Document exceeds configured byte limit")
    try:
        current = metadata(item)
        if any(current.get(field) != info.get(field) for field in ("version", "modifiedTime", "mimeType")):
            raise HTTPException(409, "Document changed while opening download; retry synchronization")
        if current.get("trashed") or not current.get("capabilities", {}).get("canDownload", False):
            raise HTTPException(403, "Document is no longer available for download")
        ensure_client_root(client)
        if not inside(item, client["folder_id"]):
            raise HTTPException(403, "File moved outside this client's folder")
    except Exception:
        response.close()
        raise

    def content():
        count = 0
        try:
            for chunk in response.iter_content(1024 * 1024):
                count += len(chunk)
                if count > MAX_BYTES:
                    raise RuntimeError("Drive stream exceeded configured byte limit")
                yield chunk
        finally:
            response.close()

    return StreamingResponse(
        content(), media_type="application/pdf" if exported else info["mimeType"],
        headers={"X-Drive-Version": str(info.get("version", "")), "X-Drive-Modified-Time": info.get("modifiedTime", "")},
    )
