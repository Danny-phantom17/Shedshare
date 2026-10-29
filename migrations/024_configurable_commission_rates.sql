INSERT IGNORE INTO shedshare_settings (setting_key, setting_value)
VALUES ('rental_commission_percent', '15.00'), ('rider_commission_percent', '5.00');

ALTER TABLE deliveries
  ADD COLUMN rider_commission_percent DECIMAL(5,2) UNSIGNED NOT NULL DEFAULT 5.00;

ALTER TABLE rider_delivery_payment_attempts
  ADD COLUMN commission_percent DECIMAL(5,2) UNSIGNED NOT NULL DEFAULT 5.00;
