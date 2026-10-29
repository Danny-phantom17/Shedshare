CREATE TABLE conversations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_key CHAR(64) NOT NULL,
  kind ENUM('item','delivery_renter','delivery_owner') NOT NULL,
  item_id BIGINT UNSIGNED NULL,
  rental_id BIGINT UNSIGNED NULL,
  delivery_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  locked_at DATETIME NULL,
  closed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversations_key (conversation_key),
  KEY idx_conversations_rental (rental_id),
  KEY idx_conversations_delivery (delivery_id),
  CONSTRAINT fk_conversations_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL,
  CONSTRAINT fk_conversations_rental FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE SET NULL,
  CONSTRAINT fk_conversations_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE SET NULL,
  CONSTRAINT fk_conversations_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE conversation_participants (
  conversation_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  last_read_message_id BIGINT UNSIGNED NULL,
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id,user_id),
  KEY idx_conversation_participants_user (user_id,conversation_id),
  CONSTRAINT fk_conversation_participants_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_conversation_participants_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  attachment_path VARCHAR(512) NULL,
  attachment_mime VARCHAR(80) NULL,
  attachment_name VARCHAR(180) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_messages_thread (conversation_id,id),
  CONSTRAINT fk_chat_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE chat_blocks (
  conversation_id BIGINT UNSIGNED NOT NULL,
  blocker_id BIGINT UNSIGNED NOT NULL,
  blocked_user_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id,blocker_id,blocked_user_id),
  CONSTRAINT fk_chat_blocks_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_blocks_blocker FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_blocks_blocked FOREIGN KEY (blocked_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE chat_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  reporter_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('open','reviewing','resolved') NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_reports_status (status,created_at),
  CONSTRAINT fk_chat_reports_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE chat_admin_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  admin_id BIGINT UNSIGNED NOT NULL,
  accessed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_admin_access (conversation_id,accessed_at),
  CONSTRAINT fk_chat_admin_access_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_admin_access_admin FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO conversations (conversation_key,kind,item_id,rental_id,created_by,created_at)
SELECT SHA2(CONCAT('item:',m.item_id,':',m.owner_id,':',m.renter_id),256),'item',m.item_id,
       (SELECT r.id FROM rentals r WHERE r.item_id=m.item_id AND r.owner_id=m.owner_id AND r.renter_id=m.renter_id ORDER BY r.created_at DESC LIMIT 1),
       m.renter_id,MIN(m.created_at)
  FROM messages m
 GROUP BY m.item_id,m.owner_id,m.renter_id;

INSERT IGNORE INTO conversation_participants (conversation_id,user_id)
SELECT c.id,m.owner_id FROM conversations c JOIN messages m
 ON c.conversation_key=SHA2(CONCAT('item:',m.item_id,':',m.owner_id,':',m.renter_id),256)
UNION
SELECT c.id,m.renter_id FROM conversations c JOIN messages m
 ON c.conversation_key=SHA2(CONCAT('item:',m.item_id,':',m.owner_id,':',m.renter_id),256);

INSERT INTO chat_messages (conversation_id,sender_id,body,created_at)
SELECT c.id,m.sender_id,m.text,m.created_at FROM messages m
JOIN conversations c ON c.conversation_key=SHA2(CONCAT('item:',m.item_id,':',m.owner_id,':',m.renter_id),256)
WHERE NOT EXISTS (SELECT 1 FROM chat_messages cm JOIN conversations existing_c ON existing_c.id=cm.conversation_id
                  WHERE existing_c.conversation_key=c.conversation_key AND cm.sender_id=m.sender_id AND cm.created_at=m.created_at AND cm.body=m.text);
