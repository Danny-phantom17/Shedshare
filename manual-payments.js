"use strict";

const express = require("express");
const { z } = require("zod");

const id = z.string().regex(/^\d+$/);
const reportSchema = z.object({
  transferReference: z.string().trim().max(120).optional().default(""),
  transferAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional().default("")
}).strict();
const decisionSchema = z.object({ action: z.enum(["confirm", "reject"]), reason: z.string().trim().max(500).optional().default("") }).strict();

function createManualPaymentsRouter({ pool, authenticate }) {
  const router = express.Router();
  router.use(authenticate);

  router.get("/bank-details", async (req, res) => {
    try {
      const [rows] = await pool.execute("SELECT bank_name,account_number,manual_account_name FROM users WHERE id=? LIMIT 1", [req.user.id]);
      return res.json({ bankName: rows[0]?.bank_name || "", accountName: rows[0]?.manual_account_name || "", accountNumber: rows[0]?.account_number || "" });
    } catch (error) { console.error("Loading manual transfer bank details failed:", error.message); return res.status(500).json({ error: "Unable to load bank details." }); }
  });

  router.get("/reports", async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: "Administrator access required." });
    try {
      const [rows] = await pool.execute("SELECT i.id,i.rental_id,i.installment_number,i.amount,i.due_at,i.transfer_reference,i.transfer_at,i.renter_note,i.reported_at,r.item_name,r.owner_id,r.renter_id,l.name lister_name,u.name renter_name FROM rental_manual_installments i JOIN rentals r ON r.id=i.rental_id JOIN users l ON l.id=r.owner_id JOIN users u ON u.id=r.renter_id WHERE i.status='payment_reported' ORDER BY i.reported_at LIMIT 500");
      return res.json(rows.map(x => ({ installmentId:String(x.id),bookingId:String(x.rental_id),itemName:x.item_name,installmentNumber:Number(x.installment_number),amount:Number(x.amount)/100,dueAt:new Date(x.due_at).toISOString(),transferReference:x.transfer_reference,transferAt:x.transfer_at?new Date(x.transfer_at).toISOString():null,note:x.renter_note,reportedAt:x.reported_at?new Date(x.reported_at).toISOString():null,listerName:x.lister_name,renterName:x.renter_name })));
    } catch (error) { console.error("Loading manual transfer reports failed:", error.message); return res.status(500).json({ error: "Unable to load manual transfer reports." }); }
  });

  router.patch("/bank-details", async (req, res) => {
    const body = z.object({ bankName: z.string().trim().min(2).max(120), accountName:z.string().trim().min(2).max(120), accountNumber: z.string().trim().regex(/^\d{10}$/, "Enter a 10-digit account number.") }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message || "Enter valid bank details." });
    try {
      const [current] = await pool.execute("SELECT bank_name,account_number,manual_account_name,subaccount_code FROM users WHERE id=? LIMIT 1", [req.user.id]);
      if (current[0]?.subaccount_code && (current[0].bank_name !== body.data.bankName || current[0].account_number !== body.data.accountNumber || current[0].manual_account_name !== body.data.accountName)) return res.status(409).json({ error: "This account is linked to a Paystack payout subaccount. Contact support before changing the payout bank details." });
      await pool.execute("UPDATE users SET bank_name=?,account_number=?,manual_account_name=? WHERE id=?", [body.data.bankName, body.data.accountNumber, body.data.accountName, req.user.id]);
      return res.json({ bankName: body.data.bankName, accountName:body.data.accountName, accountNumberLast4: body.data.accountNumber.slice(-4) });
    } catch (error) { console.error("Saving manual transfer bank details failed:", error.message); return res.status(500).json({ error: "Unable to save bank details." }); }
  });

  router.get("/rentals/:rentalId", async (req, res) => {
    const rentalId = id.safeParse(req.params.rentalId);
    if (!rentalId.success) return res.status(400).json({ error: "Invalid booking." });
    try {
      const [rentals] = await pool.execute("SELECT id,owner_id,renter_id,item_name,subtotal,platform_fee_percent,status,agreement_version FROM rentals WHERE id=? AND (owner_id=? OR renter_id=?) LIMIT 1", [rentalId.data, req.user.id, req.user.id]);
      if (!rentals.length) return res.status(404).json({ error: "Booking not found." });
      // Do not let an unrelated authenticated user mutate schedule state by probing a booking ID,
      // and do not advance due-state for a booking that has ended or is under dispute.
      if (!["cancelled", "completed", "disputed"].includes(rentals[0].status)) {
        await pool.execute("UPDATE rental_manual_installments SET status='awaiting_payment' WHERE rental_id=? AND status='scheduled' AND due_at<=UTC_TIMESTAMP()", [rentalId.data]);
        await pool.execute("UPDATE rental_manual_installments SET status='overdue' WHERE rental_id=? AND status='awaiting_payment' AND due_at<UTC_TIMESTAMP()", [rentalId.data]);
      }
      const rental = rentals[0];
      const [rows] = await pool.execute("SELECT i.id,i.installment_number,i.amount,i.currency,i.due_at,i.status,i.transfer_reference,i.transfer_at,i.renter_note,i.reported_at,i.confirmed_at,i.rejection_reason,i.bank_name,i.account_name,i.account_number,u.name confirmer_name FROM rental_manual_installments i LEFT JOIN users u ON u.id=i.confirmed_by WHERE i.rental_id=? ORDER BY i.installment_number", [rentalId.data]);
      if (!rows.length) return res.status(409).json({ error: "This booking has no manual transfer schedule." });
      const [events] = await pool.execute("SELECT e.installment_id,e.actor_id,e.event_type,e.note,e.created_at,u.name actor_name FROM rental_manual_payment_events e JOIN users u ON u.id=e.actor_id JOIN rental_manual_installments i ON i.id=e.installment_id WHERE i.rental_id=? ORDER BY e.id", [rentalId.data]);
      const total = rows.reduce((sum, x) => sum + Number(x.amount), 0);
      const confirmed = rows.reduce((sum, x) => sum + (x.status === "confirmed" ? Number(x.amount) : 0), 0);
      const reported = rows.reduce((sum, x) => sum + (x.status === "payment_reported" ? Number(x.amount) : 0), 0);
      const cancelled = rows.reduce((sum, x) => sum + (["cancelled", "refunded"].includes(x.status) ? Number(x.amount) : 0), 0);
      const outstanding = rows.reduce((sum, x) => sum + (!["confirmed", "cancelled", "refunded"].includes(x.status) ? Number(x.amount) : 0), 0);
      const next = rows.find(x => ["scheduled", "awaiting_payment", "overdue", "rejected"].includes(x.status));
      const renterView=String(rental.renter_id)===String(req.user.id),bookingEnded=["cancelled","completed","disputed"].includes(rental.status);
      const installments = rows.map(x => ({ id: String(x.id), number: Number(x.installment_number), amount: Number(x.amount) / 100, currency: x.currency, dueAt: new Date(x.due_at).toISOString(), status: x.status, transferReference: x.transfer_reference, transferAt: x.transfer_at ? new Date(x.transfer_at).toISOString() : null, note: x.renter_note, reportedAt: x.reported_at ? new Date(x.reported_at).toISOString() : null, confirmedAt: x.confirmed_at ? new Date(x.confirmed_at).toISOString() : null, confirmerName: x.confirmer_name || null, rejectionReason: x.rejection_reason, paymentInstructions: renterView && !bookingEnded && !["confirmed","cancelled","refunded"].includes(x.status) ? { bankName: x.bank_name, accountName: x.account_name, accountNumber: x.account_number, bookingReference: `SS-${rental.id}`, transferReference: `SS-${rental.id}-I${x.installment_number}` } : undefined }));
      const paymentStatus=rental.status==="cancelled"?"cancelled":rental.status==="disputed"?"disputed":confirmed>=total?"fully_paid":confirmed?"partially_paid":reported?"payment_confirmation_pending":rows.some(x=>x.status==="overdue")?"overdue":"awaiting_payment";
      return res.json({ bookingId: String(rental.id), itemName: rental.item_name, agreementVersion: rental.agreement_version, bookingStatus: rental.status, isRenter:renterView, isLister:String(rental.owner_id)===String(req.user.id), manualPaymentNotice:"You are transferring this payment directly to the lister. ShedShare records the payment status but does not hold these funds or automatically collect its commission.", paymentStatus, rentalTotal: total / 100, confirmedAmount: confirmed / 100, reportedAmount: reported / 100, cancelledAmount:cancelled/100, outstandingBalance: outstanding / 100, commissionPercent: Number(rental.platform_fee_percent), nextInstallmentId: next ? String(next.id) : null, installments, events: events.map(e => ({ installmentId: String(e.installment_id), actorId: String(e.actor_id), actorName: e.actor_name, type: e.event_type, note: e.note, at: new Date(e.created_at).toISOString() })) });
    } catch (error) { console.error("Loading manual payment schedule failed:", error.message); return res.status(500).json({ error: "Unable to load the booking payment schedule." }); }
  });

  router.post("/installments/:installmentId/report", async (req, res) => {
    const installmentId = id.safeParse(req.params.installmentId), body = reportSchema.safeParse(req.body);
    if (!installmentId.success || !body.success) return res.status(400).json({ error: body.success ? "Invalid installment." : body.error.issues[0]?.message });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT i.*,r.renter_id,r.owner_id,r.status rental_status FROM rental_manual_installments i JOIN rentals r ON r.id=i.rental_id WHERE i.id=? FOR UPDATE", [installmentId.data]);
      if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "Installment not found." }); }
      const row = rows[0];
      if (String(row.renter_id) !== String(req.user.id)) { await connection.rollback(); return res.status(403).json({ error: "Only this booking's renter can report a transfer." }); }
      if (["cancelled", "completed", "disputed"].includes(row.rental_status)) { await connection.rollback(); return res.status(409).json({ error: "This booking no longer accepts payments." }); }
      if (!["scheduled", "awaiting_payment", "overdue", "rejected"].includes(row.status)) {
        if (row.status === "payment_reported") { await connection.commit(); return res.json({ status: row.status, idempotent: true }); }
        await connection.rollback(); return res.status(409).json({ error: "This installment cannot accept another transfer report." });
      }
      const transferAt = body.data.transferAt ? new Date(body.data.transferAt) : null;
      await connection.execute("UPDATE rental_manual_installments SET status='payment_reported',transfer_reference=?,transfer_at=?,renter_note=?,reported_at=UTC_TIMESTAMP(),rejection_reason=NULL WHERE id=?", [body.data.transferReference || null, transferAt ? transferAt.toISOString().slice(0,19).replace("T", " ") : null, body.data.note || null, installmentId.data]);
      await connection.execute("INSERT INTO rental_manual_payment_events(installment_id,actor_id,event_type,note) VALUES(?,?,'reported',?)", [installmentId.data, req.user.id, body.data.note || body.data.transferReference || null]);
      await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'manual_payment_reported',?,?)", [row.owner_id, `The renter reported a bank transfer of ₦${(Number(row.amount) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })} for booking SS-${row.rental_id}. Review your bank account before confirming receipt.`, row.rental_id]);
      await connection.commit();
      return res.json({ status: "payment_reported", confirmed: false });
    } catch (error) { await connection.rollback(); console.error("Reporting manual transfer failed:", error.message); return res.status(500).json({ error: "Unable to report this transfer." }); }
    finally { connection.release(); }
  });

  router.post("/installments/:installmentId/decision", async (req, res) => {
    const installmentId = id.safeParse(req.params.installmentId), body = decisionSchema.safeParse(req.body);
    if (!installmentId.success || !body.success || (body.data.action === "reject" && body.data.reason.length < 4)) return res.status(400).json({ error: body.success ? "A rejection needs a reason of at least 4 characters." : body.error.issues[0]?.message });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT i.*,r.renter_id,r.owner_id,r.id rental_id,r.subtotal,r.platform_fee_percent FROM rental_manual_installments i JOIN rentals r ON r.id=i.rental_id WHERE i.id=? FOR UPDATE", [installmentId.data]);
      if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "Installment not found." }); }
      const row = rows[0], admin = Boolean(req.user.isAdmin);
      if (!admin && String(row.owner_id) !== String(req.user.id)) { await connection.rollback(); return res.status(403).json({ error: "Only the lister or an administrator can review a transfer." }); }
      const [bookingRows] = await connection.execute("SELECT status FROM rentals WHERE id=? FOR UPDATE", [row.rental_id]);
      if (!bookingRows.length || ["cancelled", "completed", "disputed"].includes(bookingRows[0].status)) { await connection.rollback(); return res.status(409).json({ error: "This booking no longer accepts payment updates." }); }
      if (row.status !== "payment_reported") { await connection.rollback(); return res.status(409).json({ error: "Only a reported transfer can be reviewed." }); }
      if (body.data.action === "confirm") {
        const [result] = await connection.execute("UPDATE rental_manual_installments SET status='confirmed',confirmed_at=UTC_TIMESTAMP(),confirmed_by=?,rejection_reason=NULL WHERE id=? AND status='payment_reported'", [req.user.id, installmentId.data]);
        if (result.affectedRows !== 1) { await connection.rollback(); return res.status(409).json({ error: "This transfer was already reviewed." }); }
        await connection.execute("INSERT INTO rental_manual_payment_events(installment_id,actor_id,event_type,note) VALUES(?,?,'confirmed',?)", [installmentId.data, req.user.id, "Receipt checked by recipient; manual confirmation does not mean ShedShare received funds."]);
        const [remaining] = await connection.execute("SELECT COUNT(*) count FROM rental_manual_installments WHERE rental_id=? AND status<>'confirmed' AND status<>'cancelled'", [row.rental_id]);
        if (Number(remaining[0].count) === 0) await connection.execute("UPDATE rentals SET status='confirmed' WHERE id=? AND status='pending_payment' AND payment_verified_at IS NULL", [row.rental_id]);
        await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'manual_payment_confirmed',?,?)", [row.renter_id, `The lister confirmed receipt of installment ${row.installment_number} for booking SS-${row.rental_id}.`, row.rental_id]);
      } else {
        await connection.execute("UPDATE rental_manual_installments SET status='rejected',rejection_reason=?,transfer_reference=NULL,transfer_at=NULL,reported_at=NULL WHERE id=? AND status='payment_reported'", [body.data.reason, installmentId.data]);
        await connection.execute("INSERT INTO rental_manual_payment_events(installment_id,actor_id,event_type,note) VALUES(?,?,'rejected',?)", [installmentId.data, req.user.id, body.data.reason]);
        await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'manual_payment_rejected',?,?)", [row.renter_id, `The lister could not verify installment ${row.installment_number} for booking SS-${row.rental_id}: ${body.data.reason}`, row.rental_id]);
      }
      await connection.commit();
      return res.json({ status: body.data.action === "confirm" ? "confirmed" : "rejected" });
    } catch (error) { await connection.rollback(); console.error("Reviewing manual transfer failed:", error.message); return res.status(500).json({ error: "Unable to review this transfer." }); }
    finally { connection.release(); }
  });

  return router;
}

module.exports = { createManualPaymentsRouter };
