-- Existing offers become time-bounded without deleting their accepted terms.
-- Offers whose original 48-hour window has already elapsed are closed so they
-- cannot be accepted or used to start checkout after the migration.
UPDATE rental_agreement_versions
   SET status='accepted'
 WHERE status='pending' AND renter_accepted_at IS NOT NULL AND owner_accepted_at IS NOT NULL;

UPDATE rental_agreement_versions
   SET expires_at=DATE_ADD(created_at,INTERVAL 48 HOUR)
 WHERE expires_at IS NULL AND status IN ('pending','accepted');

UPDATE rental_agreement_versions
   SET status='expired'
 WHERE status IN ('pending','accepted') AND expires_at<=UTC_TIMESTAMP();
