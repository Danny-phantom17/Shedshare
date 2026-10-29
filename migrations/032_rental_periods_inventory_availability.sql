ALTER TABLE items
  MODIFY pricing_unit ENUM('hour','day','week','month','year') NOT NULL DEFAULT 'day',
  ADD COLUMN available_quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER max_period;

ALTER TABLE rentals
  MODIFY pricing_unit ENUM('hour','day','week','month','year') NOT NULL,
  ADD COLUMN inventory_quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER units;

CREATE TABLE item_pricing_options (
  item_id BIGINT UNSIGNED NOT NULL,
  pricing_unit ENUM('hour','day','week','month','year') NOT NULL,
  price DECIMAL(12,2) UNSIGNED NOT NULL,
  min_period SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  max_period SMALLINT UNSIGNED NOT NULL DEFAULT 14,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(item_id,pricing_unit),
  CONSTRAINT fk_item_pricing_item FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  CONSTRAINT chk_item_pricing_price CHECK(price>0),
  CONSTRAINT chk_item_pricing_period CHECK(min_period>=1 AND max_period>=min_period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO item_pricing_options(item_id,pricing_unit,price,min_period,max_period)
SELECT id,pricing_unit,price,min_period,max_period FROM items;

CREATE TABLE item_availability_blocks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id BIGINT UNSIGNED NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  status ENUM('reserved','booked','occupied','unavailable') NOT NULL DEFAULT 'unavailable',
  quantity SMALLINT UNSIGNED NULL,
  note VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id),
  KEY idx_item_availability_block_dates(item_id,start_at,end_at,status),
  CONSTRAINT fk_item_availability_item FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  CONSTRAINT fk_item_availability_owner FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_item_availability_dates CHECK(end_at>start_at),
  CONSTRAINT chk_item_availability_quantity CHECK(quantity IS NULL OR quantity>=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
