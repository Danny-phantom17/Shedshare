"use strict";

const crypto = require("node:crypto");
const express = require("express");
const { z } = require("zod");
const { normalizeEmail } = require("./email-integrity");

const EVENT_TYPES = ["account_verified", "first_public_listing", "first_completed_rental"];
const EVENT_LABELS = {
  account_verified: "New account email verified",
  first_public_listing: "First public listing created",
  first_completed_rental: "First payment-verified rental completed"
};
const DEFAULT_RULES = EVENT_TYPES.map(eventType => ({ eventType, label: EVENT_LABELS[eventType], enabled: false, referrerReward: 0, referredReward: 0 }));
const codeSchema = z.string().trim().min(4).max(20).transform(value => value.toUpperCase()).refine(value => /^[A-Z0-9-]+$/.test(value), "Enter a valid referral code.");

function normalizePhone(value) { const digits = String(value || "").replace(/\D/g, ""); return digits.startsWith("234") && digits.length >= 13 ? `0${digits.slice(3)}` : digits; }
function referralStatusLabel(status) { return ({ pending: "Pending qualifying action", not_qualifying: "Action not qualifying", eligible: "Eligible · awaiting review", approved: "Approved · awaiting issue", rewarded: "Rewarded", rejected: "Rejected", reversed: "Reward reversed" })[status] || status; }

async function getReferralAttribution(pool, rawCode, email = "") {
  const parsed = codeSchema.safeParse(rawCode);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || "Enter a valid referral code." };
  const [rows] = await pool.execute("SELECT rc.code,rc.user_id,u.email,u.phone FROM referral_codes rc JOIN users u ON u.id=rc.user_id WHERE rc.code=? LIMIT 1", [parsed.data]);
  if (!rows.length) return { error: "That referral code was not found. Check it and try again." };
  if (normalizeEmail(rows[0].email) === normalizeEmail(email)) return { error: "You cannot use your own referral code." };
  return { referrerUserId: String(rows[0].user_id), code: rows[0].code, referrerPhone: rows[0].phone || "" };
}

async function insertReferralAttribution(connection, attribution, referredUserId, referredPhone = "") {
  if (!attribution) return null;
  const normalizedPhone = normalizePhone(referredPhone);
  const [priorPhoneRows] = normalizedPhone ? await connection.execute("SELECT id FROM users WHERE phone=? AND id<>? LIMIT 1", [referredPhone, referredUserId]) : [[]];
  const samePhone = Boolean(normalizedPhone && (normalizedPhone === normalizePhone(attribution.referrerPhone) || priorPhoneRows.length));
  const [result] = await connection.execute(
    "INSERT INTO referrals(referrer_user_id,referred_user_id,referral_code,status,risk_flag,risk_reason) VALUES(?,?,?,?,?,?)",
    [attribution.referrerUserId, referredUserId, attribution.code, samePhone ? "rejected" : "pending", samePhone, samePhone ? "Possible self-referral or duplicate account: phone number matches referrer." : null]
  );
  return result.insertId;
}

async function ensureReferralCode(pool, userId) {
  const [existing] = await pool.execute("SELECT code FROM referral_codes WHERE user_id=? LIMIT 1", [userId]);
  if (existing.length) return existing[0].code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = crypto.randomBytes(7).toString("base64url").replace(/[^a-z0-9]/gi, "").slice(0, 10).toUpperCase();
    try {
      await pool.execute("INSERT INTO referral_codes(user_id,code) VALUES(?,?)", [userId, code]);
      return code;
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY") throw error;
      const [raced] = await pool.execute("SELECT code FROM referral_codes WHERE user_id=? LIMIT 1", [userId]);
      if (raced.length) return raced[0].code;
    }
  }
  throw new Error("Unable to generate a unique referral code.");
}

async function getReferralProgram(pool) {
  const [[controlRows], [ruleRows]] = await Promise.all([
    pool.execute("SELECT enabled FROM referral_program_controls WHERE control_id=1 LIMIT 1"),
    pool.execute("SELECT event_type,enabled,referrer_reward_kobo,referred_reward_kobo FROM referral_program_rules ORDER BY event_type")
  ]);
  const rulesByType = new Map(ruleRows.map(rule => [rule.event_type, rule]));
  return {
    enabled: Boolean(controlRows[0]?.enabled),
    rules: EVENT_TYPES.map(eventType => {
      const row = rulesByType.get(eventType);
      return { eventType, label: EVENT_LABELS[eventType], enabled: Boolean(row?.enabled), referrerReward: Number(row?.referrer_reward_kobo || 0) / 100, referredReward: Number(row?.referred_reward_kobo || 0) / 100 };
    })
  };
}

async function validateReferralEvent(connection, userId, eventType) {
  const [users] = await connection.execute("SELECT email_verified FROM users WHERE id=? LIMIT 1", [userId]);
  if (!users.length || !Boolean(users[0].email_verified)) return { valid: false, reason: "The referred account has not verified its email address." };
  if (eventType === "account_verified") return { valid: true, reason: "Email ownership was verified by the configured authentication provider." };
  if (eventType === "first_public_listing") {
    const [items] = await connection.execute("SELECT id FROM items WHERE owner_id=? AND paused=FALSE AND moderation_status='approved' LIMIT 1", [userId]);
    return items.length ? { valid: true, reason: "A public listing exists for the referred lister." } : { valid: false, reason: "The referred lister has no public listing." };
  }
  if (eventType === "first_completed_rental") {
    const [rentals] = await connection.execute("SELECT id FROM rentals WHERE renter_id=? AND status='completed' AND payment_verified_at IS NOT NULL LIMIT 1", [userId]);
    return rentals.length ? { valid: true, reason: "A completed payment-verified rental exists for the referred renter." } : { valid: false, reason: "The referred renter has no completed payment-verified rental." };
  }
  return { valid: false, reason: "The event type is not supported." };
}

async function recordReferralEvent(pool, referredUserId, eventType, eventKey, metadata = {}) {
  if (!EVENT_TYPES.includes(eventType)) return { recorded: false };
  const [existingReferral] = await pool.execute("SELECT id FROM referrals WHERE referred_user_id=? LIMIT 1", [referredUserId]);
  if (!existingReferral.length) return { recorded: false };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [refs] = await connection.execute("SELECT id,referrer_user_id,referred_user_id,status,risk_flag FROM referrals WHERE referred_user_id=? LIMIT 1 FOR UPDATE", [referredUserId]);
    if (!refs.length) { await connection.commit(); return { recorded: false }; }
    const referral = refs[0];
    const validation = await validateReferralEvent(connection, referredUserId, eventType);
    if (!validation.valid) { await connection.commit(); return { recorded: false, reason: "not_eligible" }; }
    const program = await getReferralProgram(connection);
    const rule = program.rules.find(candidate => candidate.eventType === eventType);
    const isEligible = program.enabled && rule?.enabled && !(referral.status === "rejected" && referral.risk_flag);
    const outcome = isEligible ? "eligible" : "not_qualifying";
    const reason = isEligible ? "Configured server-verified referral event." : !program.enabled ? "Referral programme is disabled." : !rule?.enabled ? "This event is not enabled as a qualifying action." : "This referral relationship was rejected.";
    const [logged] = await connection.execute(
      "INSERT IGNORE INTO referral_events(referral_id,event_key,event_type,outcome,status,referrer_reward_kobo,referred_reward_kobo,decision_reason,metadata) VALUES(?,?,?,?,?,?,?,?,?)",
      [referral.id, String(eventKey).slice(0, 160), eventType, outcome, isEligible ? "eligible" : "not_qualifying", isEligible ? Math.round(rule.referrerReward * 100) : 0, isEligible ? Math.round(rule.referredReward * 100) : 0, reason, JSON.stringify(metadata).slice(0, 3000)]
    );
    if (!logged.affectedRows) { await connection.commit(); return { recorded: false, duplicate: true }; }
    if (isEligible) {
      await connection.execute("UPDATE referrals SET status='eligible',qualifying_event=?,eligible_at=COALESCE(eligible_at,UTC_TIMESTAMP()) WHERE id=? AND status<>'rejected'", [eventType, referral.id]);
      const notice = `A referral reached the configured qualifying action: ${EVENT_LABELS[eventType]}. It is awaiting administrator review.`;
      await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'referral_eligible',?,?),(?,'referral_eligible',?,?)", [referral.referrer_user_id, notice, referral.id, referral.referred_user_id, notice, referral.id]);
    }
    await connection.commit();
    return { recorded: true, status: isEligible ? "eligible" : referral.status };
  } catch (error) { await connection.rollback(); if (error.code === "ER_DUP_ENTRY") return { recorded: false, duplicate: true }; throw error; }
  finally { connection.release(); }
}

function createReferralRouter({ pool, authenticate }) {
  const router = express.Router();
  router.use(authenticate);
  router.get("/me", async (req, res) => {
    try {
      const code = await ensureReferralCode(pool, req.user.id);
      const [rows] = await pool.execute(`SELECT r.id,r.status referral_status,r.created_at,r.eligible_at,e.id event_id,e.event_type,e.status event_status,e.created_at event_created_at,
          COALESCE((SELECT SUM(l.amount_kobo) FROM referral_reward_ledger l WHERE l.referral_event_id=e.id AND l.user_id=?),0) reward_kobo
        FROM referrals r LEFT JOIN referral_events e ON e.referral_id=r.id WHERE r.referrer_user_id=? ORDER BY r.created_at DESC,e.created_at DESC LIMIT 500`, [req.user.id, req.user.id]);
      const [own] = await pool.execute("SELECT status,qualifying_event FROM referrals WHERE referred_user_id=? LIMIT 1", [req.user.id]);
      const program = await getReferralProgram(pool);
      const [balance] = await pool.execute("SELECT COALESCE(SUM(amount_kobo),0) amount_kobo FROM referral_reward_ledger WHERE user_id=?", [req.user.id]);
      return res.json({ code, enabled: program.enabled, rules: program.rules, ownReferral: own[0] ? { status: own[0].status, qualifyingEvent: own[0].qualifying_event } : null,
        promotionalCreditBalance: Number(balance[0]?.amount_kobo || 0) / 100,
        referrals: rows.map(row => ({ id: String(row.id), eventId: row.event_id == null ? null : String(row.event_id), status: row.event_status || row.referral_status, statusLabel: referralStatusLabel(row.event_status || row.referral_status), qualifyingEvent: row.event_type || null, createdAt: new Date(row.created_at).toISOString(), eventAt: row.event_created_at ? new Date(row.event_created_at).toISOString() : null, eligibleAt: row.eligible_at ? new Date(row.eligible_at).toISOString() : null, promotionalCredit: Number(row.reward_kobo || 0) / 100 })) });
    } catch (error) { console.error("Loading referral dashboard failed:", error.message); return res.status(500).json({ error: "Unable to load your referral programme." }); }
  });
  return router;
}

function createAdminReferralRouter({ pool }) {
  const router = express.Router();
  router.get("/program", async (_req, res) => { try { return res.json(await getReferralProgram(pool)); } catch (error) { console.error("Loading referral programme failed:", error.message); return res.status(500).json({ error: "Unable to load referral settings." }); } });
  router.put("/program", async (req, res) => {
    const parsed = z.object({ enabled: z.boolean(), rules: z.array(z.object({ eventType: z.enum(EVENT_TYPES), enabled: z.boolean(), referrerReward: z.number().finite().min(0).max(1000000), referredReward: z.number().finite().min(0).max(1000000) }).strict()).length(EVENT_TYPES.length) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Check the referral programme rules and reward amounts." });
    const byType = new Map(parsed.data.rules.map(rule => [rule.eventType, rule]));
    if (EVENT_TYPES.some(eventType => !byType.has(eventType)) || parsed.data.rules.some(rule => rule.enabled && rule.referrerReward === 0 && rule.referredReward === 0)) return res.status(400).json({ error: "Provide each qualifying event once and at least one non-zero reward for each enabled event." });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("INSERT INTO referral_program_controls(control_id,enabled,updated_by) VALUES(1,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),updated_by=VALUES(updated_by)", [parsed.data.enabled, req.user.id]);
      for (const rule of parsed.data.rules) await connection.execute("INSERT INTO referral_program_rules(event_type,enabled,referrer_reward_kobo,referred_reward_kobo,updated_by) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),referrer_reward_kobo=VALUES(referrer_reward_kobo),referred_reward_kobo=VALUES(referred_reward_kobo),updated_by=VALUES(updated_by)", [rule.eventType, rule.enabled, Math.round(rule.referrerReward * 100), Math.round(rule.referredReward * 100), req.user.id]);
      await connection.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,?)", [req.user.id, "referral_program_config", "platform_setting", "referral_program", "Administrator updated referral programme rules.", JSON.stringify(parsed.data)]);
      await connection.commit(); return res.json(await getReferralProgram(pool));
    } catch (error) { await connection.rollback(); console.error("Saving referral programme failed:", error.message); return res.status(500).json({ error: "Unable to save referral programme settings." }); }
    finally { connection.release(); }
  });
  router.get("/", async (_req, res) => {
    try {
      const [rows] = await pool.execute(`SELECT r.id referral_id,r.referrer_user_id,r.referred_user_id,r.referral_code,r.status referral_status,r.risk_flag,r.risk_reason,r.decision_reason,r.created_at,r.eligible_at,
        e.id event_id,e.event_type,e.status event_status,e.decision_reason event_decision_reason,e.created_at event_created_at,
        ru.name referrer_name,nu.name referred_name,
        COALESCE((SELECT SUM(l.amount_kobo) FROM referral_reward_ledger l WHERE l.referral_event_id=e.id),0) reward_kobo
        FROM referrals r JOIN users ru ON ru.id=r.referrer_user_id JOIN users nu ON nu.id=r.referred_user_id LEFT JOIN referral_events e ON e.referral_id=r.id ORDER BY r.created_at DESC,e.created_at DESC LIMIT 1000`);
      return res.json(rows.map(row => ({ id: String(row.referral_id), eventId: row.event_id == null ? null : String(row.event_id), referrerName: row.referrer_name, referredName: row.referred_name, status: row.event_status || row.referral_status, referralStatus: row.referral_status, qualifyingEvent: row.event_type, riskFlag: Boolean(row.risk_flag), riskReason: row.risk_reason || "", decisionReason: row.event_decision_reason || row.decision_reason || "", createdAt: new Date(row.created_at).toISOString(), eventAt: row.event_created_at ? new Date(row.event_created_at).toISOString() : null, eligibleAt: row.eligible_at ? new Date(row.eligible_at).toISOString() : null, promotionalCreditNet: Number(row.reward_kobo || 0) / 100 })));
    } catch (error) { console.error("Loading referrals for review failed:", error.message); return res.status(500).json({ error: "Unable to load referral reviews." }); }
  });
  router.patch("/:id/events/:eventId/status", async (req, res) => {
    const id = z.string().regex(/^\d+$/).safeParse(req.params.id), eventId = z.string().regex(/^\d+$/).safeParse(req.params.eventId);
    const body = z.object({ action: z.enum(["approve", "reject", "reward", "reverse"]), reason: z.string().trim().min(5).max(1000) }).strict().safeParse(req.body);
    if (!id.success || !eventId.success || !body.success) return res.status(400).json({ error: "Choose a referral event action and explain the decision." });
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.execute("SELECT * FROM referrals WHERE id=? FOR UPDATE", [id.data]);
      if (!rows.length) { await c.rollback(); return res.status(404).json({ error: "Referral not found." }); }
      const referral = rows[0], action = body.data.action;
      const [eventRows] = await c.execute("SELECT * FROM referral_events WHERE id=? AND referral_id=? FOR UPDATE", [eventId.data, referral.id]);
      if (!eventRows.length) { await c.rollback(); return res.status(404).json({ error: "Referral qualifying event not found." }); }
      const qualifyingEvent = eventRows[0];
      if (["approve", "reward"].includes(body.data.action)) {
        const validation = await validateReferralEvent(c, referral.referred_user_id, qualifyingEvent.event_type);
        if (!validation.valid) {
          await c.execute("UPDATE referral_events SET outcome='not_qualifying',status='not_qualifying',decision_reason=? WHERE id=?", [validation.reason, qualifyingEvent.id]);
          await c.execute("UPDATE referrals SET status='pending',decision_reason=? WHERE id=?", [validation.reason, referral.id]);
          await c.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,?)", [req.user.id, "referral_eligibility_revalidation_failed", "referral_event", qualifyingEvent.id, validation.reason, JSON.stringify({ referralId: String(referral.id), eventType: qualifyingEvent.event_type, requestedAction: body.data.action })]);
          await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'referral_not_qualifying',?,?),(?,'referral_not_qualifying',?,?)", [referral.referrer_user_id, "A referral reward was not issued because current eligibility could not be verified.", referral.id, referral.referred_user_id, "A referral reward was not issued because current eligibility could not be verified.", referral.id]);
          await c.commit();
          return res.status(409).json({ error: "Current referral eligibility could not be verified. No reward was issued." });
        }
      }
      const expected = { approve: "eligible", reject: ["eligible", "approved"], reward: "approved", reverse: "rewarded" }[action];
      if (Array.isArray(expected) ? !expected.includes(qualifyingEvent.status) : qualifyingEvent.status !== expected) { await c.rollback(); return res.status(409).json({ error: `This referral event cannot be ${action} from its current status.` }); }
      let status = action === "approve" ? "approved" : action === "reject" ? "rejected" : action === "reward" ? "rewarded" : "reversed";
      if (action === "reward") {
        const rewards = [[referral.referrer_user_id, qualifyingEvent.referrer_reward_kobo, "referrer"], [referral.referred_user_id, qualifyingEvent.referred_reward_kobo, "referred"]];
        for (const [userId, amount, recipient] of rewards) if (Number(amount) > 0) await c.execute("INSERT IGNORE INTO referral_reward_ledger(referral_id,referral_event_id,user_id,entry_type,amount_kobo,currency,idempotency_key,metadata) VALUES(?,?,?,'credit',?,'NGN',?,?)", [referral.id, qualifyingEvent.id, userId, amount, `referral:${referral.id}:event:${qualifyingEvent.id}:${recipient}:credit`, JSON.stringify({ qualifyingEvent: qualifyingEvent.event_type, withdrawable: false })]);
      }
      if (action === "reverse") {
        const [credits] = await c.execute("SELECT user_id,amount_kobo,idempotency_key FROM referral_reward_ledger WHERE referral_event_id=? AND entry_type='credit'", [qualifyingEvent.id]);
        for (const credit of credits) await c.execute("INSERT IGNORE INTO referral_reward_ledger(referral_id,referral_event_id,user_id,entry_type,amount_kobo,currency,idempotency_key,metadata) VALUES(?,?,?,'reversal',?,'NGN',?,?)", [referral.id, qualifyingEvent.id, credit.user_id, -Math.abs(Number(credit.amount_kobo)), `${credit.idempotency_key}:reversal`, JSON.stringify({ reason: body.data.reason })]);
      }
      await c.execute("UPDATE referral_events SET status=?,decision_reason=?,approved_by=IF(?='approve',?,approved_by),approved_at=IF(?='approve',UTC_TIMESTAMP(),approved_at),rewarded_at=IF(?='reward',UTC_TIMESTAMP(),rewarded_at),reversed_at=IF(?='reverse',UTC_TIMESTAMP(),reversed_at) WHERE id=?", [status, body.data.reason, action, req.user.id, action, action, action, qualifyingEvent.id]);
      await c.execute("UPDATE referrals SET status=?,qualifying_event=?,decision_reason=?,approved_by=IF(?='approve',?,approved_by),approved_at=IF(?='approve',UTC_TIMESTAMP(),approved_at),rewarded_at=IF(?='reward',UTC_TIMESTAMP(),rewarded_at),reversed_at=IF(?='reverse',UTC_TIMESTAMP(),reversed_at) WHERE id=?", [status, qualifyingEvent.event_type, body.data.reason, action, req.user.id, action, action, action, referral.id]);
      await c.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,?)", [req.user.id, `referral_${action}`, "referral_event", qualifyingEvent.id, body.data.reason, JSON.stringify({ referralId: String(referral.id), eventType: qualifyingEvent.event_type, from: qualifyingEvent.status, to: status })]);
      const type = `referral_${status}`;
      const eventLabel = EVENT_LABELS[qualifyingEvent.event_type];
      const message = ({ approved: `Your ${eventLabel.toLowerCase()} referral event was approved and is awaiting reward issuance.`, rejected: `Your ${eventLabel.toLowerCase()} referral event was not approved.`, rewarded: `A promotional referral reward for ${eventLabel.toLowerCase()} was added to your ShedShare rewards ledger.`, reversed: `A referral reward for ${eventLabel.toLowerCase()} was reversed after review.` })[status];
      await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES(?,?,?,?),(?,?,?,?)", [referral.referrer_user_id, type, message, referral.id, referral.referred_user_id, type, message, referral.id]);
      await c.commit(); return res.json({ id: String(referral.id), eventId: String(qualifyingEvent.id), status });
    } catch (error) { await c.rollback(); console.error("Updating referral status failed:", error.message); return res.status(500).json({ error: "Unable to update referral status." }); }
    finally { c.release(); }
  });
  return router;
}

module.exports = { EVENT_TYPES, DEFAULT_RULES, codeSchema, normalizePhone, getReferralAttribution, insertReferralAttribution, ensureReferralCode, getReferralProgram, recordReferralEvent, createReferralRouter, createAdminReferralRouter };
