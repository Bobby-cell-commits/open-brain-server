-- Clean up one-time backfill and diagnostic functions
DROP FUNCTION IF EXISTS backfill_connections_batch(int);
DROP FUNCTION IF EXISTS diag_backfill_test(uuid);
