"use strict";

const ALERT_THRESHOLD = 6;
const ALERT_WINDOW_MINUTES = 10;

function requestIp(request) {
  return String(request.ip || request.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "").slice(0, 45);
}

async function notifyAdministrator(subject, message) {
  const url = process.env.EMAIL_PROVIDER_URL;
  const key = process.env.EMAIL_PROVIDER_API_KEY;
  const to = process.env.SECURITY_ALERT_EMAIL;
  if (!url || !key || !to) {
    console.error("Security alert not sent: configure EMAIL_PROVIDER_URL, EMAIL_PROVIDER_API_KEY, and SECURITY_ALERT_EMAIL.", subject);
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ to, subject, text: message }), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) console.error("Security alert email provider returned", response.status);
  } catch (error) { console.error("Security alert email failed:", error.message); }
}

function createSecurityEvents({ pool }) {
  async function record(type, request, fields = {}) {
    const ip = requestIp(request);
    const email = typeof fields.email === "string" ? fields.email.slice(0, 254) : null;
    const userId = fields.userId && /^\d+$/.test(String(fields.userId)) ? String(fields.userId) : null;
    const details = fields.details ? JSON.stringify(fields.details).slice(0, 4000) : null;
    await pool.execute("INSERT INTO security_events(event_type,ip_address,user_email,user_id,details) VALUES(?,?,?,?,?)", [type, ip, email, userId, details]);
    return ip;
  }

  async function failedLogin(request, email) {
    const ip = requestIp(request);
    const normalizedEmail = String(email || "unknown").slice(0, 254);
    await pool.execute("INSERT INTO login_failures(ip_address,user_email) VALUES(?,?)", [ip, normalizedEmail]);
    await record("failed_login", request, { email: normalizedEmail });
    const [rows] = await pool.execute("SELECT COUNT(*) AS total FROM login_failures WHERE ip_address=? AND created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 MINUTE)", [ip]);
    if (Number(rows[0]?.total) === ALERT_THRESHOLD) {
      await notifyAdministrator("ShedShare security alert: repeated failed logins", `${ALERT_THRESHOLD} or more failed logins were recorded from IP ${ip} within 10 minutes. Check the security_events table.`);
    }
    const [targetRows] = await pool.execute("SELECT COUNT(*) AS total FROM login_failures WHERE ip_address=? AND user_email=? AND created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 15 MINUTE)", [ip, normalizedEmail]);
    if (Number(targetRows[0]?.total) >= 5) {
      await pool.execute("INSERT INTO login_lockouts(ip_address,user_email,locked_until) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE)) ON DUPLICATE KEY UPDATE locked_until=GREATEST(locked_until,VALUES(locked_until))", [ip, normalizedEmail]);
    }
  }

  async function isLocked(request, email) {
    const [rows] = await pool.execute("SELECT locked_until FROM login_lockouts WHERE ip_address=? AND user_email=? AND locked_until>UTC_TIMESTAMP() LIMIT 1", [requestIp(request), String(email || "unknown").slice(0, 254)]);
    return rows.length > 0;
  }

  async function clearLoginFailures(request, email) {
    const ip = requestIp(request);
    const normalizedEmail = String(email || "unknown").slice(0, 254);
    await pool.execute("DELETE FROM login_failures WHERE ip_address=? AND user_email=?", [ip, normalizedEmail]);
    await pool.execute("DELETE FROM login_lockouts WHERE ip_address=? AND user_email=?", [ip, normalizedEmail]);
  }

  async function webhookSignatureFailure(request, reference) {
    await record("webhook_signature_failure", request, { details: { reference: String(reference || "unknown").slice(0, 120) } });
    await notifyAdministrator("ShedShare security alert: Paystack webhook signature failure", `A Paystack webhook signature check failed from IP ${requestIp(request)}. Review the security_events table and Paystack dashboard.`);
  }

  return { record, failedLogin, isLocked, clearLoginFailures, webhookSignatureFailure };
}

module.exports = { createSecurityEvents, requestIp };
