ALTER TABLE rider_profiles
  ADD COLUMN full_name VARCHAR(120) NULL,
  ADD COLUMN city VARCHAR(100) NULL,
  ADD COLUMN state VARCHAR(100) NULL,
  ADD COLUMN plate_number VARCHAR(40) NULL,
  ADD COLUMN profile_photo_path VARCHAR(512) NULL,
  ADD COLUMN id_document_path VARCHAR(512) NULL,
  ADD COLUMN application_status ENUM('pending','approved','rejected','suspended') NOT NULL DEFAULT 'pending',
  ADD COLUMN rejection_reason VARCHAR(500) NULL,
  ADD COLUMN reviewed_by BIGINT UNSIGNED NULL,
  ADD COLUMN reviewed_at DATETIME NULL,
  ADD COLUMN cancellation_count INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN rating_sum INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN rating_count INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN flagged_low_rating BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT fk_rider_profiles_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD INDEX idx_rider_application_status (application_status,id);

UPDATE rider_profiles SET application_status=IF(is_approved=TRUE,'approved','pending'),full_name=(SELECT name FROM users WHERE users.id=rider_profiles.user_id);

ALTER TABLE deliveries
  ADD COLUMN rider_handover_code_hash CHAR(64) NULL;

CREATE TABLE delivery_rider_cancellations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id BIGINT UNSIGNED NOT NULL,
  rider_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_delivery_rider_cancellations (rider_id,created_at),
  CONSTRAINT fk_delivery_rider_cancel_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_rider_cancel_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE delivery_ratings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id BIGINT UNSIGNED NOT NULL,
  renter_id BIGINT UNSIGNED NOT NULL,
  rider_id BIGINT UNSIGNED NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_rating_delivery (delivery_id),
  KEY idx_delivery_ratings_rider (rider_id,created_at),
  CONSTRAINT fk_delivery_ratings_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_ratings_renter FOREIGN KEY (renter_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_delivery_ratings_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_delivery_rating_range CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
