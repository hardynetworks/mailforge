ALTER TABLE api_keys ADD COLUMN scope text NOT NULL DEFAULT 'full'; -- full | send
ALTER TABLE domains ADD COLUMN last_checked_at timestamptz;
ALTER TABLE domains ADD COLUMN check_detail jsonb;
ALTER TABLE domains ADD COLUMN manual_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN disabled boolean NOT NULL DEFAULT false;

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid,
  user_id uuid,
  actor text,
  action text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created ON audit_log (created_at DESC);
CREATE INDEX audit_org ON audit_log (org_id, created_at DESC);
