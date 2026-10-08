"use strict";

require("dotenv").config();

const express = require("express");
const mysql = require("mysql2/promise");
const { createClient } = require("@supabase/supabase-js");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createAuth } = require("./auth");
const { createItemsRouter } = require("./items");
const { createRentalsRouter } = require("./rentals");
const { createMediaUploadsRouter } = require("./mediaUploads");
const { createPaymentWebhookRouter } = require("./payments");

const requiredVariables = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "JWT_SECRET"];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);
if (missingVariables.length) throw new Error(`Missing required environment variables: ${missingVariables.join(", ")}`);
if (process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters.");
if (process.env.NODE_ENV === "production") {
  if (!process.env.ALLOWED_ORIGINS) throw new Error("ALLOWED_ORIGINS must contain the deployed frontend origin in production.");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Complete Supabase URL, anon key, and service role key are required in production.");
  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is required in production.");
  if ([process.env.JWT_SECRET, process.env.DB_PASSWORD, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.PAYSTACK_SECRET_KEY].some((value) => /replace_with|your-project|sk_test_replace/i.test(value || ""))) throw new Error("Replace all example secrets and credentials before production startup.");
  for (const origin of process.env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)) {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "https:") throw new Error("Every ALLOWED_ORIGINS entry must use HTTPS in production.");
  }
}

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid TCP port.");
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5.");
const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  waitForConnections: true, queueLimit: 0, timezone: "Z"
});
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const supabaseAdmin = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", trustProxyHops);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
for (const origin of allowedOrigins) {
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch (_error) { throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`); }
  if (!new Set(["http:", "https:"]).has(parsedOrigin.protocol) || parsedOrigin.origin !== origin) throw new Error(`ALLOWED_ORIGINS entries must be bare HTTP(S) origins: ${origin}`);
}
app.use((request, response, next) => {
  const origin = request.get("origin");
  if (!origin) return next();
  if (!allowedOrigins.has(origin)) return response.status(403).json({ error: "This website is not allowed to access the API." });
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, PUT, OPTIONS");
  if (request.method === "OPTIONS") return response.sendStatus(204);
  return next();
});
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/payments", createPaymentWebhookRouter({ pool }));
app.use(express.json({ limit: "1mb" }));
const auth = createAuth({ pool, jwtSecret: process.env.JWT_SECRET, jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1h", supabaseAuth: supabase, supabaseAdmin });
app.use("/api/auth", auth.router);
app.locals.authenticate = auth.authenticate;

if (supabase && process.env.SUPABASE_SERVICE_ROLE_KEY) app.use("/api/items", createMediaUploadsRouter({ pool, supabase: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }), authenticate: auth.authenticate }));
else app.use("/api/items", (request, response, next) => {
  if (["POST", "PATCH"].includes(request.method) && request.body && ["image", "video"].some((key) => typeof request.body[key] === "string" && /^data:/i.test(request.body[key]))) {
    return response.status(503).json({ error: "Image and video storage is not configured. Set Supabase Storage credentials before uploading media." });
  }
  next();
});

app.use("/api/items", (request, response, next) => {
  if (["POST", "PATCH"].includes(request.method) && request.body && typeof request.body.video === "string" && /^data:/i.test(request.body.video)) {
    return response.status(400).json({ error: "Upload item videos through the authenticated video upload endpoint." });
  }
  return next();
});
app.use("/api/items", createItemsRouter({ pool, authenticate: auth.authenticate }));
app.use("/api", createRentalsRouter({ pool, authenticate: auth.authenticate }));

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    const configured = Boolean(supabase && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_STORAGE_BUCKET && process.env.EMAIL_VERIFICATION_REDIRECT_URL);
    const paymentsConfigured = Boolean(process.env.PAYSTACK_SECRET_KEY);
    const healthy = process.env.NODE_ENV !== "production" || (configured && paymentsConfigured && allowedOrigins.size > 0);
    response.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "incomplete", database: "connected", storageAndEmailConfigured: configured, paystackConfigured: paymentsConfigured, corsConfigured: allowedOrigins.size > 0 });
  } catch (error) { console.error("Database health check failed:", error.message); response.status(503).json({ status: "unavailable", database: "disconnected" }); }
});
app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) return response.status(400).json({ error: "Invalid JSON request body." });
  console.error("Unhandled API error:", error.message);
  return response.status(500).json({ error: "An unexpected server error occurred." });
});

const server = app.listen(port, () => console.log(`ShedShare API listening on port ${port}`));
async function shutDown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close(async () => { try { await pool.end(); process.exit(0); } catch (error) { console.error("Shutdown failed:", error.message); process.exit(1); } });
}
process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));
