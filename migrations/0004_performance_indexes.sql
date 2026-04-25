CREATE INDEX IF NOT EXISTS idx_highlight_groups_user_id ON highlight_groups(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_highlight_rules_group_id_id ON highlight_rules(group_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_block_rules_user_id_id ON block_rules(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id_id ON subscriptions(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_push_logs_post_id ON push_logs(post_id);
