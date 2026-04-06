BEGIN;

-- 1) Conectores por usuario (tokens cifrados y metadatos)
CREATE TABLE IF NOT EXISTS user_connectors (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  external_account_id VARCHAR(128),
  account_email VARCHAR(255),
  scopes TEXT[] NOT NULL DEFAULT '{}',
  access_token_encrypted TEXT,
  access_token_iv TEXT,
  refresh_token_encrypted TEXT,
  refresh_token_iv TEXT,
  long_lived_token_encrypted TEXT,
  long_lived_token_iv TEXT,
  token_expires_at TIMESTAMPTZ,
  provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  encryption_key_version INTEGER NOT NULL DEFAULT 1,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_user_connectors_user ON user_connectors(user_id);
CREATE INDEX IF NOT EXISTS idx_user_connectors_provider ON user_connectors(provider);

-- 2) Acciones pendientes para confirmación por chat
CREATE TABLE IF NOT EXISTS pending_actions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  connector_id INTEGER REFERENCES user_connectors(id) ON DELETE SET NULL,
  intent VARCHAR(64) NOT NULL,
  params JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','executed','expired')),
  confirm_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_user_status ON pending_actions(user_id, status);

-- 3) Auditoría mínima
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  connector_id INTEGER REFERENCES user_connectors(id) ON DELETE SET NULL,
  provider VARCHAR(32),
  action VARCHAR(64) NOT NULL,
  intent VARCHAR(64),
  request JSONB,
  response JSONB,
  status VARCHAR(16),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_logs(user_id, created_at DESC);

-- trigger simple para updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_connectors_updated_at ON user_connectors;
CREATE TRIGGER trg_user_connectors_updated_at BEFORE UPDATE ON user_connectors
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS trg_pending_actions_updated_at ON pending_actions;
CREATE TRIGGER trg_pending_actions_updated_at BEFORE UPDATE ON pending_actions
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

COMMIT;


