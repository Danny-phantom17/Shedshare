-- Preserve the local part exactly and normalize only surrounding whitespace and domain case.
-- The existing uq_users_email collation folds case more aggressively than that policy.
UPDATE users SET email=CONCAT(SUBSTRING_INDEX(TRIM(email),'@',1),'@',LOWER(SUBSTRING_INDEX(TRIM(email),'@',-1)));
ALTER TABLE users DROP INDEX uq_users_email;
ALTER TABLE users ADD COLUMN email_normalized VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
  GENERATED ALWAYS AS (CONCAT(SUBSTRING_INDEX(TRIM(email),'@',1),'@',LOWER(SUBSTRING_INDEX(TRIM(email),'@',-1)))) STORED;
ALTER TABLE users ADD CONSTRAINT uq_users_email_normalized UNIQUE(email_normalized);

CREATE TABLE auth_email_rate_limits (
  scope ENUM('email','ip') NOT NULL,
  key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_started_at DATETIME NOT NULL,
  request_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(scope,key_hash),
  KEY idx_auth_email_rate_window(window_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE email_verification_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  provider ENUM('supabase','google') NOT NULL,
  verified_email_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_email_verification_source(user_id,provider),
  KEY idx_email_verification_audit_created(created_at),
  CONSTRAINT fk_email_verification_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
