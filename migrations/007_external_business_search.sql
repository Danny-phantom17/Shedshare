CREATE TABLE external_place_search_cache (
  cache_key CHAR(64) NOT NULL,
  item_term VARCHAR(180) NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  place_ids JSON NOT NULL,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (cache_key),
  INDEX idx_external_search_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE external_business_leads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  place_id VARCHAR(255) NOT NULL,
  item_term VARCHAR(180) NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  action ENUM('call','whatsapp','directions') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_external_business_lead_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_external_business_lead_place (place_id,created_at),
  INDEX idx_external_business_lead_date (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE external_search_daily_usage (
  user_id BIGINT UNSIGNED NOT NULL,
  usage_date DATE NOT NULL,
  searches SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id,usage_date),
  CONSTRAINT fk_external_search_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
