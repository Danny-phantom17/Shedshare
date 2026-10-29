ALTER TABLE rentals
  ADD COLUMN safety_hold BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN safety_hold_reason VARCHAR(500) NULL;

ALTER TABLE messages
  ADD COLUMN contact_flagged BOOLEAN NOT NULL DEFAULT FALSE;

INSERT IGNORE INTO shedshare_settings (setting_key, setting_value)
VALUES ('payments_paused', '0');
