"use strict";

const crypto = require("node:crypto");
const express = require("express");

function paymentLog(reference, result) {
  console.info("Paystack payment event", JSON.stringify({ reference: typeof reference === "string" ? reference.slice(0, 120) : "unknown", result, at: new Date().toISOString() }));
}

function referenceFromUntrustedBody(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return typeof parsed?.data?.reference === "string" ? parsed.data.reference.slice(0, 120) : "unknown";
  } catch (_error) { return "unknown"; }
}

function toKobo(naira) { return Math.round(Number(naira) * 100); }

function createPaymentWebhookRouter({ pool, securityEvents }) {
  const router = express.Router();
  router.post("/paystack/webhook", express.raw({ type: "application/json", limit: "256kb" }), async (request, response) => {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = request.get("x-paystack-signature") || "";
    const rawReference = Buffer.isBuffer(request.body) ? referenceFromUntrustedBody(request.body) : "unknown";
    if (!secret || !Buffer.isBuffer(request.body)) {
      paymentLog(rawReference, "rejected_not_configured_or_missing_raw_body");
      return response.status(503).send("Webhook is not configured.");
    }
    const expected = crypto.createHmac("sha512", secret).update(request.body).digest();
    let received;
    try { received = /^[0-9a-f]{128}$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0); }
    catch (_error) { received = Buffer.alloc(0); }
    if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) {
      paymentLog(rawReference, "rejected_invalid_signature");
      if (securityEvents) await securityEvents.webhookSignatureFailure(request, rawReference);
      return response.status(401).send("Invalid signature.");
    }

    let event;
    try { event = JSON.parse(request.body.toString("utf8")); }
    catch (_error) { paymentLog(rawReference, "rejected_invalid_json"); return response.status(400).send("Invalid JSON."); }
    if (!event || typeof event !== "object" || Array.isArray(event)) { paymentLog(rawReference, "rejected_invalid_event_shape"); return response.status(400).send("Invalid event."); }
    const transaction = event.data;
    const reference = typeof transaction?.reference === "string" ? transaction.reference.slice(0, 120) : "unknown";
    if (event.event === "charge.failed" && reference !== "unknown") {
      try {
        await pool.execute("UPDATE rider_delivery_payment_attempts SET status='failed' WHERE reference=? AND status='initialized'", [reference]);
        await pool.execute("UPDATE rental_payment_attempts SET status='failed' WHERE reference=? AND status<>'success'", [reference]);
        if (securityEvents) await securityEvents.record("payment_failure", request, { details: { reference } });
        paymentLog(reference, "verified_charge_failed");
        return response.status(200).send("Recorded failed payment.");
      } catch (error) {
        console.error("Paystack failed-payment event could not be recorded:", error.message);
        paymentLog(reference, "failed_event_recording_error");
        return response.status(500).send("Unable to record payment event.");
      }
    }
    if (event.event !== "charge.success") { paymentLog(reference, `ignored_${String(event.event || "unknown").slice(0, 50)}`); return response.status(200).send("Ignored."); }
    if (transaction?.metadata?.purpose === "rider_delivery_fee") {
      if (!transaction || typeof transaction !== "object" || Array.isArray(transaction) || typeof transaction.reference !== "string" || transaction.reference.length > 120 || !transaction.metadata.deliveryId) { paymentLog(reference,"rejected_missing_rider_delivery_metadata");return response.status(400).send("Missing delivery payment metadata."); }
      let connection;
      try {
        connection=await pool.getConnection();await connection.beginTransaction();
        const [attemptRows]=await connection.execute("SELECT p.*,d.rider_id AS current_rider_id,d.rider_payment_status,d.status AS delivery_status,r.renter_id AS current_renter_id FROM rider_delivery_payment_attempts p JOIN deliveries d ON d.id=p.delivery_id JOIN rentals r ON r.id=p.rental_id WHERE p.reference=? FOR UPDATE",[transaction.reference]);
        if(!attemptRows.length){await connection.rollback();paymentLog(reference,"rejected_rider_payment_not_found");return response.status(404).send("Delivery payment not found.");}
        const attempt=attemptRows[0];
        if(attempt.status==="success"){await connection.commit();paymentLog(reference,"duplicate_rider_payment_already_processed");return response.status(200).send("Already processed.");}
        if(String(attempt.delivery_id)!==String(transaction.metadata.deliveryId)||String(attempt.rental_id)!==String(transaction.metadata.rentalId)||String(attempt.renter_id)!==String(transaction.metadata.renterId)||String(attempt.rider_id)!==String(transaction.metadata.riderId)||String(attempt.id)!==String(transaction.metadata.paymentAttemptId)||String(attempt.current_rider_id)!==String(attempt.rider_id)||String(attempt.current_renter_id)!==String(attempt.renter_id)||attempt.rider_payment_status!=="pending"||attempt.delivery_status!=="awaiting_collection") { await connection.rollback();paymentLog(reference,"rejected_rider_delivery_state_mismatch");return response.status(409).send("Delivery payment state changed."); }
        const expectedAmount=Number(attempt.amount),commissionPercent=Number(attempt.commission_percent),expectedPlatformFee=Math.round(expectedAmount*commissionPercent/100),expectedRiderPayout=expectedAmount-expectedPlatformFee;
        if(!Number.isFinite(commissionPercent)||commissionPercent<0||commissionPercent>100||Number(attempt.platform_fee)!==expectedPlatformFee||Number(attempt.rider_payout)!==expectedRiderPayout||String(transaction.metadata.commissionPercent)!==commissionPercent.toFixed(2)||String(transaction.metadata.grossDeliveryFeeKobo)!==String(expectedAmount)||String(transaction.metadata.platformFeeKobo)!==String(expectedPlatformFee)||String(transaction.metadata.riderPayoutKobo)!==String(expectedRiderPayout)){await connection.rollback();paymentLog(reference,"rejected_rider_delivery_split_mismatch");return response.status(400).send("Delivery fee split verification failed.");}
        let verifyResponse,verification;
        try{verifyResponse=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(transaction.reference)}`,{headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(10000)});verification=await verifyResponse.json();}
        catch(_error){await connection.rollback();paymentLog(reference,"rider_payment_verification_unavailable");return response.status(503).send("Payment verification is temporarily unavailable.");}
        const verified=verification.data;
        if(!verifyResponse.ok||!verification.status||verified?.status!=="success"||verified?.reference!==transaction.reference||Number(verified?.amount)!==expectedAmount||Number(transaction.amount)!==expectedAmount||verified?.currency!=="NGN"||transaction.currency!=="NGN"||verified?.metadata?.purpose!=="rider_delivery_fee"||String(verified?.metadata?.commissionPercent)!==commissionPercent.toFixed(2)||String(verified?.metadata?.deliveryId)!==String(attempt.delivery_id)||String(verified?.metadata?.rentalId)!==String(attempt.rental_id)||String(verified?.metadata?.renterId)!==String(attempt.renter_id)||String(verified?.metadata?.riderId)!==String(attempt.rider_id)||String(verified?.metadata?.paymentAttemptId)!==String(attempt.id)){await connection.rollback();paymentLog(reference,"rejected_rider_payment_provider_verification");return response.status(400).send("Delivery payment verification failed.");}
        await connection.execute("UPDATE rider_delivery_payment_attempts SET status='success',verified_at=UTC_TIMESTAMP(),provider_payload=? WHERE id=? AND status='initialized'",[JSON.stringify({id:verified.id,status:verified.status,amount:verified.amount,currency:verified.currency,paid_at:verified.paid_at,channel:verified.channel,fees:verified.fees}),attempt.id]);
        const [paid]=await connection.execute("UPDATE deliveries SET rider_payment_status='paid' WHERE id=? AND rider_id=? AND rider_payment_status='pending' AND status='awaiting_collection'",[attempt.delivery_id,attempt.rider_id]);
        if(paid.affectedRows!==1){await connection.rollback();paymentLog(reference,"rider_payment_delivery_changed_during_confirmation");return response.status(409).send("Delivery assignment changed.");}
        const feeNaira=(expectedPlatformFee/100).toLocaleString("en-NG",{minimumFractionDigits:2}),payoutNaira=(expectedRiderPayout/100).toLocaleString("en-NG",{minimumFractionDigits:2});
        await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rider_delivery_paid',?,?),(?,'rider_delivery_paid',?,?)",[attempt.renter_id,`Your rider fee payment was verified. ShedShare received ₦${feeNaira} (${commissionPercent}%); your rider receives ₦${payoutNaira}.`,attempt.delivery_id,attempt.rider_id,`The renter paid your delivery quote. Your Paystack payout is ₦${payoutNaira} after ShedShare's ${commissionPercent}% fee of ₦${feeNaira}.`,attempt.delivery_id]);
        await connection.commit();paymentLog(reference,"rider_delivery_fee_verified_and_split");return response.status(200).send("Verified.");
      }catch(error){if(connection){try{await connection.rollback();}catch(_rollbackError){}}console.error("Rider delivery payment webhook failed:",error.message);paymentLog(reference,"rider_delivery_webhook_processing_error");return response.status(500).send("Unable to process rider payment.");}
      finally{connection?.release();}
    }
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction) || typeof transaction.reference !== "string" || transaction.reference.length > 120 || !transaction.metadata?.rentalId) { paymentLog(reference, "rejected_missing_rental_metadata"); return response.status(400).send("Missing rental metadata."); }

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT r.id, r.item_id, r.status, r.payment_reference, r.subtotal, r.owner_id, r.created_at,r.checkout_expires_at,r.platform_fee_percent,r.platform_fee,r.owner_payout, r.delivery_method, r.delivery_location, r.delivery_latitude, r.delivery_longitude, i.location AS pickup_location, i.latitude AS pickup_latitude, i.longitude AS pickup_longitude, i.name AS item_name, r.renter_id, u.subaccount_code
           FROM rentals r JOIN users u ON u.id = r.owner_id JOIN items i ON i.id=r.item_id WHERE r.id = ? FOR UPDATE`,
        [transaction.metadata.rentalId]
      );
      if (!rows.length) { await connection.rollback(); paymentLog(reference, "rejected_rental_not_found"); return response.status(404).send("Rental not found."); }
      const rental = rows[0];
      if (rental.payment_reference !== transaction.reference || transaction.metadata.purpose !== "rental_fee") {
        await connection.rollback(); paymentLog(reference, "rejected_reference_or_purpose_mismatch"); return response.status(400).send("Payment does not match rental.");
      }
      if (Number(transaction.metadata.itemId) !== Number(rental.item_id) || Number(transaction.metadata.rentalId) !== Number(rental.id) || transaction.metadata.purpose !== "rental_fee") {
        await connection.rollback(); paymentLog(reference, "rejected_event_metadata_mismatch"); return response.status(400).send("Payment verification failed.");
      }
      let verifyResponse, verification;
      try {
        verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(transaction.reference)}`, {
          headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000)
        });
        verification = await verifyResponse.json();
      } catch (_error) {
        await connection.rollback(); paymentLog(reference, "verification_service_unavailable"); return response.status(503).send("Payment verification is temporarily unavailable.");
      }
      const verified = verification.data;
      const expectedAmount = toKobo(rental.subtotal);
      const commissionPercent = Number(rental.platform_fee_percent);
      const expectedPlatformFee = Math.round(expectedAmount * commissionPercent / 100);
      const expectedOwnerPayout = expectedAmount - expectedPlatformFee;
      const storedSplitMatches = Number.isFinite(commissionPercent) && commissionPercent >= 0 && commissionPercent <= 100 && toKobo(rental.platform_fee) === expectedPlatformFee && toKobo(rental.owner_payout) === expectedOwnerPayout;
      if (!verifyResponse.ok || !verification.status || verified?.status !== "success" || verified?.reference !== transaction.reference || Number(verified?.amount) !== expectedAmount || Number(transaction.amount) !== expectedAmount || verified?.currency !== "NGN" || transaction.currency !== "NGN" || String(verified?.metadata?.rentalId) !== String(rental.id) || String(verified?.metadata?.itemId) !== String(rental.item_id) || !storedSplitMatches) {
        await connection.rollback(); paymentLog(reference, "rejected_verify_or_amount_currency_reference_split_mismatch"); return response.status(400).send("Payment verification failed.");
      }
      const [attemptRows] = await connection.execute("SELECT id,rental_id,amount,currency,status FROM rental_payment_attempts WHERE reference=? FOR UPDATE", [transaction.reference]);
      const existingAttempt = attemptRows[0];
      if (existingAttempt && (String(existingAttempt.rental_id) !== String(rental.id) || Number(existingAttempt.amount) !== expectedAmount || existingAttempt.currency !== "NGN")) {
        await connection.rollback(); paymentLog(reference, "rejected_payment_attempt_record_mismatch"); return response.status(409).send("Payment record does not match this rental.");
      }
      if (existingAttempt?.status === "success" && rental.status !== "pending_payment") {
        await connection.commit(); paymentLog(reference, "duplicate_already_processed"); return response.status(200).send("Already processed.");
      }
      if (rental.status !== "pending_payment") {
        await connection.rollback(); paymentLog(reference, "rejected_rental_not_pending"); return response.status(409).send("Rental is no longer payable.");
      }
      if (rental.checkout_expires_at && new Date(rental.checkout_expires_at).getTime() < Date.now()) {
        await connection.execute("UPDATE rentals SET status = 'cancelled' WHERE id = ? AND status = 'pending_payment'", [rental.id]);
        await connection.commit(); paymentLog(reference, "rejected_checkout_expired_after_verification");
        return response.status(409).send("Payment hold expired.");
      }
      if (existingAttempt?.status === "success") {
        await connection.rollback(); paymentLog(reference, "rejected_success_record_with_pending_rental"); return response.status(409).send("Payment record needs review.");
      }
      if (!existingAttempt) {
        await connection.execute("INSERT INTO rental_payment_attempts(rental_id,reference,amount,currency,status) VALUES(?,?,?,'NGN','pending')", [rental.id, transaction.reference, expectedAmount]);
      }
      const [confirmed] = await connection.execute("UPDATE rentals SET status = 'confirmed', payment_verified_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending_payment' AND payment_reference = ?", [rental.id, transaction.reference]);
      if (confirmed.affectedRows !== 1) {
        await connection.rollback(); paymentLog(reference, "rejected_concurrent_state_change"); return response.status(409).send("Rental payment state changed.");
      }
      {
        await connection.execute("UPDATE rental_payment_attempts SET status='success',verified_at=UTC_TIMESTAMP(),provider_payload=? WHERE reference=? AND rental_id=?",[JSON.stringify({id:verified.id,status:verified.status,amount:verified.amount,currency:verified.currency,paid_at:verified.paid_at,channel:verified.channel,fees:verified.fees}),transaction.reference,rental.id]);
        await connection.execute("INSERT IGNORE INTO rental_financial_ledger(rental_id,payment_attempt_id,entry_type,amount,currency,reference,metadata) SELECT ?,id,'payment',?,'NGN',?,JSON_OBJECT('verified',TRUE) FROM rental_payment_attempts WHERE reference=?",[rental.id,Number(verified.amount),`payment:${transaction.reference}`,transaction.reference]);
        await connection.execute("INSERT IGNORE INTO rental_financial_ledger(rental_id,payment_attempt_id,entry_type,amount,currency,reference,metadata) SELECT ?,id,'commission',?,'NGN',?,JSON_OBJECT('commissionPercent',?) FROM rental_payment_attempts WHERE reference=?",[rental.id,expectedPlatformFee,`commission:${transaction.reference}`,commissionPercent,transaction.reference]);
        await connection.execute("INSERT IGNORE INTO rental_financial_ledger(rental_id,payment_attempt_id,entry_type,amount,currency,reference,metadata) SELECT ?,id,'owner_allocation',?,'NGN',?,JSON_OBJECT('settlement','Paystack subaccount','allocationPercent',?) FROM rental_payment_attempts WHERE reference=?",[rental.id,expectedOwnerPayout,`owner:${transaction.reference}`,100-commissionPercent,transaction.reference]);
        if(Number.isFinite(Number(verified.fees)))await connection.execute("INSERT IGNORE INTO rental_financial_ledger(rental_id,payment_attempt_id,entry_type,amount,currency,reference,metadata) SELECT ?,id,'processing_fee',?,'NGN',?,JSON_OBJECT('provider','Paystack') FROM rental_payment_attempts WHERE reference=?",[rental.id,-Number(verified.fees),`processing:${transaction.reference}`,transaction.reference]);
        await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'payment_verified','ShedShare verified your Paystack payment and confirmed the rental.',?),(?,'booking_confirmed','A verified ShedShare payment confirmed this rental.',?)",[rental.renter_id,rental.id,rental.owner_id,rental.id]);
        if (["delivery", "owner_delivery", "rider_delivery"].includes(rental.delivery_method)) {
          if (!rental.delivery_location) { await connection.rollback(); paymentLog(reference, "rejected_missing_delivery_destination"); return response.status(409).send("Delivery destination is missing."); }
          const referenceNumber = `SSD-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
          const riderDelivery = rental.delivery_method === "rider_delivery";
          const [created] = await connection.execute("INSERT IGNORE INTO deliveries (rental_id,pickup_location,dropoff_location,reference_number,status,delivery_method,pickup_latitude,pickup_longitude,dropoff_latitude,dropoff_longitude,offer_expires_at,tracking_ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,IF(?=1,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),NULL),DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? HOUR))", [rental.id, rental.pickup_location, rental.delivery_location, referenceNumber, riderDelivery ? "awaiting_rider" : "requested", riderDelivery ? "rider_delivery" : "owner_delivery", rental.pickup_latitude ?? null, rental.pickup_longitude ?? null, rental.delivery_latitude ?? null, rental.delivery_longitude ?? null, Number(riderDelivery), require("./delivery-config").offerTimeoutMinutes, require("./delivery-config").maxTrackingHours]);
          const [deliveryRows]=await connection.execute("SELECT id,delivery_pin,rider_handover_code_hash FROM deliveries WHERE rental_id=? FOR UPDATE",[rental.id]);
          if(riderDelivery&&deliveryRows.length&&!deliveryRows[0].delivery_pin){
            const code=String(crypto.randomInt(1000,10000)),deliveryId=deliveryRows[0].id;
            const hash=crypto.createHmac("sha256",process.env.JWT_SECRET).update(`${deliveryId}:${code}`).digest("hex");
            await connection.execute("UPDATE deliveries SET delivery_pin=?,rider_handover_code_hash=? WHERE id=?",[code,hash,deliveryId]);
            await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'delivery_handover_code',?,?)",[rental.renter_id,`Give your rider this 4-digit hand-over code when the item arrives: ${code}`,deliveryId]);
          }
          if (created.affectedRows) {
          if (riderDelivery && rental.pickup_latitude != null && rental.pickup_longitude != null) {
              const radius = require("./delivery-config").riderSearchRadiusKm;
              const [nearby] = await connection.execute(`SELECT p.user_id, (6371 * 2 * ASIN(SQRT(POWER(SIN(RADIANS(o.lat-?)/2),2)+COS(RADIANS(?))*COS(RADIANS(o.lat))*POWER(SIN(RADIANS(o.lng-?)/2),2)))) AS distance_km FROM rider_profiles p JOIN rider_online_locations o ON o.rider_id=p.user_id WHERE p.is_approved=TRUE AND p.availability='active' AND p.current_delivery_id IS NULL AND o.updated_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? SECOND) HAVING distance_km<=? ORDER BY distance_km LIMIT 100`, [rental.pickup_latitude, rental.pickup_latitude, rental.pickup_longitude, require("./delivery-config").locationStaleAfterSeconds, radius]);
              for (const rider of nearby) {
                await connection.execute("INSERT IGNORE INTO delivery_offers (delivery_id,rider_id) VALUES (?,?)", [created.insertId, rider.user_id]);
                await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)", [rider.user_id, "delivery_offer", "A nearby ShedShare delivery is available. Open your rider dashboard to review it.", created.insertId]);
              }
            }
            await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)", [rental.renter_id, "delivery_requested", riderDelivery ? `Delivery for ${rental.item_name} is being offered to nearby riders. The delivery fee is paid directly to the rider after delivery.` : `Delivery for ${rental.item_name} has been requested.`, rental.id]);
          }
        }
      }
      await connection.commit();
      paymentLog(reference, "verified_and_confirmed");
      return response.status(200).send("Verified.");
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch (_rollbackError) {} }
      console.error("Paystack webhook processing failed:", error.message);
      paymentLog(reference, "processing_error");
      return response.status(500).send("Unable to process webhook.");
    } finally { connection?.release(); }
  });
  return router;
}

module.exports = { createPaymentWebhookRouter };
