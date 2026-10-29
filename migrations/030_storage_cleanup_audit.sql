CREATE TABLE storage_cleanup_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id BIGINT UNSIGNED NOT NULL,
  mode ENUM('dry_run','delete') NOT NULL,
  status ENUM('completed','failed','partial') NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  retention_days SMALLINT UNSIGNED NOT NULL,
  candidate_count INT UNSIGNED NOT NULL DEFAULT 0,
  bytes_estimated BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), KEY idx_storage_cleanup_runs_admin(admin_id,created_at),
  CONSTRAINT fk_storage_cleanup_admin FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE storage_cleanup_asset_registry (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(20) NOT NULL,
  bucket_name VARCHAR(255) NOT NULL,
  object_key VARCHAR(1024) NOT NULL,
  asset_type ENUM('image','original_image','video') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_storage_asset_object(provider,bucket_name,object_key(400)),
  KEY idx_storage_asset_item(item_id,asset_type),
  KEY idx_storage_asset_key(object_key(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE storage_cleanup_upload_leases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(20) NOT NULL,
  bucket_name VARCHAR(255) NOT NULL,
  object_key VARCHAR(1024) NOT NULL,
  asset_type ENUM('image','original_image','video') NOT NULL,
  status ENUM('pending','attached','removed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uq_storage_upload_lease(provider,bucket_name,object_key(400)),
  KEY idx_storage_upload_lease_status(status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE storage_cleanup_run_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(20) NOT NULL,
  bucket_name VARCHAR(255) NOT NULL,
  object_key VARCHAR(1024) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_modified DATETIME NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('candidate','deleted','failed','skipped') NOT NULL DEFAULT 'candidate',
  error_message VARCHAR(500) NULL,
  PRIMARY KEY(id), UNIQUE KEY uq_storage_cleanup_run_object(run_id,provider,bucket_name,object_key(400)),
  KEY idx_storage_cleanup_item_status(run_id,status),
  CONSTRAINT fk_storage_cleanup_item_run FOREIGN KEY(run_id) REFERENCES storage_cleanup_runs(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
