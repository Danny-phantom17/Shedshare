ALTER TABLE rentals
  MODIFY COLUMN status ENUM('inquiry','pending_payment','confirmed','active','completed','cancelled','disputed') NOT NULL DEFAULT 'pending_payment',
  ADD COLUMN dispute_return_status ENUM('inquiry','pending_payment','confirmed','active','completed','cancelled') NULL;
