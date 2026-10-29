-- The application database role has no DROP privilege. This empty legacy table
-- is no longer read or written by the app and can be dropped by a DBA later.

ALTER TABLE rentals
  MODIFY COLUMN status ENUM('inquiry','pending_payment','confirmed','active','completed','cancelled','disputed') NOT NULL DEFAULT 'pending_payment',
  MODIFY COLUMN dispute_return_status ENUM('inquiry','pending_payment','confirmed','active','completed','cancelled') NULL;

ALTER TABLE rental_payment_attempts
  MODIFY COLUMN status ENUM('initialized','pending','success','failed','expired','disputed') NOT NULL DEFAULT 'initialized';

ALTER TABLE rental_financial_ledger
  MODIFY COLUMN entry_type ENUM('payment','commission','owner_allocation','processing_fee','payout') NOT NULL;
