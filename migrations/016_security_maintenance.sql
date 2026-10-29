CREATE TABLE IF NOT EXISTS security_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  user_email VARCHAR(254) NULL,
  user_id BIGINT UNSIGNED NULL,
  details JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_security_events_type_time (event_type, created_at),
  KEY idx_security_events_ip_time (ip_address, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS login_failures (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ip_address VARCHAR(45) NOT NULL,
  user_email VARCHAR(254) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_login_failures_ip_time (ip_address, created_at),
  KEY idx_login_failures_ip_email_time (ip_address, user_email, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS login_lockouts (
  ip_address VARCHAR(45) NOT NULL,
  user_email VARCHAR(254) NOT NULL,
  locked_until DATETIME NOT NULL,
  PRIMARY KEY (ip_address, user_email),
  KEY idx_login_lockouts_expiry (locked_until)
) ENGINE=InnoDB;
