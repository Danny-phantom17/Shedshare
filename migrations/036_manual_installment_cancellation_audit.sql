ALTER TABLE rental_manual_payment_events
  MODIFY COLUMN event_type ENUM('reported','confirmed','rejected','cancelled') NOT NULL;
