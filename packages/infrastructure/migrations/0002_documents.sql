-- Uploaded documents, their extracted text and row-level security.
-- The web role runs every document query inside a transaction with `app.user_id` set to the
-- signed-in person; the policies show it only documents of projects that person may see.
-- The worker role processes and purges documents of every project.

CREATE FUNCTION app_viewer_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Members see their projects, admins see every project. Runs with the caller's rights.
CREATE FUNCTION app_can_see_project(target uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
             SELECT 1 FROM project_members m
              WHERE m.project_id = target AND m.user_id = app_viewer_id())
        OR EXISTS (SELECT 1 FROM users u WHERE u.id = app_viewer_id() AND u.role = 'admin')
  $$;

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  kind text,
  audience text CHECK (audience IN ('internal', 'client')),
  audience_source text CHECK (audience_source IN ('pm', 'rule', 'default')),
  document_date timestamptz,
  date_source text,
  uncertain text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  extractor text,
  chunk_count integer NOT NULL DEFAULT 0,
  uploaded_by uuid NOT NULL REFERENCES users (id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (project_id, sha256)
);
CREATE INDEX documents_project_idx ON documents (project_id, uploaded_at DESC);
CREATE INDEX documents_uploaded_at_idx ON documents (uploaded_at);

CREATE TABLE document_chunks (
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  -- Copied from the document so the policy needs no join.
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  locator jsonb NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (document_id, position)
);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_viewer ON documents TO octobrief_app
  USING (app_can_see_project(project_id))
  WITH CHECK (app_can_see_project(project_id) AND uploaded_by = app_viewer_id());
CREATE POLICY documents_worker ON documents TO octobrief_worker USING (true) WITH CHECK (true);
CREATE POLICY chunks_viewer ON document_chunks TO octobrief_app
  USING (app_can_see_project(project_id));
CREATE POLICY chunks_worker ON document_chunks TO octobrief_worker USING (true) WITH CHECK (true);

GRANT EXECUTE ON FUNCTION app_viewer_id(), app_can_see_project(uuid) TO octobrief_app;
GRANT SELECT, INSERT, DELETE ON documents TO octobrief_app;
-- The PM corrects the classification; nothing else of a document changes from the web.
GRANT UPDATE (kind, audience, audience_source, uncertain) ON documents TO octobrief_app;
GRANT SELECT ON document_chunks TO octobrief_app;
GRANT SELECT, UPDATE, DELETE ON documents TO octobrief_worker;
GRANT SELECT, INSERT, DELETE ON document_chunks TO octobrief_worker;
