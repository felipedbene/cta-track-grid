-- DeepSeek dispatcher-narration cache for the /api/feed/narration endpoint.
-- Mirrors alert_summaries/event_advisories. Keyed by a *bucketed* network-state
-- signature (line loads + delayed lines) rather than exact counts, so the jaded
-- one-liner is reused across small train movements and the model runs rarely.
CREATE TABLE IF NOT EXISTS feed_narrations (
  hash        TEXT PRIMARY KEY,  -- SHA-256 hex of the bucketed state signature
  summary     TEXT NOT NULL,     -- DeepSeek narration text
  model       TEXT,              -- model that produced it
  train_count INTEGER,           -- total trains at generation time
  created_at  INTEGER            -- epoch ms
);
