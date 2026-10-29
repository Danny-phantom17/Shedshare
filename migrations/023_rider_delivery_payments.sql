ALTER TABLE items
  ADD COLUMN rider_delivery_available BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE deliveries
  ADD COLUMN rider_payment_status ENUM('not_required','pending','paid','declined') NOT NULL DEFAULT 'not_required';

CREATE TABLE rider_delivery_payment_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id BIGINT UNSIGNED NOT NULL,
  rental_id BIGINT UNSIGNED NOT NULL,
  renter_id BIGINT UNSIGNED NOT NULL,
  rider_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(120) NOT NULL,
  amount BIGINT UNSIGNED NOT NULL,
  platform_fee BIGINT UNSIGNED NOT NULL,
  rider_payout BIGINT UNSIGNED NOT NULL,
  status ENUM('initialized','success','failed') NOT NULL DEFAULT 'initialized',
  checkout_url VARCHAR(2048) NULL,
  provider_payload JSON NULL,
  verified_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rider_delivery_payment_reference (reference),
  KEY idx_rider_delivery_payments_delivery (delivery_id,status,created_at),
  KEY idx_rider_delivery_payments_renter (renter_id,status,created_at),
  CONSTRAINT fk_rider_delivery_payment_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rider_delivery_payment_rental FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rider_delivery_payment_renter FOREIGN KEY (renter_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rider_delivery_payment_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
