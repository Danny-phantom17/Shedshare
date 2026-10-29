CREATE TABLE referral_program_controls (
  control_id TINYINT UNSIGNED NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(control_id),
  CONSTRAINT chk_referral_program_singleton CHECK(control_id=1),
  CONSTRAINT fk_referral_program_actor FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE referral_program_rules (
  event_type ENUM('account_verified','first_public_listing','first_completed_rental') NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  referrer_reward_kobo BIGINT UNSIGNED NOT NULL DEFAULT 0,
  referred_reward_kobo BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(event_type),
  CONSTRAINT fk_referral_rule_actor FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO referral_program_controls(control_id,enabled) VALUES(1,FALSE);
INSERT INTO referral_program_rules(event_type,enabled,referrer_reward_kobo,referred_reward_kobo) VALUES
 ('account_verified',FALSE,0,0),('first_public_listing',FALSE,0,0),('first_completed_rental',FALSE,0,0);

CREATE TABLE referral_codes (
  user_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id),
  UNIQUE KEY uq_referral_code(code),
  CONSTRAINT fk_referral_code_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE referrals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  referrer_user_id BIGINT UNSIGNED NOT NULL,
  referred_user_id BIGINT UNSIGNED NOT NULL,
  referral_code VARCHAR(20) NOT NULL,
  status ENUM('pending','eligible','approved','rewarded','rejected','reversed') NOT NULL DEFAULT 'pending',
  qualifying_event ENUM('account_verified','first_public_listing','first_completed_rental') NULL,
  risk_flag BOOLEAN NOT NULL DEFAULT FALSE,
  risk_reason VARCHAR(500) NULL,
  decision_reason VARCHAR(1000) NULL,
  approved_by BIGINT UNSIGNED NULL,
  eligible_at DATETIME NULL,
  approved_at DATETIME NULL,
  rewarded_at DATETIME NULL,
  reversed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  UNIQUE KEY uq_referral_referred_user(referred_user_id),
  KEY idx_referrals_referrer_created(referrer_user_id,created_at),
  KEY idx_referrals_review(status,risk_flag,created_at),
  CONSTRAINT fk_referral_referrer FOREIGN KEY(referrer_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_referred FOREIGN KEY(referred_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_approver FOREIGN KEY(approved_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_referral_not_self CHECK(referrer_user_id<>referred_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE referral_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  referral_id BIGINT UNSIGNED NOT NULL,
  event_key VARCHAR(160) NOT NULL,
  event_type ENUM('account_verified','first_public_listing','first_completed_rental') NOT NULL,
  outcome ENUM('eligible','not_qualifying') NOT NULL,
  status ENUM('not_qualifying','eligible','approved','rewarded','rejected','reversed') NOT NULL,
  referrer_reward_kobo BIGINT UNSIGNED NOT NULL DEFAULT 0,
  referred_reward_kobo BIGINT UNSIGNED NOT NULL DEFAULT 0,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  rewarded_at DATETIME NULL,
  reversed_at DATETIME NULL,
  decision_reason VARCHAR(500) NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  UNIQUE KEY uq_referral_event_key(event_key),
  KEY idx_referral_events_referral(referral_id,created_at),
  CONSTRAINT fk_referral_event_referral FOREIGN KEY(referral_id) REFERENCES referrals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_event_approver FOREIGN KEY(approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE referral_reward_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  referral_id BIGINT UNSIGNED NOT NULL,
  referral_event_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  entry_type ENUM('credit','reversal') NOT NULL,
  amount_kobo BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  idempotency_key VARCHAR(180) NOT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  UNIQUE KEY uq_referral_reward_idempotency(idempotency_key),
  UNIQUE KEY uq_referral_reward_event_recipient_type(referral_event_id,user_id,entry_type),
  KEY idx_referral_rewards_user(user_id,created_at),
  KEY idx_referral_rewards_referral(referral_id,entry_type),
  CONSTRAINT fk_referral_reward_referral FOREIGN KEY(referral_id) REFERENCES referrals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_reward_event FOREIGN KEY(referral_event_id) REFERENCES referral_events(id) ON DELETE RESTRICT,
  CONSTRAINT fk_referral_reward_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_referral_reward_sign CHECK((entry_type='credit' AND amount_kobo>0) OR (entry_type='reversal' AND amount_kobo<0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
