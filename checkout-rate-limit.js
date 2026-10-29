"use strict";

const CHECKOUT_WINDOW_MINUTES = 15;
const CHECKOUT_MAX_ATTEMPTS = 10;

function createCheckoutRateLimiter(pool) {
  if (!pool || typeof pool.execute !== "function") throw new Error("A database pool is required for checkout rate limiting.");

  return async function checkoutRateLimiter(request, response, next) {
    const userId = request.user?.id;
    if (!userId) return response.status(401).json({ error: "Sign in before starting checkout." });

    try {
      await pool.execute(
        `INSERT INTO checkout_rate_limits (user_id, window_started_at, request_count)
         VALUES (?, UTC_TIMESTAMP(), 1)
         ON DUPLICATE KEY UPDATE
           request_count = IF(window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${CHECKOUT_WINDOW_MINUTES} MINUTE), 1, request_count + 1),
           window_started_at = IF(window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${CHECKOUT_WINDOW_MINUTES} MINUTE), UTC_TIMESTAMP(), window_started_at)`,
        [userId]
      );
      const [rows] = await pool.execute(
        `SELECT request_count,
                GREATEST(1, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), DATE_ADD(window_started_at, INTERVAL ${CHECKOUT_WINDOW_MINUTES} MINUTE))) AS retry_after
           FROM checkout_rate_limits WHERE user_id = ?`,
        [userId]
      );
      const row = rows[0];
      if (!row || Number(row.request_count) > CHECKOUT_MAX_ATTEMPTS) {
        response.setHeader("Retry-After", String(Math.max(1, Number(row?.retry_after) || 1)));
        return response.status(429).json({ error: "Too many checkout attempts. Wait before trying again." });
      }
      return next();
    } catch (error) {
      console.error("Checkout rate limiter failed:", error.message);
      return response.status(503).json({ error: "Checkout is temporarily unavailable. Try again shortly." });
    }
  };
}

module.exports = { createCheckoutRateLimiter };
