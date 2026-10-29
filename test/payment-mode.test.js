"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getPaymentMode, paystackConfigurationError, requirePaystackMode } = require("../payment-mode");

test("payment mode defaults to manual and accepts a configured manual deployment without Paystack secrets", () => {
  const env = { NODE_ENV: "production", PAYMENT_MODE: "manual" };
  assert.equal(getPaymentMode(env), "manual");
  assert.equal(paystackConfigurationError(env), null);
});

test("manual mode middleware rejects direct backend initialization requests", () => {
  const oldMode = process.env.PAYMENT_MODE;
  const oldKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYMENT_MODE = "manual";
  delete process.env.PAYSTACK_SECRET_KEY;
  let statusCode, payload, continued = false;
  const response = { status(code) { statusCode = code; return this; }, json(value) { payload = value; return this; } };
  requirePaystackMode({}, response, () => { continued = true; });
  assert.equal(statusCode, 503);
  assert.match(payload.error, /suspended/i);
  assert.equal(continued, false);
  if (oldMode === undefined) delete process.env.PAYMENT_MODE; else process.env.PAYMENT_MODE = oldMode;
  if (oldKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = oldKey;
});

test("Paystack mode requires environment-appropriate, non-placeholder credentials", () => {
  assert.match(paystackConfigurationError({ NODE_ENV: "production", PAYMENT_MODE: "paystack", PAYSTACK_SECRET_KEY: "sk_test_sandbox" }), /sk_live_/);
  assert.match(paystackConfigurationError({ NODE_ENV: "development", PAYMENT_MODE: "paystack", PAYSTACK_SECRET_KEY: "" }), /requires a sk_test_/);
  assert.match(paystackConfigurationError({ NODE_ENV: "production", PAYMENT_MODE: "paystack", PAYSTACK_SECRET_KEY: "sk_live_replace_me" }), /real provider secret/i);
  assert.equal(paystackConfigurationError({ NODE_ENV: "production", PAYMENT_MODE: "paystack", PAYSTACK_SECRET_KEY: "sk_live_production-secret" }), null);
});

test("invalid payment mode fails configuration validation", () => {
  assert.match(paystackConfigurationError({ PAYMENT_MODE: "disabled" }), /PAYMENT_MODE/);
});
