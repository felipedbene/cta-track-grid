-- DeepSeek crowd-advisory cache for the /api/events/advisory endpoint.
-- Mirrors alert_summaries (0002): one row per distinct active-event set, keyed
-- by the SHA-256 of the event corpus, so the LLM summarizes a given day's events
-- once and never costs another DeepSeek call. Tiny, low-churn table.
CREATE TABLE IF NOT EXISTS event_advisories (
  hash        TEXT PRIMARY KEY,  -- SHA-256 hex of the event corpus
  summary     TEXT NOT NULL,     -- DeepSeek crowd advisory text
  model       TEXT,              -- model that produced it
  event_count INTEGER,           -- number of source events
  created_at  INTEGER            -- epoch ms
);
