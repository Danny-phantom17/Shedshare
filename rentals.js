"use strict";

const express = require("express");
const { z } = require("zod");

const PLATFORM_FEE_PERCENT = 15;
const MAX_DISCOUNT_NAIRA = 500;
const AGREEMENT_VERSION = "v1";
const OPEN_STATUSES = ["confirmed", "active"];

const idSchema = z.string().regex(/^\d+$/, "Invalid id.");

const roleSchema = z.enum(["renter", "owner", "admin"], {
  errorMap: () => ({ message: "Role must be renter, owner, or admin." })
});

const createRentalSchema = z.object({
  itemId: z.union([
    z.string().regex(/^\d+$/, "Invalid item id."),
    z.number().int().positive()
  ]).transform(String),
  pricePerUnit: z.number({
    required_error: "Price per unit is required.",
    invalid_type_error: "Price per unit must be a number."
  }).finite().positive("Price per unit must be greater than zero."),
  units: z.number({
    required_error: "Rental period is required.",
    invalid_type_error: "Rental period must be a number."
  }).int("Rental period must be a whole number.").positive("Rental period must be at least 1."),
  startAt: z.string({ required_error: "Choose a start date." }).trim().min(1, "Choose a start date."),
  deliveryMethod: z.enum(["pickup", "delivery"], {
    errorMap: () => ({ message: "Choose pickup or delivery." })
  }),
  paymentReference: z.string().trim().min(8).max(100)
}).strict("Request contains fields that cannot be set.");

const rentalSelectSql = `
  SELECT r.id, r.item_id, r.owner_id, r.renter_id, r.item_name,
         r.price_per_unit, r.units, r.pricing_unit, r.start_at, r.end_at,
         r.subtotal, r.deposit, r.delivery_method, r.delivery_fee, r.total,
         r.platform_fee_percent, r.platform_fee, r.owner_payout,
         r.agreement_version, r.agreement_accepted, r.accepted_at,
         r.status, r.payment_reference, r.payment_verified_at, r.created_at,
         owner.name AS owner_name, owner.phone AS owner_phone,
         owner.brand AS owner_brand,
         renter.name AS renter_name, renter.phone AS renter_phone
    FROM rentals r
    JOIN users owner ON owner.id = r.owner_id
    JOIN users renter ON renter.id = r.renter_id
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
  } else {
    end.setUTCDate(end.getUTCDate() + units);
  }

  return end;
}

function publicRental(row) {
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    itemName: row.item_name,
    ownerName: row.owner_name,
    ownerPhone: row.owner_phone,
    ownerBrand: row.owner_brand || "",
    renterName: row.renter_name,
    renterPhone: row.renter_phone,
    pricePerUnit: Number(row.price_per_unit),
    units: Number(row.units),
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
    status: row.status,
    paymentReference: row.payment_reference || ""
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
        `SELECT start_at, end_at
           FROM rentals
          WHERE item_id = ?
            AND status IN ('confirmed', 'active')
          ORDER BY start_at ASC`,
        [parsedId.data]
      );

      return response.status(200).json(rows.map((row) => ({
        startAt: isoDate(row.start_at),
        endAt: isoDate(row.end_at)
      })));
    } catch (error) {
      console.error("Loading item bookings failed:", error.message);
      return response.status(500).json({ error: "Unable to load bookings." });
    }
  });

  router.post("/rentals", authenticate, async (request, response) => {
    const parsed = createRentalSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: firstValidationMessage(parsed) });
    }

    const data = parsed.data;
    if (!request.user.emailVerified) return response.status(403).json({ error: "Verify your email before renting an item." });
    const startAt = new Date(data.startAt);

    if (!Number.isFinite(startAt.getTime())) {
      return response.status(400).json({ error: "Choose a valid start date." });
    }

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      await connection.execute("UPDATE rentals SET status = 'cancelled' WHERE item_id = ? AND status = 'pending_payment' AND created_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)", [data.itemId]);

      const [itemRows] = await connection.execute(
        `SELECT id, owner_id, name, price, pricing_unit, min_period,
                max_period, deposit, delivery_available, delivery_fee, paused
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

      if (String(item.owner_id) === String(request.user.id)) {
        await connection.rollback();
        return response.status(403).json({ error: "You cannot rent your own listing." });
      }

      if (Boolean(item.paused)) {
        await connection.rollback();
        return response.status(409).json({ error: "This listing is paused." });
      }

      if (data.units < Number(item.min_period) || data.units > Number(item.max_period)) {
        await connection.rollback();
        return response.status(400).json({
          error: `Rental period must be between ${item.min_period} and ${item.max_period} ${item.pricing_unit}${Number(item.max_period) === 1 ? "" : "s"}.`
        });
      }

      const listingPriceKobo = toKobo(item.price);
      const requestedPriceKobo = toKobo(data.pricePerUnit);
      const minimumPriceKobo = Math.max(0, listingPriceKobo - (MAX_DISCOUNT_NAIRA * 100));

      if (requestedPriceKobo < minimumPriceKobo) {
        await connection.rollback();
        return response.status(400).json({
          error: `Price per unit cannot be more than ₦${MAX_DISCOUNT_NAIRA} below the listing price.`
        });
      }

      if (requestedPriceKobo > listingPriceKobo) {
        await connection.rollback();
        return response.status(400).json({ error: "Price per unit cannot exceed the listing price." });
      }

      if (data.deliveryMethod === "delivery" && !Boolean(item.delivery_available)) {
        await connection.rollback();
        return response.status(400).json({ error: "Delivery is not available for this item." });
      }

      const endAt = addUnits(startAt, item.pricing_unit, data.units);
      const now = new Date();

      if (startAt.getTime() < now.getTime()) {
        await connection.rollback();
        return response.status(400).json({ error: "That start time is in the past." });
      }

      if (!Number.isFinite(endAt.getTime()) || endAt <= startAt) {
        await connection.rollback();
        return response.status(400).json({ error: "Invalid rental dates." });
      }

      const [conflicts] = await connection.execute(
        `SELECT id
           FROM rentals
          WHERE item_id = ?
            AND (status IN ('confirmed', 'active') OR (status = 'pending_payment' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)))
            AND start_at < ?
            AND end_at > ?
          LIMIT 1
          FOR UPDATE`,
        [data.itemId, mysqlDate(endAt), mysqlDate(startAt)]
      );

      if (conflicts.length > 0) {
        await connection.rollback();
        return response.status(409).json({ error: "Those dates were just booked. Pick different dates." });
      }

      const subtotalKobo = requestedPriceKobo * data.units;
      const depositKobo = toKobo(item.deposit);
      const deliveryFeeKobo = data.deliveryMethod === "delivery" ? toKobo(item.delivery_fee) : 0;
      const platformFeeKobo = Math.round((subtotalKobo * PLATFORM_FEE_PERCENT) / 100);
      const totalKobo = subtotalKobo + depositKobo + deliveryFeeKobo;
      const ownerPayoutKobo = subtotalKobo - platformFeeKobo;
      const acceptedAt = new Date();

      const [result] = await connection.execute(
        `INSERT INTO rentals
          (item_id, owner_id, renter_id, item_name, price_per_unit, units,
           pricing_unit, start_at, end_at, subtotal, deposit, delivery_method,
           delivery_fee, total, platform_fee_percent, platform_fee,
           owner_payout, agreement_version, agreement_accepted, accepted_at,
           status, payment_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, 'pending_payment', ?)`,
        [
          item.id,
          item.owner_id,
          request.user.id,
          item.name,
          toNaira(requestedPriceKobo),
          data.units,
          item.pricing_unit,
          mysqlDate(startAt),
          mysqlDate(endAt),
          toNaira(subtotalKobo),
          toNaira(depositKobo),
          data.deliveryMethod,
          toNaira(deliveryFeeKobo),
          toNaira(totalKobo),
          PLATFORM_FEE_PERCENT,
          toNaira(platformFeeKobo),
          toNaira(ownerPayoutKobo),
          AGREEMENT_VERSION,
          mysqlDate(acceptedAt),
          data.paymentReference
        ]
      );

      const rental = await findRental(connection, result.insertId);
      if (!process.env.PAYSTACK_SECRET_KEY) {
        await connection.rollback();
        return response.status(503).json({ error: "Verified online payment is not configured yet." });
      }
      const [ownerRows] = await connection.execute("SELECT subaccount_code FROM users WHERE id = ? LIMIT 1", [item.owner_id]);
      if (!ownerRows[0]?.subaccount_code) {
        await connection.rollback();
        return response.status(409).json({ error: "This owner is not connected to verified Paystack payouts yet." });
      }
      const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: request.user.email,
          amount: subtotalKobo,
          reference: data.paymentReference,
          subaccount: ownerRows[0].subaccount_code,
          transaction_charge: platformFeeKobo,
          metadata: { rentalId: String(result.insertId), itemId: String(item.id), purpose: "rental_fee" }
        }),
        signal: AbortSignal.timeout(10000)
      });
      const checkout = await paystackResponse.json();
      let checkoutUrl;
      try { checkoutUrl = new URL(checkout.data?.authorization_url); } catch (_error) {}
      if (!paystackResponse.ok || !checkout.status || !checkoutUrl || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com") {
        await connection.rollback();
        console.error("Paystack checkout initialization failed:", checkout.message || paystackResponse.status);
        return response.status(502).json({ error: "Unable to initialize Paystack checkout." });
      }
      if (checkout.data.reference !== data.paymentReference) {
        await connection.rollback();
        console.error("Paystack returned a different checkout reference than requested.");
        return response.status(502).json({ error: "Paystack checkout could not be safely matched to this rental." });
      }
      await connection.commit();
      return response.status(201).json({ ...rental, checkoutUrl: checkoutUrl.toString() });
    } catch (error) {
      await connection.rollback();
      console.error("Creating rental failed:", error.message);
      return response.status(500).json({ error: "Unable to create rental." });
    } finally {
      connection.release();
    }
  });

  router.get("/rentals", authenticate, async (request, response) => {
    try {
      await pool.execute("UPDATE rentals SET status = 'cancelled' WHERE status = 'pending_payment' AND created_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)");
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
        `SELECT id, owner_id, renter_id, status, payment_verified_at
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
      const isOwner = String(rental.owner_id) === String(request.user.id);
      const isRenter = String(rental.renter_id) === String(request.user.id);
      const isAdministrator = Boolean(request.user.isAdmin);

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

      if (action === "cancel" && !rental.payment_verified_at && !isAdministrator) {
        await connection.rollback();
        return response.status(403).json({ error: "Only an administrator can cancel an unpaid rental hold." });
      }

      if (!permitted) {
        await connection.rollback();
        return response.status(403).json({ error: "You are not allowed to perform that rental action." });
      }

      if (rental.status !== expectedStatus) {
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

module.exports = { createRentalsRouter };
