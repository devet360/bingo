CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR(120) NOT NULL,
  environment VARCHAR(12) NOT NULL CHECK (environment IN ('test', 'live')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name, environment)
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  key_id VARCHAR(32) NOT NULL UNIQUE,
  secret_digest BYTEA NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['verification:create', 'verification:read'],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  provider_code VARCHAR(48) NOT NULL,
  reference_fingerprint BYTEA NOT NULL,
  expected_amount NUMERIC(19, 4),
  expected_currency CHAR(3),
  status VARCHAR(24) NOT NULL CHECK (status IN ('VERIFIED', 'PENDING', 'NOT_FOUND', 'NOT_MATCHED', 'UNREACHABLE', 'UNSUPPORTED', 'INVALID_INPUT', 'MANUAL_REVIEW', 'FAILED')),
  source VARCHAR(48),
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at TIMESTAMPTZ,
  UNIQUE (organization_id, provider_code, reference_fingerprint)
);

CREATE INDEX verification_requests_project_created_idx ON verification_requests(project_id, created_at DESC);
CREATE INDEX verification_requests_org_status_created_idx ON verification_requests(organization_id, status, created_at DESC);

CREATE TABLE idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  idempotency_key VARCHAR(128) NOT NULL,
  request_fingerprint BYTEA NOT NULL,
  verification_id UUID REFERENCES verification_requests(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours',
  UNIQUE (project_id, idempotency_key)
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_type VARCHAR(24) NOT NULL,
  actor_id UUID,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(48) NOT NULL,
  resource_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_org_created_idx ON audit_events(organization_id, created_at DESC);
