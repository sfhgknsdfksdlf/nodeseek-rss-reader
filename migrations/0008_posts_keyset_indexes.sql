CREATE INDEX IF NOT EXISTS idx_posts_published_at_id ON posts(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_board_published_at_id ON posts(board_key, published_at DESC, id DESC);
