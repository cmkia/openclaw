import threading

from .config import EMBEDDING_MODEL, EMBEDDING_REVISION, EMBEDDINGS_ENABLED

_model = None
_lock = threading.Lock()
last_error: str | None = None


def model():
    global _model, last_error
    if not EMBEDDINGS_ENABLED:
        return None
    with _lock:
        if _model is None:
            try:
                from sentence_transformers import SentenceTransformer
                _model = SentenceTransformer(EMBEDDING_MODEL, revision=EMBEDDING_REVISION,
                                             device='cpu', trust_remote_code=False)
                _model.max_seq_length = 512
                if _model.get_sentence_embedding_dimension() != 384:
                    raise ValueError('This schema requires a 384-dimensional embedding model')
                last_error = None
            except Exception as exc:
                _model = None
                last_error = type(exc).__name__ + ': embedding model could not be loaded'
                raise RuntimeError(last_error) from exc
    return _model


def encode(texts: list[str], query: bool = False) -> list[list[float]]:
    encoder = model()
    if encoder is None:
        return []
    prefix = 'query: ' if query else 'passage: '
    with _lock:
        return encoder.encode([prefix + text for text in texts], normalize_embeddings=True,
                              batch_size=16, show_progress_bar=False).tolist()


def vector_literal(values: list[float]) -> str:
    return '[' + ','.join(str(float(value)) for value in values) + ']'


def status() -> dict:
    return {'enabled': EMBEDDINGS_ENABLED, 'model': EMBEDDING_MODEL, 'revision': EMBEDDING_REVISION,
            'loaded': _model is not None, 'loaded_scope': 'current_process',
            'last_error': last_error, 'validated_for_medical_use': False}
