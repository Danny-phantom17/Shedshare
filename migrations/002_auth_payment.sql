-- Upgrade path for installations created before these fields existed.
-- Fresh installs already receive the final schema in migration 001.
SET @schema_name = DATABASE();
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_verified') = 0,
  'ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE',
  'SELECT 1'
);
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'users' AND COLUMN_NAME = 'supabase_auth_id') = 0,
  'ALTER TABLE users ADD COLUMN supabase_auth_id CHAR(36) NULL, ADD CONSTRAINT uq_users_supabase_auth_id UNIQUE (supabase_auth_id)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'items' AND COLUMN_NAME = 'image' AND DATA_TYPE = 'longtext') > 0,
  'ALTER TABLE items MODIFY image VARCHAR(2048) NULL, MODIFY video VARCHAR(2048) NULL',
  'SELECT 1'
);
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @schema_name AND TABLE_NAME = 'rentals' AND COLUMN_NAME = 'payment_reference') = 0,
  'ALTER TABLE rentals MODIFY status ENUM(''pending_payment'', ''confirmed'', ''active'', ''completed'', ''cancelled'') NOT NULL DEFAULT ''pending_payment'', ADD COLUMN payment_reference VARCHAR(100) NULL, ADD COLUMN payment_verified_at DATETIME NULL, ADD CONSTRAINT uq_rentals_payment_reference UNIQUE (payment_reference)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @ddl; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
