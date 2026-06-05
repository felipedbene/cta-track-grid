-- Let the SITREP and event-advisory caches reference their spoken audio too,
-- so all three AI panels can be voiced (Aura → R2), not just the narration.
-- (feed_narrations already got audio_key in 0005.)
ALTER TABLE alert_summaries ADD COLUMN audio_key TEXT;
ALTER TABLE event_advisories ADD COLUMN audio_key TEXT;
