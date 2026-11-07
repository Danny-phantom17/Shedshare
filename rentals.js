"use strict";

const express = require("express");
const { z } = require("zod");
const { createCheckoutRateLimiter } = require("./checkout-rate-limit");
const { recordReferralEvent } = require("./referrals");
const { getPaymentMode, isPaystackAvailable, requirePaystackMode, requireValidPaymentMode } = require("./payment-mode");
const { buildInstallmentAmounts } = require("./manual-installment-math");

const AGREEMENT_VERSION = "v1";
const OPEN_STATUSES = ["confirmed", "active"];

const idSchema = z.string().regex(/^\d+$/, "Invalid id.");

const roleSchema = z.enum(["renter", "owner", "admin"], {
  errorMap: () => ({ message: "Role must be renter, owner, or admin." })
});

const createRentalSchema = z.object({
  agreementId: z.string().regex(/^\d+$/, "Invalid rental summary."),
  itemId: z.union([
    z.string().regex(/^\d+$/, "Invalid item id."),
    z.number().int().positive()
  ]).transform(String),
  pricePerUnit: z.number({
    required_error: "Price per unit is required.",
    invalid_type_error: "Price per unit must be a number."
  }).finite().positive("Price per unit must be greater than zero.").max(9999999999.99),
  units: z.number({
    required_error: "Rental period is required.",
    invalid_type_error: "Rental period must be a number."
  }).int("Rental period must be a whole number.").positive("Rental period must be at least 1."),
  pricingUnit: z.enum(["hour","day","week","month","year"]).default("day"),
  inventoryQuantity: z.number().int().min(1).max(10000).default(1),
  startAt: z.string({ required_error: "Choose a start date." }).trim().min(1, "Choose a start date."),
  deliveryMethod: z.enum(["pickup", "owner_delivery", "rider_delivery", "delivery"], {
    errorMap: () => ({ message: "Choose pickup, owner delivery or ShedShare rider delivery." })
  }),
  deliveryLocation: z.string().trim().max(255).optional().default(""),
  deliveryLatitude: z.number().finite().min(4).max(14).optional(),
  deliveryLongitude: z.number().finite().min(2).max(15).optional(),
  paymentReference: z.string().trim().min(8).max(100).optional()
}).strict("Request contains fields that cannot be set.");

const rentalSelectSql = `
  SELECT r.id, r.item_id, r.owner_id, r.renter_id, r.item_name,
         r.price_per_unit, r.units, r.inventory_quantity, r.pricing_unit, r.start_at, r.end_at,
         r.subtotal, r.deposit, r.delivery_method, r.delivery_fee, r.total,
         r.platform_fee_percent, r.platform_fee, r.owner_payout,
         r.agreement_version, r.agreement_accepted, r.accepted_at,
         r.agreement_terms, r.renter_accepted_at, r.owner_accepted_at, r.handover_at, r.return_at, r.payout_status, r.payout_reference,
         (SELECT e.id FROM rental_extensions e WHERE e.rental_id=r.id AND e.status='requested' ORDER BY e.id DESC LIMIT 1) AS pending_extension_id,
         r.status, r.payment_reference, r.payment_verified_at, r.safety_hold, r.safety_hold_reason, r.created_at,
         EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=r.id) AS has_manual_installments,
         (SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=r.id AND mi.status='confirmed') AS manual_amount_confirmed,
         (SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=r.id AND mi.status='payment_reported') AS manual_amount_reported,
         (SELECT COUNT(*) FROM rental_manual_installments mi WHERE mi.rental_id=r.id AND mi.status='overdue') AS manual_overdue_count,
         owner.name AS owner_name, owner.phone AS owner_phone,
         owner.brand AS owner_brand,
         renter.name AS renter_name, renter.phone AS renter_phone,
         item.pickup_address, d.id AS delivery_id, d.status AS delivery_status, d.rider_payment_status AS rider_payment_status,d.rider_commission_percent AS rider_commission_percent,
         EXISTS(SELECT 1 FROM rider_delivery_payment_attempts rp WHERE rp.delivery_id=d.id AND rp.status='initialized') AS rider_payment_checkout_started,
         (SELECT COALESCE(SUM(rp.platform_fee),0)/100 FROM rider_delivery_payment_attempts rp WHERE rp.delivery_id=d.id AND rp.status='success') AS rider_platform_fee,
         (SELECT COUNT(*) FROM delivery_ratings dr WHERE dr.delivery_id=d.id AND dr.renter_id=r.renter_id) AS rider_rated
    FROM rentals r
    JOIN users owner ON owner.id = r.owner_id
    JOIN users renter ON renter.id = r.renter_id
    JOIN items item ON item.id = r.item_id
    LEFT JOIN deliveries d ON d.rental_id = r.id
`;

function firstValidationMessage(result) {
  return result.error.issues[0]?.message || "Invalid request.";
}

function toNaira(kobo) {
  return Number((kobo / 100).toFixed(2));
}

function toKobo(naira) {
  return Math.round(Number(naira) * 100);
}

function mysqlDate(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const normalized = text.includes("T") ? text : text.replace(" ", "T") + "Z";
  return new Date(normalized).toISOString();
}

function addUnits(start, pricingUnit, units) {
  const end = new Date(start.getTime());

  if (pricingUnit === "hour") {
    end.setUTCHours(end.getUTCHours() + units);
  } else if (pricingUnit === "week") {
    end.setUTCDate(end.getUTCDate() + (units * 7));
  } else if (pricingUnit === "day") {
    end.setUTCDate(end.getUTCDate() + units);
  } else {
    const day=end.getUTCDate(),months=pricingUnit==="year"?units*12:units;
    end.setUTCDate(1);end.setUTCMonth(end.getUTCMonth()+months);
    end.setUTCDate(Math.min(day,new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,0)).getUTCDate()));
  }

  return end;
}

function hasInventoryCapacity(capacity, bookedQuantity, blockedQuantity, requestedQuantity) {
  const numbers=[capacity,bookedQuantity,blockedQuantity,requestedQuantity].map(Number);
  return numbers.every(Number.isFinite)&&numbers[0]>=1&&numbers[1]>=0&&numbers[2]>=0&&numbers[3]>=1&&numbers[1]+numbers[2]+numbers[3]<=numbers[0];
}

function calculateRentalSubtotalKobo(unitPriceKobo, durationUnits, inventoryQuantity=1) {
  const total=Number(unitPriceKobo)*Number(durationUnits)*Number(inventoryQuantity);
  return Number.isSafeInteger(total)&&total>0&&total<=999999999999?total:null;
}

async function transitionHandover(req,res,pool,idSchema){const id=idSchema.safeParse(req.params.id),body=z.object({conditionNotes:z.string().max(3000).optional().default("")}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Invalid handover confirmation."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT r.id,r.owner_id,r.renter_id,r.status,r.payment_verified_at,r.safety_hold,EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=r.id) has_manual,(SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=r.id AND mi.status='confirmed') manual_paid,(SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=r.id) manual_total,r.subtotal FROM rentals r WHERE r.id=? FOR UPDATE",[id.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Rental not found."});}const r=rows[0],uid=String(req.user.id),owner=uid===String(r.owner_id),renter=uid===String(r.renter_id);if(!owner&&!renter){await c.rollback();return res.status(403).json({error:"You are not part of this rental."});}const paymentComplete=Boolean(r.payment_verified_at)||(Boolean(r.has_manual)&&Number(r.manual_paid)>=Number(r.manual_total));if(!paymentComplete||!new Set(["confirmed","active"]).has(r.status)||r.safety_hold){await c.rollback();return res.status(409).json({error:"Only a fully paid and confirmed rental can record handover."});}await c.execute("INSERT INTO rental_handover_records(rental_id,record_type,actor_id,condition_notes,confirmed_by_owner_at,confirmed_by_renter_at) VALUES (?,'handover',?,?,?,?) ON DUPLICATE KEY UPDATE condition_notes=CONCAT_WS(' | ',condition_notes,VALUES(condition_notes)),confirmed_by_owner_at=COALESCE(confirmed_by_owner_at,VALUES(confirmed_by_owner_at)),confirmed_by_renter_at=COALESCE(confirmed_by_renter_at,VALUES(confirmed_by_renter_at))",[id.data,req.user.id,body.data.conditionNotes||null,owner?new Date():null,renter?new Date():null]);const [rec]=await c.execute("SELECT confirmed_by_owner_at,confirmed_by_renter_at FROM rental_handover_records WHERE rental_id=? AND record_type='handover'",[id.data]);if(rec[0].confirmed_by_owner_at&&rec[0].confirmed_by_renter_at)await c.execute("UPDATE rentals SET status='active',handover_at=COALESCE(handover_at,UTC_TIMESTAMP()) WHERE id=?",[id.data]);await c.commit();return res.json({confirmed:true,complete:Boolean(rec[0].confirmed_by_owner_at&&rec[0].confirmed_by_renter_at)});}catch(e){await c.rollback();console.error("Recording handover failed:",e.message);return res.status(500).json({error:"Unable to record handover."});}finally{c.release();}}
async function transitionReturn(req,res,pool,idSchema){const id=idSchema.safeParse(req.params.id),body=z.object({conditionNotes:z.string().max(3000).optional().default("")}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Invalid return confirmation."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT id,owner_id,renter_id,status,safety_hold,payment_verified_at,EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id) has_manual,(SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id AND mi.status='confirmed') manual_paid,(SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id) manual_total FROM rentals WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Rental not found."});}const r=rows[0],uid=String(req.user.id),owner=uid===String(r.owner_id),renter=uid===String(r.renter_id);if(!owner&&!renter){await c.rollback();return res.status(403).json({error:"You are not part of this rental."});}if(r.status!=="active"||r.safety_hold){await c.rollback();return res.status(409).json({error:"Only an active rental without a safety hold can record return."});}await c.execute("INSERT INTO rental_handover_records(rental_id,record_type,actor_id,condition_notes,confirmed_by_owner_at,confirmed_by_renter_at) VALUES (?,'return',?,?,?,?) ON DUPLICATE KEY UPDATE condition_notes=CONCAT_WS(' | ',condition_notes,VALUES(condition_notes)),confirmed_by_owner_at=COALESCE(confirmed_by_owner_at,VALUES(confirmed_by_owner_at)),confirmed_by_renter_at=COALESCE(confirmed_by_renter_at,VALUES(confirmed_by_renter_at))",[id.data,req.user.id,body.data.conditionNotes||null,owner?new Date():null,renter?new Date():null]);const [rec]=await c.execute("SELECT confirmed_by_owner_at,confirmed_by_renter_at FROM rental_handover_records WHERE rental_id=? AND record_type='return'",[id.data]);const complete=Boolean(rec[0].confirmed_by_owner_at&&rec[0].confirmed_by_renter_at);if(complete)await c.execute("UPDATE rentals SET status='completed',return_at=UTC_TIMESTAMP() WHERE id=?",[id.data]);await c.commit();const manualPaid=Boolean(r.has_manual)&&Number(r.manual_total)>0&&Number(r.manual_paid)>=Number(r.manual_total);if(complete&&(r.payment_verified_at||manualPaid))await recordReferralEvent(pool,r.renter_id,"first_completed_rental",`first-completed-rental:${r.renter_id}`,{rentalId:String(id.data)}).catch(error=>console.error("Recording completed-rental referral event failed:",error.message));return res.json({confirmed:true,complete});}catch(e){await c.rollback();console.error("Recording return failed:",e.message);return res.status(500).json({error:"Unable to record return."});}finally{c.release();}}
async function openDispute(req,res,pool,idSchema){const id=idSchema.safeParse(req.params.id),body=z.object({reason:z.string().trim().min(5).max(1000)}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Describe the rental issue."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT id,owner_id,renter_id,status,payment_verified_at,EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id) has_manual,(SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id AND mi.status='confirmed') manual_paid,(SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id) manual_total FROM rentals WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Rental not found."});}const r=rows[0];if(![String(r.owner_id),String(r.renter_id)].includes(String(req.user.id))){await c.rollback();return res.status(403).json({error:"You are not part of this rental."});}const manualPaid=Boolean(r.has_manual)&&Number(r.manual_total)>0&&Number(r.manual_paid)>=Number(r.manual_total);if(!(r.payment_verified_at||manualPaid)||!["confirmed","active","completed"].includes(r.status)){await c.rollback();return res.status(409).json({error:"Disputes can be opened for verified rentals only."});}const [open]=await c.execute("SELECT id FROM rental_disputes WHERE rental_id=? AND status IN ('open','reviewing') LIMIT 1 FOR UPDATE",[id.data]);if(open.length){await c.rollback();return res.status(409).json({error:"An unresolved dispute already exists for this rental."});}await c.execute("INSERT INTO rental_disputes(rental_id,opened_by,reason) VALUES(?,?,?)",[id.data,req.user.id,body.data.reason]);await c.execute("UPDATE rentals SET dispute_return_status=status,status='disputed',safety_hold=TRUE,safety_hold_reason=? WHERE id=?",[body.data.reason,id.data]);const other=String(req.user.id)===String(r.owner_id)?r.renter_id:r.owner_id;await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rental_dispute','A dispute was opened for a verified rental.',?),(?,'rental_dispute','Your rental dispute was received.',?)",[other,id.data,req.user.id,id.data]);await c.commit();return res.status(201).json({status:"open"});}catch(e){await c.rollback();console.error("Opening dispute failed:",e.message);return res.status(500).json({error:"Unable to open a dispute."});}finally{c.release();}}async function requestExtension(req,res,pool,idSchema){const id=idSchema.safeParse(req.params.id),body=z.object({proposedEndAt:z.string().datetime(),}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Choose a proposed return time."});try{const [rows]=await pool.execute("SELECT id,owner_id,renter_id,status,end_at,price_per_unit,pricing_unit FROM rentals WHERE id=?",[id.data]);if(!rows.length)return res.status(404).json({error:"Rental not found."});const r=rows[0];if(String(r.renter_id)!==String(req.user.id))return res.status(403).json({error:"Only the renter can request an extension."});if(r.status!=="active"||new Date(body.data.proposedEndAt)<=new Date(r.end_at))return res.status(409).json({error:"Choose a later return time for an active rental."});const [result]=await pool.execute("INSERT INTO rental_extensions(rental_id,requested_by,proposed_end_at,additional_charge) VALUES(?,?,?,?)",[id.data,req.user.id,mysqlDate(new Date(body.data.proposedEndAt)),0]);await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'extension_request','A renter requested more time. Additional charges require a new accepted summary and verified checkout.',?)",[r.owner_id,result.insertId]);return res.status(201).json({id:String(result.insertId),status:"requested"});}catch(e){console.error("Creating extension request failed:",e.message);return res.status(500).json({error:"Unable to request an extension."});}}
async function respondExtension(req,res,pool,idSchema){const id=idSchema.safeParse(req.params.id),extension=idSchema.safeParse(req.params.extensionId),body=z.object({accepted:z.boolean()}).strict().safeParse(req.body);if(!id.success||!extension.success||!body.success)return res.status(400).json({error:"Invalid extension response."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT e.*,r.owner_id,r.renter_id,r.status rental_status FROM rental_extensions e JOIN rentals r ON r.id=e.rental_id WHERE e.id=? AND e.rental_id=? FOR UPDATE",[extension.data,id.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Extension request not found."});}const e=rows[0];if(String(e.owner_id)!==String(req.user.id)){await c.rollback();return res.status(403).json({error:"Only the owner can respond."});}if(e.status!=="requested"||e.rental_status!=="active"){await c.rollback();return res.status(409).json({error:"This extension is no longer pending."});}if(body.data.accepted){await c.rollback();return res.status(409).json({error:"An extension cannot change rental dates until both parties accept revised terms and any additional payment is verified."});}await c.execute("UPDATE rental_extensions SET status='declined' WHERE id=?",[extension.data]);await c.commit();await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'extension_response','Your extension was declined.',?)",[e.renter_id,id.data]);return res.json({status:"declined"});}catch(e){await c.rollback();console.error("Responding to extension failed:",e.message);return res.status(500).json({error:"Unable to respond to an extension."});}finally{c.release();}}

function publicRental(row) {
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    itemName: row.item_name,
    ownerName: row.owner_name,
    ownerId: String(row.owner_id),
    ownerId: String(row.owner_id),
    ownerPhone: "",
    ownerBrand: row.owner_brand || "",
    renterName: row.renter_name,
    renterId: String(row.renter_id),
    renterId: String(row.renter_id),
    renterPhone: "",
    pricePerUnit: Number(row.price_per_unit),
    units: Number(row.units),
    inventoryQuantity:Number(row.inventory_quantity||1),
    pricingUnit: row.pricing_unit,
    startAt: isoDate(row.start_at),
    endAt: isoDate(row.end_at),
    subtotal: Number(row.subtotal),
    deposit: Number(row.deposit),
    deliveryMethod: row.delivery_method,
    deliveryFee: Number(row.delivery_fee),
    total: Number(row.total),
    platformFeePercent: Number(row.platform_fee_percent),
    platformFee: Number(row.platform_fee),
    ownerPayout: Number(row.owner_payout),
    agreementVersion: row.agreement_version,
    agreementAccepted: Boolean(row.agreement_accepted),
    acceptedAt: row.accepted_at ? isoDate(row.accepted_at) : null,
    agreementTerms: row.agreement_terms ? (typeof row.agreement_terms === "string" ? JSON.parse(row.agreement_terms) : row.agreement_terms) : null,
    renterAcceptedAt: row.renter_accepted_at ? isoDate(row.renter_accepted_at) : null,
    ownerAcceptedAt: row.owner_accepted_at ? isoDate(row.owner_accepted_at) : null,
    handoverAt: row.handover_at ? isoDate(row.handover_at) : null,
    returnAt: row.return_at ? isoDate(row.return_at) : null,
    payoutStatus: row.payout_status || "not_due",
    payoutReference: row.payout_reference || "",
    pendingExtensionId: row.pending_extension_id==null?null:String(row.pending_extension_id),
    status: row.status,
    createdAt: row.created_at ? isoDate(row.created_at) : null,
    paymentVerified: Boolean(row.payment_verified_at),
    paymentComplete:Boolean(row.payment_verified_at)||(Boolean(row.has_manual_installments)&&Number(row.manual_amount_confirmed||0)>=toKobo(row.subtotal)),
    manualPayment: Boolean(row.has_manual_installments),
    manualAmountConfirmed: Number(row.manual_amount_confirmed||0)/100,
    manualAmountReported: Number(row.manual_amount_reported||0)/100,
    manualPaymentStatus: !row.has_manual_installments?null:Number(row.manual_amount_confirmed||0)>=toKobo(row.subtotal)?"fully_paid":Number(row.manual_amount_confirmed||0)>0?"partially_paid":Number(row.manual_amount_reported||0)>0?"payment_confirmation_pending":Number(row.manual_overdue_count||0)>0?"overdue":"awaiting_payment",
    onHold: Boolean(row.safety_hold),
    holdReason: row.safety_hold_reason || "",
    paymentReference: row.payment_reference || "",
    deliveryId: row.delivery_id == null ? null : String(row.delivery_id),
    deliveryStatus: row.delivery_status || null,
    riderPaymentStatus: row.rider_payment_status || "not_required",
    riderCommissionPercent: Number(row.rider_commission_percent ?? 5),
    riderPaymentCheckoutStarted: Boolean(row.rider_payment_checkout_started),
    riderPlatformFee: Number(row.rider_platform_fee || 0),
    riderRated: Boolean(row.rider_rated),
    pickupAddress: String(row.renter_id) !== String(row.owner_id) && ["confirmed", "active", "completed"].includes(row.status) ? (row.pickup_address || "") : "",
    ownerPhone: row.status === "pending_payment" ? "" : (row.owner_phone || ""),
    renterPhone: row.status === "pending_payment" ? "" : (row.renter_phone || "")
  };
}

async function findRental(executor, id) {
  const [rows] = await executor.execute(
    `${rentalSelectSql} WHERE r.id = ? LIMIT 1`,
    [id]
  );

  return rows[0] ? publicRental(rows[0]) : null;
}

function createRentalsRouter({ pool, authenticate }) {
  if (!pool) throw new Error("A rental database pool is required.");
  if (typeof authenticate !== "function") throw new Error("Rental authentication middleware is required.");

  const router = express.Router();
  const checkoutRateLimiter = createCheckoutRateLimiter(pool);

  router.get("/items/:id/bookings", async (request, response) => {
    const parsedId = idSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      return response.status(400).json({ error: firstValidationMessage(parsedId) });
    }

    try {
      const [itemRows] = await pool.execute(
        "SELECT id FROM items WHERE id = ? LIMIT 1",
        [parsedId.data]
      );

      if (itemRows.length === 0) {
        return response.status(404).json({ error: "Item not found." });
      }

      const [rows] = await pool.execute(
        `SELECT start_at, end_at, inventory_quantity quantity, 'booking' source
           FROM rentals
          WHERE item_id = ?
            AND (status IN ('confirmed', 'active') OR (status='pending_payment' AND COALESCE(checkout_expires_at,DATE_ADD(created_at,INTERVAL 30 MINUTE))>UTC_TIMESTAMP()))
         UNION ALL
         SELECT start_at,end_at,COALESCE(quantity, (SELECT available_quantity FROM items WHERE id=?)) quantity,status source
           FROM item_availability_blocks WHERE item_id=?
         ORDER BY start_at ASC`,
        [parsedId.data,parsedId.data,parsedId.data]
      );

      return response.status(200).json(rows.map((row) => ({
        startAt: isoDate(row.start_at),
        endAt: isoDate(row.end_at),quantity:Number(row.quantity||1),source:row.source
      })));
    } catch (error) {
      console.error("Loading item bookings failed:", error.message);
      return response.status(500).json({ error: "Unable to load bookings." });
    }
  });

  router.get("/rentals/:id/receipt",authenticate,async(request,response)=>{const id=idSchema.safeParse(request.params.id);if(!id.success)return response.status(400).json({error:"Invalid rental."});try{const [rows]=await pool.execute(`SELECT r.id,r.item_name,r.owner_id,r.renter_id,r.price_per_unit,r.units,r.inventory_quantity,r.pricing_unit,r.start_at,r.end_at,r.subtotal,r.total,r.deposit,r.informational_deposit,r.delivery_method,r.delivery_fee,r.platform_fee_percent,r.platform_fee,r.owner_payout,r.payment_reference,r.payment_verified_at,r.status,r.agreement_terms,r.agreement_version,owner.name owner_name,renter.name renter_name FROM rentals r JOIN users owner ON owner.id=r.owner_id JOIN users renter ON renter.id=r.renter_id WHERE r.id=? AND (r.owner_id=? OR r.renter_id=?) LIMIT 1`,[id.data,request.user.id,request.user.id]);if(!rows.length)return response.status(404).json({error:"Rental receipt not found."});const row=rows[0];let paidAt=row.payment_verified_at,paymentMethod="Paystack";if(!paidAt){const [inst]=await pool.execute("SELECT COUNT(*) count,SUM(status='confirmed') confirmed,MAX(confirmed_at) paid_at FROM rental_manual_installments WHERE rental_id=?",[id.data]);if(!Number(inst[0]?.count)||Number(inst[0].count)!==Number(inst[0].confirmed))return response.status(409).json({error:"A payment receipt is available after all installment payments are confirmed by the lister."});paidAt=inst[0].paid_at;paymentMethod="Manual bank transfer, confirmed by the lister";}let terms=row.agreement_terms;try{if(typeof terms==="string")terms=JSON.parse(terms);}catch{terms=null;}return response.json({receiptNumber:`SS-${row.id}-${paymentMethod==="Paystack"?String(row.payment_reference||"").slice(-8):"MANUAL"}`,paymentReference:row.payment_reference||`SS-${row.id}`,paymentMethod,paidAt:isoDate(paidAt),status:row.status,itemName:row.item_name,ownerName:row.owner_name,renterName:row.renter_name,startAt:isoDate(row.start_at),endAt:isoDate(row.end_at),pricingUnit:row.pricing_unit,periodUnits:Number(row.units),inventoryQuantity:Number(row.inventory_quantity||1),pricePerUnit:Number(row.price_per_unit),rentalSubtotal:Number(row.subtotal),platformFee:Number(row.platform_fee),platformFeePercent:Number(row.platform_fee_percent),ownerPayout:Number(row.owner_payout),deliveryMethod:row.delivery_method,deliveryFee:Number(row.delivery_fee),informationalDeposit:Number(row.informational_deposit??row.deposit??0),platformAmount:Number(row.subtotal),total:Number(row.total),currency:"NGN",agreementVersion:row.agreement_version,agreementTerms:terms});}catch(error){console.error("Loading rental transaction receipt failed:",error.message);return response.status(500).json({error:"Unable to load transaction receipt."});}});

  router.post("/rental-summaries",authenticate,async(req,res)=>{
    const body=z.object({itemId:idSchema,startAt:z.string().datetime(),units:z.number().int().positive(),pricingUnit:z.enum(["hour","day","week","month","year"]).default("day"),inventoryQuantity:z.number().int().min(1).max(10000).default(1),pricePerUnit:z.number().finite().positive().max(9999999999.99),deliveryMethod:z.enum(["pickup","owner_delivery","rider_delivery"]),deliveryLocation:z.string().max(255).optional().default(""),paymentPlan:z.enum(["full","deposit_balance"]).default("full")}).strict().safeParse(req.body);
    if(!body.success)return res.status(400).json({error:body.error.issues[0]?.message||"Check the rental details."});
    if(!req.user.emailVerified)return res.status(403).json({error:"Verify your email before sending a rental summary."});
    try{
      const [items]=await pool.execute("SELECT id,owner_id,name,price,pricing_unit,min_period,max_period,available_quantity,deposit,delivery_available,rider_delivery_available,delivery_fee,cancellation_policy,rental_conditions,known_defects,installment_enabled,installment_deposit_percent,paused,moderation_status FROM items WHERE id=?",[body.data.itemId]);
      if(!items.length)return res.status(404).json({error:"Listing not found."});const i=items[0];if(String(i.owner_id)===String(req.user.id))return res.status(403).json({error:"You cannot rent your own listing."});if(i.paused||i.moderation_status!=="approved")return res.status(409).json({error:"This listing is not available for rental."});
      const [rateRows]=await pool.execute("SELECT price,min_period,max_period FROM item_pricing_options WHERE item_id=? AND pricing_unit=?",[i.id,body.data.pricingUnit]);const rate=rateRows[0];if(!rate)return res.status(400).json({error:"This listing does not support that rental period."});if(body.data.units<Number(rate.min_period)||body.data.units>Number(rate.max_period))return res.status(400).json({error:"Choose a duration within the selected rental period limits."});if(body.data.inventoryQuantity>Number(i.available_quantity||1))return res.status(400).json({error:"Requested quantity exceeds listing availability."});
      const price=toKobo(body.data.pricePerUnit);if(price<=0)return res.status(400).json({error:"Rental price must be greater than zero."});
      if(body.data.deliveryMethod==="owner_delivery"&&!i.delivery_available)return res.status(400).json({error:"Owner delivery is unavailable for this listing."});
      if(body.data.deliveryMethod==="rider_delivery"&&!i.rider_delivery_available)return res.status(400).json({error:"ShedShare rider delivery is unavailable for this listing."});
      const start=new Date(body.data.startAt);if(start<=new Date())return res.status(400).json({error:"Choose a future start time."});const end=addUnits(start,body.data.pricingUnit,body.data.units);const subtotal=calculateRentalSubtotalKobo(price,body.data.units,body.data.inventoryQuantity);if(subtotal==null)return res.status(400).json({error:"The rental amount exceeds the supported transaction limit."});const deliveryFee=body.data.deliveryMethod==="owner_delivery"?toKobo(i.delivery_fee):0;const [commissionRows]=await pool.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='rental_commission_percent' LIMIT 1");const commissionPercent=isPaystackAvailable()?Number(commissionRows[0]?.setting_value??15):0;if(!Number.isFinite(commissionPercent)||commissionPercent<0||commissionPercent>100)return res.status(503).json({error:"Rental commission settings are invalid. Contact ShedShare support."});
  const balanceDue=new Date(start.getTime()-24*60*60*1000),canInstall=Boolean(i.installment_enabled)&&body.data.paymentPlan==="deposit_balance"&&balanceDue.getTime()>Date.now();if(body.data.paymentPlan==="deposit_balance"&&(!i.installment_enabled||!canInstall||getPaymentMode()!=="manual"))return res.status(409).json({error:"This listing cannot use the offered installment schedule for these dates."});const terms={listingId:String(i.id),itemName:i.name,renterId:String(req.user.id),ownerId:String(i.owner_id),startAt:start.toISOString(),endAt:end.toISOString(),units:body.data.units,inventoryQuantity:body.data.inventoryQuantity,pricingUnit:body.data.pricingUnit,pricePerUnit:toNaira(price),subtotal:toNaira(subtotal),deliveryMethod:body.data.deliveryMethod,deliveryFee:toNaira(deliveryFee),directDeliveryFee:toNaira(deliveryFee),platformCheckoutAmount:toNaira(subtotal),totalEstimatedCost:toNaira(subtotal+deliveryFee),informationalDeposit:toNaira(toKobo(i.deposit)),platformCommission:toNaira(Math.round(subtotal*commissionPercent/100)),platformCommissionPercent:commissionPercent,totalPayable:toNaira(subtotal+deliveryFee),paymentSchedule:canInstall?{type:"deposit_balance",depositPercent:Number(i.installment_deposit_percent||50),balanceDueAt:balanceDue.toISOString(),currency:"NGN"}:{type:"full",depositPercent:100,balanceDueAt:start.toISOString(),currency:"NGN"},cancellationPolicy:i.cancellation_policy||"Contact ShedShare support to discuss cancellation requests.",rentalConditions:i.rental_conditions||"Follow the listing conditions and return the item by the agreed deadline.",knownDefects:i.known_defects||"None listed",deliveryLocation:body.data.deliveryLocation,deliveryLatitude:body.data.deliveryLatitude??null,deliveryLongitude:body.data.deliveryLongitude??null,processingFee:null,processingFeeDisclosure:"Provider fees, if any, are determined by the configured payment method and disclosed before payment."};
      const connection=await pool.getConnection();try{await connection.beginTransaction();const [rental]=await connection.execute("INSERT INTO rentals(item_id,owner_id,renter_id,item_name,price_per_unit,units,inventory_quantity,pricing_unit,start_at,end_at,subtotal,deposit,delivery_method,delivery_fee,total,platform_fee_percent,platform_fee,owner_payout,agreement_version,status,payment_reference,delivery_location,delivery_latitude,delivery_longitude,informational_deposit) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?, ?,?,?,?,'inquiry',NULL,?,NULL,NULL,?)",[i.id,i.owner_id,req.user.id,i.name,toNaira(price),body.data.units,body.data.inventoryQuantity,body.data.pricingUnit,mysqlDate(start),mysqlDate(end),toNaira(subtotal),body.data.deliveryMethod,toNaira(deliveryFee),toNaira(subtotal+deliveryFee),commissionPercent,toNaira(Math.round(subtotal*commissionPercent/100)),toNaira(subtotal-Math.round(subtotal*commissionPercent/100)),"draft",body.data.deliveryLocation||null,toNaira(toKobo(i.deposit))]);
        const rentalId=rental.insertId;const [versions]=await connection.execute("SELECT COALESCE(MAX(version),0)+1 AS next_version FROM rental_agreement_versions WHERE rental_id=?",[rentalId]);const serialized=JSON.stringify(terms);const hash=require("node:crypto").createHash("sha256").update(serialized).digest("hex");const [version]=await connection.execute("INSERT INTO rental_agreement_versions(rental_id,version,terms,terms_hash,created_by,status,expires_at) VALUES(?,?,?,?,?,'pending',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 48 HOUR))",[rentalId,versions[0].next_version,serialized,hash,req.user.id]);const key=require("node:crypto").createHash("sha256").update(`item:${i.id}:${i.owner_id}:${req.user.id}`).digest("hex");await connection.execute("INSERT INTO conversations(conversation_key,kind,item_id,rental_id,created_by) VALUES(?,'item',?,?,?) ON DUPLICATE KEY UPDATE rental_id=VALUES(rental_id)",[key,i.id,rentalId,req.user.id]);const [conversation]=await connection.execute("SELECT id FROM conversations WHERE conversation_key=?",[key]);await connection.execute("INSERT IGNORE INTO conversation_participants(conversation_id,user_id) VALUES(?,?),(?,?)",[conversation[0].id,i.owner_id,conversation[0].id,req.user.id]);await connection.commit();await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'agreement_ready','A renter sent you a rental summary to review. It expires in 48 hours.',?)",[i.owner_id,rentalId]);return res.status(201).json({rentalId:String(rentalId),agreementId:String(version.insertId),version:Number(versions[0].next_version),terms});
      }catch(e){await connection.rollback();throw e;}finally{connection.release();}
    }catch(e){console.error("Creating rental summary failed:",e.message);return res.status(500).json({error:"Unable to prepare the rental summary."});}
  });

  router.post("/rental-summaries/:id/accept",authenticate,async(req,res)=>{
    const agreementId=idSchema.safeParse(req.params.id);if(!agreementId.success)return res.status(400).json({error:"Invalid rental summary."});const body=z.object({accepted:z.literal(true)}).strict().safeParse(req.body);if(!body.success)return res.status(400).json({error:"Confirm acceptance of the rental summary."});
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [rows]=await connection.execute("SELECT av.*,r.renter_id,r.owner_id,r.id rental_id,r.status rental_status,(av.expires_at IS NULL OR av.expires_at>UTC_TIMESTAMP()) offer_current FROM rental_agreement_versions av JOIN rentals r ON r.id=av.rental_id WHERE av.id=? FOR UPDATE",[agreementId.data]);if(!rows.length){await connection.rollback();return res.status(404).json({error:"Rental summary not found."});}const a=rows[0],uid=String(req.user.id);if(uid!==String(a.renter_id)&&uid!==String(a.owner_id)){await connection.rollback();return res.status(403).json({error:"You are not part of this agreement."});}if(a.rental_status!=="inquiry"){await connection.rollback();return res.status(409).json({error:"Terms cannot be changed after checkout begins."});}const [latest]=await connection.execute("SELECT id FROM rental_agreement_versions WHERE rental_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE",[a.rental_id]);if(!latest.length||String(latest[0].id)!==String(a.id)||!["pending","accepted"].includes(a.status)){await connection.rollback();return res.status(409).json({error:"This offer has been rejected, superseded, or is no longer current."});}if(!a.offer_current){await connection.execute("UPDATE rental_agreement_versions SET status='expired' WHERE id=? AND status='pending'",[a.id]);await connection.commit();return res.status(409).json({error:"This offer has expired. Ask the other party for a new proposal."});}const col=uid===String(a.renter_id)?"renter_accepted_at":"owner_accepted_at",alreadyAccepted=Boolean(a[col]);await connection.execute(`UPDATE rental_agreement_versions SET ${col}=COALESCE(${col},UTC_TIMESTAMP()) WHERE id=?`,[agreementId.data]);const [updated]=await connection.execute("SELECT renter_accepted_at,owner_accepted_at,terms FROM rental_agreement_versions WHERE id=?",[agreementId.data]);const ready=Boolean(updated[0].renter_accepted_at&&updated[0].owner_accepted_at);if(ready){let terms=typeof updated[0].terms==="string"?JSON.parse(updated[0].terms):updated[0].terms;await connection.execute("UPDATE rental_agreement_versions SET status='accepted' WHERE id=? AND status='pending'",[agreementId.data]);await connection.execute("UPDATE rentals SET agreement_accepted=TRUE,accepted_at=UTC_TIMESTAMP(),agreement_version=?,agreement_terms=?,renter_accepted_at=?,owner_accepted_at=? WHERE id=?",[String(a.version),JSON.stringify(terms),updated[0].renter_accepted_at,updated[0].owner_accepted_at,a.rental_id]);}await connection.commit();if(!alreadyAccepted){const recipient=uid===String(a.renter_id)?a.owner_id:a.renter_id;await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'agreement_response',?,?)",[recipient,ready?"Both parties accepted the rental terms. Continue to checkout when ready.":"The other party accepted the rental terms.",a.rental_id]);}return res.json({accepted:true,ready,rentalId:String(a.rental_id)});}catch(e){await connection.rollback();console.error("Agreement acceptance failed:",e.message);return res.status(500).json({error:"Unable to record acceptance."});}finally{connection.release();}
  });

  router.post("/rental-summaries/:id/reject",authenticate,async(req,res)=>{
    const offerId=idSchema.safeParse(req.params.id),body=z.object({reason:z.string().trim().max(500).optional().default("")}).strict().safeParse(req.body);
    if(!offerId.success||!body.success)return res.status(400).json({error:"Invalid offer response."});
    const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT av.id,av.rental_id,av.status,av.created_by,av.expires_at,(av.expires_at IS NULL OR av.expires_at>UTC_TIMESTAMP()) offer_current,r.owner_id,r.renter_id,r.status rental_status FROM rental_agreement_versions av JOIN rentals r ON r.id=av.rental_id WHERE av.id=? FOR UPDATE",[offerId.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Rental offer not found."});}const offer=rows[0],uid=String(req.user.id);if(![String(offer.owner_id),String(offer.renter_id)].includes(uid)){await c.rollback();return res.status(403).json({error:"You are not part of this negotiation."});}if(uid===String(offer.created_by)){await c.rollback();return res.status(403).json({error:"Only the other party can reject this offer."});}const [latest]=await c.execute("SELECT id FROM rental_agreement_versions WHERE rental_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE",[offer.rental_id]);if(offer.rental_status!=="inquiry"||!latest.length||String(latest[0].id)!==String(offer.id)||offer.status!=="pending"||!offer.offer_current){if(offer.status==="pending"&&!offer.offer_current)await c.execute("UPDATE rental_agreement_versions SET status='expired' WHERE id=? AND status='pending'",[offer.id]);await c.commit();return res.status(409).json({error:"This offer is expired or no longer current."});}await c.execute("UPDATE rental_agreement_versions SET status='rejected' WHERE id=? AND status='pending'",[offer.id]);await c.execute("UPDATE rentals SET agreement_accepted=FALSE,renter_accepted_at=NULL,owner_accepted_at=NULL,agreement_terms=NULL WHERE id=? AND status='inquiry'",[offer.rental_id]);const recipient=String(offer.owner_id)===uid?offer.renter_id:offer.owner_id;await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rental_offer_rejected',?,?)",[recipient,`The other party rejected the rental price offer.${body.data.reason?` Reason: ${body.data.reason}`:""}`,offer.rental_id]);await c.commit();return res.json({status:"rejected",rentalId:String(offer.rental_id)});}catch(error){await c.rollback();console.error("Rejecting rental offer failed:",error.message);return res.status(500).json({error:"Unable to reject this offer."});}finally{c.release();}
  });

  router.post("/rentals/:id/propose",authenticate,async(req,res)=>{
    const rentalId=idSchema.safeParse(req.params.id),body=z.object({pricePerUnit:z.number().finite().positive().max(9999999999.99)}).strict().safeParse(req.body);if(!rentalId.success||!body.success)return res.status(400).json({error:"Enter a valid rental price proposal."});
    const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT id,renter_id,owner_id,status,pricing_unit FROM rentals WHERE id=? FOR UPDATE",[rentalId.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Rental negotiation not found."});}const rental=rows[0];if(String(rental.renter_id)!==String(req.user.id)){await c.rollback();return res.status(403).json({error:"Only the renter can submit another price proposal."});}if(rental.status!=="inquiry"){await c.rollback();return res.status(409).json({error:"This negotiation is no longer open."});}const [current]=await c.execute("SELECT id,version,terms,status FROM rental_agreement_versions WHERE rental_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE",[rental.id]);if(!current.length||!["rejected","expired"].includes(current[0].status)){await c.rollback();return res.status(409).json({error:"A new proposal is available after the current offer is rejected or expires."});}const previous=typeof current[0].terms==="string"?JSON.parse(current[0].terms):current[0].terms,priceKobo=toKobo(body.data.pricePerUnit),subtotalKobo=calculateRentalSubtotalKobo(priceKobo,Number(previous.units),Number(previous.inventoryQuantity||1));if(subtotalKobo==null||subtotalKobo<=0){await c.rollback();return res.status(400).json({error:"The proposed rental total is outside the supported payment range."});}const feeKobo=Math.round(subtotalKobo*Number(previous.platformCommissionPercent||0)/100),deliveryKobo=toKobo(Number(previous.deliveryFee||0)),terms={...previous,pricePerUnit:toNaira(priceKobo),subtotal:toNaira(subtotalKobo),platformCheckoutAmount:toNaira(subtotalKobo),totalEstimatedCost:toNaira(subtotalKobo+deliveryKobo),totalPayable:toNaira(subtotalKobo+deliveryKobo),platformCommission:toNaira(feeKobo),counterofferTo:Number(previous.pricePerUnit)};const serialized=JSON.stringify(terms),hash=require("node:crypto").createHash("sha256").update(serialized).digest("hex"),version=Number(current[0].version)+1;const [created]=await c.execute("INSERT INTO rental_agreement_versions(rental_id,version,terms,terms_hash,created_by,status,expires_at) VALUES(?,?,?,?,?,'pending',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 48 HOUR))",[rental.id,version,serialized,hash,req.user.id]);await c.execute("UPDATE rentals SET price_per_unit=?,subtotal=?,total=?,platform_fee=?,owner_payout=?,agreement_accepted=FALSE,renter_accepted_at=NULL,owner_accepted_at=NULL,agreement_terms=NULL WHERE id=?",[toNaira(priceKobo),toNaira(subtotalKobo),terms.totalPayable,terms.platformCommission,toNaira(subtotalKobo-feeKobo),rental.id]);await c.commit();await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rental_price_proposal',?,?)",[rental.owner_id,`The renter proposed ₦${toNaira(priceKobo).toLocaleString("en-NG")} per ${rental.pricing_unit}. Review the updated terms within 48 hours.`,rental.id]);return res.status(201).json({agreementId:String(created.insertId),version,status:"pending",pricePerUnit:toNaira(priceKobo)});}catch(error){await c.rollback();console.error("Submitting another rental price proposal failed:",error.message);return res.status(500).json({error:"Unable to submit another price proposal."});}finally{c.release();}
  });

  // A lister counteroffer is a new immutable agreement version. Neither side's
  // acceptance of an earlier price carries over to the new version.
  router.post("/rentals/:id/counteroffer",authenticate,async(req,res)=>{
    const rentalId=idSchema.safeParse(req.params.id),body=z.object({pricePerUnit:z.number().finite().positive().max(9999999999.99)}).strict().safeParse(req.body);
    if(!rentalId.success||!body.success)return res.status(400).json({error:"Enter a valid counteroffer amount."});
    const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT r.*,i.name listing_name FROM rentals r JOIN items i ON i.id=r.item_id WHERE r.id=? FOR UPDATE",[rentalId.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Rental negotiation not found."});}const r=rows[0];if(String(r.owner_id)!==String(req.user.id)){await c.rollback();return res.status(403).json({error:"Only the lister can submit a counteroffer."});}if(r.status!=="inquiry"){await c.rollback();return res.status(409).json({error:"This negotiation is no longer open."});}const [current]=await c.execute("SELECT id,version,terms,status,created_by,(expires_at IS NULL OR expires_at>UTC_TIMESTAMP()) offer_current FROM rental_agreement_versions WHERE rental_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE",[r.id]);if(!current.length){await c.rollback();return res.status(409).json({error:"No renter proposal exists yet."});}if(!["pending","accepted"].includes(current[0].status)||String(current[0].created_by)===String(req.user.id)){await c.rollback();return res.status(409).json({error:"The current offer is no longer open for a counteroffer."});}if(!current[0].offer_current){await c.execute("UPDATE rental_agreement_versions SET status='expired' WHERE id=? AND status='pending'",[current[0].id]);await c.commit();return res.status(409).json({error:"This offer has expired. Ask the renter to send a new proposal."});}const previous=typeof current[0].terms==="string"?JSON.parse(current[0].terms):current[0].terms;const oldPrice=Number(previous.pricePerUnit);const price=Number(body.data.pricePerUnit);const subtotal=Number((price*Number(previous.units)*Number(previous.inventoryQuantity||1)).toFixed(2));const terms={...previous,pricePerUnit:price,subtotal,platformCheckoutAmount:subtotal,totalEstimatedCost:Number((subtotal+Number(previous.deliveryFee||0)).toFixed(2)),totalPayable:Number((subtotal+Number(previous.deliveryFee||0)).toFixed(2)),platformCommission:Number((subtotal*Number(previous.platformCommissionPercent||0)/100).toFixed(2)),counterofferTo:oldPrice};const serialized=JSON.stringify(terms),hash=require("node:crypto").createHash("sha256").update(serialized).digest("hex"),version=Number(current[0].version)+1;await c.execute("UPDATE rental_agreement_versions SET status='superseded' WHERE id=? AND status IN ('pending','accepted')",[current[0].id]);const [created]=await c.execute("INSERT INTO rental_agreement_versions(rental_id,version,terms,terms_hash,created_by,status,expires_at) VALUES(?,?,?,?,?,'pending',DATE_ADD(UTC_TIMESTAMP(),INTERVAL 48 HOUR))",[r.id,version,serialized,hash,req.user.id]);await c.execute("UPDATE rentals SET price_per_unit=?,subtotal=?,total=?,platform_fee=?,owner_payout=?,agreement_accepted=FALSE,renter_accepted_at=NULL,owner_accepted_at=NULL,agreement_terms=NULL WHERE id=?",[price,subtotal,terms.totalPayable,terms.platformCommission,Number((subtotal-terms.platformCommission).toFixed(2)),r.id]);await c.commit();await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rental_counteroffer',?,?)",[r.renter_id,`The lister counteroffered ₦${price.toLocaleString("en-NG")} per ${r.pricing_unit}. Review the new terms within 48 hours.`,r.id]);return res.status(201).json({agreementId:String(created.insertId),version,previousPrice:oldPrice,pricePerUnit:price,status:"pending"});}catch(e){await c.rollback();console.error("Creating rental counteroffer failed:",e.message);return res.status(500).json({error:"Unable to submit counteroffer."});}finally{c.release();}
  });

  router.post("/inspections",authenticate,async(req,res)=>{
    const body=z.object({itemId:idSchema,proposedAt:z.string().datetime(),meetingLocation:z.string().trim().min(4).max(255)}).strict().safeParse(req.body);if(!body.success)return res.status(400).json({error:"Choose a listing, future inspection time, and meeting location."});try{const [items]=await pool.execute("SELECT id,owner_id,paused FROM items WHERE id=?",[body.data.itemId]);if(!items.length)return res.status(404).json({error:"Listing not found."});if(String(items[0].owner_id)===String(req.user.id))return res.status(403).json({error:"You cannot request an inspection for your own listing."});if(items[0].paused)return res.status(409).json({error:"This listing is unavailable for new requests."});const proposed=new Date(body.data.proposedAt);if(proposed<=new Date())return res.status(400).json({error:"Choose a future inspection time."});const key=require("node:crypto").createHash("sha256").update(`item:${items[0].id}:${items[0].owner_id}:${req.user.id}`).digest("hex");const [c]=await pool.execute("SELECT id FROM conversations WHERE conversation_key=?",[key]);const [created]=await pool.execute("INSERT INTO rental_inspections(item_id,renter_id,owner_id,conversation_id,proposed_at,meeting_location) VALUES(?,?,?,?,?,?)",[items[0].id,req.user.id,items[0].owner_id,c[0]?.id||null,mysqlDate(proposed),body.data.meetingLocation]);await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'inspection_request','A renter requested an item inspection.',?)",[items[0].owner_id,created.insertId]);return res.status(201).json({id:String(created.insertId),status:"requested",proposedAt:proposed.toISOString(),meetingLocation:body.data.meetingLocation});}catch(e){console.error("Creating inspection request failed:",e.message);return res.status(500).json({error:"Unable to request an inspection."});}
  });
  router.get("/inspections",authenticate,async(req,res)=>{try{const [rows]=await pool.execute("SELECT ri.*,i.name item_name FROM rental_inspections ri JOIN items i ON i.id=ri.item_id WHERE ri.renter_id=? OR ri.owner_id=? ORDER BY ri.proposed_at DESC",[req.user.id,req.user.id]);return res.json(rows.map(r=>({id:String(r.id),itemId:String(r.item_id),itemName:r.item_name,conversationId:r.conversation_id==null?null:String(r.conversation_id),proposedAt:isoDate(r.proposed_at),meetingLocation:r.meeting_location,status:r.status,ownerId:String(r.owner_id),renterId:String(r.renter_id)})));}catch(e){console.error("Loading inspections failed:",e.message);return res.status(500).json({error:"Unable to load inspections."});}});
  router.patch("/inspections/:id",authenticate,async(req,res)=>{const inspectionId=idSchema.safeParse(req.params.id);const body=z.object({action:z.enum(["accept","decline","cancel","reschedule"]),proposedAt:z.string().datetime().optional(),meetingLocation:z.string().trim().min(4).max(255).optional()}).strict().safeParse(req.body);if(!inspectionId.success||!body.success)return res.status(400).json({error:"Invalid inspection update."});try{const [rows]=await pool.execute("SELECT * FROM rental_inspections WHERE id=?",[inspectionId.data]);if(!rows.length)return res.status(404).json({error:"Inspection not found."});const r=rows[0],uid=String(req.user.id),owner=uid===String(r.owner_id),renter=uid===String(r.renter_id);if(!owner&&!renter)return res.status(403).json({error:"You are not part of this inspection."});let status=r.status;if(body.data.action==="accept"){if(!owner||status!=="requested")return res.status(409).json({error:"Only the owner can accept a pending inspection."});status="accepted";}else if(body.data.action==="decline"){if(!owner||status!=="requested")return res.status(409).json({error:"Only the owner can decline a pending inspection."});status="declined";}else if(body.data.action==="cancel"){if(!["requested","accepted"].includes(status))return res.status(409).json({error:"This inspection cannot be cancelled."});status="cancelled";}else{if(!body.data.proposedAt||new Date(body.data.proposedAt)<=new Date())return res.status(400).json({error:"Choose a new future time."});status="rescheduled";}await pool.execute("UPDATE rental_inspections SET status=?,proposed_at=?,meeting_location=? WHERE id=?",[status,body.data.proposedAt?mysqlDate(new Date(body.data.proposedAt)):r.proposed_at,body.data.meetingLocation||r.meeting_location,inspectionId.data]);const recipient=owner?r.renter_id:r.owner_id;await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,?,?,?)",[recipient,"inspection_update",`The inspection request was ${body.data.action==="reschedule"?"rescheduled":status}.`,inspectionId.data]);return res.json({id:inspectionId.data,status});}catch(e){console.error("Updating inspection failed:",e.message);return res.status(500).json({error:"Unable to update inspection."});}});

  router.post("/rentals/:id/handover",authenticate,async(req,res)=>transitionHandover(req,res,pool,idSchema));
  router.post("/rentals/:id/return",authenticate,async(req,res)=>transitionReturn(req,res,pool,idSchema));
  router.post("/rentals/:id/disputes",authenticate,async(req,res)=>openDispute(req,res,pool,idSchema));
  router.post("/rentals/:id/extensions",authenticate,async(req,res)=>requestExtension(req,res,pool,idSchema));
  router.get("/rentals/:id/extensions",authenticate,async(req,res)=>{const id=idSchema.safeParse(req.params.id);if(!id.success)return res.status(400).json({error:"Invalid rental."});try{const [rows]=await pool.execute("SELECT e.id,e.proposed_end_at,e.status,e.created_at,r.owner_id,r.renter_id FROM rental_extensions e JOIN rentals r ON r.id=e.rental_id WHERE e.rental_id=? AND (r.owner_id=? OR r.renter_id=?) ORDER BY e.created_at DESC",[id.data,req.user.id,req.user.id]);return res.json(rows.map(e=>({id:String(e.id),proposedEndAt:isoDate(e.proposed_end_at),status:e.status,createdAt:isoDate(e.created_at)})));}catch(e){console.error("Loading rental extensions failed:",e.message);return res.status(500).json({error:"Unable to load extension requests."});}});
  router.post("/rentals/:id/extensions/:extensionId/respond",authenticate,async(req,res)=>respondExtension(req,res,pool,idSchema));

  router.post("/rentals", authenticate, requireValidPaymentMode, checkoutRateLimiter, async (request, response) => {
    const parsed = createRentalSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: firstValidationMessage(parsed) });
    }

    const data = parsed.data;
    const paymentMode = getPaymentMode();
    if (paymentMode === "paystack" && !data.paymentReference) return response.status(400).json({ error: "A unique Paystack checkout reference is required." });
    if (!request.user.emailVerified) return response.status(403).json({ error: "Verify your email before renting an item." });
    const acceptedAgreementId = data.agreementId;
    const startAt = new Date(data.startAt);
    if (["delivery", "owner_delivery", "rider_delivery"].includes(data.deliveryMethod) && !data.deliveryLocation) return response.status(400).json({ error: "Enter the delivery location." });

    if (!Number.isFinite(startAt.getTime())) {
      return response.status(400).json({ error: "Choose a valid start date." });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      const [controlRows] = await connection.execute("SELECT setting_key,setting_value FROM shedshare_settings WHERE setting_key IN ('payments_paused','checkout_reservation_minutes')");
      const settings = Object.fromEntries(controlRows.map(row=>[row.setting_key,row.setting_value]));
      if (settings.payments_paused === "1") {
        await connection.rollback();
        return response.status(423).json({ error: "ShedShare has temporarily paused new checkouts. Your item and account are unchanged." });
      }
      await connection.execute("UPDATE rentals SET status = 'cancelled' WHERE item_id = ? AND id <> (SELECT rental_id FROM rental_agreement_versions WHERE id=?) AND status = 'pending_payment' AND payment_reference IS NOT NULL AND COALESCE(checkout_expires_at,DATE_ADD(created_at,INTERVAL 30 MINUTE))<=UTC_TIMESTAMP()", [data.itemId,data.agreementId]);

      const [itemRows] = await connection.execute(
        `SELECT id, owner_id, name, price, pricing_unit, min_period,
                max_period, available_quantity, deposit, delivery_available, rider_delivery_available, delivery_fee, paused, moderation_status
           FROM items
          WHERE id = ?
          LIMIT 1
          FOR UPDATE`,
        [data.itemId]
      );

      if (itemRows.length === 0) {
        await connection.rollback();
        return response.status(404).json({ error: "Item not found." });
      }

      const item = itemRows[0];

      const [ownerRows] = await connection.execute("SELECT subaccount_code,bank_name,account_number,manual_account_name FROM users WHERE id = ? LIMIT 1", [item.owner_id]);
      if (paymentMode === "paystack" && !ownerRows[0]?.subaccount_code) { await connection.rollback(); return response.status(409).json({ error: "This owner is not connected to verified Paystack payouts yet." }); }
      if (paymentMode === "manual" && (!ownerRows[0]?.bank_name || !ownerRows[0]?.manual_account_name || !/^\d{10}$/.test(ownerRows[0]?.account_number || ""))) { await connection.rollback(); return response.status(409).json({ error: "The lister has not configured valid bank transfer details yet." }); }

      const [agreements]=await connection.execute(`SELECT av.id,av.terms,av.terms_hash,av.renter_accepted_at,av.owner_accepted_at,av.status offer_status,av.expires_at,(av.expires_at IS NULL OR av.expires_at>UTC_TIMESTAMP()) offer_current,r.id AS rental_id,r.platform_fee_percent,r.platform_fee,r.owner_payout
        FROM rental_agreement_versions av JOIN rentals r ON r.id=av.rental_id
        WHERE av.id=? AND r.item_id=? AND r.renter_id=? AND r.owner_id=? FOR UPDATE`,[acceptedAgreementId,item.id,request.user.id,item.owner_id]);
      if(!agreements.length||!agreements[0].renter_accepted_at||!agreements[0].owner_accepted_at){await connection.rollback();return response.status(409).json({error:"Both parties must accept the same rental summary before checkout."});}
      if(agreements[0].offer_status!=="accepted"||!agreements[0].offer_current){if(["pending","accepted"].includes(agreements[0].offer_status)&&!agreements[0].offer_current){await connection.execute("UPDATE rental_agreement_versions SET status='expired' WHERE id=? AND status IN ('pending','accepted')",[acceptedAgreementId]);await connection.commit();}else await connection.rollback();return response.status(409).json({error:"This agreed offer has expired or is no longer active. Request fresh terms before checkout."});}
      const [latestOffer]=await connection.execute("SELECT id FROM rental_agreement_versions WHERE rental_id=? ORDER BY version DESC LIMIT 1 FOR UPDATE",[agreements[0].rental_id]);if(!latestOffer.length||String(latestOffer[0].id)!==String(acceptedAgreementId)){await connection.rollback();return response.status(409).json({error:"A newer offer replaced these terms. Review and accept the current version."});}
      let agreedTerms;try{agreedTerms=typeof agreements[0].terms==="string"?JSON.parse(agreements[0].terms):agreements[0].terms;}catch{agreedTerms=null;}
      if(!agreedTerms||String(agreedTerms.startAt)!==new Date(data.startAt).toISOString()||Number(agreedTerms.units)!==data.units||Number(agreedTerms.inventoryQuantity||1)!==data.inventoryQuantity||String(agreedTerms.pricingUnit||"day")!==data.pricingUnit||String(agreedTerms.deliveryMethod)!==data.deliveryMethod){await connection.rollback();return response.status(409).json({error:"Checkout details changed after agreement. Prepare a new accepted summary."});}
      const [ownerAgreements]=await connection.execute("SELECT owner_accepted_at FROM rental_agreement_versions WHERE id=? AND rental_id=?",[acceptedAgreementId,agreements[0].rental_id]);
      if(!ownerAgreements[0]?.owner_accepted_at){await connection.rollback();return response.status(409).json({error:"The owner has not accepted these exact terms yet."});}

      // A lost response or client retry must return the already-created manual schedule,
      // not fail on the unique installment key or create duplicate commission entries.
      if(paymentMode==="manual"){
        const [existingInstallments]=await connection.execute("SELECT id,installment_number,amount,currency,due_at,status,bank_name,account_name,account_number FROM rental_manual_installments WHERE rental_id=? AND agreement_id=? ORDER BY installment_number",[agreements[0].rental_id,agreements[0].id]);
        if(existingInstallments.length){
          const rental=await findRental(connection,agreements[0].rental_id);
          await connection.commit();
          return response.status(200).json({...rental,paymentMode:"manual",manualPaymentNotice:"You are transferring this payment directly to the lister. ShedShare records the payment status but does not hold these funds or automatically collect its commission. Confirm the recipient and booking details before sending money.",paymentSchedule:existingInstallments.map(x=>({id:String(x.id),number:Number(x.installment_number),amount:Number(x.amount)/100,currency:x.currency,dueAt:new Date(x.due_at).toISOString(),status:x.status,paymentInstructions:{bankName:x.bank_name,accountName:x.account_name,accountNumber:x.account_number,bookingReference:`SS-${agreements[0].rental_id}`,transferReference:`SS-${agreements[0].rental_id}-I${x.installment_number}`}}))});
        }
      }

      if (String(item.owner_id) === String(request.user.id)) {
        await connection.rollback();
        return response.status(403).json({ error: "You cannot rent your own listing." });
      }

      if (Boolean(item.paused)) {
        await connection.rollback();
        return response.status(409).json({ error: "This listing is paused." });
      }
      if(item.moderation_status!=="approved"){await connection.rollback();return response.status(409).json({error:"This listing is not approved for rental."});}

      const [rateRows]=await connection.execute("SELECT min_period,max_period FROM item_pricing_options WHERE item_id=? AND pricing_unit=? FOR UPDATE",[item.id,data.pricingUnit]);
      if (!rateRows.length) { await connection.rollback(); return response.status(409).json({error:"This listing no longer supports that rental period."}); }
      if (data.units < Number(rateRows[0].min_period) || data.units > Number(rateRows[0].max_period)) {
        await connection.rollback();
        return response.status(400).json({error:"Rental duration is outside the selected rate's limits."});
      }
      if(data.inventoryQuantity>Number(item.available_quantity||1)){await connection.rollback();return response.status(400).json({error:"Requested quantity exceeds listing capacity."});}

      const listingPriceKobo = toKobo(item.price);
      const requestedPriceKobo = toKobo(data.pricePerUnit);
      if(requestedPriceKobo!==toKobo(agreedTerms.pricePerUnit)){await connection.rollback();return response.status(409).json({error:"Agreed price differs from checkout details."});}
      if (requestedPriceKobo <= 0) { await connection.rollback(); return response.status(400).json({ error: "Rental price must be greater than zero." }); }

      if (data.deliveryMethod === "owner_delivery" && !Boolean(item.delivery_available)) {
        await connection.rollback();
        return response.status(400).json({ error: "Owner delivery is not available for this item." });
      }
      if (data.deliveryMethod === "rider_delivery" && !Boolean(item.rider_delivery_available)) {
        await connection.rollback();
        return response.status(400).json({ error: "ShedShare rider delivery is not available for this item." });
      }

      const endAt = addUnits(startAt, data.pricingUnit, data.units);
      const now = new Date();

      if (startAt.getTime() < now.getTime()) {
        await connection.rollback();
        return response.status(400).json({ error: "That start time is in the past." });
      }

      if (!Number.isFinite(endAt.getTime()) || endAt <= startAt) {
        await connection.rollback();
        return response.status(400).json({ error: "Invalid rental dates." });
      }

      const [bookedRows]=await connection.execute("SELECT COALESCE(SUM(inventory_quantity),0) quantity FROM rentals r WHERE item_id=? AND (status IN ('confirmed','active') OR (status='pending_payment' AND ((payment_reference IS NOT NULL AND COALESCE(checkout_expires_at,DATE_ADD(created_at,INTERVAL 30 MINUTE))>UTC_TIMESTAMP()) OR (payment_reference IS NULL AND checkout_expires_at IS NULL AND EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=r.id AND mi.status NOT IN ('cancelled','refunded')))))) AND start_at<? AND end_at>?",[data.itemId,mysqlDate(endAt),mysqlDate(startAt)]);
      const [blockedRows]=await connection.execute("SELECT COALESCE(SUM(COALESCE(quantity,?)),0) quantity FROM item_availability_blocks WHERE item_id=? AND start_at<? AND end_at>?",[item.available_quantity,data.itemId,mysqlDate(endAt),mysqlDate(startAt)]);
      if (!hasInventoryCapacity(item.available_quantity||1,bookedRows[0]?.quantity||0,blockedRows[0]?.quantity||0,data.inventoryQuantity)) {
        await connection.rollback();
        return response.status(409).json({ error: "That date range no longer has enough available units. Choose different dates or quantity." });
      }

      const agreedDeliveryFee = data.deliveryMethod === "owner_delivery" ? toKobo(item.delivery_fee) : 0;
      if(String(agreedTerms.endAt)!==endAt.toISOString()||Number(agreedTerms.subtotal)!==Number((requestedPriceKobo*data.units*data.inventoryQuantity/100).toFixed(2))||toKobo(agreedTerms.deliveryFee)!==agreedDeliveryFee||String(agreedTerms.deliveryMethod)!==data.deliveryMethod||String(agreedTerms.deliveryLocation||"")!==String(data.deliveryLocation||"")){await connection.rollback();return response.status(409).json({error:"Agreed dates, delivery details or totals do not match trusted listing data. Prepare a revised summary."});}
      if((agreedTerms.deliveryLatitude??null)!==(data.deliveryLatitude??null)||(agreedTerms.deliveryLongitude??null)!==(data.deliveryLongitude??null)){await connection.rollback();return response.status(409).json({error:"Delivery details differ from the accepted summary."});}
      const subtotalKobo = calculateRentalSubtotalKobo(requestedPriceKobo,data.units,data.inventoryQuantity);
      if(subtotalKobo==null){await connection.rollback();return response.status(400).json({error:"The rental amount exceeds the supported transaction limit."});}
      const depositKobo = toKobo(item.deposit);
      const deliveryFeeKobo = data.deliveryMethod === "owner_delivery" ? toKobo(item.delivery_fee) : 0;
      const commissionPercent=Number(agreements[0].platform_fee_percent);
      if(!Number.isFinite(commissionPercent)||commissionPercent<0||commissionPercent>100){await connection.rollback();return response.status(409).json({error:"The saved rental commission is invalid. Prepare a new rental summary."});}
      const agreedCommissionKobo=Math.round(subtotalKobo*commissionPercent/100);
      if(Number(agreedTerms.platformCommissionPercent)!==commissionPercent||toKobo(agreedTerms.platformCommission)!==agreedCommissionKobo){await connection.rollback();return response.status(409).json({error:"The platform commission changed after these terms were accepted. Prepare and accept a revised rental summary."});}
      const platformFeeKobo = Math.round((subtotalKobo * commissionPercent) / 100);
      const totalKobo = subtotalKobo + deliveryFeeKobo;
      const ownerPayoutKobo = subtotalKobo - platformFeeKobo;
      await connection.execute("UPDATE rentals SET status='pending_payment',payment_reference=?,checkout_expires_at=?,agreement_version=?,agreement_accepted=TRUE,accepted_at=UTC_TIMESTAMP(),agreement_terms=?,renter_accepted_at=?,owner_accepted_at=?,delivery_location=?,delivery_latitude=?,delivery_longitude=?,pricing_unit=?,inventory_quantity=? WHERE id=?",[paymentMode==="paystack"?data.paymentReference:null,paymentMode==="paystack"?new Date(Date.now()+Math.max(5,Math.min(120,Number(settings.checkout_reservation_minutes||30)))*60_000):null,String(agreements[0].id),JSON.stringify(agreedTerms),agreements[0].renter_accepted_at,agreements[0].owner_accepted_at,data.deliveryLocation||null,data.deliveryLatitude??null,data.deliveryLongitude??null,data.pricingUnit,data.inventoryQuantity,agreements[0].rental_id]);
      const result={insertId:agreements[0].rental_id};
      const rental = await findRental(connection, agreements[0].rental_id);
      // Re-read the persisted rental amount/split; never send frontend totals to Paystack.
      const trustedAmountKobo = toKobo(rental.subtotal);
      const trustedPlatformFeeKobo = Math.round(trustedAmountKobo * Number(rental.platformFeePercent) / 100);
      const trustedOwnerPayoutKobo = trustedAmountKobo - trustedPlatformFeeKobo;
      if (trustedAmountKobo !== subtotalKobo || Number(rental.platformFeePercent) !== commissionPercent || toKobo(rental.platformFee) !== trustedPlatformFeeKobo || toKobo(rental.ownerPayout) !== trustedOwnerPayoutKobo) {
        await connection.rollback();
        console.error("Paystack checkout rejected because persisted rental totals do not match the server-calculated 15/85 split.");
        return response.status(409).json({ error: "Rental payment totals changed. Prepare and accept a new rental summary." });
      }
      if (paymentMode === "manual") {
        const plan=agreedTerms.paymentSchedule||{type:"full",depositPercent:100,balanceDueAt:agreedTerms.startAt};
        const installmentAmounts=buildInstallmentAmounts(trustedAmountKobo,plan);
        if(!installmentAmounts){await connection.rollback();return response.status(409).json({error:"The accepted installment schedule is invalid. Prepare a new agreement."});}
        const firstDue=new Date(),balanceDue=plan.type==="deposit_balance"?new Date(plan.balanceDueAt):firstDue;
        if(!Number.isFinite(balanceDue.getTime())||balanceDue<=firstDue){await connection.rollback();return response.status(409).json({error:"The balance due date has passed. Ask the lister to prepare updated terms."});}
        const dueDates=installmentAmounts.length===1?[firstDue]:[firstDue,balanceDue];
        for(let index=0;index<installmentAmounts.length;index++)await connection.execute("INSERT INTO rental_manual_installments(rental_id,agreement_id,installment_number,amount,due_at,status,bank_name,account_name,account_number) VALUES(?,?,?,?,?,?,?,?,?)",[agreements[0].rental_id,agreements[0].id,index+1,installmentAmounts[index],dueDates[index].toISOString().slice(0,19).replace("T"," "),index===0?"awaiting_payment":"scheduled",ownerRows[0].bank_name,ownerRows[0].manual_account_name,ownerRows[0].account_number]);
        if(trustedPlatformFeeKobo>0){
          await connection.execute("INSERT INTO rental_commission_obligations(rental_id,agreement_id,owner_id,renter_id,rate_percent,basis_amount,amount_due) VALUES(?,?,?,?,?,?,?)",[agreements[0].rental_id,agreements[0].id,item.owner_id,request.user.id,commissionPercent,trustedAmountKobo,trustedPlatformFeeKobo]);
          await connection.execute("INSERT INTO rental_financial_ledger(rental_id,entry_type,amount,currency,reference,metadata) VALUES(?,'commission',?,'NGN',?,JSON_OBJECT('rate',?,'basis','manual rental subtotal','status','due'))",[agreements[0].rental_id,trustedPlatformFeeKobo,`commission:manual:${agreements[0].id}`,commissionPercent]);
        }
        const [inst] = await connection.execute("SELECT id,installment_number,amount,currency,due_at,status,bank_name,account_name,account_number FROM rental_manual_installments WHERE rental_id=? AND agreement_id=? ORDER BY installment_number",[agreements[0].rental_id,agreements[0].id]);
        await connection.commit();
        return response.status(201).json({...rental,paymentMode:"manual",manualPaymentNotice:"You are transferring this payment directly to the lister. ShedShare records the payment status but does not hold these funds or automatically collect its commission. Confirm the recipient and booking details before sending money.",paymentSchedule:inst.map(x=>({id:String(x.id),number:Number(x.installment_number),amount:Number(x.amount)/100,currency:x.currency,dueAt:new Date(x.due_at).toISOString(),status:x.status,paymentInstructions:{bankName:x.bank_name,accountName:x.account_name,accountNumber:x.account_number,bookingReference:`SS-${agreements[0].rental_id}`,transferReference:`SS-${agreements[0].rental_id}-I${x.installment_number}`}}))});
      }
      const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: request.user.email,
          amount: trustedAmountKobo,
          reference: data.paymentReference,
          subaccount: ownerRows[0].subaccount_code,
          transaction_charge: trustedPlatformFeeKobo,
          bearer: "account",
          metadata: { rentalId: String(agreements[0].rental_id), itemId: String(item.id), purpose: "rental_fee" }
        }),
        signal: AbortSignal.timeout(10000)
      });
      const checkout = await paystackResponse.json();
      let checkoutUrl;
      try { checkoutUrl = new URL(checkout.data?.authorization_url); } catch (_error) {}
      if (!paystackResponse.ok || !checkout.status || !checkoutUrl || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com") {
        await connection.rollback();
        console.error("Paystack checkout initialization failed:", checkout.message || paystackResponse.status);
        console.info("Paystack payment event", JSON.stringify({ reference: data.paymentReference, result: "checkout_initialization_failed", status: paystackResponse.status }));
        return response.status(502).json({ error: "Unable to initialize Paystack checkout." });
      }
      if (checkout.data.reference !== data.paymentReference) {
        await connection.rollback();
        console.error("Paystack returned a different checkout reference than requested.");
        console.info("Paystack payment event", JSON.stringify({ reference: data.paymentReference, result: "checkout_reference_mismatch" }));
        return response.status(502).json({ error: "Paystack checkout could not be safely matched to this rental." });
      }

      const [attempt] = await connection.execute("INSERT INTO rental_payment_attempts(rental_id,reference,amount,currency,status) VALUES(?,? ,?,'NGN','initialized')",[agreements[0].rental_id,data.paymentReference,trustedAmountKobo]);
      await connection.execute("INSERT INTO rental_financial_ledger(rental_id,payment_attempt_id,entry_type,amount,currency,reference,metadata) VALUES(?,?,'commission',?,'NGN',?,JSON_OBJECT('rate',?,'basis','rental subtotal'))",[agreements[0].rental_id,attempt.insertId,trustedPlatformFeeKobo,`commission:${data.paymentReference}`,commissionPercent]);
      console.info("Paystack payment event", JSON.stringify({ reference: data.paymentReference, result: "checkout_initialized", amountKobo: trustedAmountKobo, currency: "NGN", platformFeeKobo: trustedPlatformFeeKobo, ownerPayoutKobo: trustedOwnerPayoutKobo }));
      await connection.commit();
      return response.status(201).json({ ...rental, checkoutUrl: checkoutUrl.toString() });
    } catch (error) {
      await connection.rollback();
      console.error("Creating rental failed:", error.message);
      if (data.paymentReference) console.info("Paystack payment event", JSON.stringify({ reference: data.paymentReference, result: "checkout_processing_error" }));
      return response.status(500).json({ error: "Unable to create rental." });
    } finally {
      connection.release();
    }
  });

  router.get("/rentals", authenticate, async (request, response) => {
    try {
      await pool.execute("UPDATE rentals SET status = 'cancelled' WHERE status = 'pending_payment' AND payment_reference IS NOT NULL AND COALESCE(checkout_expires_at,DATE_ADD(created_at,INTERVAL 30 MINUTE))<=UTC_TIMESTAMP()");
    } catch (error) {
      console.error("Expiring old rental payment holds failed:", error.message);
      return response.status(500).json({ error: "Unable to load rentals." });
    }
    const parsedRole = roleSchema.safeParse(request.query.role || "renter");
    if (!parsedRole.success) {
      return response.status(400).json({ error: firstValidationMessage(parsedRole) });
    }

    const role = parsedRole.data;

    if (role === "admin" && !request.user.isAdmin) {
      return response.status(403).json({ error: "Administrator access required." });
    }

    let whereSql = "";
    let values = [];

    if (role === "owner") {
      whereSql = "WHERE r.owner_id = ?";
      values = [request.user.id];
    } else if (role === "renter") {
      whereSql = "WHERE r.renter_id = ?";
      values = [request.user.id];
    }

    try {
      const [rows] = await pool.execute(
        `${rentalSelectSql} ${whereSql} ORDER BY r.created_at DESC`,
        values
      );

      return response.status(200).json(rows.map(publicRental));
    } catch (error) {
      console.error("Loading rentals failed:", error.message);
      return response.status(500).json({ error: "Unable to load rentals." });
    }
  });

  router.post("/rentals/:id/report-safety", authenticate, async (request, response) => {
    const parsedId = idSchema.safeParse(request.params.id);
    const report = z.object({ reason: z.string().trim().min(4).max(1000) }).strict().safeParse(request.body);
    if (!parsedId.success || !report.success) return response.status(400).json({ error: "Describe the safety issue in a few words." });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT id,owner_id,renter_id,status,safety_hold FROM rentals WHERE id=? FOR UPDATE", [parsedId.data]);
      if (!rows.length) { await connection.rollback(); return response.status(404).json({ error: "Rental not found." }); }
      const rental = rows[0], userId = String(request.user.id);
      if (![String(rental.owner_id), String(rental.renter_id)].includes(userId)) { await connection.rollback(); return response.status(403).json({ error: "Only the renter or lister can report an issue for this rental." }); }
      if (!["confirmed", "active"].includes(rental.status)) { await connection.rollback(); return response.status(409).json({ error: "Only a confirmed or active rental can be placed on safety hold." }); }
      const reason = `Safety report: ${report.data.reason}`;
      await connection.execute("UPDATE rentals SET safety_hold=TRUE,safety_hold_reason=? WHERE id=?", [reason, parsedId.data]);
      const otherParty = userId === String(rental.owner_id) ? rental.renter_id : rental.owner_id;
      const notice = "A safety issue was reported for this rental. Further handover or completion steps are paused while ShedShare reviews it.";
      await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?),(?,?,?,?)", [otherParty, "rental_safety_hold", notice, rental.id, request.user.id, "rental_safety_reported", "Your safety report was received. The rental has been placed on hold.", rental.id]);
      await connection.commit();
      return response.status(201).json({ rentalId: String(rental.id), onHold: true, message: "Safety report submitted. The rental is paused for review." });
    } catch (error) { await connection.rollback(); console.error("Reporting rental safety issue failed:", error.message); return response.status(500).json({ error: "Unable to submit the safety report." }); }
    finally { connection.release(); }
  });

  router.post("/rentals/:id/:action", authenticate, async (request, response) => {
    const parsedId = idSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      return response.status(400).json({ error: firstValidationMessage(parsedId) });
    }

    const action = request.params.action;
    if (!new Set(["activate", "complete", "cancel"]).has(action)) {
      return response.status(404).json({ error: "Rental action not found." });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [rows] = await connection.execute(
        `SELECT id, owner_id, renter_id, status, payment_verified_at, safety_hold,
                EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id) has_manual,
                (SELECT COALESCE(SUM(mi.amount),0) FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id AND mi.status='confirmed') manual_paid,
                (SELECT COUNT(*) FROM rental_manual_installments mi WHERE mi.rental_id=rentals.id AND mi.status='payment_reported') manual_reported
           FROM rentals
          WHERE id = ?
          LIMIT 1
          FOR UPDATE`,
        [parsedId.data]
      );

      if (rows.length === 0) {
        await connection.rollback();
        return response.status(404).json({ error: "Rental not found." });
      }

      const rental = rows[0];
      if (rental.safety_hold) {
        await connection.rollback();
        return response.status(423).json({ error: "This rental is on an administrator safety hold." });
      }
      if(action==="activate"||action==="complete") { await connection.rollback(); return response.status(409).json({error:"Use the mutual handover or return confirmation workflow to advance this rental."}); }
      const isOwner = String(rental.owner_id) === String(request.user.id);
      const isRenter = String(rental.renter_id) === String(request.user.id);
      const isAdministrator = Boolean(request.user.isAdmin);
      const manualSchedule = Boolean(rental.has_manual);
      const manualPaid = manualSchedule && Number(rental.manual_paid) > 0;

      let nextStatus;
      let permitted = false;
      let expectedStatus;

      if (action === "activate") {
        nextStatus = "active";
        expectedStatus = "confirmed";
        permitted = isOwner || isAdministrator;
      } else if (action === "complete") {
        nextStatus = "completed";
        expectedStatus = "active";
        permitted = isOwner || isAdministrator;
      } else {
        nextStatus = "cancelled";
        expectedStatus = "confirmed";
        permitted = isOwner || isRenter || isAdministrator;
      }

      if (action === "cancel" && Number(rental.manual_reported) > 0) {
        await connection.rollback();
        return response.status(409).json({ error: "A reported bank transfer must be reviewed before this booking can be cancelled." });
      }

      if (action === "cancel" && !rental.payment_verified_at && !manualPaid && !manualSchedule && !isAdministrator) {
        await connection.rollback();
        return response.status(403).json({ error: "Only an administrator can cancel an unpaid rental hold." });
      }

      if (!permitted) {
        await connection.rollback();
        return response.status(403).json({ error: "You are not allowed to perform that rental action." });
      }

      const cancellableStatus = action !== "cancel"
        ? rental.status === expectedStatus
        : rental.status === "confirmed" || (rental.status === "pending_payment" && (isAdministrator || manualSchedule));
      if (!cancellableStatus) {
        await connection.rollback();
        return response.status(409).json({
          error: action === "cancel"
            ? "Only a confirmed rental can be cancelled."
            : `Only a ${expectedStatus} rental can be ${action === "activate" ? "activated" : "completed"}.`
        });
      }

      await connection.execute(
        "UPDATE rentals SET status = ? WHERE id = ?",
        [nextStatus, parsedId.data]
      );

      if (action === "cancel" && manualSchedule) {
        const [openInstallments] = await connection.execute("SELECT id FROM rental_manual_installments WHERE rental_id=? AND status IN ('scheduled','awaiting_payment','overdue','rejected') FOR UPDATE", [parsedId.data]);
        for (const installment of openInstallments) {
          await connection.execute("UPDATE rental_manual_installments SET status='cancelled' WHERE id=?", [installment.id]);
          await connection.execute("INSERT INTO rental_manual_payment_events(installment_id,actor_id,event_type,note) VALUES(?,?,'cancelled',?)", [installment.id, request.user.id, "Booking cancelled; this unpaid installment is no longer payable."]);
        }
        await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'manual_booking_cancelled','A manual-transfer rental booking was cancelled. Confirmed transfers remain recorded separately; contact the lister directly about any agreed refund.',?),(?,'manual_booking_cancelled','A manual-transfer rental booking was cancelled. Confirmed transfers remain recorded separately; contact the renter directly about any agreed refund.',?)", [rental.renter_id, parsedId.data, rental.owner_id, parsedId.data]);
      }

      if (action === "complete") {
        try { await connection.execute(
          "UPDATE conversations SET locked_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? DAY) WHERE rental_id=? AND kind='item' AND locked_at IS NULL",
          [require("./chat-config").completionLockDays, parsedId.data]
        ); } catch (chatError) { console.error("Rental completed; chat lock update failed:", chatError.message); }
      }

      if (action === "complete" || action === "cancel") {
        const [requestOffers] = await connection.execute("SELECT request_id FROM request_offers WHERE rental_id=? LIMIT 1", [parsedId.data]);
        if (requestOffers.length) {
          const requestStatus = action === "complete" ? "completed" : "cancelled";
          const [requestUpdate] = await connection.execute("UPDATE item_requests SET status=? WHERE id=? AND status='booking_confirmed'", [requestStatus, requestOffers[0].request_id]);
          if (requestUpdate.affectedRows) await connection.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('from','booking_confirmed','to',?,'rentalId',?))", [requestOffers[0].request_id, request.user.id, "request_status_changed", requestStatus, parsedId.data]);
        }
      }

      const updatedRental = await findRental(connection, parsedId.data);
      await connection.commit();
      return response.status(200).json(updatedRental);
    } catch (error) {
      await connection.rollback();
      console.error(`Rental ${request.params.action} failed:`, error.message);
      return response.status(500).json({ error: "Unable to update rental." });
    } finally {
      connection.release();
    }
  });

  return router;
}

module.exports = { createRentalsRouter, addUnits, hasInventoryCapacity, calculateRentalSubtotalKobo };
