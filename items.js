"use strict";

const express = require("express");
const { z } = require("zod");

const categories = [
  "Home & Furniture",
  "Kitchen",
  "Vehicles",
  "Tools & Equipment",
  "Electronics",
  "Events",
  "Fashion",
  "Music",
  "Outdoor",
  "Other"
];

const conditions = ["Like new", "Good", "Well used"];
const pricingUnits = ["hour", "day", "week"];

const itemFields = {
  name: z.string({ required_error: "Item name is required." }).trim().min(1, "Item name is required.").max(180, "Item name is too long."),
  category: z.enum(categories, { errorMap: () => ({ message: "Choose a valid category." }) }),
  condition: z.enum(conditions, { errorMap: () => ({ message: "Choose a valid condition." }) }),
  location: z.string({ required_error: "Location is required." }).trim().min(1, "Location is required.").max(255, "Location is too long."),
  description: z.string().trim().max(65535, "Description is too long."),
  image: z.string().max(2048, "Image URL is too long."),
  video: z.string().max(2048, "Video URL is too long."),
  price: z.number({ required_error: "Price is required.", invalid_type_error: "Price must be a number." }).finite().positive("Price must be greater than zero.").max(9999999999.99, "Price is too large."),
  pricingUnit: z.enum(pricingUnits, { errorMap: () => ({ message: "Choose a valid pricing unit." }) }),
  minPeriod: z.number({ invalid_type_error: "Minimum rental period must be a number." }).int("Minimum rental period must be a whole number.").min(1, "Minimum rental period must be at least 1.").max(65535, "Minimum rental period is too large."),
  maxPeriod: z.number({ invalid_type_error: "Maximum rental period must be a number." }).int("Maximum rental period must be a whole number.").min(1, "Maximum rental period must be at least 1.").max(65535, "Maximum rental period is too large."),
  deposit: z.number({ invalid_type_error: "Deposit must be a number." }).finite().min(0, "Deposit cannot be negative.").max(9999999999.99, "Deposit is too large."),
  deliveryAvailable: z.boolean({ invalid_type_error: "Delivery availability must be true or false." }),
  deliveryFee: z.number({ invalid_type_error: "Delivery fee must be a number." }).finite().min(0, "Delivery fee cannot be negative.").max(9999999999.99, "Delivery fee is too large.")
};

const createItemSchema = z.object({
  name: itemFields.name,
  category: itemFields.category,
  condition: itemFields.condition.default("Good"),
  location: itemFields.location,
  description: itemFields.description.default(""),
  image: itemFields.image.default(""),
  video: itemFields.video.default(""),
  price: itemFields.price,
  pricingUnit: itemFields.pricingUnit.default("day"),
  minPeriod: itemFields.minPeriod.default(1),
  maxPeriod: itemFields.maxPeriod.default(14),
  deposit: itemFields.deposit.default(0),
  deliveryAvailable: itemFields.deliveryAvailable.default(false),
  deliveryFee: itemFields.deliveryFee.default(0)
}).strict("Request contains fields that cannot be changed.").superRefine(validateItemRules);

const updateItemSchema = z.object({
  ...itemFields,
  paused: z.boolean({ invalid_type_error: "Paused must be true or false." })
}).partial().strict("Request contains fields that cannot be changed.").refine(
  (data) => Object.keys(data).length > 0,
  { message: "Provide at least one item field to update." }
);

const idSchema = z.string().regex(/^\d+$/, "Invalid item id.");

const selectItemsSql = `
  SELECT i.id, i.owner_id, i.name, i.category, i.item_condition,
         i.location, i.description, i.image, i.video, i.price,
         i.pricing_unit, i.min_period, i.max_period, i.deposit,
         i.delivery_available, i.delivery_fee, i.paused,
         u.name AS owner_name, u.phone AS owner_phone,
         u.brand AS owner_brand
    FROM items i
    JOIN users u ON u.id = i.owner_id
`;

function validateItemRules(data, context) {
  if (data.maxPeriod < data.minPeriod) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxPeriod"],
      message: "Maximum rental period cannot be shorter than the minimum."
    });
  }

  if (!data.deliveryAvailable && data.deliveryFee !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["deliveryFee"],
      message: "Delivery fee must be zero when delivery is unavailable."
    });
  }
}

function firstValidationMessage(result) {
  return result.error.issues[0]?.message || "Invalid request.";
}

function publicItem(row) {
  return {
    id: String(row.id),
    name: row.name,
    category: row.category,
    condition: row.item_condition,
    location: row.location,
    description: row.description || "",
    image: row.image || "",
    video: row.video || "",
    ownerName: row.owner_name,
    ownerPhone: row.owner_phone,
    ownerBrand: row.owner_brand || "",
    price: Number(row.price),
    pricingUnit: row.pricing_unit,
    minPeriod: Number(row.min_period),
    maxPeriod: Number(row.max_period),
    deposit: Number(row.deposit),
    deliveryAvailable: Boolean(row.delivery_available),
    deliveryFee: Number(row.delivery_fee),
    paused: Boolean(row.paused)
  };
}

async function findItem(pool, id) {
  const [rows] = await pool.execute(
    `${selectItemsSql} WHERE i.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] ? publicItem(rows[0]) : null;
}

function createItemsRouter({ pool, authenticate }) {
  if (!pool) throw new Error("An item database pool is required.");
  if (typeof authenticate !== "function") throw new Error("Item authentication middleware is required.");

  const router = express.Router();

  router.get("/", (request, response, next) => {
    if (request.query.mine === "1") return authenticate(request, response, next);
    return next();
  }, async (request, response) => {
    try {
      if (request.query.mine === "1") {
        const [rows] = await pool.execute(
          `${selectItemsSql} WHERE i.owner_id = ? ORDER BY i.created_at DESC`,
          [request.user.id]
        );
        return response.status(200).json(rows.map(publicItem));
      }

      const [rows] = await pool.execute(
        `${selectItemsSql} WHERE i.paused = FALSE ORDER BY i.created_at DESC`
      );
      return response.status(200).json(rows.map(publicItem));
    } catch (error) {
      console.error("Loading items failed:", error.message);
      return response.status(500).json({ error: "Unable to load items." });
    }
  });

  router.post("/", authenticate, async (request, response) => {
    if (!request.user.emailVerified) return response.status(403).json({ error: "Verify your email before listing an item." });
    const parsed = createItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: firstValidationMessage(parsed) });
    }
    if (/^data:/i.test(parsed.data.image) || /^data:/i.test(parsed.data.video)) {
      return response.status(400).json({ error: "Upload image and video files through their authenticated media upload endpoints." });
    }

    const data = parsed.data;

    try {
      const [result] = await pool.execute(
        `INSERT INTO items
          (owner_id, name, category, item_condition, location, description,
           image, video, price, pricing_unit, min_period, max_period,
           deposit, delivery_available, delivery_fee)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          request.user.id,
          data.name,
          data.category,
          data.condition,
          data.location,
          data.description || null,
          data.image || null,
          data.video || null,
          data.price,
          data.pricingUnit,
          data.minPeriod,
          data.maxPeriod,
          data.deposit,
          data.deliveryAvailable,
          data.deliveryAvailable ? data.deliveryFee : 0
        ]
      );

      const item = await findItem(pool, result.insertId);
      return response.status(201).json(item);
    } catch (error) {
      console.error("Creating item failed:", error.message);
      return response.status(500).json({ error: "Unable to create item." });
    }
  });

  router.patch("/:id", authenticate, async (request, response) => {
    const parsedId = idSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      return response.status(400).json({ error: firstValidationMessage(parsedId) });
    }

    const parsed = updateItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: firstValidationMessage(parsed) });
    }

    try {
      const [existingRows] = await pool.execute(
        `SELECT owner_id, min_period, max_period, delivery_available, delivery_fee
           FROM items
          WHERE id = ?
          LIMIT 1`,
        [parsedId.data]
      );

      if (existingRows.length === 0) {
        return response.status(404).json({ error: "Item not found." });
      }

      if (String(existingRows[0].owner_id) !== request.user.id) {
        return response.status(403).json({ error: "That isn't your listing." });
      }

      const data = parsed.data;
      if ([data.image, data.video].some((value) => typeof value === "string" && /^data:/i.test(value))) {
        return response.status(400).json({ error: "Upload image and video files through their authenticated media upload endpoints." });
      }
      const minPeriod = data.minPeriod ?? Number(existingRows[0].min_period);
      const maxPeriod = data.maxPeriod ?? Number(existingRows[0].max_period);
      const deliveryAvailable = data.deliveryAvailable ?? Boolean(existingRows[0].delivery_available);
      const deliveryFee = data.deliveryFee ?? Number(existingRows[0].delivery_fee);

      if (maxPeriod < minPeriod) {
        return response.status(400).json({ error: "Maximum rental period cannot be shorter than the minimum." });
      }

      if (!deliveryAvailable && deliveryFee !== 0) {
        return response.status(400).json({ error: "Delivery fee must be zero when delivery is unavailable." });
      }

      const columns = {
        name: "name",
        category: "category",
        condition: "item_condition",
        location: "location",
        description: "description",
        image: "image",
        video: "video",
        price: "price",
        pricingUnit: "pricing_unit",
        minPeriod: "min_period",
        maxPeriod: "max_period",
        deposit: "deposit",
        deliveryAvailable: "delivery_available",
        deliveryFee: "delivery_fee",
        paused: "paused"
      };

      const assignments = [];
      const values = [];
      for (const [field, value] of Object.entries(data)) {
        assignments.push(`${columns[field]} = ?`);
        values.push(value === "" && ["description", "image", "video"].includes(field) ? null : value);
      }

      values.push(parsedId.data, request.user.id);
      await pool.execute(
        `UPDATE items SET ${assignments.join(", ")} WHERE id = ? AND owner_id = ?`,
        values
      );

      const item = await findItem(pool, parsedId.data);
      return response.status(200).json(item);
    } catch (error) {
      console.error("Updating item failed:", error.message);
      return response.status(500).json({ error: "Unable to update item." });
    }
  });

  router.delete("/:id", authenticate, async (request, response) => {
    const parsedId = idSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      return response.status(400).json({ error: firstValidationMessage(parsedId) });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [itemRows] = await connection.execute(
        "SELECT owner_id FROM items WHERE id = ? LIMIT 1 FOR UPDATE",
        [parsedId.data]
      );

      if (itemRows.length === 0) {
        await connection.rollback();
        return response.status(404).json({ error: "Item not found." });
      }

      if (String(itemRows[0].owner_id) !== request.user.id) {
        await connection.rollback();
        return response.status(403).json({ error: "That isn't your listing." });
      }

      const [rentalRows] = await connection.execute(
        `SELECT id
           FROM rentals
          WHERE item_id = ? AND status IN ('confirmed', 'active')
          LIMIT 1
          FOR UPDATE`,
        [parsedId.data]
      );

      if (rentalRows.length > 0) {
        await connection.rollback();
        return response.status(409).json({ error: "This item has an open rental." });
      }

      await connection.execute(
        "DELETE FROM items WHERE id = ? AND owner_id = ?",
        [parsedId.data, request.user.id]
      );
      await connection.commit();
      return response.status(200).json({ ok: true });
    } catch (error) {
      await connection.rollback();

      if (error && error.code === "ER_ROW_IS_REFERENCED_2") {
        return response.status(409).json({ error: "This item has rental history and cannot be deleted." });
      }

      console.error("Deleting item failed:", error.message);
      return response.status(500).json({ error: "Unable to delete item." });
    } finally {
      connection.release();
    }
  });

  return router;
}

module.exports = { createItemsRouter };
