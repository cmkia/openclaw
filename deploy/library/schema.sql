CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS library_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sha256 text NOT NULL UNIQUE,
 title text NOT NULL,
 edition text NOT NULL DEFAULT '',
 filename text NOT NULL,
 original_path text NOT NULL,
 byte_size bigint NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','pending_review','failed')),
 review_reason text,
 page_count integer NOT NULL DEFAULT 0,
 extraction jsonb NOT NULL DEFAULT '{}',
 embedding_model text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_sources (
 source_key text PRIMARY KEY,
 provider text NOT NULL CHECK (provider IN ('upload','url','drive')),
 document_id uuid REFERENCES library_documents(id),
 version text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT true,
 metadata jsonb NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_sources_document ON library_sources(document_id) WHERE active;
CREATE TABLE IF NOT EXISTS library_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK (kind IN ('convert','url','drive_sync','drive_file','enrich')),
 document_id uuid REFERENCES library_documents(id),
 payload jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
 phase text NOT NULL DEFAULT 'queued',
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 lease_owner text,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_jobs_pending ON library_jobs(available_at,created_at) WHERE status IN ('queued','processing');
CREATE UNIQUE INDEX IF NOT EXISTS library_jobs_convert_active ON library_jobs(document_id) WHERE kind='convert' AND status IN ('queued','processing');
CREATE TABLE IF NOT EXISTS library_chunks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 document_id uuid NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE,
 ordinal integer NOT NULL,
 chapter text NOT NULL,
 section text NOT NULL,
 heading_path jsonb NOT NULL DEFAULT '[]',
 page_start integer,
 page_end integer,
 content text NOT NULL,
 content_kind text NOT NULL DEFAULT 'text',
 source_refs jsonb NOT NULL DEFAULT '[]',
 embedding vector(384),
 fts tsvector GENERATED ALWAYS AS (to_tsvector('simple',content)) STORED,
 UNIQUE(document_id,ordinal)
);
CREATE INDEX IF NOT EXISTS library_chunks_scope ON library_chunks(document_id,chapter,section,ordinal);
CREATE INDEX IF NOT EXISTS library_chunks_fts ON library_chunks USING gin(fts);
CREATE INDEX IF NOT EXISTS library_chunks_embedding ON library_chunks USING hnsw(embedding vector_cosine_ops);
CREATE TABLE IF NOT EXISTS library_entities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 chunk_id uuid NOT NULL REFERENCES library_chunks(id) ON DELETE CASCADE,
 entity_text text NOT NULL,
 entity_type text NOT NULL,
 start_offset integer NOT NULL,
 end_offset integer NOT NULL,
 confidence real NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 model text NOT NULL,
 model_revision text NOT NULL,
 reviewed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS library_entities_chunk ON library_entities(chunk_id);
CREATE INDEX IF NOT EXISTS library_entities_name ON library_entities(lower(entity_text));
CREATE TABLE IF NOT EXISTS library_settings (
 key text PRIMARY KEY,
 value jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM library_settings WHERE key='schema_version' AND value='2'::jsonb) THEN
  ALTER TABLE library_jobs DROP CONSTRAINT IF EXISTS library_jobs_kind_check;
  ALTER TABLE library_jobs ADD CONSTRAINT library_jobs_kind_check
    CHECK(kind IN ('convert','url','drive_sync','drive_file','enrich'));
  INSERT INTO library_settings(key,value) VALUES('schema_version','2'::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now();
 END IF;
END $$;
