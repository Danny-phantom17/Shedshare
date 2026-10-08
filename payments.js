"use strict";

const crypto = require("node:crypto");
const express = require("express");

function createPaymentWebhookRouter({ pool }) {
  const router = express.Router();
  router.post("/paystack/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (request, response) => {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = request.get("x-paystack-signature") || "";
    if (!secret || !Buffer.isBuffer(request.body)) return response.status(503).send("Webhook is not configured.");
    const expected = crypto.createHmac("sha512", secret).update(request.body).digest();
    let received;
    try { received = Buffer.from(signature, "hex"); } catch (_error) { return response.status(401).send("Invalid signature."); }
    if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) return response.status(401).send("Invalid signature.");

    let event;
    try { event = JSON.parse(request.body.toString("utf8")); }
    catch (_error) { return response.status(400).send("Invalid JSON."); }
    if (event.event !== "charge.success") return response.status(200).send("Ignored.");
    const transaction = event.data;
    if (!transaction?.reference || !transaction.metadata?.rentalId) return response.status(400).send("Missing rental metadata.");

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT r.id, r.item_id, r.status, r.payment_reference, r.subtotal, r.owner_id, r.created_at, u.subaccount_code
           FROM rentals r JOIN users u ON u.id = r.owner_id WHERE r.id = ? FOR UPDATE`,
        [transaction.metadata.rentalId]
      );
      if (!rows.length) { await connection.rollback(); return response.status(404).send("Rental not found."); }
      const rental = rows[0];
      if (rental.status === "cancelled" || rental.status === "completed") {
        await connection.rollback(); return response.status(409).send("Rental is no longer payable.");
      }
      if (rental.status === "pending_payment" && Date.now() - new Date(rental.created_at).getTime() > 30 * 60 * 1000) {
        await connection.execute("UPDATE rentals SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'", [rental.id]);
        await connection.commit();
        return response.status(409).send("Payment hold expired.");
      }
      if (rental.payment_reference !== transaction.reference || transaction.metadata.purpose !== "rental_fee") {
        await connection.rollback(); return response.status(400).send("Payment does not match rental.");
      }
      if (Number(transaction.metadata.itemId) !== Number(rental.item_id) || Number(transaction.metadata.rentalId) !== Number(rental.id) || transaction.metadata.purpose !== "rental_fee") {
        await connection.rollback(); return response.status(400).send("Payment verification failed.");
      }
      const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(transaction.reference)}`, {
        headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000)
      });
      const verification = await verifyResponse.json();
      const verified = verification.data;
      const expectedAmount = Math.round(Number(rental.subtotal) * 100);
      if (!verifyResponse.ok || !verification.status || verified?.status !== "success" || verified?.reference !== transaction.reference || Number(verified?.amount) !== expectedAmount || verified?.currency !== "NGN" || String(verified?.metadata?.rentalId) !== String(rental.id) || String(verified?.metadata?.itemId) !== String(rental.item_id)) {
        await connection.rollback(); return response.status(400).send("Payment verification failed.");
      }
      if (rental.status === "pending_payment") {
        await connection.execute("UPDATE rentals SET status = 'confirmed', payment_verified_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending_payment'", [rental.id]);
      }
      await connection.commit();
      return response.status(200).send("Verified.");
    } catch (error) {
      await connection.rollback();
      console.error("Paystack webhook processing failed:", error.message);
      return response.status(500).send("Unable to process webhook.");
    } finally { connection.release(); }
  });
  return router;
}

module.exports = { createPaymentWebhookRouter };
