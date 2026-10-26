CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	salt TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'user',
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maps (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	title TEXT NOT NULL,
	data TEXT NOT NULL,
	share_token TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maps_owner ON maps (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_maps_share ON maps (share_token) WHERE share_token IS NOT NULL;
