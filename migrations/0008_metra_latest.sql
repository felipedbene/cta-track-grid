-- Single-row stash of the most recent Metra positions, written by the
-- request-context /api/metra/positions handler (which CAN reach Metra; the cron
-- cannot — Metra's WAF 403s Cloudflare-internal egress). The per-minute cron
-- reads this (if fresh) to include Metra in the snapshot.
CREATE TABLE IF NOT EXISTS metra_latest (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT,
  updated_at INTEGER
);
