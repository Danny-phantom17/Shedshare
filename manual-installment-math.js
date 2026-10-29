"use strict";

function buildInstallmentAmounts(totalMinor, schedule) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) return null;
  if (!schedule || schedule.type === "full") return [totalMinor];
  if (schedule.type !== "deposit_balance") return null;
  const percent = Number(schedule.depositPercent);
  if (!Number.isInteger(percent) || percent < 1 || percent > 99) return null;
  const first = Math.round(totalMinor * percent / 100);
  const remainder = totalMinor - first;
  return first > 0 && remainder > 0 ? [first, remainder] : null;
}

module.exports = { buildInstallmentAmounts };
