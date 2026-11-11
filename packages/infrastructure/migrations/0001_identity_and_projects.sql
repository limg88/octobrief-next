-- Users, server-side sessions, login attempts in flight, projects and their members.
-- Authorization is enforced by the use cases; row-level security comes with shared data.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  role text NOT NULL DEFAULT 'pm' CHECK (role IN ('pm', 'admin')),
  locale text NOT NULL DEFAULT 'it' CHECK (locale IN ('it', 'en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
-- Only verified emails identify people when adding members.
CREATE UNIQUE INDEX users_verified_email_key ON users (lower(email)) WHERE email_verified;

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE login_attempts (
  id_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  state text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  client text CHECK (client IS NULL OR length(client) BETWEEN 1 AND 120),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_id_idx ON project_members (user_id);

GRANT SELECT, INSERT, UPDATE ON users TO octobrief_app;
GRANT SELECT, INSERT, DELETE ON sessions, login_attempts TO octobrief_app;
GRANT SELECT, INSERT ON projects, project_members TO octobrief_app;
GRANT SELECT ON users, projects, project_members TO octobrief_worker;
GRANT DELETE ON sessions, login_attempts TO octobrief_worker;
