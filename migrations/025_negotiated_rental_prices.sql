ALTER TABLE rental_agreement_versions
  ADD COLUMN status ENUM('pending','accepted','rejected','expired','superseded') NOT NULL DEFAULT 'pending',
  ADD COLUMN expires_at DATETIME NULL,
  ADD KEY idx_rental_offer_expiry(rental_id,status,expires_at);

-- Existing agreements predate offer expiry and remain readable. New agreements
-- are assigned a bounded expiry by the application when created.
