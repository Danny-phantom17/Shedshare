"use strict";

const crypto = require("node:crypto");

const SESSION_COOKIE = "shedshare_session";
const CSRF_COOKIE = "shedshare_csrf";
const SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const CSRF_MAX_AGE_SECONDS = 60 * 60;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function cookieValue(request, name) {
  const header = request.headers?.cookie || "";
  let found;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

function appendCookie(response, value) {
  response.append("Set-Cookie", value);
}

function setSessionCookie(response, token, secure) {
  const secureFlag = secure ? "; Secure" : "";
  response.set("Cache-Control", "no-store");
  appendCookie(response, `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}${secureFlag}`);
}

function clearSessionCookie(response, secure) {
  const secureFlag = secure ? "; Secure" : "";
  response.set("Cache-Control", "no-store");
  appendCookie(response, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`);
}

function csrfCookie(token, secure) {
  const secureFlag = secure ? "; Secure" : "";
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${CSRF_MAX_AGE_SECONDS}${secureFlag}`;
}

function issueCsrfToken(request, response, secure) {
  const existing = cookieValue(request, CSRF_COOKIE);
  const token = existing && /^[A-Za-z0-9_-]{43}$/.test(existing)
    ? existing
    : crypto.randomBytes(32).toString("base64url");
  response.set("Cache-Control", "no-store");
  if (token !== existing) appendCookie(response, csrfCookie(token, secure));
  return token;
}

function requestOrigin(request) {
  const origin = request.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      return parsed.origin === origin ? parsed.origin : null;
    } catch (_error) { return null; }
  }
  const referer = request.get("referer");
  if (!referer) return null;
  try { return new URL(referer).origin; }
  catch (_error) { return null; }
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createCsrfProtection({ allowedOrigins = new Set() } = {}) {
  return function csrfProtection(request, response, next) {
    if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return next();

    const origin = requestOrigin(request);
    const ownOrigin = `${request.protocol}://${request.get("host")}`;
    if (!origin || (origin !== ownOrigin && !allowedOrigins.has(origin))) {
      return response.status(403).json({ error: "Request origin is not allowed.", code: "CSRF_ORIGIN_REJECTED" });
    }

    if (request.method.toUpperCase() === "DELETE" && request.path === "/account") return next();

    const cookieToken = cookieValue(request, CSRF_COOKIE);
    const headerToken = request.get("x-csrf-token");
    if (!safeEqual(cookieToken, headerToken)) {
      return response.status(403).json({ error: "CSRF token is missing or invalid.", code: "CSRF_TOKEN_INVALID" });
    }
    return next();
  };
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  SESSION_MAX_AGE_MS,
  cookieValue,
  setSessionCookie,
  clearSessionCookie,
  issueCsrfToken,
  createCsrfProtection
};
