-- Position history for the CTA Track Grid.
-- One row per cron tick (every minute), storing the full ttpositions payload
-- as a blob. This keeps writes at ~1,440/day (well under the D1 free-tier
-- 100k writes/day limit) instead of one-row-per-train (~259k/day).
CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at  INTEGER NOT NULL,  -- epoch ms (controller.scheduledTime)
  tmst         TEXT,              -- CTA feed timestamp (ctatt.tmst)
  train_count  INTEGER,
  payload      TEXT NOT NULL      -- full ttpositions JSON, all lines
);

CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(observed_at);
