ALTER TABLE items
  ADD COLUMN installment_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN installment_deposit_percent TINYINT UNSIGNED NOT NULL DEFAULT 50;

ALTER TABLE users ADD COLUMN manual_account_name VARCHAR(120) NULL;

CREATE TABLE rental_manual_installments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rental_id BIGINT UNSIGNED NOT NULL,
  agreement_id BIGINT UNSIGNED NOT NULL,
  installment_number TINYINT UNSIGNED NOT NULL,
  amount BIGINT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  due_at DATETIME NOT NULL,
  status ENUM('scheduled','awaiting_payment','payment_reported','confirmed','rejected','overdue','cancelled','refunded') NOT NULL DEFAULT 'awaiting_payment',
  bank_name VARCHAR(120) NOT NULL,
  account_name VARCHAR(120) NOT NULL,
  account_number VARCHAR(40) NOT NULL,
  transfer_reference VARCHAR(120) NULL,
  transfer_at DATETIME NULL,
  renter_note VARCHAR(500) NULL,
  reported_at DATETIME NULL,
  confirmed_at DATETIME NULL,
  confirmed_by BIGINT UNSIGNED NULL,
  rejection_reason VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  UNIQUE KEY uq_manual_installment_number(rental_id,agreement_id,installment_number),
  KEY idx_manual_installment_rental_status(rental_id,status,due_at),
  CONSTRAINT fk_manual_installment_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_manual_installment_agreement FOREIGN KEY(agreement_id) REFERENCES rental_agreement_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_manual_installment_confirmer FOREIGN KEY(confirmed_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_manual_payment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  installment_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('reported','confirmed','rejected') NOT NULL,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), KEY idx_manual_payment_event(installment_id,created_at),
  CONSTRAINT fk_manual_event_installment FOREIGN KEY(installment_id) REFERENCES rental_manual_installments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_manual_event_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_commission_obligations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rental_id BIGINT UNSIGNED NOT NULL,
  agreement_id BIGINT UNSIGNED NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  renter_id BIGINT UNSIGNED NOT NULL,
  rate_percent DECIMAL(5,2) UNSIGNED NOT NULL,
  basis_amount BIGINT UNSIGNED NOT NULL,
  amount_due BIGINT UNSIGNED NOT NULL,
  amount_received BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('not_yet_due','due','partially_paid','paid','disputed','waived','adjusted') NOT NULL DEFAULT 'due',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_commission_rental_agreement(rental_id,agreement_id), KEY idx_commission_status(status,created_at),
  CONSTRAINT fk_commission_rental FOREIGN KEY(rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_agreement FOREIGN KEY(agreement_id) REFERENCES rental_agreement_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_renter FOREIGN KEY(renter_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_commission_received CHECK(amount_received<=amount_due)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rental_commission_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  obligation_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  amount BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(120) NULL,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_commission_event_reference(obligation_id,reference), KEY idx_commission_event(obligation_id,created_at),
  CONSTRAINT fk_commission_event_obligation FOREIGN KEY(obligation_id) REFERENCES rental_commission_obligations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_commission_event_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
