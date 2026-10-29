"use strict";

function positiveInteger(name, fallback, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}.`);
  return value;
}

module.exports = Object.freeze({
  messagesPerMinute: positiveInteger("CHAT_MESSAGES_PER_MINUTE", 30, 300),
  retentionMonths: positiveInteger("CHAT_RETENTION_MONTHS", 12, 60),
  completionLockDays: positiveInteger("CHAT_COMPLETION_LOCK_DAYS", 7, 30),
  maxImageBytes: positiveInteger("CHAT_MAX_IMAGE_BYTES", 5 * 1024 * 1024, 20 * 1024 * 1024),
  streamPollMs: positiveInteger("CHAT_STREAM_POLL_MS", 2000, 30000),
  notificationBatchMinutes: positiveInteger("CHAT_NOTIFICATION_BATCH_MINUTES", 5, 60),
  privateBucket: process.env.CHAT_PRIVATE_STORAGE_BUCKET || "shedshare-chat-private"
});
