-- Sources: where the documents of a project come from besides the manual upload.
-- A pushing source (Microsoft 365, the data warehouse, a folder) is fed by a feeder that runs on
-- the PM's computer and presents a token; a pulling source (Jira, Azure DevOps) is read by the
-- worker with a sealed credential. What they bring enters the same pipeline as uploads.

CREATE TABLE sources (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('m365', 'dwsi', 'files', 'jira', 'ado')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Connector settings of a pulling source; never a credential.
  config jsonb NOT NULL DEFAULT '{}',
  perimeter text[] NOT NULL DEFAULT '{}',
  -- SHA-256 of the token a feeder presents; the token itself is shown once and never stored.
  token_hash text CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  -- The credential of a pulling source, sealed with AES-256-GCM under the installation's key.
  secret_key_version integer,
  secret_iv bytea,
  secret_tag bytea,
  secret_ciphertext bytea,
  cursor jsonb,
  last_sync_at timestamptz,
  -- Up to when the source system's data has been read: the freshness of what it brought.
  data_as_of timestamptz,
  -- A stable error code of the last delivery, never a message of the source system.
  last_error text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX sources_project_idx ON sources (project_id);

ALTER TABLE documents
  ADD COLUMN source_id uuid REFERENCES sources (id) ON DELETE SET NULL,
  ADD COLUMN external_id text,
  ADD COLUMN external_version text,
  -- When the source system says the item was made or changed.
  ADD COLUMN origin_at timestamptz,
  ADD COLUMN external_url text,
  -- When the file was last changed where a feeder read it: a weaker date than the source's own.
  ADD COLUMN file_modified_at timestamptz,
  -- The kind a connector declares for a document it made from the system's data.
  ADD COLUMN system_kind text;
CREATE UNIQUE INDEX documents_external_idx ON documents (source_id, external_id)
  WHERE source_id IS NOT NULL;

-- People and organizations the items of a source name: hidden from every model like the members.
CREATE TABLE project_people (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  email text NOT NULL DEFAULT '',
  -- A name chosen outside the organization: only its full form is hidden.
  untrusted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (project_id, display_name, email)
);

-- Structured items of a tracker (one row per work item, its latest version).
CREATE TABLE tracker_items (
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version text NOT NULL,
  title text NOT NULL,
  record jsonb NOT NULL,
  origin_at timestamptz,
  external_url text,
  removed_at timestamptz,
  PRIMARY KEY (source_id, external_id)
);

-- Rows of the views of a system of record (the data warehouse), as the system gave them.
CREATE TABLE system_rows (
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  view text NOT NULL,
  perimeter text NOT NULL,
  key text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  "values" jsonb NOT NULL,
  extracted_at timestamptz NOT NULL,
  source_synced_at timestamptz,
  PRIMARY KEY (source_id, view, perimeter, key)
);

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracker_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY sources_viewer ON sources TO octobrief_app
  USING (app_can_see_project(project_id)) WITH CHECK (app_can_see_project(project_id));
CREATE POLICY sources_worker ON sources TO octobrief_worker USING (true) WITH CHECK (true);
CREATE POLICY people_viewer ON project_people TO octobrief_app
  USING (app_can_see_project(project_id)) WITH CHECK (app_can_see_project(project_id));
CREATE POLICY people_worker ON project_people TO octobrief_worker USING (true) WITH CHECK (true);
CREATE POLICY tracker_viewer ON tracker_items TO octobrief_app
  USING (app_can_see_project(project_id)) WITH CHECK (app_can_see_project(project_id));
CREATE POLICY tracker_worker ON tracker_items TO octobrief_worker USING (true) WITH CHECK (true);
CREATE POLICY rows_viewer ON system_rows TO octobrief_app
  USING (app_can_see_project(project_id)) WITH CHECK (app_can_see_project(project_id));
CREATE POLICY rows_worker ON system_rows TO octobrief_worker USING (true) WITH CHECK (true);

-- A feeder has no session: its token names the source, and what it brings is stored as the
-- person who connected the source (who must still see the project). Runs with the owner's rights
-- only to find that person; everything else goes through the policies above.
CREATE FUNCTION app_ingest_target(source uuid, presented_hash text)
  RETURNS TABLE (id uuid, project_id uuid, kind text, created_by uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT s.id, s.project_id, s.kind, s.created_by FROM sources s
     WHERE s.id = source AND s.token_hash IS NOT NULL AND s.token_hash = presented_hash
  $$;
REVOKE ALL ON FUNCTION app_ingest_target(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ingest_target(uuid, text) TO octobrief_app;

GRANT SELECT, INSERT, DELETE ON sources TO octobrief_app;
GRANT UPDATE (token_hash, last_sync_at, data_as_of, last_error) ON sources TO octobrief_app;
GRANT SELECT, UPDATE ON sources TO octobrief_worker;
GRANT INSERT ON documents TO octobrief_worker;
GRANT SELECT, INSERT, UPDATE ON project_people TO octobrief_app, octobrief_worker;
GRANT SELECT, INSERT, UPDATE ON tracker_items, system_rows TO octobrief_app, octobrief_worker;
