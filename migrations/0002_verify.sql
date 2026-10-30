-- Registration verification codes.
--
-- A row is created when someone asks to register with an email address. The code
-- is never sent by the Worker itself (Workers cannot open SMTP connections); a
-- local relay polls this table, delivers the message, and stamps `sent_at`.
CREATE TABLE IF NOT EXISTS verify_codes (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	code TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	sent_at INTEGER,
	used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_verify_email ON verify_codes (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verify_unsent ON verify_codes (sent_at) WHERE sent_at IS NULL;
