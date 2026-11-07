"use strict";

const { paystackConfigurationError } = require("./payment-mode");

const PLACEHOLDER = /(replace_with|your-project|your-domain|changeme|placeholder|sk_test_replace|example\.com)/i;

function isHttpsUrl(value) {
  if (!value || PLACEHOLDER.test(value)) return false;
  try { return new URL(value).protocol === "https:"; }
  catch (_error) { return false; }
}

function productionReadinessErrors(env = process.env) {
  const errors = [];
  if (env.NODE_ENV !== "production") errors.push("NODE_ENV must be production.");
  if ((env.AUTH_MODE || "supabase").toLowerCase() !== "supabase") errors.push("AUTH_MODE must be supabase.");
  for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    if (!env[key] || PLACEHOLDER.test(env[key])) errors.push(`${key} must be set to the production MySQL value.`);
  }
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || PLACEHOLDER.test(env.JWT_SECRET)) {
    errors.push("JWT_SECRET must be a non-placeholder secret with at least 32 characters.");
  }
  if (!isHttpsUrl(env.SUPABASE_URL)) errors.push("SUPABASE_URL must be a real HTTPS project URL.");
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  if (!publishableKey || PLACEHOLDER.test(publishableKey)) errors.push("SUPABASE_PUBLISHABLE_KEY (or legacy SUPABASE_ANON_KEY) must be set to the production Supabase key.");
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey || PLACEHOLDER.test(secretKey)) errors.push("SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) must be set to the production Supabase key.");
  if (!isHttpsUrl(env.EMAIL_VERIFICATION_REDIRECT_URL)) {
    errors.push("EMAIL_VERIFICATION_REDIRECT_URL must be the deployed HTTPS ShedShare URL.");
  }
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length) errors.push("ALLOWED_ORIGINS must contain the deployed frontend HTTPS origin.");
  for (const origin of origins) {
    let parsed;
    try { parsed = new URL(origin); } catch (_error) { parsed = null; }
    if (!parsed || parsed.protocol !== "https:" || parsed.origin !== origin || PLACEHOLDER.test(origin)) {
      errors.push(`ALLOWED_ORIGINS entry must be a bare HTTPS origin: ${origin || "(empty)"}.`);
    }
  }
  try {
    const redirectOrigin = new URL(env.EMAIL_VERIFICATION_REDIRECT_URL).origin;
    if (origins.length && !origins.includes(redirectOrigin)) errors.push("EMAIL_VERIFICATION_REDIRECT_URL must use one of the ALLOWED_ORIGINS origins.");
  } catch (_error) { /* The HTTPS URL error above explains an invalid redirect. */ }
  const paymentError = paystackConfigurationError(env);
  if (paymentError) errors.push(paymentError);
  return [...new Set(errors)];
}

function productionReadinessWarnings(env = process.env) {
  const warnings = [];
  if (["localhost", "127.0.0.1", "::1"].includes((env.DB_HOST || "").toLowerCase())) {
    warnings.push("DB_HOST points to localhost; a deployed API normally needs a reachable managed MySQL endpoint.");
  }
  if (!env.GEOAPIFY_MAPS_BROWSER_KEY || !env.GEOAPIFY_API_KEY) {
    warnings.push("Geoapify map rendering and server-side geocoding are incomplete until both restricted Geoapify keys are configured.");
  }
  if (!env.GOOGLE_CLIENT_ID) warnings.push("Google sign-in is unavailable until the production OAuth client is configured.");
  if ((env.EXTERNAL_SEARCH_ENABLED || "false").toLowerCase() === "true" && !env.GOOGLE_MAPS_PLACES_SERVER_KEY) {
    warnings.push("External business search is enabled but its Places server key is missing.");
  }
  if (!env.EMAIL_PROVIDER_URL || !env.EMAIL_PROVIDER_API_KEY) {
    warnings.push("General email notifications are inactive; only Supabase auth email and in-app notifications are available.");
  }
  if (!env.WEB_PUSH_PUBLIC_KEY || !env.WEB_PUSH_PRIVATE_KEY) warnings.push("Web push notifications are inactive.");
  return warnings;
}

module.exports = { isHttpsUrl, productionReadinessErrors, productionReadinessWarnings };
