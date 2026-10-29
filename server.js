"use strict";

require("dotenv").config();
// A host may export these as empty strings; let the local .env pair fill those blanks.
if (!process.env.WEB_PUSH_PUBLIC_KEY || !process.env.WEB_PUSH_PRIVATE_KEY) {
  try {
    const localPushConfig = require("dotenv").parse(require("node:fs").readFileSync(require("node:path").join(__dirname, ".env"), "utf8"));
    for (const key of ["WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY"]) if (!process.env[key]) process.env[key] = localPushConfig[key] || "";
  } catch (_error) { /* Production hosts provide push keys through their environment. */ }
}

const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const mysql = require("mysql2/promise");
const { createClient } = require("@supabase/supabase-js");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const webpush = require("web-push");
const { createAuth } = require("./auth");
const { createItemsRouter } = require("./items");
const { createRentalsRouter } = require("./rentals");
const { createMediaUploadsRouter } = require("./mediaUploads");
const { createVideoUploadsRouter } = require("./videoUploads");
const { createPaymentWebhookRouter } = require("./payments");
const { createWorkflowRouter } = require("./workflows");
const { createChatRouter } = require("./chat");
const { createDispatchRouter } = require("./dispatch");
const { createAdminRouter } = require("./admin");
const { createLocationsRouter } = require("./locations");
const { createExternalSearchRouter } = require("./external-search");
const { createReferralRouter } = require("./referrals");
const { privacyAndTermsNotice } = require("./privacy");
const deliveryConfig = require("./delivery-config");
const externalSearchConfig = require("./external-search-config");
const { isHttpsUrl, productionReadinessErrors } = require("./production-readiness");
const { createCsrfProtection, issueCsrfToken } = require("./security-cookies");
const { createSecurityEvents } = require("./security-events");
const { createAiRouter, getAiControlState } = require("./ai");
const { createTestimonialsRouter } = require("./testimonials");
const { getGoogleMapsPlacesServerKey, getGeocodingConfig } = require("./map-config");
const { getPaymentMode, paystackConfigurationError } = require("./payment-mode");


const requiredVariables = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "JWT_SECRET"];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);
if (missingVariables.length) throw new Error(`Missing required environment variables: ${missingVariables.join(", ")}`);
if (process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters.");
if (process.env.NODE_ENV === "production") {
  const productionErrors = productionReadinessErrors(process.env);
  if (productionErrors.length) throw new Error(`Production configuration is incomplete:\n- ${productionErrors.join("\n- ")}`);
}
const authMode = (process.env.AUTH_MODE || "supabase").toLowerCase();
if (!["local", "supabase"].includes(authMode)) throw new Error("AUTH_MODE must be either local or supabase.");

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
const securityEvents = createSecurityEvents({ pool });
app.disable("x-powered-by");
app.set("trust proxy", trustProxyHops);
// A per-response nonce is shared with dynamically loaded map library assets.
app.use((request, response, next) => {
  response.locals.cspNonce = crypto.randomBytes(18).toString("base64");
  next();
});
const supabaseOrigin = (() => {
  try { return new URL(process.env.SUPABASE_URL).origin; } catch (_error) { return null; }
})();
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    reportOnly: true, // Change to false after reviewing browser reports and completing the CSP checklist.
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (request, response) => `'nonce-${response.locals.cspNonce}'`, "'strict-dynamic'", "'unsafe-eval'", "blob:", "https://accounts.google.com", "https://unpkg.com"],
      styleSrc: ["'self'", (request, response) => `'nonce-${response.locals.cspNonce}'`, "https://fonts.googleapis.com", "https://accounts.google.com/gsi/style", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "blob:", ...(supabaseOrigin ? [supabaseOrigin] : []), "https://maps.geoapify.com", "https://unpkg.com", "https://*.googleapis.com", "https://*.gstatic.com", "https://*.google.com", "https://*.googleusercontent.com", "https://*.ggpht.com", "https://picsum.photos"],
      connectSrc: ["'self'", "data:", "blob:", ...(supabaseOrigin ? [supabaseOrigin] : []), "https://accounts.google.com/gsi/", "https://*.googleapis.com", "https://*.google.com", "https://*.gstatic.com"],
      frameSrc: ["'self'", "https://accounts.google.com/gsi/", "https://*.google.com", "https://checkout.paystack.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      mediaSrc: ["'self'", "data:", "blob:", ...(supabaseOrigin ? [supabaseOrigin] : []), "https://interactive-examples.mdn.mozilla.net"],
      workerSrc: ["'self'", "blob:"],
      formAction: ["'self'", "https://checkout.paystack.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      reportUri: ["/csp-report"]
    }
  }
}));
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean));
for (const origin of allowedOrigins) {
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch (_error) { throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`); }
  if (!new Set(["http:", "https:"]).has(parsedOrigin.protocol) || parsedOrigin.origin !== origin) throw new Error(`ALLOWED_ORIGINS entries must be bare HTTP(S) origins: ${origin}`);
}
// In production, redirect only to a preconfigured HTTPS origin so an untrusted Host header cannot choose the redirect destination.
app.use((request, response, next) => {
  if (process.env.NODE_ENV !== "production" || request.secure) return next();
  const requestHost = String(request.get("host") || "").toLowerCase();
  const secureOrigin = [...allowedOrigins].find((origin) => {
    try { return new URL(origin).host.toLowerCase() === requestHost && new URL(origin).protocol === "https:"; }
    catch (_error) { return false; }
  });
  if (!secureOrigin) return response.status(400).json({ error: "HTTPS is required and this host is not configured." });
  return response.redirect(308, `${secureOrigin}${request.originalUrl}`);
});
app.use((request, response, next) => {
  const origin = request.get("origin");
  if (!origin) return next();
  const requestOrigin = `${request.protocol}://${request.get("host")}`;
  if (origin !== requestOrigin && !allowedOrigins.has(origin)) return response.status(403).json({ error: "This website is not allowed to access the API." });
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, PUT, OPTIONS");
  if (request.method === "OPTIONS") return response.sendStatus(204);
  return next();
});
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests. Wait a minute and try again." } }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, limit: 60, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many unsuccessful sign-in attempts. Wait a few minutes and try again." } }));
// The webhook is mounted before express.json() to retain the raw body for HMAC verification;
// protect it here because the general API limiter is mounted later in the stack.
app.use("/api/payments", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many payment requests. Try again shortly." } }));
app.use("/api/payments", createPaymentWebhookRouter({ pool, securityEvents }));
app.use(express.json({ limit: "1mb" }));
// CSP reports come from browsers, use either the legacy CSP report shape or JSON Reporting API shape.
app.post("/csp-report", express.json({ type: ["application/csp-report", "application/json"], limit: "16kb" }), (request, response) => {
  const body = request.body || {};
  const report = body["csp-report"] || body;
  const blockedValue = report["blocked-uri"] || report.blockedURL || report.blockedURLString || "unknown";
  let blocked = String(blockedValue).slice(0, 500);
  try { blocked = new URL(blocked).origin; } catch (_error) { /* Keep inline, eval, and other non-URL labels. */ }
  console.warn("CSP violation", JSON.stringify({
    directive: String(report["violated-directive"] || report.effectiveDirective || "unknown").slice(0, 120),
    blocked,
    document: (() => { try { return new URL(report["document-uri"] || report.documentURL).origin; } catch (_error) { return "unknown"; } })()
  }));
  return response.status(204).end();
});
const csrfProtection = createCsrfProtection({ allowedOrigins });
app.get("/api/csrf", (request, response) => response.json({ csrfToken: issueCsrfToken(request, response, process.env.NODE_ENV === "production") }));
// Paystack's webhook is mounted above and uses its HMAC signature; all browser API writes require CSRF and a trusted Origin/Referer.
app.use("/api", csrfProtection);
const auth = createAuth({ pool, jwtSecret: process.env.JWT_SECRET, jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1h", supabaseAuth: supabase, supabaseAdmin, authMode, securityEvents });
app.use("/api/auth", auth.router);
app.use("/api/referrals", createReferralRouter({ pool, authenticate: auth.authenticate }));
app.locals.authenticate = auth.authenticate;
const webPushConfigured = Boolean(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY);
async function notificationBadgeCount(userId, isAdmin) {
  const [unreadRows] = await pool.execute("SELECT COUNT(*) AS total FROM notifications WHERE user_id=? AND is_read=FALSE AND (?=FALSE OR type<>'rider_application_review')", [userId, Boolean(isAdmin)]);
  let pendingApprovals = 0;
  if (isAdmin) {
    const [pendingRows] = await pool.execute("SELECT COUNT(*) AS total FROM rider_profiles WHERE application_status='pending' AND is_approved=FALSE");
    pendingApprovals = Number(pendingRows[0]?.total || 0);
  }
  return { unreadCount: Number(unreadRows[0]?.total || 0), pendingApprovals, badgeCount: Number(unreadRows[0]?.total || 0) + pendingApprovals };
}
app.get("/api/notifications",auth.authenticate,async(req,res)=>{
  try {
    const [rows] = await pool.execute("SELECT id,type,message,related_id,is_read,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100", [req.user.id]);
    const counts = await notificationBadgeCount(req.user.id, req.user.isAdmin);
    return res.json({ ...counts, items: rows.map(row => ({ id:String(row.id), type:row.type, message:row.message, relatedId:row.related_id==null?null:String(row.related_id), isRead:Boolean(row.is_read), createdAt:new Date(row.created_at).toISOString() })) });
  } catch (e) { console.error("Loading notifications failed:",e.message); return res.status(500).json({error:"Unable to load notifications."}); }
});
app.post("/api/push-subscriptions",auth.authenticate,async(req,res)=>{
  const {z}=require("zod");
  const body=z.object({endpoint:z.string().url().max(2048).refine(value=>value.startsWith("https://")),keys:z.object({p256dh:z.string().min(40).max(128),auth:z.string().min(16).max(64)}).strict()}).strict().safeParse(req.body);
  if(!body.success)return res.status(400).json({error:"Invalid push subscription."});
  if(!webPushConfigured)return res.status(503).json({error:"Phone push notifications are not configured on this server yet."});
  try {
    const appUrl=new URL(req.get("origin")||"");
    if(appUrl.protocol!=="https:"&&!(appUrl.protocol==="http:"&&["localhost","127.0.0.1"].includes(appUrl.hostname)))return res.status(400).json({error:"Push subscriptions must come from ShedShare's secure website."});
    const applicationOrigin=appUrl.protocol==="http:"?"https://localhost/":appUrl.origin;
    const endpointHash=crypto.createHash("sha256").update(body.data.endpoint).digest("hex");
    await pool.execute("INSERT INTO push_subscriptions(user_id,application_origin,endpoint,endpoint_hash,p256dh_key,auth_key) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),application_origin=VALUES(application_origin),endpoint=VALUES(endpoint),p256dh_key=VALUES(p256dh_key),auth_key=VALUES(auth_key)",[req.user.id,applicationOrigin,body.data.endpoint,endpointHash,body.data.keys.p256dh,body.data.keys.auth]);
    await pool.execute("INSERT INTO user_notification_preferences(user_id,in_app,email,push) VALUES(?,TRUE,FALSE,TRUE) ON DUPLICATE KEY UPDATE push=TRUE",[req.user.id]);
    return res.status(201).json({subscribed:true});
  } catch(e) { console.error("Saving push subscription failed:",e.message); return res.status(500).json({error:"Unable to enable phone notifications."}); }
});
app.delete("/api/push-subscriptions",auth.authenticate,async(req,res)=>{
  const {z}=require("zod"); const body=z.object({endpoint:z.string().url().max(2048)}).strict().safeParse(req.body);
  if(!body.success)return res.status(400).json({error:"Invalid push subscription."});
  try { const hash=crypto.createHash("sha256").update(body.data.endpoint).digest("hex"); await pool.execute("DELETE FROM push_subscriptions WHERE user_id=? AND endpoint_hash=?",[req.user.id,hash]); await pool.execute("UPDATE user_notification_preferences SET push=FALSE WHERE user_id=?",[req.user.id]); return res.json({subscribed:false}); }
  catch(e) { console.error("Removing push subscription failed:",e.message); return res.status(500).json({error:"Unable to turn off phone notifications."}); }
});
app.get("/api/notification-preferences",auth.authenticate,async(req,res)=>{try{const [rows]=await pool.execute("SELECT in_app,email,push FROM user_notification_preferences WHERE user_id=?",[req.user.id]);const [subs]=await pool.execute("SELECT id FROM push_subscriptions WHERE user_id=? LIMIT 1",[req.user.id]);const row=rows[0]||{in_app:1,email:0,push:0};return res.json({inApp:Boolean(row.in_app),email:Boolean(row.email),push:Boolean(row.push&&subs.length),emailAvailable:Boolean(process.env.EMAIL_PROVIDER_URL&&process.env.EMAIL_PROVIDER_API_KEY),pushAvailable:webPushConfigured});}catch(e){console.error("Loading notification preferences failed:",e.message);return res.status(500).json({error:"Unable to load notification preferences."});}});
app.put("/api/notification-preferences",auth.authenticate,async(req,res)=>{const {z}=require("zod");const body=z.object({inApp:z.boolean(),email:z.boolean(),push:z.boolean()}).strict().safeParse(req.body);if(!body.success)return res.status(400).json({error:"Choose valid notification preferences."});try{const [subs]=await pool.execute("SELECT id FROM push_subscriptions WHERE user_id=? LIMIT 1",[req.user.id]);if(body.data.push&&(!webPushConfigured||!subs.length))return res.status(409).json({error:"Enable phone notifications on this device first."});await pool.execute("INSERT INTO user_notification_preferences(user_id,in_app,email,push) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE in_app=VALUES(in_app),email=VALUES(email),push=VALUES(push)",[req.user.id,body.data.inApp,body.data.email&&Boolean(process.env.EMAIL_PROVIDER_URL&&process.env.EMAIL_PROVIDER_API_KEY),body.data.push]);return res.json({inApp:body.data.inApp,email:body.data.email&&Boolean(process.env.EMAIL_PROVIDER_URL&&process.env.EMAIL_PROVIDER_API_KEY),push:body.data.push,emailAvailable:Boolean(process.env.EMAIL_PROVIDER_URL&&process.env.EMAIL_PROVIDER_API_KEY),pushAvailable:webPushConfigured&&Boolean(subs.length)});}catch(e){console.error("Saving notification preferences failed:",e.message);return res.status(500).json({error:"Unable to save notification preferences."});}});
// Register before the /api routers so their not-found handlers cannot swallow this public config endpoint.
app.get("/api/config", async (_request, response) => {
  let mapsEnabled = false;
  try {
    const [rows] = await pool.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='maps_enabled' LIMIT 1");
    mapsEnabled = rows[0]?.setting_value === "1";
  } catch (_error) { /* Missing settings table keeps maps disabled by default. */ }
  const mapsBrowserKey = mapsEnabled ? (process.env.GEOAPIFY_MAPS_BROWSER_KEY || "") : "";
  const geocodingConfig = mapsEnabled ? getGeocodingConfig() : { provider: "none", key: "" };
  const mapsDiagnostic = !mapsBrowserKey ? "Map unavailable: add GEOAPIFY_MAPS_BROWSER_KEY to the server .env and restrict it to your website origin." : !geocodingConfig.key ? "Map display can load, but address lookup needs GOOGLE_MAPS_SERVER_KEY or GEOAPIFY_API_KEY in the server environment." : "";
  const externalSearchEnabled = mapsEnabled && externalSearchConfig.enabled;
  const minListingsForExternal = externalSearchConfig.minListings;
  const externalSearchDiagnostic = !mapsEnabled ? "Nearby business search is off because Geoapify maps are turned off in admin settings." : !externalSearchEnabled ? "External business search is disabled. Set EXTERNAL_SEARCH_ENABLED=true to enable it." : !getGoogleMapsPlacesServerKey() ? "External business search is enabled but GOOGLE_MAPS_PLACES_SERVER_KEY is missing." : "External search is enabled. If search fails, check the Places API key restrictions and daily quota.";
  const aiSettings = await getAiControlState(pool);
   const cloudinaryPhoto= require("./cloudinary-photo").cloudinaryConfig();
   response.json({ googleClientId: authMode === "local" ? "" : (process.env.GOOGLE_CLIENT_ID || ""), mapsEnabled, mapTilesKey:mapsBrowserKey, mapsDiagnostic: mapsEnabled ? mapsDiagnostic : "Maps are turned off by the ShedShare administrator.", authMode, paymentMode:getPaymentMode(), paystackAvailable:getPaymentMode()==="paystack"&&!paystackConfigurationError(), externalSearchEnabled, minListingsForExternal, externalSearchDiagnostic, aiAvailable: aiSettings.enabled, cloudinaryPhotoEnhancementAvailable:cloudinaryPhoto.enabled, cloudinaryPhotoEnhancementConfigured:cloudinaryPhoto.configured, privacyAndTermsNotice:privacyAndTermsNotice(),emailNotificationsConfigured:Boolean(process.env.EMAIL_PROVIDER_URL&&process.env.EMAIL_PROVIDER_API_KEY),pushNotificationsConfigured:webPushConfigured,pushPublicKey:webPushConfigured?process.env.WEB_PUSH_PUBLIC_KEY:"" });
});
app.use("/api/ai", createAiRouter({ authenticate: auth.authenticate, pool }));
app.use("/api", createTestimonialsRouter({ pool, authenticate: auth.authenticate }));
app.use("/api/trust", require("./rental-trust").createRentalTrustRouter({pool,authenticate:auth.authenticate}));
app.get("/privacy",(_req,res)=>res.type("text/plain").send(privacyAndTermsNotice()));
app.get("/terms",(_req,res)=>res.type("text/plain").send(privacyAndTermsNotice()));

app.use("/api/items", require("./cloudinary-photo").createCloudinaryPhotoRouter({pool,authenticate:auth.authenticate}));
if (supabase && process.env.SUPABASE_SERVICE_ROLE_KEY) app.use("/api/items", createMediaUploadsRouter({ pool, supabase: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }), authenticate: auth.authenticate }));
else app.use("/api/items", (request, response, next) => {
  if (["POST", "PATCH"].includes(request.method) && request.body && ["image", "video"].some((key) => typeof request.body[key] === "string" && /^data:/i.test(request.body[key]))) {
    return response.status(503).json({ error: "Image and video storage is not configured. Set Supabase Storage credentials before uploading media." });
  }
  next();
});

app.use("/api/items", createVideoUploadsRouter({ pool, supabase: supabaseAdmin, authenticate: auth.authenticate }));

app.use("/api/items", (request, response, next) => {
  if (["POST", "PATCH"].includes(request.method) && request.body && typeof request.body.video === "string" && /^data:/i.test(request.body.video)) {
    return response.status(400).json({ error: "Upload item videos through the authenticated video upload endpoint." });
  }
  return next();
});
app.use("/api/items", createItemsRouter({ pool, authenticate: auth.authenticate, supabase: supabaseAdmin }));
app.use("/api", createRentalsRouter({ pool, authenticate: auth.authenticate }));
app.use("/api", require("./event-plans").createEventPlansRouter({ pool, authenticate: auth.authenticate }));
app.use("/api", createWorkflowRouter({ pool, authenticate: auth.authenticate, supabase: supabaseAdmin }));
app.use("/api", createChatRouter({ pool, authenticate: auth.authenticate, supabase: supabaseAdmin }));
app.use("/api", createDispatchRouter({ pool, authenticate: auth.authenticate, supabase: supabaseAdmin }));
app.use("/api/manual-payments", require("./manual-payments").createManualPaymentsRouter({ pool, authenticate: auth.authenticate }));
app.use("/api/admin", createAdminRouter({ pool, authenticate: auth.authenticate, securityEvents, supabase: supabaseAdmin }));
const requireMapsEnabled = async (_request, response, next) => {
  try {
    const [rows] = await pool.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='maps_enabled' LIMIT 1");
    if (rows[0]?.setting_value !== "1") return response.status(503).json({ error: "Map features are currently turned off by the ShedShare administrator." });
    return next();
  } catch (_error) { return response.status(503).json({ error: "Map features are currently unavailable." }); }
};
const geocodingConfig = getGeocodingConfig();
app.use("/api/locations", requireMapsEnabled, createLocationsRouter({ pool, authenticate: auth.authenticate, geocodingProvider: geocodingConfig.provider, serverKey: geocodingConfig.key }));
app.use("/api/external-search", requireMapsEnabled, createExternalSearchRouter({ pool, authenticate: auth.authenticate, placesKey: getGoogleMapsPlacesServerKey(), enabled: externalSearchConfig.enabled, minListings: externalSearchConfig.minListings, maxPerDay: externalSearchConfig.maxPerUserPerDay }));

const deliveryFallbackTimer = setInterval(async () => {
  try {
    const [expired] = await pool.execute("UPDATE deliveries SET status='fallback_available' WHERE status='awaiting_rider' AND rider_id IS NULL AND offer_expires_at<=UTC_TIMESTAMP()");
    if (expired.affectedRows) {
      const [rows] = await pool.execute("SELECT d.id,d.rental_id,r.renter_id,r.owner_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.status='fallback_available' AND d.updated_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE)");
      for (const row of rows) await pool.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?),(?,?,?,?)", [row.renter_id,"delivery_fallback","No rider accepted within the configured offer period. Choose Pickup or Owner delivers.",row.rental_id,row.owner_id,"delivery_fallback","No rider accepted. Contact the renter to arrange Pickup or Owner delivers.",row.rental_id]);
    }
    await pool.execute("DELETE FROM rider_online_locations WHERE updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? SECOND)", [deliveryConfig.locationStaleAfterSeconds]);
  } catch (error) { console.error("Delivery offer expiry check failed:", error.message); }
}, 30_000);
deliveryFallbackTimer.unref();

const chatRetentionTimer = setInterval(async () => {
  try { await pool.execute("DELETE FROM chat_messages WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MONTH)", [require("./chat-config").retentionMonths]); }
  catch (error) { console.error("Chat retention cleanup failed:", error.message); }
}, 24 * 60 * 60_000);
chatRetentionTimer.unref();

const rentalSchedulerTimer=setInterval(async()=>{
  try{
    const [expired]=await pool.execute("UPDATE rentals SET status='cancelled' WHERE status='pending_payment' AND payment_reference IS NOT NULL AND payment_verified_at IS NULL AND checkout_expires_at IS NOT NULL AND checkout_expires_at<=UTC_TIMESTAMP()");
    if(expired.affectedRows)console.log(`Expired ${expired.affectedRows} unpaid checkout reservations.`);
    const [upcoming]=await pool.execute("SELECT r.id,r.renter_id,r.owner_id,r.item_name,r.end_at FROM rentals r WHERE r.status='active' AND r.end_at BETWEEN UTC_TIMESTAMP() AND DATE_ADD(UTC_TIMESTAMP(),INTERVAL 24 HOUR) AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.type='return_reminder' AND n.related_id=r.id AND n.created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 12 HOUR))");
    for(const r of upcoming)await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'return_reminder',?,?),(?,'return_reminder',?,?)",[r.renter_id,`Return reminder: ${r.item_name} is due by ${new Date(r.end_at).toISOString()}.`,r.id,r.owner_id,`Return reminder: ${r.item_name} is due within 24 hours.`,r.id]);
  }catch(e){console.error("Rental reminder and checkout expiry job failed:",e.message);}
},60_000);
rentalSchedulerTimer.unref();

const pushQueueTimer=setInterval(async()=>{
    if(!webPushConfigured)return;
  try {
    await pool.execute("UPDATE notifications SET push_processed_at=UTC_TIMESTAMP() WHERE push_processed_at IS NULL AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY)");
    const [pending]=await pool.execute("SELECT n.id,n.user_id,n.type,n.message FROM notifications n JOIN user_notification_preferences p ON p.user_id=n.user_id AND p.push=TRUE WHERE n.push_processed_at IS NULL ORDER BY n.id LIMIT 40");
    for(const notification of pending){
      const [subscriptions]=await pool.execute("SELECT id,application_origin,endpoint,p256dh_key,auth_key FROM push_subscriptions WHERE user_id=?",[notification.user_id]);
      if(subscriptions.length){
        const [accountRows]=await pool.execute("SELECT is_admin FROM users WHERE id=? LIMIT 1",[notification.user_id]);
        const counts=await notificationBadgeCount(notification.user_id,Boolean(accountRows[0]?.is_admin));
        const payload=JSON.stringify({title:"ShedShare",body:notification.message,url:"/",notificationId:String(notification.id),unreadCount:counts.badgeCount});
        for(const subscription of subscriptions){
          try { webpush.setVapidDetails(subscription.application_origin,process.env.WEB_PUSH_PUBLIC_KEY,process.env.WEB_PUSH_PRIVATE_KEY); await webpush.sendNotification({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh_key,auth:subscription.auth_key}},payload,{TTL:3600,urgency:"normal",topic:`ss${notification.id}`.slice(0,32)}); }
          catch(error){ if(error.statusCode===404||error.statusCode===410)await pool.execute("DELETE FROM push_subscriptions WHERE id=?",[subscription.id]); else console.warn("Web push delivery failed:",error.statusCode||"network error"); }
        }
      }
      await pool.execute("UPDATE notifications SET push_processed_at=UTC_TIMESTAMP() WHERE id=? AND push_processed_at IS NULL",[notification.id]);
    }
  } catch(error) { console.error("Push notification queue failed:",error.message); }
},15_000);
pushQueueTimer.unref();

// Serve the local frontend from the API origin so `npm start` runs the full app.
app.get("/", async (_request, response, next) => {
  try {
    const html = await fs.readFile(require("node:path").join(__dirname, "index.html"), "utf8");
    return response.set("Cache-Control", "no-store").type("html").send(html.replaceAll("__CSP_NONCE__", response.locals.cspNonce));
  } catch (error) { return next(error); }
});
app.get("/style.css", (_request, response) => response.set("Cache-Control", "no-store").sendFile(require("node:path").join(__dirname, "style.css")));
app.get("/script.js", (_request, response) => response.set("Cache-Control", "no-store").sendFile(require("node:path").join(__dirname, "script.js")));
app.get("/manifest.json", (_request, response) => response.set("Cache-Control", "no-cache").type("application/manifest+json").sendFile(require("node:path").join(__dirname, "manifest.json")));
app.get("/service-worker.js", (_request, response) => response.set("Cache-Control", "no-cache").type("application/javascript").sendFile(require("node:path").join(__dirname, "service-worker.js")));
app.get("/icons/:icon", (request, response, next) => {
  if (!/^icon-(?:192|512)\.png$/.test(request.params.icon)) return response.sendStatus(404);
  return response.set("Cache-Control", "public, max-age=86400").sendFile(require("node:path").join(__dirname, "icons", request.params.icon), (error) => { if (error) next(error); });
});

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    const supabaseConfigured = Boolean(supabase && supabaseAdmin);
    const storageCredentialsConfigured = Boolean(supabaseAdmin && (process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media"));
    const emailRedirectConfigured = isHttpsUrl(process.env.EMAIL_VERIFICATION_REDIRECT_URL);
    const paystackKey = process.env.PAYSTACK_SECRET_KEY || "";
    const paystackKeyConfigured = Boolean(paystackKey) && !paystackConfigurationError({ ...process.env, PAYMENT_MODE: "paystack" });
    const paystackAvailable = getPaymentMode() === "paystack" && !paystackConfigurationError();
    const healthy = process.env.NODE_ENV !== "production" || (supabaseConfigured && storageCredentialsConfigured && emailRedirectConfigured && (getPaymentMode() !== "paystack" || paystackAvailable) && allowedOrigins.size > 0);
    response.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "incomplete",
      database: "connected",
      supabaseConfigured,
      storageCredentialsConfigured,
      emailRedirectConfigured,
      paystackKeyConfigured,
      paystackAvailable,
      paymentMode: getPaymentMode(),
      corsConfigured: allowedOrigins.size > 0
    });
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
  clearInterval(deliveryFallbackTimer);
  clearInterval(chatRetentionTimer);
  clearInterval(rentalSchedulerTimer);
  clearInterval(pushQueueTimer);
  server.close(async () => { try { await pool.end(); process.exit(0); } catch (error) { console.error("Shutdown failed:", error.message); process.exit(1); } });
}
process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));
