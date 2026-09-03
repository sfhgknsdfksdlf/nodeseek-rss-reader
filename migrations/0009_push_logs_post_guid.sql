ALTER TABLE push_logs ADD COLUMN post_guid TEXT;

UPDATE push_logs
SET post_guid = (
  SELECT guid
  FROM posts
  WHERE posts.id = push_logs.post_id
)
WHERE post_guid IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_logs_guid_unique ON push_logs(user_id, subscription_id, post_guid, channel);
