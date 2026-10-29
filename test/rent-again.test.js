"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createItemsRouter } = require("../items");

const publicListing = (overrides = {}) => ({
  id: 17, owner_id: 8, name: "Current projector", category: "Electronics", item_condition: "Good",
  location: "Yaba, Lagos", city: "Lagos", state: "Lagos", area_name: "Yaba", description: "",
  known_defects: "", cancellation_policy: "", rental_conditions: "", image: "current.jpg", video: "",
  owner_name: "Lister", owner_brand: "", owner_email_verified: 1, owner_review_count: 0,
  owner_completed_rentals: 1, price: "12000.00", pricing_unit: "day", min_period: 1,
  max_period: 10, deposit: "3000.00", delivery_available: 0, rider_delivery_available: 0,
  delivery_fee: "0.00", paused: 0, created_at: new Date("2026-01-01T00:00:00Z"), ...overrides
});

async function startItemsServer(t, row) {
  const app = express();
  app.use("/api/items", createItemsRouter({
    pool: { execute: async (_sql, [id]) => [String(id) === "17" && row ? [row] : []] },
    authenticate: (_req, _res, next) => next()
  }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("Rent Again lookup returns current listing price and terms, not historical rental values", async t => {
  const base = await startItemsServer(t, publicListing({ price: "14900.00", min_period: 2 }));
  const response = await fetch(`${base}/api/items/17`);
  const listing = await response.json();
  assert.equal(response.status, 200);
  assert.equal(listing.price, 14900);
  assert.equal(listing.minPeriod, 2);
  assert.equal(listing.deposit, 3000);
  assert.equal(listing.paused, false);
});

test("Rent Again cannot restart a missing or paused listing", async t => {
  const paused = await startItemsServer(t, publicListing({ paused: 1 }));
  const pausedResponse = await fetch(`${paused}/api/items/17`);
  assert.equal(pausedResponse.status, 404);
  assert.match((await pausedResponse.json()).error, /no longer available/);

  const missing = await startItemsServer(t, null);
  assert.equal((await fetch(`${missing}/api/items/17`)).status, 404);
});
