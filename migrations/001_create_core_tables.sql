CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  brand VARCHAR(160) NULL,
  bank_name VARCHAR(120) NOT NULL,
  account_number VARCHAR(40) NOT NULL,
  subaccount_code VARCHAR(120) NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  supabase_auth_id CHAR(36) NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT uq_users_subaccount_code UNIQUE (subaccount_code),
  CONSTRAINT uq_users_supabase_auth_id UNIQUE (supabase_auth_id),
  INDEX idx_users_email_lookup (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(180) NOT NULL,
  category ENUM(
    'Home & Furniture',
    'Kitchen',
    'Vehicles',
    'Tools & Equipment',
    'Electronics',
    'Events',
    'Fashion',
    'Music',
    'Outdoor',
    'Other'
  ) NOT NULL,
  item_condition ENUM('Like new', 'Good', 'Well used') NOT NULL DEFAULT 'Good',
  location VARCHAR(255) NOT NULL,
  description TEXT NULL,
  image VARCHAR(2048) NULL,
  video VARCHAR(2048) NULL,
  price DECIMAL(12,2) UNSIGNED NOT NULL,
  pricing_unit ENUM('hour', 'day', 'week') NOT NULL DEFAULT 'day',
  min_period SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  max_period SMALLINT UNSIGNED NOT NULL DEFAULT 14,
  deposit DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  delivery_available BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_fee DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_items_owner
    FOREIGN KEY (owner_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_items_price_positive CHECK (price > 0),
  CONSTRAINT chk_items_period_range CHECK (
    min_period >= 1 AND max_period >= min_period
  ),
  CONSTRAINT chk_items_delivery_fee CHECK (
    delivery_available = TRUE OR delivery_fee = 0
  ),
  INDEX idx_items_owner_created (owner_id, created_at),
  INDEX idx_items_browse (paused, category, price)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE rentals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id BIGINT UNSIGNED NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  renter_id BIGINT UNSIGNED NOT NULL,
  item_name VARCHAR(180) NOT NULL,
  price_per_unit DECIMAL(12,2) UNSIGNED NOT NULL,
  units SMALLINT UNSIGNED NOT NULL,
  pricing_unit ENUM('hour', 'day', 'week') NOT NULL,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  subtotal DECIMAL(12,2) UNSIGNED NOT NULL,
  deposit DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  delivery_method ENUM('pickup', 'delivery') NOT NULL DEFAULT 'pickup',
  delivery_fee DECIMAL(12,2) UNSIGNED NOT NULL DEFAULT 0,
  total DECIMAL(12,2) UNSIGNED NOT NULL,
  platform_fee_percent DECIMAL(5,2) UNSIGNED NOT NULL,
  platform_fee DECIMAL(12,2) UNSIGNED NOT NULL,
  owner_payout DECIMAL(12,2) UNSIGNED NOT NULL,
  agreement_version VARCHAR(40) NOT NULL,
  agreement_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_at DATETIME NULL,
  status ENUM('pending_payment', 'confirmed', 'active', 'completed', 'cancelled') NOT NULL DEFAULT 'pending_payment',
  payment_reference VARCHAR(100) NULL,
  payment_verified_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_rentals_item
    FOREIGN KEY (item_id) REFERENCES items (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_rentals_owner
    FOREIGN KEY (owner_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_rentals_renter
    FOREIGN KEY (renter_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_rentals_parties_differ CHECK (owner_id <> renter_id),
  CONSTRAINT chk_rentals_units_positive CHECK (units >= 1),
  CONSTRAINT chk_rentals_price_positive CHECK (price_per_unit > 0),
  CONSTRAINT chk_rentals_date_order CHECK (end_at > start_at),
  CONSTRAINT chk_rentals_fee_percent CHECK (platform_fee_percent <= 100),
  CONSTRAINT chk_rentals_agreement CHECK (
    agreement_accepted = FALSE OR accepted_at IS NOT NULL
  ),
  CONSTRAINT uq_rentals_payment_reference UNIQUE (payment_reference),
  CONSTRAINT chk_rentals_delivery_fee CHECK (
    delivery_method = 'delivery' OR delivery_fee = 0
  ),
  INDEX idx_rentals_status (status),
  INDEX idx_rentals_owner_status (owner_id, status, created_at),
  INDEX idx_rentals_renter_status (renter_id, status, created_at),
  INDEX idx_rentals_item_status_dates (item_id, status, start_at, end_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
