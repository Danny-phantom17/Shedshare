CREATE TABLE push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  application_origin VARCHAR(512) NOT NULL,
  endpoint VARCHAR(2048) NOT NULL,
  endpoint_hash CHAR(64) NOT NULL,
  p256dh_key VARCHAR(128) NOT NULL,
  auth_key VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_endpoint_hash (endpoint_hash),
  KEY idx_push_subscriptions_user (user_id),
  CONSTRAINT fk_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE notifications
  ADD COLUMN push_processed_at DATETIME NULL;

UPDATE notifications SET push_processed_at=UTC_TIMESTAMP() WHERE push_processed_at IS NULL;
