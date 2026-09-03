PRAGMA defer_foreign_keys = ON;

CREATE TABLE push_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subscription_id INTEGER NOT NULL,
  post_guid TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, subscription_id, post_guid, channel),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

INSERT INTO push_logs_new (id, user_id, subscription_id, post_guid, channel, status, error, created_at)
SELECT
  push_logs.id,
  push_logs.user_id,
  push_logs.subscription_id,
  CASE
    WHEN TRIM(push_logs.post_guid) <> '' THEN push_logs.post_guid
    WHEN TRIM(posts.guid) <> '' THEN posts.guid
  END,
  push_logs.channel,
  push_logs.status,
  push_logs.error,
  push_logs.created_at
FROM push_logs
LEFT JOIN posts ON posts.id = push_logs.post_id;

DROP TABLE push_logs;
ALTER TABLE push_logs_new RENAME TO push_logs;

CREATE INDEX idx_push_logs_created_at ON push_logs(created_at);
