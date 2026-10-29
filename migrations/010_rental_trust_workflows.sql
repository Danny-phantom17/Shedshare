ALTER TABLE rentals
  MODIFY COLUMN status ENUM('inquiry','pending_payment','confirmed','active','completed','cancelled','disputed') NOT NULL DEFAULT 'pending_payment',
  ADD COLUMN checkout_expires_at DATETIME NULL,
  ADD COLUMN informational_deposit DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN agreement_terms JSON NULL,
  ADD COLUMN renter_accepted_at DATETIME NULL,
  ADD COLUMN owner_accepted_at DATETIME NULL,
  ADD COLUMN handover_at DATETIME NULL,
  ADD COLUMN return_at DATETIME NULL,
  ADD COLUMN payout_status ENUM('not_due','pending','paid','failed') NOT NULL DEFAULT 'not_due',
  ADD COLUMN payout_reference VARCHAR(120) NULL;

ALTER TABLE items
  ADD COLUMN known_defects TEXT NULL,
  ADD COLUMN cancellation_policy TEXT NULL,
  ADD COLUMN rental_conditions TEXT NULL;

CREATE TABLE rental_agreement_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rental_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  terms JSON NOT NULL,
  terms_hash CHAR(64) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  renter_accepted_at DATETIME NULL,
  owner_accepted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_rental_agreement_version(rental_id,version),
  KEY idx_agreement_hash(rental_id,terms_hash),
  CONSTRAINT fk_agreement_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_agreement_creator FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_inspections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id BIGINT UNSIGNED NOT NULL, renter_id BIGINT UNSIGNED NOT NULL, owner_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NULL, proposed_at DATETIME NOT NULL, meeting_location VARCHAR(255) NOT NULL,
  status ENUM('requested','accepted','declined','cancelled','completed','rescheduled') NOT NULL DEFAULT 'requested',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), KEY idx_inspection_owner_status(owner_id,status,proposed_at), KEY idx_inspection_renter(renter_id,created_at),
  CONSTRAINT fk_inspection_item FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inspection_renter FOREIGN KEY(renter_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inspection_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inspection_conversation FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_payment_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rental_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(40) NOT NULL DEFAULT 'paystack', reference VARCHAR(120) NOT NULL,
  amount BIGINT UNSIGNED NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status ENUM('initialized','pending','success','failed','expired','disputed') NOT NULL DEFAULT 'initialized',
  provider_payload JSON NULL, verified_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_payment_attempt_reference(reference), KEY idx_payment_attempt_rental(rental_id,status),
  CONSTRAINT fk_payment_attempt_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_financial_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rental_id BIGINT UNSIGNED NOT NULL,
  payment_attempt_id BIGINT UNSIGNED NULL, entry_type ENUM('payment','commission','owner_allocation','processing_fee','payout') NOT NULL,
  amount BIGINT NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'NGN', reference VARCHAR(120) NULL,
  metadata JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_ledger_type_reference(entry_type,reference), KEY idx_ledger_rental(rental_id,entry_type,created_at),
  CONSTRAINT fk_ledger_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ledger_attempt FOREIGN KEY(payment_attempt_id) REFERENCES rental_payment_attempts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_handover_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rental_id BIGINT UNSIGNED NOT NULL,
  record_type ENUM('handover','return') NOT NULL, actor_id BIGINT UNSIGNED NOT NULL,
  confirmed_by_owner_at DATETIME NULL, confirmed_by_renter_at DATETIME NULL,
  condition_notes TEXT NULL, evidence_path VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_rental_handover_type(rental_id,record_type),
  CONSTRAINT fk_handover_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_handover_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_disputes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rental_id BIGINT UNSIGNED NOT NULL,
  opened_by BIGINT UNSIGNED NOT NULL, reason VARCHAR(1000) NOT NULL,
  status ENUM('open','reviewing','resolved') NOT NULL DEFAULT 'open', resolution TEXT NULL,
  resolved_by BIGINT UNSIGNED NULL, resolved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), KEY idx_dispute_status(status,created_at), KEY idx_dispute_rental(rental_id,status),
  CONSTRAINT fk_dispute_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispute_opener FOREIGN KEY(opened_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispute_resolver FOREIGN KEY(resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_extensions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, rental_id BIGINT UNSIGNED NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL, proposed_end_at DATETIME NOT NULL, additional_charge DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('requested','accepted','declined','cancelled','payment_pending','paid') NOT NULL DEFAULT 'requested',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), KEY idx_extension_rental(rental_id,status),
  CONSTRAINT fk_extension_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_extension_requester FOREIGN KEY(requested_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE admin_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, admin_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(100) NOT NULL, entity_type VARCHAR(80) NOT NULL, entity_id VARCHAR(80) NOT NULL,
  reason VARCHAR(1000) NOT NULL, metadata JSON NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), KEY idx_admin_audit_actor(admin_id,created_at), KEY idx_admin_audit_entity(entity_type,entity_id,created_at),
  CONSTRAINT fk_admin_audit_actor FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE users ADD COLUMN trust_role ENUM('none','super_admin','trust_and_safety') NOT NULL DEFAULT 'none';
ALTER TABLE users MODIFY COLUMN account_number VARCHAR(40) NULL, MODIFY COLUMN bank_name VARCHAR(120) NULL;

CREATE TABLE user_notification_preferences (
  user_id BIGINT UNSIGNED NOT NULL, in_app BOOLEAN NOT NULL DEFAULT TRUE,
  email BOOLEAN NOT NULL DEFAULT FALSE, push BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id), CONSTRAINT fk_notification_preferences_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO shedshare_settings(setting_key,setting_value) VALUES
 ('checkout_reservation_minutes','30');

CREATE TABLE rental_review_links_v2 (
  rental_id BIGINT UNSIGNED NOT NULL, completed_at DATETIME NULL,
  PRIMARY KEY(rental_id),
  CONSTRAINT fk_future_review_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
