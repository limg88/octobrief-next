-- Knowledge: the facts a project's documents state, each with the exact text it comes from,
-- how far the reading of each document is, and the vectors of the text for the search.
-- The worker compiles; the web only reads, under the same row-level security as documents.

ALTER TABLE documents
  ADD COLUMN knowledge_status text CHECK (knowledge_status IN ('pending', 'ready', 'failed')),
  -- A stable error code, never a message of the model.
  ADD COLUMN knowledge_error text,
  ADD COLUMN compiled_at timestamptz;

ALTER TABLE document_chunks
  ADD COLUMN embedding vector(1024),
  -- The encoder that made the vector (`model@digest`): vectors of two encoders never compare.
  ADD COLUMN encoder text;
CREATE INDEX document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE facts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN
    ('person', 'decision', 'risk', 'action', 'status', 'milestone', 'economics', 'note')),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 300),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 1000),
  value text CHECK (value IS NULL OR length(value) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'contested', 'superseded')),
  origin text NOT NULL DEFAULT 'compile' CHECK (origin IN ('compile', 'pm')),
  locked_by_pm boolean NOT NULL DEFAULT false,
  pm_asserted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (origin = 'pm' OR NOT (locked_by_pm OR pm_asserted))
);
CREATE INDEX facts_project_idx ON facts (project_id, key);

CREATE TABLE fact_sources (
  fact_id uuid NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  -- Copied from the fact so the policy needs no join.
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  locator jsonb NOT NULL,
  -- The canonical form of the locator: one source per place of a document.
  locator_key text NOT NULL,
  excerpt text NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 300),
  PRIMARY KEY (fact_id, document_id, locator_key)
);
CREATE INDEX fact_sources_document_idx ON fact_sources (document_id);

-- A fact lives as long as a document states it: when its last source goes (the document was
-- deleted or expired) the fact goes too, and a fact left alone is no longer contested.
-- Runs with the owner's rights: the web deletes documents but never writes facts.
CREATE FUNCTION facts_follow_sources() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
  BEGIN
    DELETE FROM facts f
     WHERE f.id IN (SELECT fact_id FROM removed)
       AND NOT f.pm_asserted
       AND NOT EXISTS (SELECT 1 FROM fact_sources s WHERE s.fact_id = f.id);
    UPDATE facts f SET state = 'active'
     WHERE f.state = 'contested'
       AND f.project_id IN (SELECT project_id FROM removed)
       AND NOT EXISTS (
             SELECT 1 FROM facts o
              WHERE o.project_id = f.project_id AND o.key = f.key
                AND o.id <> f.id AND o.state = 'contested');
    RETURN NULL;
  END
  $$;
CREATE TRIGGER fact_sources_removed AFTER DELETE ON fact_sources
  REFERENCING OLD TABLE AS removed
  FOR EACH STATEMENT EXECUTE FUNCTION facts_follow_sources();

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY facts_viewer ON facts FOR SELECT TO octobrief_app
  USING (app_can_see_project(project_id));
CREATE POLICY facts_worker ON facts TO octobrief_worker USING (true) WITH CHECK (true);
CREATE POLICY fact_sources_viewer ON fact_sources FOR SELECT TO octobrief_app
  USING (app_can_see_project(project_id));
CREATE POLICY fact_sources_worker ON fact_sources TO octobrief_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON facts, fact_sources TO octobrief_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON facts TO octobrief_worker;
GRANT SELECT, INSERT, DELETE ON fact_sources TO octobrief_worker;
GRANT UPDATE (embedding, encoder) ON document_chunks TO octobrief_worker;
