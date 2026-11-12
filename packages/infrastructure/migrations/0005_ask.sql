-- Ask: the full-text index of the documents, the questions of the PMs and their verified answers.

ALTER TABLE document_chunks
  ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('italian', text)) STORED;
CREATE INDEX document_chunks_search_idx ON document_chunks USING gin (search);

ALTER TABLE facts
  ADD COLUMN search tsvector GENERATED ALWAYS AS
    (to_tsvector('italian', statement || ' ' || coalesce(value, ''))) STORED;
CREATE INDEX facts_search_idx ON facts USING gin (search);

-- Whether the text of a document holds sentences shaped like instructions: shown as data, with
-- a warning, never followed.
ALTER TABLE documents ADD COLUMN suspicious boolean NOT NULL DEFAULT false;

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  asked_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  lang text NOT NULL DEFAULT 'it',
  phase text NOT NULL DEFAULT 'queued'
    CHECK (phase IN ('queued', 'reading', 'checking', 'done', 'failed')),
  -- The verified answer, as `verifyAnswer` made it; read back through `rehydrateVerifiedAnswer`.
  answer jsonb,
  -- A stable error code, never a message of the model.
  error text,
  turns integer,
  backend text,
  asked_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  CHECK ((phase = 'done') = (answer IS NOT NULL))
);
CREATE INDEX questions_asker_idx ON questions (project_id, asked_by, asked_at DESC);

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
-- A question and its answer belong to who asked, for as long as that person sees the project.
CREATE POLICY questions_asker ON questions TO octobrief_app
  USING (asked_by = app_viewer_id() AND app_can_see_project(project_id))
  WITH CHECK (asked_by = app_viewer_id() AND app_can_see_project(project_id));
CREATE POLICY questions_worker ON questions TO octobrief_worker USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, DELETE ON questions TO octobrief_app;
GRANT SELECT, UPDATE ON questions TO octobrief_worker;
GRANT UPDATE (suspicious) ON documents TO octobrief_worker;
GRANT SELECT ON tracker_items, sources, project_people TO octobrief_worker;
