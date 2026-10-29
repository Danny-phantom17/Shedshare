"use strict";

const crypto = require("node:crypto");

function normalizeEmail(value) {
  // Trim and normalize the domain only; preserve local-part case and all aliases.
  const email = String(value || "").trim();
  const splitAt = email.lastIndexOf("@");
  return splitAt < 1 ? email : `${email.slice(0, splitAt)}@${email.slice(splitAt + 1).toLowerCase()}`;
}

function rateLimitHash(secret, scope, value) {
  return crypto.createHmac("sha256", secret).update(`${scope}:${String(value || "unknown")}`).digest("hex");
}

async function reserveRateLimit(pool, { secret, ip, email, windowMinutes = 15, emailLimit = 3, ipLimit = 10 }) {
  if (!secret) throw new Error("A server secret is required for email verification rate limiting.");
  const buckets = [
    { scope: "email", hash: rateLimitHash(secret, "verification-email", normalizeEmail(email)), limit: emailLimit },
    { scope: "ip", hash: rateLimitHash(secret, "verification-ip", ip || "unknown"), limit: ipLimit }
  ].sort((a, b) => `${a.scope}:${a.hash}`.localeCompare(`${b.scope}:${b.hash}`));
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const bucket of buckets) {
      await connection.execute("INSERT IGNORE INTO auth_email_rate_limits(scope,key_hash,window_started_at,request_count) VALUES(?,?,UTC_TIMESTAMP(),0)", [bucket.scope, bucket.hash]);
    }
    const states = [];
    for (const bucket of buckets) {
      const [rows] = await connection.execute("SELECT window_started_at,request_count FROM auth_email_rate_limits WHERE scope=? AND key_hash=? FOR UPDATE", [bucket.scope, bucket.hash]);
      states.push({ ...bucket, ...rows[0] });
    }
    const [window] = await connection.execute("SELECT UTC_TIMESTAMP() AS now");
    const now = new Date(window[0].now).getTime();
    const exceeds = states.some(state => {
      const started = new Date(state.window_started_at).getTime();
      return now - started < windowMinutes * 60000 && Number(state.request_count) >= state.limit;
    });
    for (const state of states) {
      const started = new Date(state.window_started_at).getTime();
      if (now - started >= windowMinutes * 60000) {
        await connection.execute("UPDATE auth_email_rate_limits SET window_started_at=UTC_TIMESTAMP(),request_count=1 WHERE scope=? AND key_hash=?", [state.scope, state.hash]);
      } else if (!exceeds) {
        await connection.execute("UPDATE auth_email_rate_limits SET request_count=request_count+1 WHERE scope=? AND key_hash=?", [state.scope, state.hash]);
      }
    }
    await connection.commit();
    return !exceeds;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

module.exports = { normalizeEmail, rateLimitHash, reserveRateLimit };
