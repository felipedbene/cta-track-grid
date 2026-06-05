-- Reference to the cached spoken narration in R2. The audio (Deepgram Aura mp3)
-- is generated once per narration hash, stored in the R2 'cta-narration' bucket,
-- and its object key recorded here so playback streams straight from R2.
ALTER TABLE feed_narrations ADD COLUMN audio_key TEXT;
