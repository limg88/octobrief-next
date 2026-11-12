-- Deliverables: the runs of a recipe on a project, their revisions (the document as written and
-- as rewritten on request), the PM's judgements and the files made at approval.

CREATE TABLE recipe_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users (id),
  recipe_slug text NOT NULL,
  recipe_version text NOT NULL,
  -- The fingerprint of the recipe the run uses: a recipe that changed is not the same recipe.
  recipe_hash text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'discarded')),
  phase text CHECK (phase IN ('gathering', 'writing', 'checking', 'revising')),
  -- Stable error codes, never a message of the model.
  error_code text,
  revision_error text,
  -- What the run read (the input snapshot, its hash) and what its gates judge with.
  snapshot jsonb,
  gate jsonb,
  usage jsonb NOT NULL DEFAULT '{}',
  -- Anomalies the PM accepted (with a reason) and contradictions the PM decided.
  acceptances jsonb NOT NULL DEFAULT '[]',
  decisions jsonb NOT NULL DEFAULT '[]',
  approval_status text CHECK (approval_status IN ('approving', 'approved', 'render_failed')),
  approval_error text,
  approved_by uuid REFERENCES users (id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recipe_runs_project_idx ON recipe_runs (project_id, created_at DESC);

CREATE TABLE run_revisions (
  run_id uuid NOT NULL REFERENCES recipe_runs (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 1),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  origin text NOT NULL CHECK (origin IN ('writer', 'automatic_cycle', 'pm_request')),
  -- The internal document of the revision, the rows of its red team and the checked answers
  -- of its texts.
  document jsonb NOT NULL,
  red_team jsonb NOT NULL,
  verifications jsonb NOT NULL,
  skeleton_hash text NOT NULL,
  data_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE deliverable_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES recipe_runs (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('internal', 'client')),
  format text NOT NULL CHECK (format IN ('md', 'docx', 'pptx', 'xlsx')),
  file_name text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  blob_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, audience, format)
);

ALTER TABLE recipe_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliverable_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY runs_viewer ON recipe_runs TO octobrief_app
  USING (app_can_see_project(project_id))
  WITH CHECK (app_can_see_project(project_id));
CREATE POLICY runs_worker ON recipe_runs TO octobrief_worker USING (true) WITH CHECK (true);
CREATE POLICY revisions_viewer ON run_revisions FOR SELECT TO octobrief_app
  USING (app_can_see_project(project_id));
CREATE POLICY revisions_worker ON run_revisions TO octobrief_worker USING (true) WITH CHECK (true);
CREATE POLICY files_viewer ON deliverable_files FOR SELECT TO octobrief_app
  USING (app_can_see_project(project_id));
CREATE POLICY files_worker ON deliverable_files TO octobrief_worker USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON recipe_runs TO octobrief_app;
-- The web records the PM's judgements and the request of approval; the worker does the rest.
GRANT UPDATE (status, acceptances, decisions, approval_status, approval_error, approved_by,
              approved_at, revision_error, updated_at) ON recipe_runs TO octobrief_app;
GRANT SELECT ON run_revisions, deliverable_files TO octobrief_app;
GRANT SELECT, UPDATE ON recipe_runs TO octobrief_worker;
GRANT SELECT, INSERT ON run_revisions TO octobrief_worker;
GRANT SELECT, INSERT, DELETE ON deliverable_files TO octobrief_worker;
