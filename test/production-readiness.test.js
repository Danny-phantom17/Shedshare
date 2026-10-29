"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isHttpsUrl, productionReadinessErrors, productionReadinessWarnings } = require("../production-readiness");

const validProductionEnv = () => ({
  NODE_ENV: "production",
  AUTH_MODE: "supabase",
  DB_HOST: "mysql.internal.example.net",
  DB_NAME: "shedshare",
  DB_USER: "shedshare_app",
  DB_PASSWORD: "a-real-password",
  JWT_SECRET: "a-random-production-secret-that-is-long-enough",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "public-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "private-key-value",
  EMAIL_VERIFICATION_REDIRECT_URL: "https://shedshare.example.org/index.html",
  ALLOWED_ORIGINS: "https://shedshare.example.org",
  PAYMENT_MODE: "paystack",
  PAYSTACK_SECRET_KEY: "sk_live_production-value"
});

test("accepts a complete production configuration", () => {
  assert.deepEqual(productionReadinessErrors(validProductionEnv()), []);
});

test("rejects a test Paystack key for production", () => {
  const env = validProductionEnv();
  env.PAYSTACK_SECRET_KEY = "sk_test_sandbox-value";
  assert.ok(productionReadinessErrors(env).some((error) => error.includes("sk_live_")));
});

test("manual payment mode is production-ready without Paystack credentials", () => {
  const env = validProductionEnv();
  env.PAYMENT_MODE = "manual";
  delete env.PAYSTACK_SECRET_KEY;
  assert.deepEqual(productionReadinessErrors(env), []);
});

test("rejects insecure or placeholder redirects and origins", () => {
  const env = validProductionEnv();
  env.EMAIL_VERIFICATION_REDIRECT_URL = "http://localhost:3000/";
  env.ALLOWED_ORIGINS = "https://your-domain.example/path";
  const errors = productionReadinessErrors(env);
  assert.ok(errors.some((error) => error.includes("EMAIL_VERIFICATION_REDIRECT_URL")));
  assert.ok(errors.some((error) => error.includes("ALLOWED_ORIGINS")));
});

test("requires the auth redirect origin to be allowlisted", () => {
  const env = validProductionEnv();
  env.EMAIL_VERIFICATION_REDIRECT_URL = "https://auth.shedshare.example.org/index.html";
  assert.ok(productionReadinessErrors(env).some((error) => error.includes("one of the ALLOWED_ORIGINS")));
});

test("HTTPS helper rejects malformed and placeholder URLs", () => {
  assert.equal(isHttpsUrl("https://shedshare.example.org"), true);
  assert.equal(isHttpsUrl("http://shedshare.example.org"), false);
  assert.equal(isHttpsUrl("https://your-domain.example"), false);
  assert.equal(isHttpsUrl("not a URL"), false);
});

test("reports optional production feature gaps without treating them as hard blockers", () => {
  const warnings = productionReadinessWarnings(validProductionEnv());
  assert.ok(warnings.some((warning) => warning.includes("Geoapify")));
  assert.ok(warnings.some((warning) => warning.includes("email notifications")));
  assert.ok(warnings.some((warning) => warning.includes("Web push")));
});

// The package test command invokes this file directly; include cookie/CSRF regression coverage here.
require("./security-cookies.test");
require("./payment-mode.test");
require("./manual-installment-math.test");
require("./manual-payments.test");
