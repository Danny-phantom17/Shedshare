"use strict";

function getPaymentMode(env = process.env) {
  return (env.PAYMENT_MODE || "manual").trim().toLowerCase();
}

function paystackConfigurationError(env = process.env) {
  const mode = getPaymentMode(env);
  if (!['manual', 'paystack'].includes(mode)) return "PAYMENT_MODE must be either manual or paystack.";
  if (mode === "manual") return null;
  const key = env.PAYSTACK_SECRET_KEY || "";
  if (/replace|placeholder|example/i.test(key)) return "PAYSTACK_SECRET_KEY must contain a real provider secret.";
  if (env.NODE_ENV === "production" && !key.startsWith("sk_live_")) return "Production Paystack mode requires an sk_live_ secret key.";
  if (env.NODE_ENV !== "production" && !/^sk_(test|live)_/.test(key)) return "Paystack mode requires a sk_test_ key in development or sk_live_ key in production.";
  return null;
}

function requirePaystackMode(_req, res, next) {
  const mode = getPaymentMode();
  const error = paystackConfigurationError();
  if (mode !== "paystack") return res.status(503).json({ error: "Automated Paystack payments are suspended. Contact ShedShare to arrange payment." });
  if (error) return res.status(503).json({ error: "Paystack payments are unavailable because server configuration is incomplete." });
  return next();
}

function requireValidPaymentMode(_req, res, next) {
  const error = paystackConfigurationError();
  if (error) return res.status(503).json({ error: "Payment service configuration is invalid. Contact ShedShare support." });
  return next();
}

module.exports = { getPaymentMode, paystackConfigurationError, requirePaystackMode, requireValidPaymentMode };
