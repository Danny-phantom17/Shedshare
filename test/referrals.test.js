"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { getReferralAttribution, insertReferralAttribution, recordReferralEvent, createAdminReferralRouter } = require("../referrals");

test("referral codes are normalized and self-referral by account email is rejected", async () => {
  const pool = { execute: async (_sql, [code]) => [[code === "FRIEND7" ? { code, user_id: 5, email: "friend@example.com", phone: "+2348012345678" } : null].filter(Boolean)] };
  assert.deepEqual(await getReferralAttribution(pool, " friend7 ", "new@example.com"), { referrerUserId: "5", code: "FRIEND7", referrerPhone: "+2348012345678" });
  assert.match((await getReferralAttribution(pool, "friend7", "friend@example.com")).error, /own referral/);
  assert.match((await getReferralAttribution(pool, "unknown", "new@example.com")).error, /not found/);
});

test("same-phone account referral is persisted as rejected and flagged for suspected self-referral", async () => {
  let inserted;
  const connection = { execute: async (sql, values) => { if (sql.startsWith("SELECT id FROM users")) return [[{ id: 5 }]]; inserted = values; return [{ insertId: 41 }]; } };
  await insertReferralAttribution(connection, { referrerUserId: "5", code: "FRIEND7", referrerPhone: "+234 801-234-5678" }, "9", "08012345678");
  assert.equal(inserted[3], "rejected");
  assert.equal(inserted[4], true);
  assert.match(inserted[5], /self-referral or duplicate account/);
});

test("only configured server events can qualify a referral and repeated events are idempotent", async () => {
  const state = { status: "pending", eventKeys: new Set(), decisions: [], notifications: 0 };
  const program = { enabled: true, ruleEnabled: true };
  const pool = {
    execute: async sql => {
      if (sql.includes("SELECT id FROM referrals")) return [[{ id: 12 }]];
      if (sql.includes("FROM referral_program_controls")) return [[{ enabled: program.enabled }]];
      if (sql.includes("FROM referral_program_rules")) return [["account_verified", "first_public_listing", "first_completed_rental"].map(event_type => ({ event_type, enabled: program.ruleEnabled, referrer_reward_kobo: 150000, referred_reward_kobo: 50000 }))];
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    getConnection: async () => ({
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
      execute: async (sql, values) => {
        if (sql.includes("FROM referrals")) return [[{ id: 12, referrer_user_id: 5, referred_user_id: 9, status: state.status, risk_flag: false }]];
        if (sql.includes("SELECT email_verified FROM users")) return [[{email_verified:true}]];
        if (sql.includes("SELECT id FROM items")) return [[{id:3}]];
        if (sql.includes("SELECT id FROM rentals")) return [[{id:4}]];
        if (sql.includes("FROM referral_program_controls")) return [[{enabled:program.enabled}]];
        if (sql.includes("FROM referral_program_rules")) return [["account_verified","first_public_listing","first_completed_rental"].map(event_type=>({event_type,enabled:program.ruleEnabled,referrer_reward_kobo:150000,referred_reward_kobo:50000}))];
        if (sql.includes("INSERT IGNORE INTO referral_events")) {
          if (state.eventKeys.has(values[1])) return [{ affectedRows: 0 }];
          state.eventKeys.add(values[1]); state.decisions.push(values); state.rewards = values.slice(5, 7); return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE referrals SET status='eligible'")) { state.status = "eligible"; return [{ affectedRows: 1 }]; }
        if (sql.includes("INSERT INTO notifications")) { state.notifications += 1; return [{ affectedRows: 2 }]; }
        throw new Error(`Unexpected connection query: ${sql}`);
      }
    })
  };
  assert.deepEqual(await recordReferralEvent(pool, "9", "account_verified", "verified:9"), { recorded: true, status: "eligible" });
  assert.equal(state.status, "eligible");
  assert.equal(state.rewards[0], 150000);
  assert.equal(state.rewards[1], 50000);
  assert.equal(state.notifications, 1);
  assert.deepEqual(await recordReferralEvent(pool, "9", "account_verified", "verified:9"), { recorded: false, duplicate: true });
  assert.equal(state.status, "eligible");
  assert.deepEqual(await recordReferralEvent(pool, "9", "first_public_listing", "first-listing:9"), { recorded: true, status: "eligible" });
  assert.equal(state.eventKeys.size, 2);
  program.enabled = false;
  assert.deepEqual(await recordReferralEvent(pool, "9", "first_completed_rental", "first-rental:9"), { recorded: true, status: "eligible" });
  assert.equal(state.status, "eligible");
});

test("admin rewards are issued once per event, blocked until approval, and reversible", async t => {
  const state = { status: "pending", eventStatus: "eligible", ledger: new Map(), audit: 0 };
  const pool = { getConnection: async () => ({
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql, values) => {
      if (sql.includes("SELECT * FROM referrals")) return [[{ id: 42, status: state.status, referrer_user_id: 5, referred_user_id: 9, referrer_reward_kobo: 150000, referred_reward_kobo: 50000, qualifying_event: "account_verified" }]];
      if (sql.includes("SELECT email_verified FROM users")) return [[{email_verified:true}]];
      if (sql.includes("SELECT * FROM referral_events")) return [[{ id: 76, referral_id: 42, event_type: "account_verified", status: state.eventStatus, referrer_reward_kobo: 150000, referred_reward_kobo: 50000 }]];
      if (sql.includes("INSERT IGNORE INTO referral_reward_ledger")) { state.ledger.set(values[4], { eventId: values[1], userId: values[2], type: sql.includes("'reversal'") ? "reversal" : "credit", amount: values[3], key: values[4] }); return [{ affectedRows: 1 }]; }
      if (sql.includes("SELECT user_id,amount_kobo,idempotency_key FROM referral_reward_ledger")) return [[...state.ledger.values()].filter(row => row.type === "credit").map(row => ({ user_id: row.userId, amount_kobo: row.amount, idempotency_key: row.key }))];
      if (sql.includes("UPDATE referral_events SET status=")) { state.eventStatus = values[0]; return [{ affectedRows: 1 }]; }
      if (sql.includes("UPDATE referrals SET status=")) { state.status = values[0]; return [{ affectedRows: 1 }]; }
      if (sql.includes("INSERT INTO admin_audit_log")) { state.audit += 1; return [{ affectedRows: 1 }]; }
      if (sql.includes("INSERT INTO notifications")) return [{ affectedRows: 2 }];
      throw new Error(`Unexpected admin query: ${sql}`);
    }
  }) };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: "99", isAdmin: true }; next(); }); app.use("/api/admin/referrals", createAdminReferralRouter({ pool }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/admin/referrals/42/events/76/status`;
  const reward = () => fetch(base, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reward", reason: "Approved after manual identity review." }) });
  assert.equal((await reward()).status, 409);
  state.eventStatus = "approved";
  assert.equal((await reward()).status, 200);
  assert.equal(state.eventStatus, "rewarded");
  assert.equal(state.ledger.size, 2);
  assert.equal((await reward()).status, 409);
  const reversed = await fetch(base, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reverse", reason: "Reward issued to a duplicate account." }) });
  assert.equal(reversed.status, 200);
  assert.equal(state.eventStatus, "reversed");
  assert.equal(state.ledger.size, 4);
  assert.equal(state.audit, 2);
});
