ALTER TABLE items
  ADD COLUMN moderation_status ENUM('pending_analysis','approved','pending_review','needs_information','declined') NOT NULL DEFAULT 'approved' AFTER paused,
  ADD COLUMN ai_description TEXT NULL AFTER description,
  ADD KEY idx_items_moderation_public(moderation_status,paused,created_at);

CREATE TABLE listing_moderation_settings (
  setting_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  policy_text TEXT NOT NULL,
  prohibited_terms JSON NOT NULL,
  review_terms JSON NOT NULL,
  auto_approval_confidence DECIMAL(4,3) NOT NULL DEFAULT 0.900,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_listing_moderation_singleton CHECK(setting_id=1),
  CONSTRAINT chk_listing_auto_confidence CHECK(auto_approval_confidence BETWEEN 0 AND 1),
  CONSTRAINT fk_listing_moderation_settings_admin FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO listing_moderation_settings(setting_id,enabled,policy_text,prohibited_terms,review_terms,auto_approval_confidence)
VALUES(1,FALSE,'Review for illegal or prohibited goods, stolen or counterfeit claims, weapons or hazardous materials, fraud, spam, unsafe use, and materially misleading descriptions. Do not flag an item solely because it is cheap, small, unusual, or low in perceived value. Ask for human review when evidence is uncertain.',JSON_ARRAY(),JSON_ARRAY(),0.900);

CREATE TABLE listing_moderation_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  submitted_by BIGINT UNSIGNED NOT NULL,
  status ENUM('processing','completed') NOT NULL DEFAULT 'processing',
  input_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('auto_approved','pending_review') NULL,
  item_summary VARCHAR(500) NULL,
  ai_description VARCHAR(1200) NULL,
  reason VARCHAR(2000) NULL,
  confidence DECIMAL(4,3) NULL,
  provider_error BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  UNIQUE KEY uq_listing_moderation_item(item_id),
  KEY idx_listing_moderation_queue(status,outcome,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE listing_moderation_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  action ENUM('auto_approved','flagged','approved','declined','information_requested','resubmitted') NOT NULL,
  previous_status VARCHAR(40) NULL,
  new_status VARCHAR(40) NOT NULL,
  reason VARCHAR(2000) NULL,
  ai_description VARCHAR(1200) NULL,
  confidence DECIMAL(4,3) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_listing_moderation_audit_item(item_id,created_at),
  CONSTRAINT fk_listing_moderation_audit_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
