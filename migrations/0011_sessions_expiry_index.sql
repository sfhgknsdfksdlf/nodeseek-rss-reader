-- Expired user sessions are purged daily by cleanupOldData(); this index keeps
-- that delete from scanning the whole sessions table.
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
