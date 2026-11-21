-- Ledger-only migration: the read_states(post_id) index is intentionally NOT
-- created here. Creating it from the build path would run the index build on
-- an existing production database without the state-machine handoff. The cron
-- state machine (sync_state.db_prune_index_state) creates and independently
-- verifies the index during the UTC 23:30-00:00 window before enabling pruning.
SELECT 1;
