"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SESSION_COOKIE,
  CSRF_COOKIE,
  SESSION_MAX_AGE_MS,
  setSessionCookie,
  clearSessionCookie,
  issueCsrfToken,
  createCsrfProtection
} = require("../security-cookies");

function fakeResponse() {
  return {
    headers: {},
    statusCode: 200,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    append(name, value) {
      const key = name.toLowerCase();
      this.headers[key] = this.headers[key] ? [].concat(this.headers[key], value) : value;
      return this;
    },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function fakeRequest({ method = "POST", origin = "https://shedshare.example", referer, cookie, csrfHeader } = {}) {
  const headers = { origin, referer, cookie, host: "shedshare.example", "x-csrf-token": csrfHeader };
  return {
    method,
    protocol: "https",
    headers,
    get(name) { return headers[name.toLowerCase()]; }
  };
}

test("session cookie is HttpOnly, SameSite Lax, and has a one-hour lifetime", () => {
  const response = fakeResponse();
  setSessionCookie(response, "signed.jwt.value", true);
  const cookie = response.headers["set-cookie"];
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=signed\\.jwt\\.value`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=3600/);
  assert.equal(SESSION_MAX_AGE_MS, 60 * 60 * 1000);
});

test("logout clears the session cookie with matching security attributes", () => {
  const response = fakeResponse();
  clearSessionCookie(response, true);
  assert.match(response.headers["set-cookie"], new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(response.headers["set-cookie"], /HttpOnly/);
  assert.match(response.headers["set-cookie"], /Secure/);
  assert.match(response.headers["set-cookie"], /SameSite=Lax/);
  assert.match(response.headers["set-cookie"], /Max-Age=0/);
});

test("CSRF token endpoint issues and reuses a random double-submit cookie", () => {
  const response = fakeResponse();
  const token = issueCsrfToken(fakeRequest(), response, true);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(response.headers["set-cookie"], new RegExp(`^${CSRF_COOKIE}=${token}`));
  assert.doesNotMatch(response.headers["set-cookie"], /HttpOnly/);

  const reused = issueCsrfToken(fakeRequest({ cookie: `${CSRF_COOKIE}=${token}` }), fakeResponse(), true);
  assert.equal(reused, token);
});

test("state-changing requests require matching CSRF cookie/header and trusted origin", () => {
  const protect = createCsrfProtection({ allowedOrigins: new Set(["https://app.shedshare.example"]) });
  const token = "A".repeat(43);
  let nextCalled = false;
  const response = fakeResponse();
  protect(fakeRequest({ cookie: `${CSRF_COOKIE}=${token}`, csrfHeader: token }), response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const missingResponse = fakeResponse();
  protect(fakeRequest({ cookie: `${CSRF_COOKIE}=${token}`, csrfHeader: "B".repeat(43) }), missingResponse, () => assert.fail("invalid token passed"));
  assert.equal(missingResponse.statusCode, 403);
  assert.equal(missingResponse.body.code, "CSRF_TOKEN_INVALID");

  const originResponse = fakeResponse();
  protect(fakeRequest({ origin: "https://attacker.example", cookie: `${CSRF_COOKIE}=${token}`, csrfHeader: token }), originResponse, () => assert.fail("untrusted origin passed"));
  assert.equal(originResponse.statusCode, 403);
  assert.equal(originResponse.body.code, "CSRF_ORIGIN_REJECTED");
});

test("read-only requests do not require CSRF headers", () => {
  const protect = createCsrfProtection();
  let nextCalled = false;
  protect(fakeRequest({ method: "GET", origin: undefined }), fakeResponse(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
