ALTER TABLE rider_profiles
  ADD COLUMN profile_photo_url VARCHAR(2048) NULL,
  ADD COLUMN id_document_reference VARCHAR(255) NULL;

ALTER TABLE deliveries
  MODIFY COLUMN status ENUM('requested','awaiting_rider','rider_assigned','awaiting_collection','collected','en_route','arrived','delivered_awaiting_confirmation','completed','exception','cancelled','fallback_available') NOT NULL DEFAULT 'requested',
  ADD COLUMN delivery_method ENUM('owner_delivery','rider_delivery') NOT NULL DEFAULT 'rider_delivery',
  ADD COLUMN pickup_latitude DECIMAL(10,7) NULL,
  ADD COLUMN pickup_longitude DECIMAL(10,7) NULL,
  ADD COLUMN dropoff_latitude DECIMAL(10,7) NULL,
  ADD COLUMN dropoff_longitude DECIMAL(10,7) NULL,
  ADD COLUMN offer_expires_at DATETIME NULL,
  ADD COLUMN tracking_ends_at DATETIME NULL;

ALTER TABLE rentals
  ADD COLUMN delivery_latitude DECIMAL(10,7) NULL,
  ADD COLUMN delivery_longitude DECIMAL(10,7) NULL;

UPDATE deliveries SET delivery_method='owner_delivery' WHERE rider_id IS NULL AND status='requested';

CREATE TABLE rider_online_locations (
  rider_id BIGINT UNSIGNED NOT NULL,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (rider_id),
  CONSTRAINT fk_rider_online_location_user FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_rider_online_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE delivery_offers (
  delivery_id BIGINT UNSIGNED NOT NULL,
  rider_id BIGINT UNSIGNED NOT NULL,
  status ENUM('offered','accepted','declined','expired') NOT NULL DEFAULT 'offered',
  offered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (delivery_id,rider_id),
  CONSTRAINT fk_delivery_offer_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_offer_rider FOREIGN KEY (rider_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_delivery_offer_rider (rider_id,status,offered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DELETE old_location FROM location_updates AS old_location
JOIN location_updates AS newer ON newer.delivery_id=old_location.delivery_id
  AND (newer.recorded_at>old_location.recorded_at OR (newer.recorded_at=old_location.recorded_at AND newer.id>old_location.id));
ALTER TABLE location_updates ADD UNIQUE KEY uq_location_updates_delivery (delivery_id);
