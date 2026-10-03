CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  daily_limit integer NOT NULL DEFAULT 1000,
  monthly_limit integer NOT NULL DEFAULT 20000,
  suspended boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain text NOT NULL UNIQUE,
  dkim_selector text NOT NULL DEFAULT 'mf1',
  dkim_private_key text NOT NULL,
  dkim_public_key text NOT NULL,
  spf_ok boolean NOT NULL DEFAULT false,
  dkim_ok boolean NOT NULL DEFAULT false,
  dmarc_ok boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  first_name text,
  last_name text,
  attributes jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'subscribed', -- subscribed | unsubscribed | bounced | complained
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_contacts (
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  html text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  subject text NOT NULL,
  from_email text NOT NULL,
  from_name text,
  reply_to text,
  html text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  list_id uuid REFERENCES lists(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft', -- draft | scheduled | sending | sent | cancelled
  scheduled_at timestamptz,
  started_at timestamptz,
  sent_at timestamptz,
  recipient_count integer NOT NULL DEFAULT 0,
  track_opens boolean NOT NULL DEFAULT true,
  track_clicks boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'api', -- api | smtp | campaign
  from_email text NOT NULL,
  from_name text,
  reply_to text,
  to_email text NOT NULL,
  to_name text,
  subject text,
  html text,
  text text,
  headers jsonb NOT NULL DEFAULT '{}',
  variables jsonb NOT NULL DEFAULT '{}',
  raw text,                      -- full RFC822 source for SMTP-submitted mail
  tags text[] NOT NULL DEFAULT '{}',
  track_opens boolean NOT NULL DEFAULT true,
  track_clicks boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'queued', -- queued | sent | deferred | bounced | failed | suppressed
  smtp_response text,
  attempts integer NOT NULL DEFAULT 0,
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX messages_org_created ON messages (org_id, created_at DESC);
CREATE INDEX messages_campaign ON messages (campaign_id);
CREATE INDEX messages_to ON messages (org_id, to_email);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  campaign_id uuid,
  type text NOT NULL, -- sent | delivered | open | click | bounce | complaint | unsubscribe | deferred
  url text,
  ip text,
  user_agent text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_org_type_created ON events (org_id, type, created_at DESC);
CREATE INDEX events_message ON events (message_id);
CREATE INDEX events_campaign ON events (campaign_id, type);

CREATE TABLE suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  reason text NOT NULL, -- hard_bounce | complaint | unsubscribe | manual
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{delivered,bounce,complaint,open,click,unsubscribe}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
