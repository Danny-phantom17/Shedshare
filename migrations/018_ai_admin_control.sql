CREATE TABLE ai_control_settings (
  setting_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  provider ENUM('openai','gemini','grok') NOT NULL DEFAULT 'grok',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_ai_control_singleton CHECK (setting_id = 1),
  CONSTRAINT fk_ai_control_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO ai_control_settings (setting_id, provider, enabled) VALUES (1, 'grok', FALSE);
