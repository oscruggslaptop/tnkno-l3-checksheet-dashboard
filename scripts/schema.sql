CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'google',
  data JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dashboard_snapshots_imported_at_idx
  ON dashboard_snapshots (imported_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_system_snapshots (
  id BIGSERIAL PRIMARY KEY,
  dashboard_snapshot_id BIGINT NOT NULL REFERENCES dashboard_snapshots(id) ON DELETE CASCADE,
  system_group TEXT NOT NULL,
  system_name TEXT NOT NULL,
  source_file TEXT,
  overall_complete DOUBLE PRECISION,
  overall_pass DOUBLE PRECISION,
  failure_count INTEGER NOT NULL DEFAULT 0,
  data JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dashboard_system_snapshots_latest_idx
  ON dashboard_system_snapshots (system_group, system_name, imported_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_failure_snapshots (
  id BIGSERIAL PRIMARY KEY,
  dashboard_snapshot_id BIGINT NOT NULL REFERENCES dashboard_snapshots(id) ON DELETE CASCADE,
  system_group TEXT NOT NULL,
  system_name TEXT NOT NULL,
  source TEXT,
  sheet TEXT,
  row_number INTEGER,
  category TEXT,
  location TEXT,
  item TEXT,
  description TEXT,
  detail TEXT,
  status TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dashboard_failure_snapshots_latest_idx
  ON dashboard_failure_snapshots (system_group, system_name, imported_at DESC);
