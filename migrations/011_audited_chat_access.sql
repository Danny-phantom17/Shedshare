ALTER TABLE chat_admin_access
  DROP FOREIGN KEY fk_chat_admin_access_conversation,
  ADD COLUMN access_reason VARCHAR(500) NOT NULL DEFAULT 'legacy access',
  ADD COLUMN access_mode ENUM('reported','dispute','safety_review','fraud_check','other') NOT NULL DEFAULT 'other',
  ADD COLUMN trust_role ENUM('super_admin','trust_and_safety') NOT NULL DEFAULT 'trust_and_safety',
  ADD CONSTRAINT fk_chat_admin_access_conversation_restrict FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT;

UPDATE chat_admin_access ca JOIN users u ON u.id=ca.admin_id
   SET ca.trust_role=CASE WHEN u.trust_role='super_admin' THEN 'super_admin' ELSE 'trust_and_safety' END;
