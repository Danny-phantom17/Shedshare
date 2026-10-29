CREATE TABLE event_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  renter_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  event_location VARCHAR(255) NOT NULL,
  event_start DATETIME NOT NULL,
  event_end DATETIME NOT NULL,
  estimated_budget DECIMAL(12,2) UNSIGNED NOT NULL,
  status ENUM('requested','reviewing','partially_responded','responded','cancelled') NOT NULL DEFAULT 'requested',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), KEY idx_event_plan_renter(renter_id,created_at),
  CONSTRAINT fk_event_plan_renter FOREIGN KEY(renter_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE event_plan_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_plan_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  requested_quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  estimated_subtotal DECIMAL(12,2) UNSIGNED NOT NULL,
  status ENUM('requested','accepted','rejected','cancelled') NOT NULL DEFAULT 'requested',
  response_note VARCHAR(1000) NULL,
  responded_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_event_plan_listing(event_plan_id,item_id),
  KEY idx_event_plan_owner(owner_id,status,created_at),
  CONSTRAINT fk_event_plan_item_plan FOREIGN KEY(event_plan_id) REFERENCES event_plans(id) ON DELETE RESTRICT,
  CONSTRAINT fk_event_plan_item_listing FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_event_plan_item_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
