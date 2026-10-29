"use strict";

const express = require("express");
const { redactContactDetails } = require("./privacy");
const { z } = require("zod");
const { recordReferralEvent } = require("./referrals");
const { getAiControlState, validImage, imageMimeType } = require("./ai");
const { assessListing, DEFAULT_POLICY } = require("./listing-moderation");
const { keyFromReference } = require("./storage-cleanup");
const crypto = require("node:crypto");

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
const pricingUnits = ["hour", "day", "week", "month", "year"];

function buildBudgetSearchQuery(query = {}) {
  const scalar = (key) => query[key] === undefined ? "" : typeof query[key] === "string" ? query[key].trim() : null;
  const rawMin = scalar("minPrice"), rawMax = scalar("maxPrice"), rawDuration = scalar("duration");
  if ([rawMin, rawMax, rawDuration].includes(null)) return { error: "Search filters must be provided once each." };
  const numberOrNull = raw => raw === "" ? null : Number(raw);
  const minPrice = numberOrNull(rawMin), maxPrice = numberOrNull(rawMax), duration = numberOrNull(rawDuration);
  if ((minPrice !== null && (!Number.isFinite(minPrice) || minPrice < 0 || minPrice > 9999999999.99)) || (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice < 0 || maxPrice > 9999999999.99))) return { error: "Enter a valid budget between ₦0 and ₦9,999,999,999.99." };
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) return { error: "Minimum budget cannot exceed maximum budget." };
  const pricingUnit = scalar("pricingUnit");
  if (pricingUnit && !pricingUnits.includes(pricingUnit)) return { error: "Choose a valid rental price unit." };
  if ((minPrice !== null || maxPrice !== null) && !pricingUnit) return { error: "Choose a rental price unit to compare budgets fairly." };
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 744)) return { error: "Rental duration must be a whole number from 1 to 744." };
  if (duration !== null && !pricingUnit) return { error: "Choose a rental price unit for the duration filter." };
  const rawStart = scalar("availabilityStart");
  if (rawStart === null) return { error: "Choose a valid availability date." };
  let startAt = null, endAt = null;
  if (rawStart) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(rawStart) || !Number.isFinite(Date.parse(rawStart))) return { error: "Choose a valid availability date." };
    if (!pricingUnit) return { error: "Choose a rental price unit to check date availability." };
    if (duration === null) return { error: "Enter the rental duration to check availability for these dates." };
    const units = duration;
    startAt = new Date(rawStart);
    endAt = addRentalPeriod(startAt,pricingUnit,units);
    if (startAt <= new Date()) return { error: "Availability date must be in the future." };
  }
  const category = scalar("category"), location = scalar("location"), search = scalar("q"), sort = scalar("sort") || "relevance";
  if (category && !categories.includes(category)) return { error: "Choose a valid category." };
  if ([category, location, search, sort].includes(null) || location.length > 120 || search.length > 120) return { error: "Search text is too long or invalid." };
  if (!["relevance", "price_asc", "price_desc"].includes(sort)) return { error: "Choose a valid sort order." };
  const rawLat=scalar("lat"),rawLng=scalar("lng");
  if((rawLat==="")!==(rawLng===""))return {error:"Provide both map coordinates."};
  const latitude=rawLat===""?null:Number(rawLat),longitude=rawLng===""?null:Number(rawLng);
  if(latitude!==null&&(!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180))return {error:"Provide valid map coordinates."};
  const pageRaw = scalar("page") || "1", pageSizeRaw = scalar("pageSize") || "24";
  const page = Number(pageRaw), pageSize = Number(pageSizeRaw);
  if (!/^\d+$/.test(pageRaw) || !Number.isSafeInteger(page) || page < 1 || page > 100000) return { error: "Invalid search page." };
  if (!/^\d+$/.test(pageSizeRaw) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 48) return { error: "Page size must be between 1 and 48." };
  const where = ["i.paused=FALSE", "i.moderation_status='approved'", "i.city IS NOT NULL", "i.state IS NOT NULL", "i.price > 0", "i.pricing_unit IN ('hour','day','week','month','year')"];
  const values = [];
  if (category) { where.push("i.category=?"); values.push(category); }
  if (location) {
    const placeParts=location.split(",").map(part=>part.trim()).filter(Boolean);
    if(placeParts.length>1){where.push("LOWER(i.city) LIKE ? AND LOWER(i.state) LIKE ?");values.push(`%${placeParts[0].toLowerCase()}%`,`%${placeParts.slice(1).join(", ").toLowerCase()}%`);}
    else { const pattern = `%${location.toLowerCase()}%`; where.push("(LOWER(i.city) LIKE ? OR LOWER(i.state) LIKE ? OR LOWER(i.area_name) LIKE ?)"); values.push(pattern, pattern, pattern); }
  }
  if (search) { const pattern = `%${search.toLowerCase()}%`; where.push("(LOWER(i.name) LIKE ? OR LOWER(i.description) LIKE ?)"); values.push(pattern, pattern); }
  const unitRate = pricingUnit ? "COALESCE((SELECT ipo.price FROM item_pricing_options ipo WHERE ipo.item_id=i.id AND ipo.pricing_unit=? LIMIT 1),IF(i.pricing_unit=?,i.price,NULL))" : "i.price";
  if (pricingUnit) { where.push(`${unitRate} IS NOT NULL`); values.push(pricingUnit, pricingUnit); }
  if (minPrice !== null) { where.push(`${unitRate}>=?`); if(pricingUnit)values.push(pricingUnit,pricingUnit); values.push(minPrice); }
  if (maxPrice !== null) { where.push(`${unitRate}<=?`); if(pricingUnit)values.push(pricingUnit,pricingUnit); values.push(maxPrice); }
  if (duration !== null) {
    if(pricingUnit){where.push("EXISTS(SELECT 1 FROM item_pricing_options pd WHERE pd.item_id=i.id AND pd.pricing_unit=? AND pd.min_period<=? AND pd.max_period>=?)");values.push(pricingUnit,duration,duration);}
    else {where.push("i.min_period<=? AND i.max_period>=?"); values.push(duration, duration);}
  }
  if (startAt) {
    where.push("((SELECT COALESCE(SUM(r.inventory_quantity),0) FROM rentals r WHERE r.item_id=i.id AND (r.status IN ('confirmed','active') OR (r.status='pending_payment' AND COALESCE(r.checkout_expires_at,DATE_ADD(r.created_at,INTERVAL 30 MINUTE))>UTC_TIMESTAMP())) AND r.start_at < ? AND r.end_at > ?) + (SELECT COALESCE(SUM(COALESCE(b.quantity,i.available_quantity)),0) FROM item_availability_blocks b WHERE b.item_id=i.id AND b.start_at < ? AND b.end_at > ?)) < i.available_quantity");
    values.push(endAt.toISOString().slice(0, 19).replace("T", " "), startAt.toISOString().slice(0, 19).replace("T", " "),endAt.toISOString().slice(0,19).replace("T"," "),startAt.toISOString().slice(0,19).replace("T"," "));
  }
  const orderParts=[];
  if (sort === "price_asc") { orderParts.push(`${pricingUnit ? unitRate : "i.price"} ASC`); if(pricingUnit)values.push(pricingUnit,pricingUnit); }
  else if (sort === "price_desc") { orderParts.push(`${pricingUnit ? unitRate : "i.price"} DESC`); if(pricingUnit)values.push(pricingUnit,pricingUnit); }
  else {
    if(search){orderParts.push("CASE WHEN LOWER(i.name)=? THEN 0 WHEN LOWER(i.name) LIKE ? THEN 1 ELSE 2 END");values.push(search.toLowerCase(),`${search.toLowerCase()}%`);}
    if(latitude!==null){orderParts.push("(i.latitude IS NULL OR i.longitude IS NULL) ASC,(6371*ACOS(LEAST(1,GREATEST(-1,SIN(RADIANS(?))*SIN(RADIANS(i.latitude))+COS(RADIANS(?))*COS(RADIANS(i.latitude))*COS(RADIANS(i.longitude)-RADIANS(?)))))) ASC");values.push(latitude,latitude,longitude);}
    orderParts.push("(CASE WHEN i.image IS NOT NULL AND i.image<>'' THEN 1 ELSE 0 END + CASE WHEN CHAR_LENGTH(COALESCE(i.description,''))>=80 THEN 1 ELSE 0 END) DESC");
  }
  orderParts.push("i.created_at DESC","i.id DESC");
  const order=orderParts.join(", ");
  const offset = (page - 1) * pageSize;
  return { sql: `${selectItemsSql} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, values: [...values, pageSize + 1, offset], page, pageSize, minPrice, maxPrice, pricingUnit, duration, availabilityStart: startAt?.toISOString() || "", sort, latitude, longitude };
}

const itemFields = {
  name: z.string({ required_error: "Item name is required." }).trim().min(1, "Item name is required.").max(180, "Item name is too long."),
  category: z.enum(categories, { errorMap: () => ({ message: "Choose a valid category." }) }),
  condition: z.enum(conditions, { errorMap: () => ({ message: "Choose a valid condition." }) }),
  location: z.string({ required_error: "Location is required." }).trim().min(1, "Location is required.").max(255, "Location is too long."),
  pickupAddress: z.string().trim().min(5, "Enter the full pickup address.").max(255, "Pickup address is too long."),
  city: z.string().trim().min(1, "City is required.").max(100),
  state: z.string().trim().min(1, "State is required.").max(100),
  areaName: z.string().trim().min(1, "Area name is required.").max(120),
  latitude: z.number().finite().min(-90).max(90).nullable(),
  longitude: z.number().finite().min(-180).max(180).nullable(),
  placeId: z.string().trim().max(255),
  description: z.string().trim().max(65535, "Description is too long."),
  knownDefects:z.string().trim().max(4000),cancellationPolicy:z.string().trim().max(4000),rentalConditions:z.string().trim().max(4000),
  image: z.string().max(2048, "Image URL is too long."),
  video: z.string().max(2048, "Video URL is too long."),
  price: z.number({ required_error: "Price is required.", invalid_type_error: "Price must be a number." }).finite().positive("Price must be greater than zero.").max(9999999999.99, "Price is too large."),
  pricingUnit: z.enum(pricingUnits, { errorMap: () => ({ message: "Choose a valid pricing unit." }) }),
  rentalPrices: z.array(z.object({ pricingUnit:z.enum(pricingUnits),price:z.number().finite().positive().max(9999999999.99),minPeriod:z.number().int().min(1).max(65535),maxPeriod:z.number().int().min(1).max(65535) }).strict()).min(1).max(5).optional(),
  minPeriod: z.number({ invalid_type_error: "Minimum rental period must be a number." }).int("Minimum rental period must be a whole number.").min(1, "Minimum rental period must be at least 1.").max(65535, "Minimum rental period is too large."),
  maxPeriod: z.number({ invalid_type_error: "Maximum rental period must be a number." }).int("Maximum rental period must be a whole number.").min(1, "Maximum rental period must be at least 1.").max(65535, "Maximum rental period is too large."),
  deposit: z.number({ invalid_type_error: "Deposit must be a number." }).finite().min(0, "Deposit cannot be negative.").max(9999999999.99, "Deposit is too large."),
  allowInstallments: z.boolean({ invalid_type_error: "Installment setting must be true or false." }),
  installmentDepositPercent: z.number().int().min(1).max(99),
  deliveryAvailable: z.boolean({ invalid_type_error: "Delivery availability must be true or false." }),
  riderDeliveryAvailable: z.boolean({ invalid_type_error: "Rider delivery availability must be true or false." }),
  deliveryFee: z.number({ invalid_type_error: "Delivery fee must be a number." }).finite().min(0, "Delivery fee cannot be negative.").max(9999999999.99, "Delivery fee is too large.")
  ,availableQuantity:z.number().int().min(1).max(10000)
};

const createItemSchema = z.object({
  name: itemFields.name,
  category: itemFields.category,
  condition: itemFields.condition.default("Good"),
  location: itemFields.location,
  pickupAddress: itemFields.pickupAddress,
  city: itemFields.city,
  state: itemFields.state,
  areaName: itemFields.areaName,
  latitude: itemFields.latitude,
  longitude: itemFields.longitude,
  placeId: itemFields.placeId.optional().default(""),
  description: itemFields.description.default(""),
  knownDefects:itemFields.knownDefects.optional().default(""),cancellationPolicy:itemFields.cancellationPolicy.optional().default(""),rentalConditions:itemFields.rentalConditions.optional().default(""),
  image: itemFields.image.default(""),
  video: itemFields.video.default(""),
  price: itemFields.price,
  pricingUnit: itemFields.pricingUnit.default("day"),
  minPeriod: itemFields.minPeriod.default(1),
  maxPeriod: itemFields.maxPeriod.default(14),
  deposit: itemFields.deposit.default(0),
  allowInstallments: itemFields.allowInstallments.default(false),
  installmentDepositPercent: itemFields.installmentDepositPercent.default(50),
  deliveryAvailable: itemFields.deliveryAvailable.default(false),
  riderDeliveryAvailable: itemFields.riderDeliveryAvailable.default(false),
  deliveryFee: itemFields.deliveryFee.default(0),
  availableQuantity:itemFields.availableQuantity.default(1),
  rentalPrices:itemFields.rentalPrices.optional()
}).strict("Request contains fields that cannot be changed.").superRefine(validateItemRules);

const updateItemSchema = z.object({
  ...itemFields,
  paused: z.boolean({ invalid_type_error: "Paused must be true or false." })
}).partial().strict("Request contains fields that cannot be changed.").refine(
  (data) => Object.keys(data).length > 0,
  { message: "Provide at least one item field to update." }
);

const idSchema = z.string().regex(/^\d+$/, "Invalid item id.");
const mysqlDate = value => value.toISOString().slice(0,19).replace("T"," ");

const selectItemsSql = `
  SELECT i.id, i.owner_id, i.name, i.category, i.item_condition,
         i.location, i.description, i.ai_description, i.moderation_status, i.image, i.original_image, i.video, i.price,
         i.pickup_address, i.city, i.state, i.area_name, i.latitude, i.longitude, i.public_latitude, i.public_longitude,
         i.pricing_unit, i.min_period, i.max_period, i.available_quantity, i.deposit,i.installment_enabled,i.installment_deposit_percent,
         i.delivery_available, i.delivery_fee, i.rider_delivery_available, i.paused,i.known_defects,i.cancellation_policy,i.rental_conditions,
         u.name AS owner_name, u.phone AS owner_phone,
         u.brand AS owner_brand,u.email_verified AS owner_email_verified,
         COALESCE(owner_reviews.average_rating,0) AS owner_average_rating,COALESCE(owner_reviews.review_count,0) AS owner_review_count,
         COALESCE(owner_reviews.communication_rating,0) AS owner_communication_rating,COALESCE(owner_reviews.accuracy_rating,0) AS owner_accuracy_rating,
         COALESCE(owner_reviews.reliability_rating,0) AS owner_reliability_rating,COALESCE(owner_reviews.fulfillment_rating,0) AS owner_fulfillment_rating,
         COALESCE(owner_rentals.completed_rentals,0) AS owner_completed_rentals
    FROM items i
    JOIN users u ON u.id = i.owner_id
    LEFT JOIN (SELECT target_user_id,AVG(overall_rating) average_rating,COUNT(*) review_count,AVG(communication_rating) communication_rating,AVG(accuracy_rating) accuracy_rating,AVG(reliability_rating) reliability_rating,AVG(fulfillment_rating) fulfillment_rating FROM rental_party_reviews WHERE target_role='lister' AND status='approved' GROUP BY target_user_id) owner_reviews ON owner_reviews.target_user_id=i.owner_id
    LEFT JOIN (SELECT owner_id,COUNT(*) completed_rentals FROM rentals WHERE status='completed' AND payment_verified_at IS NOT NULL AND safety_hold=FALSE GROUP BY owner_id) owner_rentals ON owner_rentals.owner_id=i.owner_id
`;

function validateItemRules(data, context) {
  if (data.maxPeriod < data.minPeriod) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxPeriod"],
      message: "Maximum rental period cannot be shorter than the minimum."
    });
  }
  if(data.rentalPrices){
    if(new Set(data.rentalPrices.map(option=>option.pricingUnit)).size!==data.rentalPrices.length)context.addIssue({code:z.ZodIssueCode.custom,path:["rentalPrices"],message:"Choose each rental price period only once."});
    if(data.rentalPrices.some(option=>option.maxPeriod<option.minPeriod))context.addIssue({code:z.ZodIssueCode.custom,path:["rentalPrices"],message:"Each rental period maximum must be at least its minimum."});
  }

  if ((data.latitude == null) !== (data.longitude == null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["latitude"], message: "Choose both map coordinates, or leave the map pin empty." });
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

function addRentalPeriod(start,unit,count){
  const end=new Date(start.getTime());
  if(unit==="hour")end.setUTCHours(end.getUTCHours()+count);
  else if(unit==="day")end.setUTCDate(end.getUTCDate()+count);
  else if(unit==="week")end.setUTCDate(end.getUTCDate()+count*7);
  else {
    const monthDelta=unit==="year"?count*12:count;
    const day=end.getUTCDate();end.setUTCDate(1);end.setUTCMonth(end.getUTCMonth()+monthDelta);
    const lastDay=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,0)).getUTCDate();end.setUTCDate(Math.min(day,lastDay));
  }
  return end;
}

function publicItem(row, includeOriginalImage = false) {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: redactContactDetails(row.name),
    category: row.category,
    condition: row.item_condition,
    location: redactContactDetails(row.area_name ? `${row.area_name}, ${row.city}, ${row.state}` : row.location),
    city: row.city || "",
    state: row.state || "",
    areaName: row.area_name || "",
    latitude: row.public_latitude == null ? null : Number(row.public_latitude),
    longitude: row.public_longitude == null ? null : Number(row.public_longitude),
    description: redactContactDetails(row.description || row.ai_description || ""),
    aiDescription:row.ai_description||"",
    moderationStatus:row.moderation_status||"approved",
    knownDefects:redactContactDetails(row.known_defects||""),cancellationPolicy:row.cancellation_policy||"",rentalConditions:row.rental_conditions||"",
    image: row.image || "",
    ...(includeOriginalImage ? { originalImage: row.original_image || "" } : {}),
    video: row.video || "",
    ownerName: redactContactDetails(row.owner_name),
    ownerPhone: "",
    ownerBrand: redactContactDetails(row.owner_brand || ""),
    ownerEmailVerified:Number(row.owner_email_verified)===1,
    ownerAverageRating:Number(row.owner_review_count)>0?Number(Number(row.owner_average_rating).toFixed(2)):null,
    ownerReviewCount:Number(row.owner_review_count||0),
    ownerCompletedRentals:Number(row.owner_completed_rentals||0),
    ownerRatingCategories:{communication:Number(row.owner_review_count)>0?Number(Number(row.owner_communication_rating).toFixed(2)):null,accuracy:Number(row.owner_review_count)>0&&row.owner_accuracy_rating!=null?Number(Number(row.owner_accuracy_rating).toFixed(2)):null,reliability:Number(row.owner_review_count)>0?Number(Number(row.owner_reliability_rating).toFixed(2)):null,fulfillment:Number(row.owner_review_count)>0?Number(Number(row.owner_fulfillment_rating).toFixed(2)):null},
    price: Number(row.price),
    pricingUnit: row.pricing_unit,
    rentalPrices: row.rental_prices || [{pricingUnit:row.pricing_unit,price:Number(row.price),minPeriod:Number(row.min_period),maxPeriod:Number(row.max_period)}],
    minPeriod: Number(row.min_period),
    maxPeriod: Number(row.max_period),
    availableQuantity:Number(row.available_quantity||1),
    deposit: Number(row.deposit),
    installmentAvailable: Boolean(row.installment_enabled),
    installmentDepositPercent: Number(row.installment_deposit_percent||50),
    deliveryAvailable: Boolean(row.delivery_available),
    riderDeliveryAvailable: Boolean(row.rider_delivery_available),
    deliveryFee: Number(row.delivery_fee),
    paused: Boolean(row.paused),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  };
}

async function findItem(pool, id) {
  const [rows] = await pool.execute(
    `${selectItemsSql} WHERE i.id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0]) return null;
  const item=publicItem(rows[0]);
  try { const [prices]=await pool.execute("SELECT pricing_unit,price,min_period,max_period FROM item_pricing_options WHERE item_id=? ORDER BY FIELD(pricing_unit,'hour','day','week','month','year')",[id]); if(prices.length)item.rentalPrices=prices.map(p=>({pricingUnit:p.pricing_unit,price:Number(p.price),minPeriod:Number(p.min_period),maxPeriod:Number(p.max_period)})); } catch(error) { if(error.code!=="ER_NO_SUCH_TABLE")throw error; }
  return item;
}

async function attachRentalPrices(pool, rows) {
  if (!rows.length) return [];
  const ids=rows.map(row=>row.id);
  const [prices]=await pool.execute(`SELECT item_id,pricing_unit,price,min_period,max_period FROM item_pricing_options WHERE item_id IN (${ids.map(()=>"?").join(",")}) ORDER BY FIELD(pricing_unit,'hour','day','week','month','year')`,ids);
  const byItem=new Map();for(const row of prices){const key=String(row.item_id);if(!byItem.has(key))byItem.set(key,[]);byItem.get(key).push({pricingUnit:row.pricing_unit,price:Number(row.price),minPeriod:Number(row.min_period),maxPeriod:Number(row.max_period)});}
  return rows.map(row=>({...publicItem(row),rentalPrices:byItem.get(String(row.id))||[{pricingUnit:row.pricing_unit,price:Number(row.price),minPeriod:Number(row.min_period),maxPeriod:Number(row.max_period)}]}));
}

function normalizeRentalPrices(data) {
  const options=data.rentalPrices?.length?data.rentalPrices:[{pricingUnit:data.pricingUnit,price:data.price,minPeriod:data.minPeriod,maxPeriod:data.maxPeriod}];
  if(new Set(options.map(option=>option.pricingUnit)).size!==options.length)return {error:"Choose each rental price period only once."};
  if(options.some(option=>option.maxPeriod<option.minPeriod))return {error:"Each rental period maximum must be at least its minimum."};
  return {options};
}

async function saveRentalPrices(pool,itemId,data) {
  const normalized=normalizeRentalPrices(data);if(normalized.error)throw new Error(normalized.error);
  await pool.execute("DELETE FROM item_pricing_options WHERE item_id=?",[itemId]);
  for(const option of normalized.options)await pool.execute("INSERT INTO item_pricing_options(item_id,pricing_unit,price,min_period,max_period) VALUES(?,?,?,?,?)",[itemId,option.pricingUnit,option.price,option.minPeriod,option.maxPeriod]);
  return normalized.options;
}

function createItemsRouter({ pool, authenticate, supabase, moderateListing=assessListing }) {
  if (!pool) throw new Error("An item database pool is required.");
  if (typeof authenticate !== "function") throw new Error("Item authentication middleware is required.");

  const router = express.Router();

  router.get("/:id/availability-blocks", authenticate, async (request, response) => {
    const id=idSchema.safeParse(request.params.id);if(!id.success)return response.status(400).json({error:"Invalid listing."});
    try { const [owner]=await pool.execute("SELECT owner_id FROM items WHERE id=?",[id.data]);if(!owner.length)return response.status(404).json({error:"Listing not found."});if(String(owner[0].owner_id)!==String(request.user.id))return response.status(403).json({error:"Only the lister can manage availability."});
      const [rows]=await pool.execute("SELECT id,start_at,end_at,status,quantity,note FROM item_availability_blocks WHERE item_id=? ORDER BY start_at",[id.data]);return response.json(rows.map(row=>({id:String(row.id),startAt:new Date(row.start_at).toISOString(),endAt:new Date(row.end_at).toISOString(),status:row.status,quantity:row.quantity==null?null:Number(row.quantity),note:row.note||""}))); }
    catch(error){console.error("Loading availability blocks failed:",error.message);return response.status(500).json({error:"Unable to load availability."});}
  });

  router.post("/:id/availability-blocks", authenticate, async (request, response) => {
    const id=idSchema.safeParse(request.params.id),body=z.object({startAt:z.string().datetime(),endAt:z.string().datetime(),status:z.enum(["reserved","booked","occupied","unavailable"]),quantity:z.number().int().min(1).max(10000).nullable().optional(),note:z.string().trim().max(500).optional().default("")}).strict().safeParse(request.body);
    if(!id.success||!body.success)return response.status(400).json({error:body.success?"Invalid listing.":body.error.issues[0]?.message||"Check the availability dates."});const start=new Date(body.data.startAt),end=new Date(body.data.endAt);if(end<=start||end<=new Date())return response.status(400).json({error:"Choose a future date range with an end after its start."});
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [items]=await connection.execute("SELECT owner_id,available_quantity FROM items WHERE id=? FOR UPDATE",[id.data]);if(!items.length){await connection.rollback();return response.status(404).json({error:"Listing not found."});}if(String(items[0].owner_id)!==String(request.user.id)){await connection.rollback();return response.status(403).json({error:"Only the lister can manage availability."});}if(body.data.quantity!=null&&body.data.quantity>Number(items[0].available_quantity)){await connection.rollback();return response.status(400).json({error:"Blocked quantity exceeds listing capacity."});}
      const [existing]=await connection.execute("SELECT id FROM item_availability_blocks WHERE item_id=? AND start_at<? AND end_at>? FOR UPDATE",[id.data,mysqlDate(end),mysqlDate(start)]);if(existing.length){await connection.rollback();return response.status(409).json({error:"This range overlaps another manual availability block. Edit that block first."});}
      const blockedQuantity=body.data.quantity??Number(items[0].available_quantity);const [booked]=await connection.execute("SELECT COALESCE(SUM(inventory_quantity),0) quantity FROM rentals WHERE item_id=? AND (status IN ('confirmed','active') OR (status='pending_payment' AND COALESCE(checkout_expires_at,DATE_ADD(created_at,INTERVAL 30 MINUTE))>UTC_TIMESTAMP())) AND start_at<? AND end_at>?",[id.data,mysqlDate(end),mysqlDate(start)]);if(Number(booked[0]?.quantity||0)+blockedQuantity>Number(items[0].available_quantity)){await connection.rollback();return response.status(409).json({error:"This block would exceed remaining capacity during an existing rental."});}
      const [created]=await connection.execute("INSERT INTO item_availability_blocks(item_id,owner_id,start_at,end_at,status,quantity,note) VALUES(?,?,?,?,?,?,?)",[id.data,request.user.id,mysqlDate(start),mysqlDate(end),body.data.status,body.data.quantity??null,body.data.note||null]);await connection.commit();return response.status(201).json({id:String(created.insertId),status:body.data.status});
    }catch(error){await connection.rollback();console.error("Creating availability block failed:",error.message);return response.status(500).json({error:"Unable to update availability."});}finally{connection.release();}
  });

  router.delete("/:id/availability-blocks/:blockId", authenticate, async (request, response) => {
    const id=idSchema.safeParse(request.params.id),block=idSchema.safeParse(request.params.blockId);if(!id.success||!block.success)return response.status(400).json({error:"Invalid availability block."});
    try{const [result]=await pool.execute("DELETE b FROM item_availability_blocks b JOIN items i ON i.id=b.item_id WHERE b.id=? AND b.item_id=? AND i.owner_id=?",[block.data,id.data,request.user.id]);if(!result.affectedRows)return response.status(404).json({error:"Availability block not found."});return response.json({deleted:true});}catch(error){console.error("Deleting availability block failed:",error.message);return response.status(500).json({error:"Unable to remove availability."});}
  });

  router.get("/search", async (request, response) => {
    try {
      const search = buildBudgetSearchQuery(request.query);
      if (search.error) return response.status(400).json({ error: search.error });
      const [rows] = await pool.execute(search.sql, search.values);
      const hasMore = rows.length > search.pageSize;
      const priced=await attachRentalPrices(pool,rows.slice(0,search.pageSize));
      return response.status(200).json({
        items: priced.map((item,index) => ({...item,distanceKm:search.latitude==null||rows[index].latitude==null||rows[index].longitude==null?null:Number(haversineKm(search.latitude,search.longitude,Number(rows[index].latitude),Number(rows[index].longitude)).toFixed(1))})),
        page: search.page,
        pageSize: search.pageSize,
        hasMore,
        appliedBudget: search.minPrice !== null || search.maxPrice !== null ? { min: search.minPrice, max: search.maxPrice, pricingUnit: search.pricingUnit } : null
      });
    } catch (error) {
      console.error("Searching listings failed:", error.message);
      return response.status(500).json({ error: "Unable to search listings." });
    }
  });

  router.post("/:id/moderate", authenticate, async (request,response)=>{
    const id=idSchema.safeParse(request.params.id);if(!id.success)return response.status(400).json({error:"Invalid listing."});
    let item,policy,hash,connection;
    try{
      connection=await pool.getConnection();await connection.beginTransaction();
      const [items]=await connection.execute("SELECT id,owner_id,name,category,item_condition,description,ai_description,image,city,state,area_name,latitude,longitude,price,moderation_status,paused FROM items WHERE id=? FOR UPDATE",[id.data]);
      if(!items.length){await connection.rollback();return response.status(404).json({error:"Listing not found."});}item=items[0];if(String(item.owner_id)!==String(request.user.id)){await connection.rollback();return response.status(403).json({error:"Only the lister can submit this listing for moderation."});}
      if(item.moderation_status==="approved"){await connection.rollback();return response.json({status:"approved",message:"This listing is already approved."});}
      if(item.moderation_status!=="pending_analysis"){await connection.rollback();return response.status(409).json({error:"This listing is not awaiting an automated review. Follow the review message to resubmit it."});}
      const [settingsRows]=await connection.execute("SELECT enabled,policy_text,prohibited_terms,review_terms,auto_approval_confidence FROM listing_moderation_settings WHERE setting_id=1");
      if(!settingsRows.length){await connection.rollback();return response.status(503).json({error:"Listing moderation is not configured."});}
      const setting=settingsRows[0],parseList=value=>Array.isArray(value)?value:(typeof value==="string"?JSON.parse(value||"[]"):[]);
      policy={prohibitedTerms:parseList(setting.prohibited_terms),reviewTerms:parseList(setting.review_terms),policyText:setting.policy_text,autoApprovalConfidence:Number(setting.auto_approval_confidence)};
      const aiControl=await getAiControlState(connection);
      hash=crypto.createHash("sha256").update(JSON.stringify({name:item.name,category:item.category,condition:item.item_condition,description:item.description||"",image:item.image||"",policy})).digest("hex");
      const [jobs]=await connection.execute("SELECT id,status,input_hash,outcome,reason,confidence,updated_at FROM listing_moderation_jobs WHERE item_id=? FOR UPDATE",[id.data]);
      if(jobs[0]?.status==="completed"&&jobs[0].input_hash===hash){await connection.commit();return response.json({status:item.moderation_status,reason:jobs[0].reason,confidence:Number(jobs[0].confidence||0)});}
      if(jobs[0]?.status==="processing"&&Date.now()-new Date(jobs[0].updated_at).getTime()<10*60_000){await connection.rollback();return response.status(409).json({error:"Listing moderation is already running."});}
      if(jobs.length)await connection.execute("UPDATE listing_moderation_jobs SET submitted_by=?,status='processing',input_hash=?,outcome=NULL,reason=NULL,provider_error=FALSE,completed_at=NULL WHERE item_id=?",[request.user.id,hash,id.data]);
      else await connection.execute("INSERT INTO listing_moderation_jobs(item_id,submitted_by,status,input_hash) VALUES(?,?,'processing',?)",[id.data,request.user.id,hash]);
      await connection.commit();
      const run=async()=>{
        let assessment,providerError=false;
        try{
          if(!Boolean(setting.enabled)||!aiControl.enabled)throw new Error("Automated moderation is disabled or not configured.");
          if(!item.image)throw new Error("No listing photo was submitted for the required image safety check.");
          const supabaseOrigin=(()=>{try{return new URL(process.env.SUPABASE_URL).origin;}catch{return "";}})();
          const key=keyFromReference(item.image,{supabaseOrigin,supabaseBucket:process.env.SUPABASE_STORAGE_BUCKET||"shedshare-media",s3BaseUrl:null});if(!key||!supabase)throw new Error("The stored listing photo cannot be checked safely.");
          const {data,error}=await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET||"shedshare-media").download(key);if(error||!data)throw new Error("The listing photo could not be loaded for moderation.");
          const buffer=Buffer.from(await data.arrayBuffer());if(buffer.length>8*1024*1024||!validImage(buffer))throw new Error("The stored photo is too large or unsupported for moderation.");
          const imageDataUrl=`data:${imageMimeType(buffer)};base64,${buffer.toString("base64")}`;
          assessment=await moderateListing({name:item.name,category:item.category,condition:item.item_condition,description:item.description||""},imageDataUrl,policy);
        }catch(error){providerError=true;assessment={itemSummary:"Automated item identification unavailable.",shortDescription:"",confidence:0,outcome:"pending_review",reason:error.message.slice(0,1800),concerns:["automated_check_failed"]};}
        const final=await pool.getConnection();let approved=false;
        try{await final.beginTransaction();const [locked]=await final.execute("SELECT moderation_status,owner_id FROM items WHERE id=? FOR UPDATE",[id.data]);const [current]=await final.execute("SELECT status FROM listing_moderation_jobs WHERE item_id=? FOR UPDATE",[id.data]);if(!locked.length||!current.length||current[0].status!=="processing"){await final.rollback();return {status:"pending_review"};}
          if(locked[0].moderation_status!=="pending_analysis"){await final.rollback();return {status:locked[0].moderation_status};}
          approved=assessment.outcome==="auto_approved";const newStatus=approved?"approved":"pending_review";
          await final.execute("UPDATE items SET moderation_status=?,ai_description=? WHERE id=?",[newStatus,assessment.shortDescription||null,id.data]);
          await final.execute("UPDATE listing_moderation_jobs SET status='completed',outcome=?,item_summary=?,ai_description=?,reason=?,confidence=?,provider_error=?,completed_at=UTC_TIMESTAMP() WHERE item_id=?",[approved?"auto_approved":"pending_review",assessment.itemSummary,assessment.shortDescription,assessment.reason,assessment.confidence,providerError,id.data]);
          await final.execute("INSERT INTO listing_moderation_audit(item_id,actor_id,action,previous_status,new_status,reason,ai_description,confidence) VALUES(?,NULL,?,?,?,?,?,?)",[id.data,approved?"auto_approved":"flagged",locked[0].moderation_status,newStatus,assessment.reason,assessment.shortDescription,assessment.confidence]);
          const notice=approved?"Your listing passed ShedShare's automated checks and is now public.":"Your listing is hidden while an administrator reviews it. We will notify you when there is an update.";
          await final.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES(?,?,?,?)",[locked[0].owner_id,approved?"listing_approved":"listing_review_pending",notice,id.data]);await final.commit();
        }catch(error){await final.rollback();throw error;}finally{final.release();}
        if(approved){try{const [counts]=await pool.execute("SELECT COUNT(*) total FROM items WHERE owner_id=? AND moderation_status='approved' AND paused=FALSE",[item.owner_id]);if(Number(counts[0]?.total)===1)await recordReferralEvent(pool,item.owner_id,"first_public_listing",`first-public-listing:${item.owner_id}`,{itemId:String(id.data)});const [alerts]=await pool.execute("SELECT id,renter_id,city,state,latitude,longitude,radius_km FROM location_alerts WHERE status='active' AND category=? AND (max_price IS NULL OR max_price>=?) AND LOWER(city)=LOWER(?) AND LOWER(state)=LOWER(?)",[item.category,item.price,item.city,item.state]);for(const alert of alerts){if(item.latitude!=null&&alert.latitude!=null&&alert.longitude!=null&&haversineKm(Number(alert.latitude),Number(alert.longitude),Number(item.latitude),Number(item.longitude))>Number(alert.radius_km))continue;await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'location_alert_match',?,?)",[alert.renter_id,`A newly approved listing is available near ${item.area_name}, ${item.city}.`,id.data]);await pool.execute("UPDATE location_alerts SET status='matched' WHERE id=? AND status='active'",[alert.id]);}}catch(error){console.error("Post-approval listing notifications failed:",error.message);}}
        return {status:approved?"approved":"pending_review",reason:assessment.reason,confidence:assessment.confidence};
      };
      return response.json(await run());
    }catch(error){if(connection)try{await connection.rollback();}catch{}console.error("Listing moderation submission failed:",error.message);return response.status(500).json({error:"Unable to submit the listing for moderation. It remains hidden pending review."});}
    finally{connection?.release();}
  });

  router.post("/:id/moderation/resubmit",authenticate,async(request,response)=>{const id=idSchema.safeParse(request.params.id);if(!id.success)return response.status(400).json({error:"Invalid listing."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT owner_id,moderation_status,name,category,item_condition,description,image FROM items WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await c.rollback();return response.status(404).json({error:"Listing not found."});}const item=rows[0];if(String(item.owner_id)!==String(request.user.id)){await c.rollback();return response.status(403).json({error:"Only the lister can resubmit this listing."});}if(item.moderation_status!=="needs_information"){await c.rollback();return response.status(409).json({error:"This listing is not waiting for more information."});}const [settingRows]=await c.execute("SELECT policy_text,prohibited_terms,review_terms,auto_approval_confidence FROM listing_moderation_settings WHERE setting_id=1"),setting=settingRows[0]||{},list=value=>Array.isArray(value)?value:(typeof value==="string"?JSON.parse(value||"[]"):[]),policy={prohibitedTerms:list(setting.prohibited_terms),reviewTerms:list(setting.review_terms),policyText:setting.policy_text||DEFAULT_POLICY.policyText,autoApprovalConfidence:Number(setting.auto_approval_confidence??DEFAULT_POLICY.autoApprovalConfidence)},hash=crypto.createHash("sha256").update(JSON.stringify({name:item.name,category:item.category,condition:item.item_condition,description:item.description||"",image:item.image||"",policy})).digest("hex"),[jobs]=await c.execute("SELECT input_hash FROM listing_moderation_jobs WHERE item_id=? FOR UPDATE",[id.data]);if(jobs.length&&jobs[0].input_hash===hash){await c.rollback();return response.status(409).json({error:"Update the requested listing details or replace its photo before resubmitting."});}await c.execute("UPDATE items SET moderation_status='pending_analysis' WHERE id=?",[id.data]);await c.execute("UPDATE listing_moderation_jobs SET status='completed' WHERE item_id=?",[id.data]);await c.execute("INSERT INTO listing_moderation_audit(item_id,actor_id,action,previous_status,new_status,reason) VALUES(?,?,'resubmitted','needs_information','pending_analysis','Lister resubmitted updated listing details.')",[id.data,request.user.id]);await c.commit();return response.json({status:"pending_analysis"});}catch(error){await c.rollback();console.error("Listing moderation resubmission failed:",error.message);return response.status(500).json({error:"Unable to resubmit this listing."});}finally{c.release();}});

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
        const priced=await attachRentalPrices(pool,rows);
        return response.status(200).json(priced.map((item,index)=>({...item,originalImage:rows[index].original_image||"",pickupAddress:rows[index].pickup_address||""})));
      }

      let sql = `${selectItemsSql} WHERE i.paused = FALSE AND i.moderation_status='approved' AND i.city IS NOT NULL AND i.state IS NOT NULL`;
      const values = [];
      const city = String(request.query.city || "").trim(), state = String(request.query.state || "").trim(), location = String(request.query.location || "").trim().toLowerCase();
      const rawLat=request.query.lat,rawLng=request.query.lng;
      const lat = Number(rawLat), lng = Number(rawLng);
      if (city) { sql += " AND LOWER(i.city)=LOWER(?)"; values.push(city); }
      if (state) { sql += " AND LOWER(i.state)=LOWER(?)"; values.push(state); }
      if (location && !/^nearby$/.test(location) && request.query.lat === undefined) { sql += " AND (LOWER(i.city) LIKE ? OR LOWER(i.state) LIKE ? OR LOWER(i.area_name) LIKE ?)"; const pattern = `%${location}%`; values.push(pattern, pattern, pattern); }
      if (rawLat !== undefined || rawLng !== undefined) {
        if(rawLat===undefined||rawLng===undefined||!Number.isFinite(lat)||!Number.isFinite(lng))return response.status(400).json({error:"Provide a valid map center."});
      }
      sql += " ORDER BY i.created_at DESC";
      const [rows] = await pool.execute(sql, values);
      const result = rawLat !== undefined && rawLng !== undefined
        ? rows.map(row => ({...row,distance_km:row.latitude == null || row.longitude == null ? null : haversineKm(lat,lng,Number(row.latitude),Number(row.longitude))})).sort((a,b)=>(a.distance_km ?? Infinity)-(b.distance_km ?? Infinity))
        : rows;
      const priced=await attachRentalPrices(pool,result);
      return response.status(200).json(priced.map((item,index) => ({ ...item, distanceKm: result[index].distance_km == null ? null : Number(result[index].distance_km.toFixed(1)) })));
    } catch (error) {
      console.error("Loading items failed:", error.message);
      return response.status(500).json({ error: "Unable to load items." });
    }
  });

  router.get("/profile-location", authenticate, async (request,response)=>{
    try { const [rows]=await pool.execute("SELECT city,state FROM users WHERE id=? LIMIT 1",[request.user.id]); return response.json(rows[0] || {city:"",state:""}); }
    catch(error){console.error("Loading profile location failed:",error.message);return response.status(500).json({error:"Unable to load profile location."});}
  });

  // Return only a currently public listing. Rent Again uses this endpoint to
  // refresh price and availability context instead of trusting an old history
  // card or cached catalogue entry.
  router.get("/:id", async (request, response) => {
    try {
      const item = await findItem(pool, request.params.id);
      if (!item || item.paused || item.moderationStatus!=="approved") return response.status(404).json({ error: "This listing is no longer available. Browse current listings to find another option." });
      return response.status(200).json(item);
    } catch (error) {
      console.error("Loading listing failed:", error.message);
      return response.status(500).json({ error: "Unable to load the current listing. Please try again." });
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
      if (data.latitude != null && (data.latitude < 4.2 || data.latitude > 13.9 || data.longitude < 2.6 || data.longitude > 14.8)) return response.status(400).json({ error: "Pickup coordinates must be in Nigeria." });
      if (data.placeId) {
        const [verified] = await pool.execute("SELECT formatted_address,city,state,area_name,latitude,longitude FROM geocode_cache WHERE place_id=? LIMIT 1",[data.placeId]);
        if(!verified.length||verified[0].city.toLowerCase()!==data.city.toLowerCase()||verified[0].state.toLowerCase()!==data.state.toLowerCase())return response.status(400).json({error:"Verify the pickup address before saving the listing."});
        Object.assign(data,{pickupAddress:verified[0].formatted_address,city:verified[0].city,state:verified[0].state,areaName:verified[0].area_name,latitude:Number(verified[0].latitude),longitude:Number(verified[0].longitude)});
      }
      data.location=[data.areaName,data.city,data.state].filter(Boolean).join(", ");

    try {
      const [result] = await pool.execute(
        `INSERT INTO items
          (owner_id, name, category, item_condition, location, pickup_address, city, state, area_name, latitude, longitude, public_latitude, public_longitude, geocode_place_id, description,
           image, video, price, pricing_unit, min_period, max_period,
           deposit, delivery_available, delivery_fee, rider_delivery_available,known_defects,cancellation_policy,rental_conditions,available_quantity,installment_enabled,installment_deposit_percent,moderation_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_analysis')`,
        [
          request.user.id,
          data.name,
          data.category,
          data.condition,
          data.location,
          data.pickupAddress,
          data.city,
          data.state,
          data.areaName,
          data.latitude,
          data.longitude,
          data.latitude == null ? null : jitterCoordinate(data.latitude, 300, true),
          data.longitude == null ? null : jitterCoordinate(data.longitude, 300, false, data.latitude),
          data.placeId || null,
          data.description || null,
          data.image || null,
          data.video || null,
          data.price,
          data.pricingUnit,
          data.minPeriod,
          data.maxPeriod,
          data.deposit,
          data.deliveryAvailable,
          data.deliveryAvailable ? data.deliveryFee : 0,
          data.riderDeliveryAvailable,
          data.knownDefects||null,data.cancellationPolicy||null,data.rentalConditions||null,data.availableQuantity,data.allowInstallments,data.installmentDepositPercent
        ]
      );

      await saveRentalPrices(pool,result.insertId,data);
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
          `SELECT owner_id, name, category, item_condition, description, image, video, moderation_status, price, pricing_unit, min_period, max_period, available_quantity, delivery_available, delivery_fee, latitude, longitude, pickup_address, city, state, area_name, geocode_place_id
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
      const safetyFields = [["name","name"],["category","category"],["condition","item_condition"],["description","description"],["image","image"],["video","video"]];
      const moderationChanged = safetyFields.some(([field,column]) => data[field] !== undefined && String(data[field] ?? "") !== String(existingRows[0][column] ?? ""));
      const locationFields = ["pickupAddress","city","state","areaName","latitude","longitude","placeId"];
      const hasLocationUpdate = locationFields.some(field => data[field] !== undefined);
      if (hasLocationUpdate && !locationFields.every(field => data[field] !== undefined)) return response.status(400).json({error:"Update the pickup address, city, state, area, and map pin together."});
      if (hasLocationUpdate && ((data.latitude == null) !== (data.longitude == null))) return response.status(400).json({error:"Choose both map coordinates, or leave the map pin empty."});
      if (hasLocationUpdate && data.latitude == null) {
        if (data.placeId) return response.status(400).json({error:"Clear the map pin or choose a map pin again."});
        data.location=[data.areaName,data.city,data.state].filter(Boolean).join(", ");
        data.publicLatitude=null;data.publicLongitude=null;
      } else if (data.latitude !== undefined && data.longitude !== undefined) {
        if (data.latitude < 4.2 || data.latitude > 13.9 || data.longitude < 2.6 || data.longitude > 14.8) return response.status(400).json({error:"Pickup coordinates must be in Nigeria."});
        if (data.placeId) {
          const [verified]=await pool.execute("SELECT formatted_address,city,state,area_name,latitude,longitude FROM geocode_cache WHERE place_id=? LIMIT 1",[data.placeId]);
          if(!verified.length||verified[0].city.toLowerCase()!==data.city.toLowerCase()||verified[0].state.toLowerCase()!==data.state.toLowerCase())return response.status(400).json({error:"Verify this pickup address before saving the listing."});
          Object.assign(data,{pickupAddress:verified[0].formatted_address,city:verified[0].city,state:verified[0].state,areaName:verified[0].area_name,latitude:Number(verified[0].latitude),longitude:Number(verified[0].longitude),location:[verified[0].area_name,verified[0].city,verified[0].state].filter(Boolean).join(", ")});
        }
      }
      if ([data.image, data.video].some((value) => typeof value === "string" && /^data:/i.test(value))) {
        return response.status(400).json({ error: "Upload image and video files through their authenticated media upload endpoints." });
      }
      const minPeriod = data.minPeriod ?? Number(existingRows[0].min_period);
      const maxPeriod = data.maxPeriod ?? Number(existingRows[0].max_period);
      if(data.rentalPrices){const checked=normalizeRentalPrices({...data,minPeriod,maxPeriod});if(checked.error)return response.status(400).json({error:checked.error});}
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
        pickupAddress: "pickup_address", city: "city", state: "state", areaName: "area_name", latitude: "latitude", longitude: "longitude", placeId: "geocode_place_id",
        description: "description",
        knownDefects:"known_defects",cancellationPolicy:"cancellation_policy",rentalConditions:"rental_conditions",
        image: "image",
        video: "video",
        price: "price",
        pricingUnit: "pricing_unit",
        minPeriod: "min_period",
        maxPeriod: "max_period",
        deposit: "deposit",
        allowInstallments: "installment_enabled",
        installmentDepositPercent: "installment_deposit_percent",
        deliveryAvailable: "delivery_available",
        riderDeliveryAvailable: "rider_delivery_available",
        deliveryFee: "delivery_fee",
        availableQuantity:"available_quantity",
        paused: "paused"
      };

      if (hasLocationUpdate) {
        const lat = data.latitude, lng = data.longitude;
        data.publicLatitude = lat == null ? null : jitterCoordinate(lat, 300, true);
        data.publicLongitude = lng == null ? null : jitterCoordinate(lng, 300, false, lat);
        columns.publicLatitude = "public_latitude"; columns.publicLongitude = "public_longitude";
      }

      const assignments = [];
      const values = [];
      if (!hasLocationUpdate) {
        for (const column of ["pickup_address","city","state","area_name","latitude","longitude","public_latitude","public_longitude","geocode_place_id"]) { assignments.push(`${column} = ?`); values.push(existingRows[0][column] ?? null); }
      }
      for (const [field, value] of Object.entries(data)) {
        if(field==="rentalPrices")continue;
        if (field === "placeId" && !hasLocationUpdate) continue;
        assignments.push(`${columns[field]} = ?`);
        values.push(value === "" && ["description", "image", "video"].includes(field) ? null : value);
      }
      if (moderationChanged) assignments.push("moderation_status = 'pending_analysis'");

      values.push(parsedId.data, request.user.id);
      await pool.execute(
        `UPDATE items SET ${assignments.join(", ")} WHERE id = ? AND owner_id = ?`,
        values
      );
      if (moderationChanged) {
        await pool.execute("INSERT INTO listing_moderation_audit(item_id,actor_id,action,previous_status,new_status,reason) VALUES(?,?,'resubmitted',?,'pending_analysis','Listing content changed and requires a fresh safety review.')",[parsedId.data,request.user.id,existingRows[0].moderation_status]);
      }

      if(data.rentalPrices) await saveRentalPrices(pool,parsedId.data,data);
      else if(data.price!==undefined||data.pricingUnit!==undefined||data.minPeriod!==undefined||data.maxPeriod!==undefined){
        const [oldOptions]=await pool.execute("SELECT pricing_unit,price,min_period,max_period FROM item_pricing_options WHERE item_id=?",[parsedId.data]);
        const baseUnit=data.pricingUnit??existingRows[0].pricing_unit;
        const options=oldOptions.map(row=>({pricingUnit:row.pricing_unit,price:Number(row.price),minPeriod:Number(row.min_period),maxPeriod:Number(row.max_period)})).filter(option=>option.pricingUnit!==baseUnit);
        options.unshift({pricingUnit:baseUnit,price:data.price??Number(existingRows[0].price),minPeriod:data.minPeriod??Number(existingRows[0].min_period),maxPeriod:data.maxPeriod??Number(existingRows[0].max_period)});
        await saveRentalPrices(pool,parsedId.data,{rentalPrices:options});
      }

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

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (v) => v * Math.PI / 180, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function jitterCoordinate(value, meters, latitude, baseLatitude = value) {
  const offset = (Math.random() * 2 - 1) * meters;
  const divisor = latitude ? 111320 : 111320 * Math.cos(Number(baseLatitude) * Math.PI / 180);
  return Number((Number(value) + offset / divisor).toFixed(7));
}

module.exports = { createItemsRouter, haversineKm, buildBudgetSearchQuery };
