CREATE INDEX IF NOT EXISTS idx_posts_board_published_at ON posts(board_key, published_at DESC);
