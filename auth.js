"use strict";

const bcrypt = require("bcryptjs");
const express = require("express");
const jwt = require("jsonwebtoken");
const { z } = require("zod");

const emailSchema = z.string().trim().email("Enter a valid email address.").max(254).transform((value) => value.toLowerCase());
const passwordSchema = z.string().min(8, "Password must be at least 8 characters.").refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password is too long.");
const signupSchema = z.object({
  name: z.string().trim().min(1).max(120), phone: z.string().trim().min(1).max(40),
  brand: z.string().trim().max(160).optional().default(""),
  bankName: z.string().trim().min(1).max(120), accountNumber: z.string().trim().min(1).max(40),
  email: emailSchema, password: passwordSchema
}).strict();

function publicUser(row) {
  return {
    id: String(row.id), name: row.name, phone: row.phone || "", brand: row.brand || "",
    bankName: row.bank_name || "", accountNumber: "",
    subaccountCode: row.subaccount_code || "", email: row.email, isAdmin: Boolean(row.is_admin),
    emailVerified: Boolean(row.email_verified)
  };
}

function createAuth({ pool, jwtSecret, jwtExpiresIn = "1h", supabaseAuth, supabaseAdmin }) {
  if (!pool || !jwtSecret) throw new Error("Authentication database and JWT secret are required.");
  const router = express.Router();

  function issueToken(user) {
    return jwt.sign({ sub: String(user.id) }, jwtSecret, {
      algorithm: "HS256", expiresIn: jwtExpiresIn, issuer: "shedshare-api", audience: "shedshare-web"
    });
  }

  async function authenticate(request, response, next) {
    const match = (request.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return response.status(401).json({ error: "Authentication required." });
    try {
      const payload = jwt.verify(match[1], jwtSecret, { algorithms: ["HS256"], issuer: "shedshare-api", audience: "shedshare-web" });
      if (!/^\d+$/.test(String(payload.sub || ""))) return response.status(401).json({ error: "Invalid or expired token." });
      const [rows] = await pool.execute(
        `SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, is_admin, email_verified FROM users WHERE id = ? LIMIT 1`, [payload.sub]
      );
      if (!rows.length) return response.status(401).json({ error: "Invalid or expired token." });
      request.user = publicUser(rows[0]);
      return next();
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) return response.status(401).json({ error: "Invalid or expired token." });
      console.error("Authentication failed:", error.message);
      return response.status(500).json({ error: "Unable to authenticate request." });
    }
  }

  router.post("/signup", async (request, response) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
      if (!supabaseAuth || !supabaseAdmin) return response.status(503).json({ error: "Email verification is not configured. Please try again later." });

    const data = parsed.data;
    try {
      const passwordHash = await bcrypt.hash(data.password, 12);
      const [existingRows] = await pool.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [data.email]);
      if (existingRows.length) return response.status(409).json({ error: "An account with that email already exists." });
      const { data: authSignup, error } = await supabaseAuth.auth.signUp({ email: data.email, password: data.password, options: { emailRedirectTo: process.env.EMAIL_VERIFICATION_REDIRECT_URL || undefined } });
      if (error) {
        if (/already registered|already exists/i.test(error.message)) return response.status(409).json({ error: "An account with that email already exists." });
        console.error("Email verification signup failed:", error.message);
        return response.status(502).json({ error: "Unable to send verification email." });
      }
      if (!authSignup.user) return response.status(502).json({ error: "Unable to create account." });
      if (authSignup.user.identities && authSignup.user.identities.length === 0) return response.status(409).json({ error: "An account with that email already exists." });
      let result;
      try {
        [result] = await pool.execute(
        `INSERT INTO users (name, phone, brand, bank_name, account_number, email, password_hash, email_verified, supabase_auth_id) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?)`,
        [data.name, data.phone, data.brand || null, data.bankName, data.accountNumber, data.email, passwordHash, authSignup.user.id]
        );
      } catch (error) {
        await supabaseAdmin.auth.admin.deleteUser(authSignup.user.id);
        throw error;
      }
      return response.status(201).json({ requiresEmailVerification: true, email: data.email, userId: String(result.insertId), message: "Check your email for a verification link before signing in." });
    } catch (error) {
      if (error && error.code === "ER_DUP_ENTRY") return response.status(409).json({ error: "An account with that email already exists." });
      console.error("Signup failed:", error.message);
      return response.status(500).json({ error: "Unable to create account." });
    }
  });

  router.post("/login", async (request, response) => {
    const parsed = z.object({ email: emailSchema, password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
    try {
      const [rows] = await pool.execute(
        `SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, password_hash, is_admin, email_verified FROM users WHERE email = ? LIMIT 1`, [parsed.data.email]
      );
      const row = rows[0];
      if (!row || !(await bcrypt.compare(parsed.data.password, row.password_hash))) return response.status(401).json({ error: "Invalid email or password." });
      if (!row.email_verified) return response.status(403).json({ error: "Verify your email before signing in." });
      if (row.supabase_auth_id && supabaseAdmin) {
        const { data: providerUser, error: providerError } = await supabaseAdmin.auth.admin.getUserById(row.supabase_auth_id);
        if (providerError || !providerUser.user?.email_confirmed_at) return response.status(403).json({ error: "Verify your email before signing in." });
      }
      const user = publicUser(row);
      return response.status(200).json({ token: issueToken(user), user });
    } catch (error) {
      console.error("Login failed:", error.message);
      return response.status(500).json({ error: "Unable to sign in." });
    }
  });

  router.post("/refresh-verification", async (request, response) => {
    const parsed = z.object({ email: emailSchema }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid email address." });
    if (!supabaseAuth) return response.status(503).json({ error: "Email verification is not configured." });
    try {
      const { error } = await supabaseAuth.auth.resend({ type: "signup", email: parsed.data.email, options: { emailRedirectTo: process.env.EMAIL_VERIFICATION_REDIRECT_URL || undefined } });
      if (error) throw error;
      return response.status(200).json({ message: "If the account is awaiting verification, a new link has been sent." });
    } catch (error) {
      console.error("Resending verification failed:", error.message);
      return response.status(502).json({ error: "Unable to resend the verification email." });
    }
  });

  router.post("/confirm-email", async (request, response) => {
    if (!supabaseAuth || !supabaseAdmin) return response.status(503).json({ error: "Email verification is not configured." });
    const tokenHash = request.body?.token_hash;
    const accessToken = request.body?.access_token;
    if ((!tokenHash || typeof tokenHash !== "string" || tokenHash.length > 2048) && (!accessToken || typeof accessToken !== "string" || accessToken.length > 4096)) return response.status(400).json({ error: "Verification token is required." });
    try {
      const verification = tokenHash
        ? await supabaseAuth.auth.verifyOtp({ token_hash: tokenHash, type: "email" })
        : await supabaseAuth.auth.getUser(accessToken);
      if (verification.error || !verification.data.user?.email) return response.status(400).json({ error: "This verification link is invalid or has expired." });
      const { data: adminData, error: adminError } = await supabaseAdmin.auth.admin.getUserById(verification.data.user.id);
      if (adminError || !adminData.user?.email_confirmed_at) return response.status(400).json({ error: "Email confirmation has not completed." });
      const [result] = await pool.execute("UPDATE users SET email_verified = TRUE WHERE email = ? AND supabase_auth_id = ?", [verification.data.user.email.toLowerCase(), verification.data.user.id]);
      if (!result.affectedRows) return response.status(404).json({ error: "Account not found." });
      return response.status(200).json({ message: "Email verified. You can now sign in." });
    } catch (error) {
      console.error("Email verification failed:", error.message);
      return response.status(500).json({ error: "Unable to verify email." });
    }
  });

  router.post("/google", async (request, response) => {
    const credential = request.body?.credential;
    if (!process.env.GOOGLE_CLIENT_ID) return response.status(503).json({ error: "Google sign-in is not configured." });
    if (typeof credential !== "string" || credential.length > 10000) return response.status(400).json({ error: "Google credential is required." });
    try {
      const verifyUrl = new URL("https://oauth2.googleapis.com/tokeninfo");
      verifyUrl.searchParams.set("id_token", credential);
      const result = await fetch(verifyUrl, { signal: AbortSignal.timeout(8000) });
      if (!result.ok) return response.status(401).json({ error: "Invalid Google sign-in credential." });
      const claims = await result.json();
      if (claims.aud !== process.env.GOOGLE_CLIENT_ID || claims.email_verified !== "true" || !claims.email) return response.status(401).json({ error: "Google account email is not verified." });
      const email = String(claims.email).toLowerCase();
      const [rows] = await pool.execute("SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, is_admin, email_verified FROM users WHERE email = ? LIMIT 1", [email]);
      let row = rows[0];
      if (!row) {
        const [insert] = await pool.execute(
          "INSERT INTO users (name, phone, brand, bank_name, account_number, email, password_hash, email_verified, supabase_auth_id) VALUES (?, '', NULL, '', '', ?, '', TRUE, ?)",
          [String(claims.name || email.split("@")[0]).slice(0, 120), email, claims.sub]
        );
        const [created] = await pool.execute("SELECT id, name, phone, brand, bank_name, account_number, subaccount_code, email, is_admin, email_verified FROM users WHERE id = ?", [insert.insertId]);
        row = created[0];
      } else if (!row.email_verified) {
        await pool.execute("UPDATE users SET email_verified = TRUE, supabase_auth_id = COALESCE(supabase_auth_id, ?) WHERE id = ?", [claims.sub, row.id]);
        row.email_verified = 1;
      }
      if (row.supabase_auth_id && String(row.supabase_auth_id) !== String(claims.sub)) return response.status(409).json({ error: "This email is linked to a different sign-in account." });
      if (!row.supabase_auth_id) {
        await pool.execute("UPDATE users SET supabase_auth_id = ? WHERE id = ?", [claims.sub, row.id]);
        row.supabase_auth_id = claims.sub;
      }
      if (row.supabase_auth_id && String(row.supabase_auth_id) !== String(claims.sub)) return response.status(409).json({ error: "This email is linked to a different sign-in account." });
      if (!row.supabase_auth_id) {
        await pool.execute("UPDATE users SET supabase_auth_id = ? WHERE id = ?", [claims.sub, row.id]);
        row.supabase_auth_id = claims.sub;
      }
      const user = publicUser(row);
      return response.status(200).json({ token: issueToken(user), user });
    } catch (error) {
      console.error("Google sign-in failed:", error.message);
      return response.status(502).json({ error: "Unable to sign in with Google." });
    }
  });

  router.post("/paystack/subaccount", authenticate, async (request, response) => {
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
