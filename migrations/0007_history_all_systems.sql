-- Capture Metra + South Shore positions alongside CTA in each per-minute
-- snapshot, so /replay can scrub historical positions for all three systems.
-- Stored in the SAME row as the CTA payload (one write/min, ~1,440/day) — old
-- rows keep these NULL (CTA-only). See the scheduled() capture in src/index.js.
ALTER TABLE snapshots ADD COLUMN metra_payload TEXT;
ALTER TABLE snapshots ADD COLUMN ss_payload TEXT;
