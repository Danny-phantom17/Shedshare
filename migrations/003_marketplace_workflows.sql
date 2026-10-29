ALTER TABLE users ADD COLUMN is_rider BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE item_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference_number VARCHAR(24) NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  item_name VARCHAR(180) NOT NULL,
  category VARCHAR(80) NOT NULL,
  description TEXT NULL,
  quantity SMALLINT UNSIGNED NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  delivery_location VARCHAR(255) NULL,
  pickup_preferred BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_required BOOLEAN NOT NULL DEFAULT FALSE,
  budget DECIMAL(12,2) UNSIGNED NULL,
  urgency VARCHAR(40) NULL,
  reference_image_url VARCHAR(2048) NULL,
  notes TEXT NULL,
  status ENUM('submitted','searching','offers_received','awaiting_customer_decision','booking_confirmed','completed','cancelled','expired','unfulfilled') NOT NULL DEFAULT 'submitted',
  unfulfilled_reason ENUM('insufficient_supply','unavailable_dates','quantity_limitation','price_mismatch','delivery_limitation','supplier_non_response','other') NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_item_requests_reference (reference_number),
  CONSTRAINT fk_item_requests_customer FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_item_requests_dates CHECK (end_date > start_date),
  CONSTRAINT chk_item_requests_quantity CHECK (quantity > 0),
  INDEX idx_item_requests_customer (customer_id, created_at),
  INDEX idx_item_requests_matching (status, category, start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE request_offers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NULL,
  rental_id BIGINT UNSIGNED NULL,
  offered_item_name VARCHAR(180) NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL,
  price DECIMAL(12,2) UNSIGNED NOT NULL,
  available_from DATE NOT NULL,
  available_to DATE NOT NULL,
  delivery_or_collection ENUM('delivery','collection') NOT NULL,
  delivery_fee DECIMAL(12,2) UNSIGNED NULL,
  deposit DECIMAL(12,2) UNSIGNED NULL,
  conditions TEXT NULL,
  expires_at DATETIME NOT NULL,
  status ENUM('pending','accepted','declined','expired') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_request_offers_request FOREIGN KEY (request_id) REFERENCES item_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_request_offers_supplier FOREIGN KEY (supplier_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_request_offers_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL,
  CONSTRAINT fk_request_offers_rental FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE SET NULL,
  CONSTRAINT chk_request_offers_dates CHECK (available_to > available_from),
  INDEX idx_request_offers_request (request_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE request_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  details JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_request_audit_request FOREIGN KEY (request_id) REFERENCES item_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_request_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_request_audit_request (request_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE request_supplier_notifications (
  request_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  admin_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id,supplier_id),
  CONSTRAINT fk_request_supplier_notifications_request FOREIGN KEY (request_id) REFERENCES item_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_request_supplier_notifications_supplier FOREIGN KEY (supplier_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_request_supplier_notifications_admin FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_request_supplier_notifications_supplier (supplier_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id BIGINT UNSIGNED NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  renter_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_messages_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_messages_renter FOREIGN KEY (renter_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_messages_thread (item_id, owner_id, renter_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rider_profiles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  phone VARCHAR(40) NOT NULL,
  vehicle_type VARCHAR(80) NOT NULL,
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  availability ENUM('active','inactive') NOT NULL DEFAULT 'inactive',
  current_delivery_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rider_profiles_user (user_id),
  CONSTRAINT fk_rider_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rental_id BIGINT UNSIGNED NOT NULL,
  rider_id BIGINT UNSIGNED NULL,
  pickup_location VARCHAR(255) NOT NULL,
  dropoff_location VARCHAR(255) NOT NULL,
  reference_number VARCHAR(24) NOT NULL,
  status ENUM('requested','awaiting_rider','rider_assigned','awaiting_collection','collected','en_route','arrived','delivered_awaiting_confirmation','completed','exception') NOT NULL DEFAULT 'requested',
  delivery_pin VARCHAR(12) NULL,
  proof_photo_url VARCHAR(2048) NULL,
  rider_confirmed_at DATETIME NULL,
  recipient_confirmed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deliveries_rental (rental_id),
  CONSTRAINT fk_deliveries_rental FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE RESTRICT,
  CONSTRAINT fk_deliveries_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_deliveries_rider_status (rider_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE rider_profiles ADD CONSTRAINT fk_rider_profiles_current_delivery FOREIGN KEY (current_delivery_id) REFERENCES deliveries(id) ON DELETE SET NULL;

CREATE TABLE location_updates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id BIGINT UNSIGNED NOT NULL,
  rider_id BIGINT UNSIGNED NOT NULL,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_location_updates_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_location_updates_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_location_updates_delivery (delivery_id, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE delivery_exceptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id BIGINT UNSIGNED NOT NULL,
  reported_by BIGINT UNSIGNED NOT NULL,
  type VARCHAR(80) NOT NULL,
  notes TEXT NULL,
  status ENUM('open','reviewing','resolved') NOT NULL DEFAULT 'open',
  admin_notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_delivery_exceptions_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_exceptions_user FOREIGN KEY (reported_by) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_delivery_exceptions_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(80) NOT NULL,
  message VARCHAR(500) NOT NULL,
  related_id BIGINT UNSIGNED NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notifications_user (user_id, is_read, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE shedshare_settings (
  setting_key VARCHAR(80) NOT NULL,
  setting_value VARCHAR(255) NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_shedshare_settings_actor FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO shedshare_settings (setting_key,setting_value) VALUES ('request_expiry_days','14');

CREATE TABLE delivery_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  details JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_delivery_audit_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_delivery_audit (delivery_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE rentals ADD COLUMN delivery_location VARCHAR(255) NULL;
