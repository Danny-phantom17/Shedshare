"use strict";

const bcrypt = require("bcryptjs");
const express = require("express");
const { requirePaystackMode } = require("./payment-mode");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { maskPhone } = require("./privacy");
const { SESSION_COOKIE, setSessionCookie, clearSessionCookie, cookieValue } = require("./security-cookies");
const { getReferralAttribution, insertReferralAttribution, recordReferralEvent } = require("./referrals");
const { normalizeEmail, reserveRateLimit } = require("./email-integrity");

const emailSchema = z.string().trim().email("Enter a valid email address.").max(254).transform(normalizeEmail);
const passwordSchema = z.string().min(8, "Password must be at least 8 characters.").refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password is too long.");
const signupSchema = z.object({
  name: z.string().trim().min(1).max(120), phone: z.string().trim().min(1).max(40),
  brand: z.string().trim().max(160).optional().default(""),
  bankName: z.string().trim().max(120).optional().default(""), accountNumber: z.string().trim().max(40).optional().default(""),
  email: emailSchema, password: passwordSchema, referralCode: z.string().trim().max(20).optional().default("")
}).strict();

function isRateLimitError(error) {
  return Number(error?.status) === 429 || /too many requests|rate.?limit|over_email_send_rate_limit/i.test(`${error?.code || ""} ${error?.message || ""}`);
}

const verificationRateLimitMessage = "Verification emails are temporarily rate-limited. Wait before retrying; for frequent testing, configure custom SMTP in Supabase.";
const passwordRecoveryRateLimitMessage = "Password reset emails are temporarily rate-limited. Wait 15 minutes before trying again.";
const passwordRecoveryAcceptedMessage = "If this email has a ShedShare password account, recovery instructions have been sent. Check your inbox and spam folder. If you signed in with Google, use Continue with Google.";
const signupAcceptedMessage = "If this address can be registered, ShedShare will send verification instructions. If you already have an account, sign in or request a fresh verification link.";

function acceptedSignup(response, email) {
  return response.status(202).json({ requiresEmailVerification: true, email, message: signupAcceptedMessage });
}

async function recordEmailVerification(pool, userId, provider, email, secret) {
  const emailHash = require("node:crypto").createHmac("sha256", secret).update(`verified-email:${normalizeEmail(email)}`).digest("hex");
  await pool.execute("INSERT IGNORE INTO email_verification_audit(user_id,provider,verified_email_hash) VALUES(?,?,?)", [userId, provider, emailHash]);
}

function publicUser(row) {
  return {
    id: String(row.id), name: row.name, phone: maskPhone(row.phone), brand: row.brand || "",
    bankName: row.bank_name || "", accountNumber: "",
    subaccountCode: row.subaccount_code || "", email: row.email, isAdmin: Boolean(row.is_admin),
    emailVerified: Boolean(row.email_verified), isRider: Boolean(row.is_rider), trustRole: row.trust_role || "none"
  };
}

function createAuth({ pool, jwtSecret, jwtExpiresIn = "1h", supabaseAuth, supabaseAdmin, authMode = "supabase", securityEvents, secureCookies = process.env.NODE_ENV === "production" }) {
  if (!pool || !jwtSecret) throw new Error("Authentication database and JWT secret are required.");
  const router = express.Router();

  function issueToken(user) {
    return jwt.sign({ sub: String(user.id) }, jwtSecret, {
      algorithm: "HS256", expiresIn: jwtExpiresIn, issuer: "shedshare-api", audience: "shedshare-web"
    });
  }

  function signIn(response, user) {
    // The browser receives only the profile; the JWT stays in an HttpOnly cookie.
    setSessionCookie(response, issueToken(user), secureCookies);
    return { user };
  }

  router.get("/session", authenticate, (request, response) => response.json({ user: request.user }));
  router.post("/logout", (_request, response) => {
    clearSessionCookie(response, secureCookies);
    return response.status(200).json({ ok: true });
  });

  router.delete("/account", authenticate, async (request, response) => {
    if (request.user.isAdmin) return response.status(403).json({ error: "Administrator accounts cannot self-delete. Transfer admin access first." });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [userRows] = await connection.execute("SELECT id,email,supabase_auth_id FROM users WHERE id=? FOR UPDATE", [request.user.id]);
      if (!userRows.length) { await connection.rollback(); clearSessionCookie(response, secureCookies); return response.status(204).end(); }
      const user = userRows[0];

      const [activeRentals] = await connection.execute("SELECT id FROM rentals WHERE (owner_id=? OR renter_id=?) AND status IN ('pending_payment','confirmed','active') LIMIT 1", [user.id, user.id]);
      if (activeRentals.length) {
        await connection.rollback();
        return response.status(409).json({ error: "Resolve or complete your pending or active rentals before deleting your account." });
      }

      // Preserve rental, payment, dispute, and audit foreign keys while removing direct identifiers.
      const anonymizedEmail = `deleted-${user.id}-${Date.now()}@account.invalid`;
      await connection.execute("UPDATE items SET paused=TRUE WHERE owner_id=?", [user.id]);
      await connection.execute("UPDATE users SET name='Deleted account',phone='',brand=NULL,bank_name=NULL,account_number=NULL,subaccount_code=NULL,email=?,password_hash='',email_verified=FALSE,supabase_auth_id=NULL,is_admin=FALSE,is_rider=FALSE,trust_role='none' WHERE id=?", [anonymizedEmail, user.id]);
      await connection.execute("DELETE FROM user_notification_preferences WHERE user_id=?", [user.id]);
      await connection.execute("DELETE FROM notifications WHERE user_id=?", [user.id]);
      await connection.execute("DELETE FROM login_failures WHERE user_email=?", [user.email]);
      await connection.execute("DELETE FROM login_lockouts WHERE user_email=?", [user.email]);
      await connection.commit();

      if (user.supabase_auth_id && supabaseAdmin) {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(user.supabase_auth_id);
        if (error) console.error("Supabase identity cleanup failed after account deletion:", error.message);
      }
      clearSessionCookie(response, secureCookies);
      return response.status(200).json({ ok: true, message: "Your account has been deleted. Some anonymized rental, payment, and safety records are retained where legally or operationally required." });
    } catch (error) {
      try { await connection.rollback(); } catch (_rollbackError) {}
      console.error("Account deletion failed:", error.message);
      return response.status(500).json({ error: "Unable to delete your account. Please contact support." });
    } finally { connection.release(); }
  });

  async function authenticate(request, response, next) {
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) return response.status(401).json({ error: "Authentication required." });
    try {
      const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"], issuer: "shedshare-api", audience: "shedshare-web" });
      if (!/^\d+$/.test(String(payload.sub || ""))) return response.status(401).json({ error: "Invalid or expired token." });
      const [rows] = await pool.execute(
        `SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, is_admin, email_verified, is_rider, trust_role FROM users WHERE id = ? LIMIT 1`, [payload.sub]
      );
      if (!rows.length) return response.status(401).json({ error: "Invalid or expired token." });
      request.user = publicUser(rows[0]);
      return next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        clearSessionCookie(response, secureCookies);
        return response.status(401).json({ error: "Invalid or expired session." });
      }
      console.error("Authentication failed:", error.message);
      return response.status(500).json({ error: "Unable to authenticate request." });
    }
  }

  router.post("/signup", async (request, response) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
    const data = parsed.data;
    try {
      const passwordHash = await bcrypt.hash(data.password, 12);
      const [existingRows] = await pool.execute("SELECT id FROM users WHERE email_normalized = ? LIMIT 1", [data.email]);
      if (existingRows.length) return acceptedSignup(response, data.email);
      const attribution = data.referralCode ? await getReferralAttribution(pool, data.referralCode, data.email) : null;
      if (attribution?.error) return response.status(400).json({ error: attribution.error });
      if (authMode === "local") {
        const connection = await pool.getConnection();
        let result;
        try {
          await connection.beginTransaction();
          [result] = await connection.execute(
            `INSERT INTO users (name, phone, brand, bank_name, account_number, email, password_hash, email_verified, supabase_auth_id) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, NULL)`,
            [data.name, data.phone, data.brand || null, data.bankName, data.accountNumber, data.email, passwordHash]
          );
          await insertReferralAttribution(connection, attribution, result.insertId, data.phone);
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
        const [created] = await pool.execute(
          `SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, is_admin, email_verified, is_rider, trust_role FROM users WHERE id = ? LIMIT 1`, [result.insertId]
        );
        const user = publicUser(created[0]);
        return response.status(201).json({ ...signIn(response, user), message: "Local test account created and signed in. Its email remains unverified; local testing does not qualify email-verification referrals." });
      }
      if (!supabaseAuth || !supabaseAdmin) return response.status(503).json({ error: "Email verification is not configured. Please try again later." });
      const { data: authSignup, error } = await supabaseAuth.auth.signUp({ email: data.email, password: data.password, options: { emailRedirectTo: process.env.EMAIL_VERIFICATION_REDIRECT_URL || undefined } });
      if (error) {
        if (/already registered|already exists/i.test(error.message)) return response.status(409).json({ error: "An account with that email already exists." });
        console.error("Email verification signup failed:", String(error?.code || "provider_error").slice(0, 80));
        if (isRateLimitError(error)) return response.status(429).json({ error: verificationRateLimitMessage });
        if (/email address not authorized|email_address_not_authorized/i.test(`${error?.code || ""} ${error?.message || ""}`)) return response.status(503).json({ error: "Supabase's built-in email service only sends to approved team addresses. Configure custom SMTP to verify other test accounts." });
        return response.status(502).json({ error: "Unable to send verification email." });
      }
      if (!authSignup.user) return response.status(502).json({ error: "Unable to create account." });
      if (authSignup.user.identities && authSignup.user.identities.length === 0) return acceptedSignup(response, data.email);
      let result;
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        [result] = await connection.execute(
          `INSERT INTO users (name, phone, brand, bank_name, account_number, email, password_hash, email_verified, supabase_auth_id) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?)`,
          [data.name, data.phone, data.brand || null, data.bankName, data.accountNumber, data.email, passwordHash, authSignup.user.id]
        );
        await insertReferralAttribution(connection, attribution, result.insertId, data.phone);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        await supabaseAdmin.auth.admin.deleteUser(authSignup.user.id);
        throw error;
      } finally { connection.release(); }
      return response.status(201).json({ requiresEmailVerification: true, email: data.email, userId: String(result.insertId), message: "Check your email for a verification link before signing in." });
    } catch (error) {
      if (error && error.code === "ER_DUP_ENTRY") return acceptedSignup(response, data.email);
      if (isRateLimitError(error)) return response.status(429).json({ error: verificationRateLimitMessage });
      console.error("Signup failed:", error.message);
      return response.status(500).json({ error: "Unable to create account." });
    }
  });

  router.post("/login", async (request, response) => {
    const parsed = z.object({ email: emailSchema, password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
    try {
      if (securityEvents && await securityEvents.isLocked(request, parsed.data.email)) return response.status(429).json({ error: "Too many failed sign-in attempts. Try again in 15 minutes." });
      const [rows] = await pool.execute(
        `SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, password_hash, is_admin, email_verified, is_rider, trust_role FROM users WHERE email_normalized = ? LIMIT 1`, [parsed.data.email]
      );
      const row = rows[0];
      if (!row || !(await bcrypt.compare(parsed.data.password, row.password_hash))) {
        if (securityEvents) await securityEvents.failedLogin(request, parsed.data.email);
        return response.status(401).json({ error: "Invalid email or password." });
      }
      if (authMode !== "local" && !row.supabase_auth_id) return response.status(403).json({ error: "This account cannot use the configured sign-in method. Use the original sign-in method or contact support." });
      if (authMode !== "local" && row.supabase_auth_id && supabaseAdmin) {
        const { data: providerUser, error: providerError } = await supabaseAdmin.auth.admin.getUserById(row.supabase_auth_id);
        if (providerError || !providerUser.user?.email_confirmed_at || normalizeEmail(providerUser.user.email) !== normalizeEmail(row.email)) return response.status(403).json({ error: "Verify your email before signing in." });
        if (!row.email_verified) {
          await pool.execute("UPDATE users SET email_verified=TRUE WHERE id=? AND supabase_auth_id=?", [row.id, row.supabase_auth_id]);
          await recordEmailVerification(pool, row.id, "supabase", row.email, jwtSecret);
          row.email_verified = 1;
          await recordReferralEvent(pool, row.id, "account_verified", `account-verified:${row.id}`, { source: "confirmed_provider_login" }).catch(error => console.error("Recording verified referral event failed:", String(error?.code || "database_error").slice(0, 80)));
        }
      }
      const user = publicUser(row);
      if (securityEvents) {
        await securityEvents.clearLoginFailures(request, parsed.data.email);
        if (user.isAdmin) await securityEvents.record("admin_login_success", request, { email: user.email, userId: user.id });
      }
      return response.status(200).json(signIn(response, user));
    } catch (error) {
      console.error("Login failed:", error.message);
      return response.status(500).json({ error: "Unable to sign in." });
    }
  });

  router.post("/refresh-verification", async (request, response) => {
    if (authMode === "local") return response.status(200).json({ message: "Email verification is disabled in local test mode. You can sign in with your email and password." });
    const parsed = z.object({ email: emailSchema }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid email address." });
    if (!supabaseAuth) return response.status(503).json({ error: "Email verification is not configured." });
    try {
      const allowed = await reserveRateLimit(pool, { secret: jwtSecret, email: parsed.data.email, ip: request.ip });
      if (!allowed) return response.status(429).json({ error: verificationRateLimitMessage });
      const { error } = await supabaseAuth.auth.resend({ type: "signup", email: parsed.data.email, options: { emailRedirectTo: process.env.EMAIL_VERIFICATION_REDIRECT_URL || undefined } });
      if (error) throw error;
      return response.status(200).json({ message: "If this account is awaiting verification, a fresh link has been sent. If it is already verified, you can sign in." });
    } catch (error) {
      console.error("Resending verification failed:", String(error?.code || "provider_error").slice(0, 80));
      if (isRateLimitError(error)) return response.status(429).json({ error: verificationRateLimitMessage });
      if (/email address not authorized|email_address_not_authorized/i.test(`${error?.code || ""} ${error?.message || ""}`)) return response.status(503).json({ error: "Supabase's built-in email service only sends to approved team addresses. Configure custom SMTP to verify this account." });
      if (/auth_email_rate_limits/.test(error?.message || "")) return response.status(503).json({ error: "Email verification rate limiting is not ready. Apply the account-integrity migration and retry." });
      return response.status(502).json({ error: "Unable to resend the verification email. Check the address and try again later." });
    }
  });

  router.post("/forgot-password", async (request, response) => {
    const parsed = z.object({ email: emailSchema }).strict().safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || "Enter a valid email address." });
    if (authMode === "local") return response.status(503).json({ error: "Password recovery email is unavailable in local test mode." });
    if (!supabaseAuth) return response.status(503).json({ error: "Password recovery is not configured." });
    try {
      const allowed = await reserveRateLimit(pool, {
        secret: jwtSecret, email: parsed.data.email, ip: request.ip,
        emailLimit: 3, ipLimit: 10, purpose: "password-recovery"
      });
      if (!allowed) return response.status(429).json({ error: passwordRecoveryRateLimitMessage });
      const redirectTo = process.env.PASSWORD_RECOVERY_REDIRECT_URL || process.env.EMAIL_VERIFICATION_REDIRECT_URL || undefined;
      const { error } = await supabaseAuth.auth.resetPasswordForEmail(parsed.data.email, { redirectTo });
      if (error) {
        if (isRateLimitError(error)) return response.status(429).json({ error: passwordRecoveryRateLimitMessage });
        console.error("Password recovery email failed:", String(error?.code || "provider_error").slice(0, 80));
        return response.status(502).json({ error: "Unable to send password recovery instructions right now. Try again later." });
      }
      return response.status(200).json({ message: passwordRecoveryAcceptedMessage });
    } catch (error) {
      console.error("Password recovery request failed:", String(error?.code || "request_error").slice(0, 80));
      if (error?.code === "ER_NO_SUCH_TABLE") return response.status(503).json({ error: "Password recovery is being configured. Please try again shortly." });
      return response.status(500).json({ error: "Unable to process the password recovery request." });
    }
  });

  router.post("/reset-password", async (request, response) => {
    const parsed = z.object({
      token_hash: z.string().min(16).max(2048).optional(),
      access_token: z.string().min(16).max(4096).optional(),
      password: passwordSchema
    }).strict().refine(data => Boolean(data.token_hash || data.access_token), { message: "A recovery link is required." }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || "Enter a valid password recovery request." });
    if (authMode === "local" || !supabaseAuth || !supabaseAdmin) return response.status(503).json({ error: "Password recovery is not configured." });

    try {
      let providerUser;
      if (parsed.data.token_hash) {
        const verification = await supabaseAuth.auth.verifyOtp({ token_hash: parsed.data.token_hash, type: "recovery" });
        if (verification.error || !verification.data.user?.id || !verification.data.user?.email) return response.status(400).json({ error: "This recovery link is invalid or expired. Request a new password reset email." });
        providerUser = verification.data.user;
      } else {
        const { data, error } = await supabaseAdmin.auth.getUser(parsed.data.access_token);
        if (error || !data.user?.id || !data.user?.email) return response.status(400).json({ error: "This recovery link is invalid or expired. Request a new password reset email." });
        providerUser = data.user;
      }

      const normalizedEmail = normalizeEmail(providerUser.email);
      const [rows] = await pool.execute(
        "SELECT id,supabase_auth_id FROM users WHERE email_normalized=? AND supabase_auth_id=? LIMIT 1",
        [normalizedEmail, providerUser.id]
      );
      if (!rows.length) return response.status(400).json({ error: "This link is not for a ShedShare email-and-password account. Use the original sign-in method or request a new link." });

      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const { error: providerError } = await supabaseAdmin.auth.admin.updateUserById(providerUser.id, { password: parsed.data.password });
      if (providerError) {
        console.error("Supabase password update failed:", String(providerError?.code || "provider_error").slice(0, 80));
        return response.status(502).json({ error: "Unable to update the password. Request a new recovery link and try again." });
      }
      const [result] = await pool.execute(
        "UPDATE users SET password_hash=? WHERE id=? AND supabase_auth_id=?",
        [passwordHash, rows[0].id, providerUser.id]
      );
      if (result.affectedRows !== 1) {
        console.error("Password reset provider/database sync failed for user id:", String(rows[0].id));
        return response.status(503).json({ error: "The password provider updated, but ShedShare could not finish syncing the account. Contact support before trying to sign in." });
      }
      return response.status(200).json({ message: "Your password has been updated. Sign in with your email and new password." });
    } catch (error) {
      console.error("Password reset failed:", String(error?.code || "request_error").slice(0, 80));
      return response.status(500).json({ error: "Unable to reset the password. Request a new recovery link and try again." });
    }
  });

  router.post("/confirm-email", async (request, response) => {
    if (authMode === "local") return response.status(200).json({ message: "Email verification is disabled in local test mode." });
    if (!supabaseAuth || !supabaseAdmin) return response.status(503).json({ error: "Email verification is not configured." });
    const tokenHash = request.body?.token_hash;
    if (typeof tokenHash !== "string" || tokenHash.length < 16 || tokenHash.length > 2048) return response.status(400).json({ error: "Verification token is required." });
    try {
      const verification = await supabaseAuth.auth.verifyOtp({ token_hash: tokenHash, type: "signup" });
      if (verification.error || !verification.data.user?.email) return response.status(400).json({ error: "This verification link is invalid or expired. If you already verified, sign in; otherwise request a fresh link." });
      const { data: adminData, error: adminError } = await supabaseAdmin.auth.admin.getUserById(verification.data.user.id);
      if (adminError || !adminData.user?.email_confirmed_at || normalizeEmail(adminData.user.email) !== normalizeEmail(verification.data.user.email)) return response.status(400).json({ error: "Email confirmation has not completed. If the link expired, request a fresh one." });
      const connection = await pool.getConnection();
      let verifiedUser;
      try {
        await connection.beginTransaction();
        const verifiedEmail = normalizeEmail(verification.data.user.email);
        const [rows] = await connection.execute("SELECT id,email FROM users WHERE email_normalized=? AND supabase_auth_id=? LIMIT 1 FOR UPDATE", [verifiedEmail, verification.data.user.id]);
        if (!rows.length) { await connection.rollback(); return response.status(400).json({ error: "This verification link is not associated with an eligible ShedShare account." }); }
        verifiedUser = rows[0];
        await connection.execute("UPDATE users SET email_verified=TRUE WHERE id=? AND supabase_auth_id=?", [verifiedUser.id, verification.data.user.id]);
        await recordEmailVerification(connection, verifiedUser.id, "supabase", verifiedEmail, jwtSecret);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
      await recordReferralEvent(pool, verifiedUser.id, "account_verified", `account-verified:${verifiedUser.id}`, { source: "supabase_email_confirmation" }).catch(error => console.error("Recording verified referral event failed:", String(error?.code || "database_error").slice(0, 80)));
      return response.status(200).json({ message: "Email verified. You can now sign in." });
    } catch (error) {
      console.error("Email verification failed:", String(error?.code || "provider_error").slice(0, 80));
      if (error?.code === "ER_NO_SUCH_TABLE") return response.status(503).json({ error: "Account verification is being updated. Please retry shortly." });
      return response.status(500).json({ error: "Unable to verify email." });
    }
  });

  router.post("/google", async (request, response) => {
    if (authMode === "local") return response.status(503).json({ error: "Google sign-in is paused in local test mode. Create or sign in with an email and password." });
    const credential = request.body?.credential;
    const referralCode = typeof request.body?.referralCode === "string" ? request.body.referralCode.trim() : "";
    if (referralCode.length > 20) return response.status(400).json({ error: "Enter a valid referral code." });
    if (!process.env.GOOGLE_CLIENT_ID) return response.status(503).json({ error: "Google sign-in is not configured." });
    if (typeof credential !== "string" || credential.length > 10000) return response.status(400).json({ error: "Google credential is required." });
    try {
      const verifyUrl = new URL("https://oauth2.googleapis.com/tokeninfo");
      verifyUrl.searchParams.set("id_token", credential);
      const result = await fetch(verifyUrl, { signal: AbortSignal.timeout(8000) });
      if (!result.ok) return response.status(401).json({ error: "Invalid Google sign-in credential." });
      const claims = await result.json();
      if (claims.aud !== process.env.GOOGLE_CLIENT_ID || claims.email_verified !== "true" || !claims.email) return response.status(401).json({ error: "Google account email is not verified." });
      const email = normalizeEmail(claims.email);
      const [rows] = await pool.execute("SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, password_hash, supabase_auth_id, is_admin, email_verified, is_rider, trust_role FROM users WHERE email_normalized = ? LIMIT 1", [email]);
      let row = rows[0];
      const attribution = !row && referralCode ? await getReferralAttribution(pool, referralCode, email) : null;
      if (attribution?.error) return response.status(400).json({ error: attribution.error });
      if (!row) {
        const connection = await pool.getConnection();
        let insert;
        try {
          await connection.beginTransaction();
          [insert] = await connection.execute(
            "INSERT INTO users (name, phone, brand, bank_name, account_number, email, password_hash, email_verified, supabase_auth_id) VALUES (?, '', NULL, '', '', ?, '', TRUE, ?)",
            [String(claims.name || email.split("@")[0]).slice(0, 120), email, claims.sub]
          );
          await recordEmailVerification(connection, insert.insertId, "google", email, jwtSecret);
          await insertReferralAttribution(connection, attribution, insert.insertId, "");
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
        finally { connection.release(); }
        const [created] = await pool.execute("SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, is_admin, email_verified, is_rider FROM users WHERE id = ?", [insert.insertId]);
        row = created[0];
      }
      if (row.supabase_auth_id && String(row.supabase_auth_id) !== String(claims.sub)) return response.status(409).json({ error: "This email is linked to a different sign-in account." });
      if (!row.email_verified || !row.supabase_auth_id) {
        await pool.execute("UPDATE users SET email_verified=TRUE,supabase_auth_id=COALESCE(supabase_auth_id,?) WHERE id=?", [claims.sub, row.id]);
        await recordEmailVerification(pool, row.id, "google", email, jwtSecret);
        row.email_verified = 1;
        row.supabase_auth_id = row.supabase_auth_id || claims.sub;
      }
      await recordReferralEvent(pool, row.id, "account_verified", `account-verified:${row.id}`, { source: "google_verified_email" }).catch(error => console.error("Recording verified referral event failed:", String(error?.code || "database_error").slice(0, 80)));
      const user = publicUser(row);
      return response.status(200).json(signIn(response, user));
    } catch (error) {
      console.error("Google sign-in failed:", error.message);
      return response.status(502).json({ error: "Unable to sign in with Google." });
    }
  });

  router.post("/paystack/subaccount", authenticate, requirePaystackMode, async (request, response) => {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return response.status(503).json({ error: "Paystack payouts are not configured." });
    let bankName;
    let accountNumber;
    try {
      const [payoutRows] = await pool.execute("SELECT bank_name, account_number FROM users WHERE id = ? LIMIT 1", [request.user.id]);
      bankName = payoutRows[0]?.bank_name || "";
      accountNumber = payoutRows[0]?.account_number || "";
    } catch (error) {
      console.error("Unable to load payout details:", error.message);
      return response.status(500).json({ error: "Unable to load payout details." });
    }
    if (!bankName || !/^\d{10}$/.test(accountNumber)) return response.status(400).json({ error: "Add valid bank account details before enabling payouts." });
    try {
      const banksResponse = await fetch("https://api.paystack.co/bank?country=nigeria&perPage=1000", { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000) });
      const banks = await banksResponse.json();
      if (!banksResponse.ok || !banks.status || !Array.isArray(banks.data)) throw new Error("Unable to load Paystack's live bank list.");
      const normalized = bankName.toLowerCase().replace(/\b(bank|plc|limited|ltd)\b/g, "").replace(/[^a-z0-9]/g, "");
      const matches = banks.data.filter((bank) => String(bank.name).toLowerCase().replace(/\b(bank|plc|limited|ltd)\b/g, "").replace(/[^a-z0-9]/g, "") === normalized);
      if (matches.length !== 1) return response.status(400).json({ error: matches.length ? "Bank name matches more than one Paystack entry. Update the bank name to match Paystack's list." : "Bank name was not found in Paystack's live bank list." });
      const accountResponse = await fetch(`https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(matches[0].code)}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000) });
      const resolvedAccount = await accountResponse.json();
      if (!accountResponse.ok || !resolvedAccount.status || !resolvedAccount.data?.account_name) return response.status(400).json({ error: "Paystack could not verify that account number for the selected bank." });
      if (request.user.subaccountCode) {
        const [existing] = await pool.execute("SELECT account_number FROM users WHERE id = ?", [request.user.id]);
        if (existing[0]?.account_number !== accountNumber) return response.status(409).json({ error: "A payout subaccount already exists. Contact support to change the payout account." });
        return response.status(200).json({ subaccountCode: request.user.subaccountCode, accountName: resolvedAccount.data.account_name, bankName: matches[0].name, accountLast4: accountNumber.slice(-4) });
      }
      const subaccountResponse = await fetch("https://api.paystack.co/subaccount", {
        method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ business_name: request.user.brand || request.user.name, bank_code: matches[0].code, account_number: accountNumber, percentage_charge: 0 }),
        signal: AbortSignal.timeout(10000)
      });
      const subaccount = await subaccountResponse.json();
      if (!subaccountResponse.ok || !subaccount.status || !subaccount.data?.subaccount_code) {
        console.error("Paystack subaccount setup failed:", subaccount.message || subaccountResponse.status);
        return response.status(502).json({ error: "Paystack could not register this payout account." });
      }
      await pool.execute("UPDATE users SET subaccount_code = ? WHERE id = ?", [subaccount.data.subaccount_code, request.user.id]);
      return response.status(200).json({ subaccountCode: subaccount.data.subaccount_code, accountName: resolvedAccount.data.account_name, bankName: matches[0].name, accountLast4: accountNumber.slice(-4) });
    } catch (error) {
      console.error("Paystack subaccount setup failed:", error.message);
      return response.status(502).json({ error: "Unable to register the payout account with Paystack." });
    }
  });

  return { router, authenticate };
}

module.exports = { createAuth };
