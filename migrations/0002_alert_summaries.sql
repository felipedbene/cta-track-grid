-- DeepSeek SITREP cache for the /api/alerts/summary endpoint.
-- One row per distinct active-alert set, keyed by the SHA-256 of the alert
-- corpus. This makes the LLM dedupe global + durable: the same alerts are
-- summarized once and never cost another DeepSeek call. Tiny table; rows are
-- only written when the active alert set changes (a few times a day at most).
CREATE TABLE IF NOT EXISTS alert_summaries (
  hash        TEXT PRIMARY KEY,  -- SHA-256 hex of the alert corpus
  summary     TEXT NOT NULL,     -- DeepSeek SITREP text
  model       TEXT,              -- model that produced it
  alert_count INTEGER,           -- number of source alerts
  created_at  INTEGER            -- epoch ms
);
