"""Optional biomedical entity candidates; no inferred clinical relationships."""
import re
import threading

from psycopg.types.json import Jsonb

from . import db
from .config import GLINER_ENABLED, GLINER_MODEL, GLINER_REVISION

LABELS = ['disease', 'tumor subtype', 'anatomical structure', 'radiotherapy technique',
          'drug', 'biomarker', 'clinical trial', 'treatment protocol']
_model = None
_lock = threading.Lock()
last_error: str | None = None


def status() -> dict:
    return {'enabled': GLINER_ENABLED, 'model': GLINER_MODEL, 'revision': GLINER_REVISION,
            'loaded': _model is not None, 'loaded_scope': 'current_process', 'last_error': last_error,
            'status': 'optional_post_ingestion_enrichment' if GLINER_ENABLED else 'disabled',
            'clinical_relationships_inferred': False, 'medical_benchmark_pending': True}


def extract(text: str) -> list[dict]:
    global _model, last_error
    if not GLINER_ENABLED:
        return []
    with _lock:
        try:
            if _model is None:
                from gliner import GLiNER
                _model = GLiNER.from_pretrained(GLINER_MODEL, revision=GLINER_REVISION,
                                                map_location='cpu', load_tokenizer=True)
                _model.eval()
            # Small overlapping windows avoid the extractor's silent long-input truncation.
            words = list(re.finditer(r'\S+', text))
            found: dict[tuple, dict] = {}
            for offset in range(0, len(words), 80):
                batch = words[offset:offset + 100]
                begin, end = batch[0].start(), batch[-1].end()
                segment = text[begin:end]
                for candidate in _model.predict_entities(segment, LABELS, threshold=0.65):
                    start = begin + int(candidate['start'])
                    finish = begin + int(candidate['end'])
                    if start < begin or finish > end or text[start:finish] != candidate['text']:
                        continue
                    item = {'text': candidate['text'], 'label': candidate['label'],
                            'start': start, 'end': finish, 'score': float(candidate['score'])}
                    key = (start, finish, candidate['label'])
                    if key not in found or item['score'] > found[key]['score']:
                        found[key] = item
            last_error = None
            return list(found.values())
        except Exception as exc:
            last_error = type(exc).__name__ + ': optional biomedical entity extraction failed'
            raise RuntimeError(last_error) from exc


def enrich(document_id, job_id, lease_owner: str) -> None:
    chunks = db.rows('SELECT id,content FROM library_chunks WHERE document_id=%s ORDER BY ordinal', (document_id,))
    projected = []
    for chunk in chunks:
        for item in extract(chunk['content']):
            projected.append((chunk['id'], item['text'], item['label'], item['start'], item['end'],
                              item['score'], GLINER_MODEL, GLINER_REVISION))
    with db.connect() as conn:
        claim = conn.execute("""SELECT id FROM library_jobs WHERE id=%s AND lease_owner=%s AND
          lease_until>now() AND status='processing' FOR UPDATE""", (job_id, lease_owner)).fetchone()
        if not claim:
            raise RuntimeError('Job lease expired before entity publication')
        conn.execute('DELETE FROM library_entities WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=%s)',
                     (document_id,))
        with conn.cursor() as cursor:
            cursor.executemany('''INSERT INTO library_entities(chunk_id,entity_text,entity_type,start_offset,
              end_offset,confidence,model,model_revision) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''', projected)
        conn.execute("""UPDATE library_documents SET extraction=extraction || %s WHERE id=%s""",
                     (Jsonb({'entities_status': 'completed', 'entity_count': len(projected)}), document_id))
        conn.execute("""UPDATE library_jobs SET status='completed',phase='completed',lease_until=NULL,updated_at=now()
          WHERE id=%s AND lease_owner=%s""", (job_id, lease_owner))


def list_entities(document_id: str, entity_type: str | None = None, limit: int = 100) -> dict:
    rows = db.rows('''SELECT e.entity_text,e.entity_type,e.confidence,e.start_offset,e.end_offset,e.model,
      e.model_revision,e.reviewed,c.id AS evidence_id,c.chapter,c.section,c.page_start,c.page_end
      FROM library_entities e JOIN library_chunks c ON c.id=e.chunk_id
      WHERE c.document_id=%s AND (%s::text IS NULL OR e.entity_type=%s)
        AND EXISTS(SELECT 1 FROM library_sources s WHERE s.document_id=c.document_id AND s.active)
      ORDER BY e.confidence DESC LIMIT %s''', (document_id, entity_type, entity_type, min(max(limit, 1), 300)))
    return {'entities': rows, 'role': 'unreviewed_entity_candidates',
            'warning': 'Co-occurrence and entity identity do not establish clinical relationships or equivalence.'}
