CREATE TABLE rental_party_reviews (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rental_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  target_user_id BIGINT UNSIGNED NOT NULL,
  target_role ENUM('lister','renter') NOT NULL,
  overall_rating TINYINT UNSIGNED NOT NULL,
  communication_rating TINYINT UNSIGNED NOT NULL,
  accuracy_rating TINYINT UNSIGNED NULL,
  reliability_rating TINYINT UNSIGNED NOT NULL,
  fulfillment_rating TINYINT UNSIGNED NOT NULL,
  body VARCHAR(2000) NOT NULL,
  status ENUM('pending','approved','rejected','hidden') NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  moderation_reason VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rental_party_review_author (rental_id,author_id),
  KEY idx_rental_party_review_target (target_user_id,target_role,status,created_at),
  KEY idx_rental_party_review_status (status,created_at),
  KEY idx_rental_party_review_aggregate (target_role,status,target_user_id),
  CONSTRAINT fk_rental_party_review_rental FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rental_party_review_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rental_party_review_target FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rental_party_review_moderator FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_rental_party_review_parties CHECK (author_id <> target_user_id),
  CONSTRAINT chk_rental_party_review_rating CHECK (overall_rating BETWEEN 1 AND 5 AND communication_rating BETWEEN 1 AND 5 AND reliability_rating BETWEEN 1 AND 5 AND fulfillment_rating BETWEEN 1 AND 5),
  CONSTRAINT chk_rental_party_review_accuracy CHECK ((target_role='lister' AND accuracy_rating BETWEEN 1 AND 5) OR (target_role='renter' AND accuracy_rating IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE rentals
  ADD KEY idx_rentals_trust_owner_completed (owner_id,status,payment_verified_at,safety_hold),
  ADD KEY idx_rentals_trust_renter_completed (renter_id,status,payment_verified_at,safety_hold);

CREATE TABLE rental_party_review_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_id BIGINT UNSIGNED NOT NULL,
  reporter_id BIGINT UNSIGNED NOT NULL,
  reason ENUM('abusive','fraudulent','irrelevant','private_information','other') NOT NULL,
  details VARCHAR(1000) NOT NULL,
  status ENUM('open','reviewing','resolved') NOT NULL DEFAULT 'open',
  resolution VARCHAR(1000) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rental_review_reporter (review_id,reporter_id),
  KEY idx_rental_review_report_status (status,created_at),
  CONSTRAINT fk_rental_review_report_review FOREIGN KEY (review_id) REFERENCES rental_party_reviews(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rental_review_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rental_review_report_moderator FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
