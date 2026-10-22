import os
from pathlib import Path


def secret(name: str, default: str = '') -> str:
    filename = os.environ.get(name + '_FILE')
    return Path(filename).read_text(encoding='utf-8').strip() if filename else os.environ.get(name, default)


DATA_DIR = Path(os.environ.get('DATA_DIR', '/data'))
MAX_BYTES = int(os.environ.get('MAX_IMPORT_BYTES', str(512 * 1024 * 1024)))
DOCLING_URL = os.environ.get('DOCLING_URL', 'http://docling-erika:5001').rstrip('/')
DRIVE_BROKER_URL = os.environ.get('DRIVE_BROKER_URL', '').rstrip('/')
EMBEDDINGS_ENABLED = os.environ.get('EMBEDDINGS_ENABLED', 'true').lower() == 'true'
EMBEDDING_MODEL = os.environ.get('EMBEDDING_MODEL', 'intfloat/multilingual-e5-small')
EMBEDDING_REVISION = os.environ.get('EMBEDDING_REVISION', '614241f622f53c4eeff9890bdc4f31cfecc418b3')
SEMANTIC_MIN_SCORE = float(os.environ.get('SEMANTIC_MIN_SCORE', '0.82'))
GLINER_ENABLED = os.environ.get('GLINER_ENABLED', 'false').lower() == 'true'
GLINER_MODEL = os.environ.get('GLINER_MODEL', 'Ihor/gliner-biomed-small-v1.0')
GLINER_REVISION = os.environ.get('GLINER_REVISION', '9892e7cd16b9a4aa33572b8b80271cd178f1059a')


def prepare_storage() -> None:
    for name in ('originals', 'imports', 'extractions'):
        (DATA_DIR / name).mkdir(parents=True, exist_ok=True)
