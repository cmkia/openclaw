import hashlib
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
from psycopg.types.json import Jsonb

from . import db
from .config import DRIVE_BROKER_URL, MAX_BYTES, secret


class DriveUnavailableError(RuntimeError):
    pass


UNAVAILABLE_MESSAGE = ('The private Google Drive connection is temporarily unavailable. Retry synchronization; '
                       'if it persists, ask the operator to check the central connection. Keep sharing restricted.')


def parse_link(url: str) -> tuple[str, str] | None:
    """Identify Drive resources without fetching a sharing page or using its login cookies."""
    parts = urlsplit(url)
    if parts.hostname not in ('drive.google.com', 'docs.google.com'):
        return None
    if parts.scheme != 'https' or parts.username or parts.password or parts.port not in (None, 443):
        raise ValueError('Use a standard HTTPS Google Drive link for the connected private Drive')
    kind = 'file'
    path = parts.path.rstrip('/')
    if parts.hostname == 'drive.google.com':
        folder = re.fullmatch(r'/drive(?:/u/\d+)?/folders/([^/]+)', path)
        file = re.fullmatch(r'/file/d/([^/]+)(?:/.*)?', path)
        if folder:
            kind, identifier = 'folder', folder[1]
        elif file:
            identifier = file[1]
        elif path in ('/open', '/uc'):
            ids = parse_qs(parts.query).get('id', [])
            identifier = ids[0] if len(ids) == 1 else ''
        else:
            identifier = ''
    else:
        file = re.fullmatch(r'/(?:document|spreadsheets|presentation)/d/([^/]+)(?:/.*)?', path)
        identifier = file[1] if file else ''
    if not re.fullmatch(r'[A-Za-z0-9_-]{5,200}', identifier):
        raise ValueError('Unsupported Google Drive link; use a file link or the configured folder link')
    return kind, identifier


def client() -> httpx.Client:
    key = secret('DRIVE_BROKER_API_KEY')
    if not DRIVE_BROKER_URL or not key:
        raise ValueError('Drive synchronization is pending central broker authorization')
    return httpx.Client(base_url=DRIVE_BROKER_URL, headers={'Authorization': 'Bearer ' + key},
                        timeout=httpx.Timeout(180, connect=15), follow_redirects=False, trust_env=False)


def status() -> dict:
    if not DRIVE_BROKER_URL or not secret('DRIVE_BROKER_API_KEY'):
        return {'authorized': False, 'status': 'pending_authorization'}
    try:
        with client() as broker:
            response = broker.get('/v1/status')
            response.raise_for_status()
            data = response.json()
        # Admin authorization URLs and OAuth credentials never enter agent results.
        return {key: data[key] for key in ('authorized','folder_id','account','status','access_scope','read_only') if key in data}
    except httpx.HTTPError:
        return {'authorized': False, 'status': 'broker_unavailable_or_pending_authorization'}


def synchronize(job_id=None, lease_owner: str | None = None, *, requested_file_id: str | None = None,
                title: str = '', edition: str = '') -> dict:
    try:
        with client() as broker:
            response = broker.get(f'/v1/files/{requested_file_id}' if requested_file_id else '/v1/files')
            if requested_file_id and response.status_code in (403, 404):
                raise ValueError('The Drive file is outside the authorized scope or unavailable to its connected account. '
                                 'Check the connected account and its authorized scope; keep sharing restricted.')
            if requested_file_id and response.status_code == 400:
                raise ValueError('The Drive link does not identify a supported downloadable document. '
                                 'Use a direct file link, not a folder or shortcut; keep sharing restricted.')
            if requested_file_id and response.status_code == 413:
                raise ValueError('The Drive file exceeds the authorized broker import size limit. '
                                 'Choose a smaller supported document; keep sharing restricted.')
            response.raise_for_status()
            inventory = response.json()
    except httpx.HTTPError:
        raise DriveUnavailableError(UNAVAILABLE_MESSAGE) from None
    if not requested_file_id and inventory.get('complete') is not True:
        raise ValueError('Drive inventory is incomplete; availability was not changed')
    files = [inventory['file']] if requested_file_id else inventory.get('files', [])
    queued = 0
    selected = None
    with db.connect() as conn:
        # Single-writer sync prevents duplicate jobs across overlapping user requests.
        conn.execute('SELECT pg_advisory_xact_lock(7348216002)')
        if job_id:
            claim = conn.execute("""SELECT id FROM library_jobs WHERE id=%s AND lease_owner=%s
              AND lease_until>now() AND status='processing' FOR UPDATE""", (job_id, lease_owner)).fetchone()
            if not claim:
                raise RuntimeError('Job lease expired before Drive publication')
        for item in files:
            key = 'drive:' + item['id']
            version = str(item.get('version') or item.get('modified_time') or '')
            previous = conn.execute('SELECT * FROM library_sources WHERE source_key=%s', (key,)).fetchone()
            if previous and previous['version'] == version:
                conn.execute('UPDATE library_sources SET active=true,updated_at=now() WHERE source_key=%s', (key,))
                if requested_file_id:
                    document = conn.execute('SELECT status FROM library_documents WHERE id=%s', (previous['document_id'],)).fetchone()
                    latest = conn.execute("SELECT id FROM library_jobs WHERE document_id=%s AND kind='convert' ORDER BY created_at DESC LIMIT 1",
                                          (previous['document_id'],)).fetchone()
                    selected = {'job_id': latest['id'] if latest else None, 'document_id': previous['document_id'],
                                'status': document['status'], 'duplicate': True}
                continue
            if previous:
                conn.execute('UPDATE library_sources SET active=false,updated_at=now() WHERE source_key=%s', (key,))
            inflight = conn.execute("""SELECT id,status,document_id FROM library_jobs WHERE kind='drive_file'
              AND payload->>'source_key'=%s AND payload->>'version'=%s AND status IN ('queued','processing')""",
                                    (key, version)).fetchone()
            if not inflight:
                inflight = conn.execute("INSERT INTO library_jobs(kind,payload) VALUES('drive_file',%s) RETURNING id,status,document_id",
                             (Jsonb({'file_id': item['id'], 'source_key': key, 'version': version,
                                     'title': title if requested_file_id and title else item['name'],
                                     'edition': edition if requested_file_id else '',
                                     'filename': item['name'], 'metadata': item}),)).fetchone()
                queued += 1
                duplicate = False
            else:
                duplicate = True
            if requested_file_id:
                selected = {**inflight, 'job_id': inflight['id'], 'duplicate': duplicate}
                selected.pop('id')
        if not requested_file_id:
            # Only a complete inventory can retire sources missing from the Drive.
            active_keys = ['drive:' + item['id'] for item in files]
            conn.execute("UPDATE library_sources SET active=false,updated_at=now() WHERE provider='drive' AND NOT(source_key=ANY(%s::text[]))",
                         (active_keys,))
            conn.execute("""INSERT INTO library_settings(key,value) VALUES('drive_last_sync',%s)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()""",
                         (Jsonb({'file_count': len(files), 'jobs_queued': queued}),))
    return {'file_count': len(files), 'jobs_queued': queued,
            **({'complete': True} if not requested_file_id else {}), **(selected or {})}


def import_link(url: str, title: str, edition: str = '') -> dict:
    target = parse_link(url)
    if target is None:
        raise ValueError('Expected a Google Drive link')
    kind, identifier = target
    if kind == 'folder':
        state = status()
        if not state.get('authorized'):
            raise DriveUnavailableError(UNAVAILABLE_MESSAGE)
        if state.get('access_scope') == 'drive':
            raise ValueError('This connection authorizes the entire Drive. Use a file link to import one document, '
                             'or explicitly synchronize Drive to import the entire authorized inventory. Keep sharing restricted.')
        if identifier != state.get('folder_id'):
            raise ValueError('This is not the configured authorized client folder. Use that folder and keep sharing restricted.')
        from .library import enqueue
        job = enqueue('drive_sync', {})
        result = {'job_id': job['id'], 'status': job['status'], 'document_id': None, 'duplicate': False}
    else:
        result = synchronize(requested_file_id=identifier, title=title, edition=edition)
    return {**result, 'route': 'authorized_drive', 'sharing': 'keep_restricted',
            'instruction': 'Use this private Drive connection. Do not request public link sharing. '
                           'Poll the returned job and report its actual import status.'}


def download(file_id: str, target: Path, expected_version: str | None = None) -> dict:
    if not file_id.replace('_', '').replace('-', '').isalnum():
        raise ValueError('Invalid Drive file ID')
    digest = hashlib.sha256()
    size = 0
    try:
        with client() as broker, broker.stream('GET', f'/v1/files/{file_id}/download') as response:
            response.raise_for_status()
            version = response.headers.get('x-drive-version') or response.headers.get('x-drive-modified-time') or ''
            if expected_version is not None and version != expected_version:
                raise ValueError('Drive file changed since inventory; synchronize Drive again before importing this revision')
            if int(response.headers.get('content-length', 0)) > MAX_BYTES:
                raise ValueError('Drive document exceeds the configured size limit')
            with target.open('wb') as handle:
                for part in response.iter_bytes(1024 * 1024):
                    size += len(part)
                    if size > MAX_BYTES:
                        raise ValueError('Drive document exceeds the configured size limit')
                    digest.update(part)
                    handle.write(part)
        return {'sha256': digest.hexdigest(), 'byte_size': size, 'version': version}
    except BaseException:
        target.unlink(missing_ok=True)
        raise
