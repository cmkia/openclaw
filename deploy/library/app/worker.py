import json
import logging
import mimetypes
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from psycopg.types.json import Jsonb

from . import chunking, db, drive, embeddings, entities, library, network
from .config import DATA_DIR, DOCLING_URL, EMBEDDING_MODEL, GLINER_ENABLED, prepare_storage, secret

log = logging.getLogger('library.worker')
OWNER = str(uuid.uuid4())


def claim() -> dict | None:
    with db.connect() as conn:
        # Expired exhausted work must be terminal and visible after a process crash.
        exhausted = conn.execute("""UPDATE library_jobs SET status='failed',phase='failed',
          error='Worker stopped after the final attempt; retry this job explicitly',updated_at=now()
          WHERE status='processing' AND lease_until<now() AND attempts>=3 RETURNING document_id,kind""").fetchall()
        for item in exhausted:
            if item['kind'] == 'enrich':
                conn.execute('UPDATE library_documents SET extraction=extraction || %s WHERE id=%s',
                             (Jsonb({'entities_status': 'failed', 'entities_error': 'Worker stopped during enrichment'}), item['document_id']))
            elif item['document_id'] and item['kind'] == 'convert':
                conn.execute("UPDATE library_documents SET status='failed',updated_at=now() WHERE id=%s AND status='processing'",
                             (item['document_id'],))
        job = conn.execute("""SELECT * FROM library_jobs WHERE attempts<3 AND
          ((status='queued' AND available_at<=now()) OR (status='processing' AND lease_until<now()))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1""").fetchone()
        if not job:
            return None
        return conn.execute("""UPDATE library_jobs SET status='processing',attempts=attempts+1,
          lease_owner=%s,lease_until=now()+interval '120 seconds',error=NULL,updated_at=now()
          WHERE id=%s RETURNING *""", (OWNER, job['id'])).fetchone()


def phase(job_id, name: str, payload_patch: dict | None = None) -> None:
    with db.connect() as conn:
        row = conn.execute("""UPDATE library_jobs SET phase=%s,payload=payload || %s,
          lease_until=now()+interval '120 seconds',updated_at=now()
          WHERE id=%s AND lease_owner=%s AND lease_until>now() AND status='processing' RETURNING id""",
                           (name, Jsonb(payload_patch or {}), job_id, OWNER)).fetchone()
        if not row:
            raise RuntimeError('Job lease is no longer owned by this worker')


def heartbeat(job_id, stop: threading.Event) -> None:
    while not stop.wait(25):
        try:
            with db.connect() as conn:
                conn.execute("""UPDATE library_jobs SET lease_until=now()+interval '120 seconds',updated_at=now()
                 WHERE id=%s AND lease_owner=%s AND lease_until>now() AND status='processing'""", (job_id, OWNER))
        except Exception:
            log.warning('Job heartbeat failed; publication will revalidate ownership')


def docling(job: dict, document: dict) -> dict:
    payload = job['payload']
    headers = {'X-Api-Key': secret('DOCLING_API_KEY')}
    with httpx.Client(base_url=DOCLING_URL, headers=headers, timeout=httpx.Timeout(300, connect=20),
                      trust_env=False) as client:
        task_id = payload.get('docling_task_id')
        if task_id:
            probe = client.get('/v1/status/poll/' + task_id)
            if probe.status_code == 404:
                task_id = None
            else:
                probe.raise_for_status()
        if not task_id:
            phase(job['id'], 'docling_submit')
            with Path(document['original_path']).open('rb') as handle:
                response = client.post('/v1/convert/file/async',
                    files={'files': (document['filename'], handle, 'application/octet-stream')},
                    data={'to_formats': 'json', 'do_ocr': 'true', 'do_table_structure': 'true',
                          'do_pdf_heading_hierarchy': 'true', 'include_images': 'false',
                          'image_export_mode': 'placeholder', 'document_timeout': '14400'})
            response.raise_for_status()
            task_id = response.json()['task_id']
            phase(job['id'], 'docling_wait', {'docling_task_id': task_id})
        deadline = time.monotonic() + 4 * 3600
        while time.monotonic() < deadline:
            phase(job['id'], 'docling_wait')
            response = client.get('/v1/status/poll/' + task_id)
            response.raise_for_status()
            state = response.json()['task_status']
            if state == 'failure':
                phase(job['id'], 'docling_failed', {'docling_task_id': None})
                raise ValueError('Docling conversion failed; inspect the original document and OCR settings')
            if state == 'success':
                response = client.get('/v1/result/' + task_id)
                response.raise_for_status()
                result = response.json()
                exported = result.get('document', {}).get('json_content')
                if not isinstance(exported, dict):
                    raise ValueError('Docling did not return a structured JSON document')
                if result.get('status') not in (None, 'success', 'partial_success'):
                    raise ValueError('Docling returned an unsuccessful conversion')
                exported['_conversion_status'] = result.get('status', 'success')
                return exported
            time.sleep(3)
    raise TimeoutError('Docling did not finish within four hours; the job remains retryable')


def convert(job: dict) -> None:
    document = db.one('SELECT * FROM library_documents WHERE id=%s', (job['document_id'],))
    if not document:
        raise ValueError('Document for conversion is missing')
    with db.connect() as conn:
        owned = conn.execute("""SELECT id FROM library_jobs WHERE id=%s AND lease_owner=%s
          AND lease_until>now() AND status='processing' FOR UPDATE""", (job['id'], OWNER)).fetchone()
        if not owned:
            raise RuntimeError('Job lease expired before conversion')
        conn.execute("UPDATE library_documents SET status='processing',updated_at=now() WHERE id=%s", (document['id'],))
    export_path = DATA_DIR / 'extractions' / (str(document['id']) + '.json')
    if export_path.exists():
        exported = json.loads(export_path.read_text(encoding='utf-8'))
    else:
        exported = docling(job, document)
        temporary = export_path.with_suffix('.' + OWNER + '.tmp')
        temporary.write_text(json.dumps(exported, ensure_ascii=False), encoding='utf-8')
        temporary.chmod(0o600)
        try:
            with db.connect() as conn:
                owned = conn.execute("""SELECT id FROM library_jobs WHERE id=%s AND lease_owner=%s
                  AND lease_until>now() AND status='processing' FOR UPDATE""", (job['id'], OWNER)).fetchone()
                if not owned:
                    raise RuntimeError('Job lease expired before extraction checkpoint')
                temporary.replace(export_path)
        finally:
            temporary.unlink(missing_ok=True)
    phase(job['id'], 'chunking')
    encoder = embeddings.model()
    chunks, report = chunking.extract(exported, tokenizer=encoder.tokenizer if encoder else None)
    if exported.get('_conversion_status') == 'partial_success':
        report['review_reason'] = (report['review_reason'] or '') + '; Docling reported partial extraction'
    if not chunks:
        raise ValueError(report['review_reason'])
    phase(job['id'], 'embedding')
    encoded = [None] * len(chunks)
    for start in range(0, len(chunks), 16):
        batch = [(index, chunk) for index, chunk in enumerate(chunks[start:start + 16], start)
                 if chunk.kind != 'table_oversize']
        if encoder and batch:
            inputs = []
            for _, chunk in batch:
                heading_ids = encoder.tokenizer.encode(chunk.chapter + '\n' + chunk.section, add_special_tokens=False)[:64]
                context = encoder.tokenizer.decode(heading_ids, skip_special_tokens=True)
                inputs.append(context + '\n' + chunk.text)
            for (index, _), vector in zip(batch, embeddings.encode(inputs)):
                encoded[index] = vector
    phase(job['id'], 'publishing')
    with db.connect() as conn:
        owned = conn.execute("""SELECT id FROM library_jobs WHERE id=%s AND lease_owner=%s
          AND lease_until>now() AND status='processing' FOR UPDATE""", (job['id'], OWNER)).fetchone()
        if not owned:
            raise RuntimeError('Job lease expired before publication')
        conn.execute('DELETE FROM library_chunks WHERE document_id=%s', (document['id'],))
        with conn.cursor() as cursor:
            cursor.executemany('''INSERT INTO library_chunks(id,document_id,ordinal,chapter,section,heading_path,
              page_start,page_end,content,content_kind,source_refs,embedding)
              VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)''',
              [(uuid.uuid5(document['id'], str(index) + '\n' + chunk.text),
                document['id'], index, chunk.chapter, chunk.section, Jsonb(chunk.heading_path),
                chunk.page_start, chunk.page_end, chunk.text, chunk.kind, Jsonb(chunk.refs),
                embeddings.vector_literal(encoded[index]) if encoded[index] is not None else None)
               for index, chunk in enumerate(chunks)])
        conn.execute('''UPDATE library_documents SET status=%s,review_reason=%s,page_count=%s,
          extraction=%s,embedding_model=%s,updated_at=now() WHERE id=%s''',
                     ('pending_review' if report['review_reason'] else 'ready', report['review_reason'],
                      report['page_count'], Jsonb(report), EMBEDDING_MODEL if encoder else None, document['id']))
        if GLINER_ENABLED:
            conn.execute("INSERT INTO library_jobs(kind,document_id) VALUES('enrich',%s)", (document['id'],))
            conn.execute("UPDATE library_documents SET extraction=extraction || %s WHERE id=%s",
                         (Jsonb({'entities_status': 'queued'}), document['id']))
        conn.execute("""UPDATE library_jobs SET status='completed',phase='completed',lease_until=NULL,
          updated_at=now() WHERE id=%s AND lease_owner=%s""", (job['id'], OWNER))


def process(job: dict) -> None:
    payload = job['payload']
    if job['kind'] == 'convert':
        convert(job)
    elif job['kind'] == 'enrich':
        phase(job['id'], 'entity_extraction')
        entities.enrich(job['document_id'], job['id'], OWNER)
    elif job['kind'] == 'drive_sync':
        phase(job['id'], 'drive_inventory')
        phase(job['id'], 'drive_enqueued', {'sync_result': drive.synchronize(job['id'], OWNER)})
    else:
        phase(job['id'], 'downloading')
        path = DATA_DIR / 'imports' / (str(job['id']) + '.' + OWNER + '.download')
        if job['kind'] == 'url':
            data = network.download_public(payload['url'], path)
            filename = Path(urlsplit(data['url']).path).name or 'download'
            media_type = data['content_type'].split(';', 1)[0].strip().lower()
            extension = {'text/html': '.html', 'application/pdf': '.pdf', 'text/plain': '.txt'}.get(media_type)
            extension = extension or mimetypes.guess_extension(media_type)
            if extension and not filename.lower().endswith(extension):
                filename += extension
            source_key = 'url:' + payload['url']
            provider = 'url'
        else:
            data = drive.download(payload['file_id'], path, expected_version=payload['version'])
            filename, source_key, provider = payload['filename'], payload['source_key'], 'drive'
        phase(job['id'], 'registering')
        result = library.register_file(path, data['sha256'], data['byte_size'], payload['title'],
            payload.get('edition', ''), filename, source_key, provider, payload.get('version', ''),
            payload.get('metadata', {}), job['id'], OWNER)
        with db.connect() as conn:
            conn.execute('UPDATE library_jobs SET document_id=%s WHERE id=%s AND lease_owner=%s',
                         (result['document_id'], job['id'], OWNER))


def run() -> None:
    logging.basicConfig(level=logging.INFO)
    prepare_storage()
    db.migrate()
    while True:
        job = claim()
        if job is None:
            time.sleep(3)
            continue
        stop = threading.Event()
        thread = threading.Thread(target=heartbeat, args=(job['id'], stop), daemon=True)
        thread.start()
        try:
            process(job)
            with db.connect() as conn:
                conn.execute("""UPDATE library_jobs SET status='completed',phase='completed',lease_until=NULL,
                  updated_at=now() WHERE id=%s AND lease_owner=%s AND lease_until>now() AND status='processing'""", (job['id'], OWNER))
        except Exception as exc:
            message = type(exc).__name__
            if isinstance(exc, (ValueError, RuntimeError)):
                message += ': ' + str(exc)[:500]
            elif isinstance(exc, httpx.HTTPStatusError):
                message += ': upstream HTTP ' + str(exc.response.status_code)
            retry = job['attempts'] < 3
            with db.connect() as conn:
                updated = conn.execute("""UPDATE library_jobs SET status=%s,phase=%s,error=%s,lease_until=NULL,
                  available_at=now()+interval '30 seconds',updated_at=now()
                  WHERE id=%s AND lease_owner=%s AND lease_until>now() AND status='processing' RETURNING id""",
                             ('queued' if retry else 'failed', 'retry_pending' if retry else 'failed', message, job['id'], OWNER)).fetchone()
                if updated and not retry and job['kind'] == 'enrich':
                    conn.execute('UPDATE library_documents SET extraction=extraction || %s WHERE id=%s',
                                 (Jsonb({'entities_status': 'failed', 'entities_error': message}), job['document_id']))
                elif updated and not retry and job['kind'] == 'convert' and job['document_id']:
                    conn.execute("UPDATE library_documents SET status='failed',review_reason=%s,updated_at=now() WHERE id=%s",
                                 (message, job['document_id']))
            log.warning('Job %s: %s', job['id'], message)
        finally:
            stop.set()
            thread.join(timeout=5)


if __name__ == '__main__':
    run()
