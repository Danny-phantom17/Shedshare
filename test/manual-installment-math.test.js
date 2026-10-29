"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInstallmentAmounts } = require("../manual-installment-math");

test("full payment creates one exact minor-unit installment", () => {
  assert.deepEqual(buildInstallmentAmounts(10001, { type: "full" }), [10001]);
});

test("deposit and balance use integer minor units and preserve the exact total", () => {
  const amounts = buildInstallmentAmounts(10001, { type: "deposit_balance", depositPercent: 33 });
  assert.deepEqual(amounts, [3300, 6701]);
  assert.equal(amounts.reduce((sum, amount) => sum + amount, 0), 10001);
});

test("invalid totals, percentages, and schedule types fail safely", () => {
  assert.equal(buildInstallmentAmounts(0, { type: "full" }), null);
  assert.equal(buildInstallmentAmounts(10000, { type: "deposit_balance", depositPercent: 0 }), null);
  assert.equal(buildInstallmentAmounts(10000, { type: "deposit_balance", depositPercent: 100 }), null);
  assert.equal(buildInstallmentAmounts(10000, { type: "unknown" }), null);
});
