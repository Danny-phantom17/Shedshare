ALTER TABLE items
  ADD COLUMN pickup_address VARCHAR(255) NULL,
  ADD COLUMN city VARCHAR(100) NULL,
  ADD COLUMN state VARCHAR(100) NULL,
  ADD COLUMN area_name VARCHAR(120) NULL,
  ADD COLUMN latitude DECIMAL(10,7) NULL,
  ADD COLUMN longitude DECIMAL(10,7) NULL,
  ADD COLUMN public_latitude DECIMAL(10,7) NULL,
  ADD COLUMN public_longitude DECIMAL(10,7) NULL,
  ADD COLUMN geocode_place_id VARCHAR(255) NULL,
  ADD INDEX idx_items_geo (paused, latitude, longitude),
  ADD INDEX idx_items_city_state (paused, city, state);

CREATE TABLE geocode_cache (
  place_id VARCHAR(255) NOT NULL,
  formatted_address VARCHAR(255) NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  area_name VARCHAR(120) NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (place_id),
  INDEX idx_geocode_city_state (city, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE location_alerts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  renter_id BIGINT UNSIGNED NOT NULL,
  item_name VARCHAR(180) NOT NULL,
  category VARCHAR(80) NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  area_name VARCHAR(120) NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  radius_km TINYINT UNSIGNED NOT NULL DEFAULT 10,
  max_price DECIMAL(12,2) UNSIGNED NULL,
  status ENUM('active','matched','cancelled') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_location_alert_renter FOREIGN KEY (renter_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_location_alert_match (status, category, city, state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE item_requests
  ADD COLUMN city VARCHAR(100) NULL,
  ADD COLUMN state VARCHAR(100) NULL,
  ADD COLUMN latitude DECIMAL(10,7) NULL,
  ADD COLUMN longitude DECIMAL(10,7) NULL;
