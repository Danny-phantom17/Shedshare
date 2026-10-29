"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { z } = require("zod");
const { createCheckoutRateLimiter } = require("./checkout-rate-limit");
const { requirePaystackMode } = require("./payment-mode");

const id = z.string().regex(/^\d+$/, "Invalid id.");
const categories = ["Home & Furniture", "Kitchen", "Vehicles", "Tools & Equipment", "Electronics", "Events", "Fashion", "Music", "Outdoor", "Other"];
const requestSchema = z.object({
  itemName: z.string().trim().min(1).max(180), category: z.enum(categories),
  description: z.string().trim().max(5000).optional().default(""),
  quantity: z.number().int().positive().max(1000),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deliveryLocation: z.string().trim().max(255).optional().default(""), pickupPreferred: z.boolean().optional().default(false),
  deliveryRequired: z.boolean().optional().default(false), budget: z.number().finite().positive().nullable().optional(),
  urgency: z.string().trim().max(40).optional().default(""), referenceImagePath: z.string().trim().max(512).regex(/^requests\/\d+\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i, "Upload the reference image through ShedShare.").nullable().optional(), notes: z.string().trim().max(5000).optional().default("")
}).strict();
const offerSchema = z.object({
  requestId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String),
  itemId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String).nullable().optional(),
  offeredItemName: z.string().trim().min(1).max(180), quantity: z.number().int().positive().max(1000),
  price: z.number().finite().positive(), availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), availableTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deliveryOrCollection: z.enum(["delivery", "collection"]), deliveryFee: z.number().finite().nonnegative().nullable().optional(),
  deposit: z.number().finite().nonnegative().nullable().optional(), conditions: z.string().trim().max(5000).nullable().optional(), expiresAt: z.string().datetime()
}).strict();

function fail(res, status, error) { return res.status(status).json({ error }); }
function validDate(value) { const d = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value; }
function dateOnly(value) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
function referenceImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: "image/png", ext: "png" };
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}
function isPrivateReferenceKey(value, ownerId) {
  if (typeof value !== "string" || !/^requests\/\d+\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(value)) return false;
  return value.startsWith(`requests/${String(ownerId)}/`);
}
function referenceImageMime(key) {
  const extension = String(key).split(".").pop().toLowerCase();
  return extension === "jpg" ? "image/jpeg" : extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : null;
}

function createWorkflowRouter({ pool, authenticate, supabase }) {
  const router = express.Router();
  const auth = [authenticate];
  const checkoutRateLimiter = createCheckoutRateLimiter(pool);
  const referenceBucket = process.env.REQUEST_PRIVATE_STORAGE_BUCKET || "shedshare-request-references-private";
  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 5 * 1024 * 1024 } });

  router.post("/requests/reference-image", ...auth, (req, res, next) => imageUpload.single("image")(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return fail(res, 413, "Reference image must be 5 MiB or smaller.");
    if (error) return fail(res, 400, "Invalid image upload.");
    next();
  }), async (req, res) => {
    if (!supabase) return fail(res, 503, "Reference image storage is not configured.");
    if (!req.file) return fail(res, 400, "Choose an image to upload.");
    const type = referenceImageType(req.file.buffer); if (!type) return fail(res, 415, "Upload a JPEG, PNG, or WebP image.");
    const key = `requests/${req.user.id}/${crypto.randomUUID()}.${type.ext}`;
    try {
      const { data: bucketInfo, error: bucketError } = await supabase.storage.getBucket(referenceBucket);
      if (bucketError || !bucketInfo || bucketInfo.public) return fail(res, 503, "Private reference image storage is not configured correctly.");
      const { error } = await supabase.storage.from(referenceBucket).upload(key, req.file.buffer, { contentType: type.mime, upsert: false, cacheControl: "0" });
      if (error) throw error;
      return res.status(201).json({ referenceImagePath: key });
    } catch (e) { console.error("Uploading request reference image failed:", e.message); return fail(res, 500, "Unable to upload reference image."); }
  });

  // Reference photos are private and may be fetched only by their requester or an administrator.
  router.get("/requests/:id/reference-image", ...auth, async (req, res) => {
    const parsedId = id.safeParse(req.params.id); if (!parsedId.success) return fail(res, 400, "Invalid request id.");
    if (!supabase) return fail(res, 503, "Private reference image storage is not configured.");
    try {
      const [rows] = await pool.execute("SELECT customer_id,reference_image_url FROM item_requests WHERE id=?", [parsedId.data]);
      if (!rows.length) return fail(res, 404, "Request not found.");
      const row = rows[0];
      if (String(row.customer_id) !== String(req.user.id) && !req.user.isAdmin) return fail(res, 403, "You cannot view this reference image.");
      if (!isPrivateReferenceKey(row.reference_image_url, row.customer_id)) return fail(res, 404, "Reference image not found.");
      const { data: bucketInfo, error: bucketError } = await supabase.storage.getBucket(referenceBucket);
      if (bucketError || !bucketInfo || bucketInfo.public) return fail(res, 503, "Private reference image storage is not configured correctly.");
      const { data, error } = await supabase.storage.from(referenceBucket).download(row.reference_image_url);
      if (error || !data) return fail(res, 404, "Reference image not found.");
      const mime = referenceImageMime(row.reference_image_url);
      if (!mime) return fail(res, 415, "Unsupported reference image type.");
      res.set("Cache-Control", "private, no-store").set("X-Content-Type-Options", "nosniff").type(mime);
      return res.send(Buffer.from(await data.arrayBuffer()));
    } catch (e) { console.error("Loading private reference image failed:", e.message); return fail(res, 500, "Unable to load reference image."); }
  });

  router.get("/notifications", ...auth, async (req, res) => {
    try {
      const [rows] = await pool.execute("SELECT id,type,message,related_id,is_read,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100", [req.user.id]);
      return res.json(rows.map((n) => ({ id: String(n.id), type: n.type, message: n.message, relatedId: n.related_id == null ? null : String(n.related_id), read: Boolean(n.is_read), createdAt: new Date(n.created_at).toISOString() })));
    } catch (e) { console.error("Loading notifications failed:", e.message); return fail(res, 500, "Unable to load notifications."); }
  });
  router.patch("/notifications/:id/read", ...auth, async (req, res) => {
    const parsed = id.safeParse(req.params.id); if (!parsed.success) return fail(res, 400, "Invalid notification id.");
    try { const [result] = await pool.execute("UPDATE notifications SET is_read=TRUE WHERE id=? AND user_id=?", [parsed.data, req.user.id]); if (!result.affectedRows) return fail(res, 404, "Notification not found."); return res.json({ id: parsed.data, read: true }); }
    catch (e) { console.error("Updating notification failed:", e.message); return fail(res, 500, "Unable to update notification."); }
  });

  router.post("/location-alerts", rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }), ...auth, async (req, res) => {
    const parsed = z.object({ itemName: z.string().trim().min(1).max(180), category: z.enum(categories), city: z.string().trim().min(1).max(100), state: z.string().trim().min(1).max(100), areaName: z.string().trim().max(120).optional().default(""), latitude: z.number().finite().min(-90).max(90).nullable().optional(), longitude: z.number().finite().min(-180).max(180).nullable().optional(), radiusKm: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(25)]).default(10), maxPrice: z.number().finite().positive().nullable().optional() }).strict().superRefine((v,c)=>{if((v.latitude==null)!==(v.longitude==null))c.addIssue({code:z.ZodIssueCode.custom,message:"Latitude and longitude must be provided together."});}).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Enter the item and a valid location.");
    try { const d = parsed.data; await pool.execute("INSERT INTO location_alerts (renter_id,item_name,category,city,state,area_name,latitude,longitude,radius_km,max_price) VALUES (?,?,?,?,?,?,?,?,?,?)", [req.user.id,d.itemName,d.category,d.city,d.state,d.areaName||null,d.latitude??null,d.longitude??null,d.radiusKm,d.maxPrice??null]); return res.status(201).json({ message: "We’ll message you when a matching item is listed." }); }
    catch (e) { console.error("Creating location alert failed:", e.message); return fail(res, 500, "We couldn't save your alert right now. Check that database migration 005 is applied, then try again."); }
  });

  router.post("/requests/nearby", rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }), ...auth, async (req, res) => {
    const parsed = z.object({ itemName: z.string().trim().min(1).max(180), category: z.enum(categories).nullable().optional(), city: z.string().trim().min(1).max(100), state: z.string().trim().min(1).max(100), latitude: z.number().finite().min(-90).max(90).nullable().optional(), longitude: z.number().finite().min(-180).max(180).nullable().optional(), radiusKm: z.union([z.literal(1),z.literal(5),z.literal(10),z.literal(25)]).default(10), maxPrice: z.number().finite().positive().nullable().optional() }).strict().superRefine((v,c)=>{if((v.latitude==null)!==(v.longitude==null))c.addIssue({code:z.ZodIssueCode.custom,message:"Latitude and longitude must be provided together."});}).safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Enter the item and a valid location.");
    if (!req.user.emailVerified) return fail(res, 403, "Verify your email before submitting an item request.");
    const d=parsed.data, reference=`SSR-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    try {
      const [result]=await pool.execute("INSERT INTO item_requests (reference_number,customer_id,item_name,category,quantity,start_date,end_date,delivery_location,pickup_preferred,budget,city,state,latitude,longitude) VALUES (?,?,?,?,1,UTC_DATE(),DATE_ADD(UTC_DATE(),INTERVAL 30 DAY),?,TRUE,?,?,?,?,?)",[reference,req.user.id,d.itemName,d.category||"Other",`${d.city}, ${d.state}`,d.maxPrice??null,d.city,d.state,d.latitude??null,d.longitude??null]);
      const [owners]=await pool.execute("SELECT DISTINCT i.owner_id FROM items i WHERE i.paused=FALSE AND i.owner_id<>? AND (? IS NULL OR i.category=?) AND LOWER(i.city)=LOWER(?) AND LOWER(i.state)=LOWER(?) AND (? IS NULL OR i.price<=?) AND (? IS NULL OR (i.latitude IS NOT NULL AND i.longitude IS NOT NULL AND 6371*2*ASIN(SQRT(POWER(SIN(RADIANS(i.latitude-?)/2),2)+COS(RADIANS(?))*COS(RADIANS(i.latitude))*POWER(SIN(RADIANS(i.longitude-?)/2),2)))<=?))",[req.user.id,d.category??null,d.category??null,d.city,d.state,d.maxPrice??null,d.maxPrice??null,d.latitude??null,d.latitude??null,d.latitude??null,d.longitude??null,d.radiusKm]);
      for(const owner of owners) await pool.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)",[owner.owner_id,"nearby_item_request",`A renter near ${d.city}, ${d.state} requested ${d.itemName}.`,result.insertId]);
      await pool.execute("INSERT INTO request_audit (request_id,actor_id,action) VALUES (?,?,?)",[result.insertId,req.user.id,"submitted"]);
      return res.status(201).json({id:String(result.insertId),referenceNumber:reference,status:"submitted",notifiedOwners:owners.length});
    } catch(e){console.error("Creating nearby item request failed:",e.message);return fail(res,500,"We couldn't save your request right now. Check that database migrations 003 and 005 are applied, then try again.");}
  });

  router.post("/requests", rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }), ...auth, async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Invalid request.");
    if (!req.user.emailVerified) return fail(res, 403, "Verify your email before submitting an item request.");
    const d = parsed.data, today = new Date().toISOString().slice(0, 10);
    if (d.referenceImagePath && !isPrivateReferenceKey(d.referenceImagePath, req.user.id)) return fail(res, 400, "Upload the reference image through ShedShare before submitting the request.");
    if (!validDate(d.startDate) || !validDate(d.endDate) || d.startDate < today || d.startDate >= d.endDate) return fail(res, 400, "Choose valid future dates with the end after the start.");
    if (!d.deliveryLocation && !d.pickupPreferred) return fail(res, 400, "Enter a delivery location or select pickup.");
      if (d.deliveryRequired && !d.deliveryLocation) return fail(res, 400, "A delivery location is required for delivery.");
    try {
      const [dupes] = await pool.execute("SELECT id,reference_number FROM item_requests WHERE customer_id=? AND LOWER(item_name)=LOWER(?) AND category=? AND quantity=? AND start_date=? AND end_date=? AND COALESCE(LOWER(delivery_location),'')=LOWER(?) AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE) LIMIT 1", [req.user.id, d.itemName, d.category, d.quantity, d.startDate, d.endDate, d.deliveryLocation]);
      if (dupes.length) return fail(res, 409, `This request was already submitted. Reference: ${dupes[0].reference_number}`);
      const reference = `SSR-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      const [result] = await pool.execute("INSERT INTO item_requests (reference_number,customer_id,item_name,category,description,quantity,start_date,end_date,delivery_location,pickup_preferred,delivery_required,budget,urgency,reference_image_url,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [reference, req.user.id, d.itemName, d.category, d.description || null, d.quantity, d.startDate, d.endDate, d.deliveryLocation || null, d.pickupPreferred, d.deliveryRequired, d.budget ?? null, d.urgency || null, d.referenceImagePath || null, d.notes || null]);
      await pool.execute("INSERT INTO request_audit (request_id,actor_id,action) VALUES (?,?,?)", [result.insertId, req.user.id, "submitted"]);
      return res.status(201).json({ id: String(result.insertId), token: reference, referenceNumber: reference, status: "submitted", createdAt: new Date().toISOString() });
    } catch (e) { console.error("Creating item request failed:", e.message); return fail(res, 500, "Unable to create request."); }
  });

  router.get("/requests", ...auth, async (req, res) => {
    const admin = req.query.role === "admin";
    if (admin && !req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    if (req.query.role && !["admin", "customer"].includes(req.query.role)) return fail(res, 400, "Invalid request role.");
    try {
      await pool.execute("UPDATE request_offers SET status='expired' WHERE status='pending' AND expires_at<=UTC_TIMESTAMP()");
      const [settingRows] = await pool.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='request_expiry_days'");
      const configuredExpiry = Number(settingRows[0]?.setting_value ?? process.env.REQUEST_EXPIRY_DAYS ?? 14);
      const expiryDays = Number.isInteger(configuredExpiry) && configuredExpiry >= 1 && configuredExpiry <= 365 ? configuredExpiry : 14;
      const [stale] = await pool.execute(`SELECT r.id,r.status,r.created_at FROM item_requests r WHERE r.status IN ('submitted','searching','offers_received','awaiting_customer_decision') AND NOT EXISTS (SELECT 1 FROM request_offers o WHERE o.request_id=r.id AND o.status='pending')`);
      for (const row of stale) {
        const nextStatus = Date.now() - new Date(row.created_at).getTime() >= expiryDays * 86400000 ? "expired" : "searching";
        if (row.status !== nextStatus) {
          await pool.execute("UPDATE item_requests SET status=? WHERE id=?", [nextStatus, row.id]);
          await pool.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,NULL,?,JSON_OBJECT('from',?,'to',?))", [row.id, "request_status_changed", row.status, nextStatus]);
        }
      }
      const filters = [], values = [];
      if (!admin) { filters.push("r.customer_id=?"); values.push(req.user.id); }
      if (admin && req.query.status) { const validStatus = z.enum(["submitted","searching","offers_received","awaiting_customer_decision","booking_confirmed","completed","cancelled","expired","unfulfilled"]).safeParse(req.query.status); if (!validStatus.success) return fail(res, 400, "Invalid request status filter."); filters.push("r.status=?"); values.push(validStatus.data); }
      if (admin && req.query.category) { const validCategory = z.enum(categories).safeParse(req.query.category); if (!validCategory.success) return fail(res, 400, "Invalid request category filter."); filters.push("r.category=?"); values.push(validCategory.data); }
      const [rows] = await pool.execute(`SELECT r.*, u.name AS customer_name FROM item_requests r JOIN users u ON u.id=r.customer_id ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY r.created_at DESC LIMIT 500`, values);
      return res.json(rows.map(publicRequest));
    } catch (e) { console.error("Loading item requests failed:", e.message); return fail(res, 500, "Unable to load requests."); }
  });

  router.patch("/admin/settings/request-expiry", ...auth, async (req, res) => {
    if (!req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    const parsed = z.object({ days: z.number().int().min(1).max(365) }).strict().safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "Request expiry must be from 1 to 365 days.");
    try { await pool.execute("INSERT INTO shedshare_settings (setting_key,setting_value,updated_by) VALUES ('request_expiry_days',?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_by=VALUES(updated_by)", [String(parsed.data.days), req.user.id]); return res.json({ requestExpiryDays: parsed.data.days }); }
    catch (e) { console.error("Updating request expiry failed:", e.message); return fail(res, 500, "Unable to update request expiry."); }
  });

  router.get("/requests/:id", ...auth, async (req, res) => {
    const parsedId = id.safeParse(req.params.id); if (!parsedId.success) return fail(res, 400, "Invalid request id.");
    try {
      const [rows] = await pool.execute("SELECT r.*, u.name AS customer_name FROM item_requests r JOIN users u ON u.id=r.customer_id WHERE r.id=?", [parsedId.data]);
      if (!rows.length) return fail(res, 404, "Request not found.");
      const r = rows[0]; if (String(r.customer_id) !== String(req.user.id) && !req.user.isAdmin) return fail(res, 403, "You cannot view this request.");
      const [offers] = await pool.execute("SELECT o.*, u.name AS supplier_name FROM request_offers o JOIN users u ON u.id=o.supplier_id WHERE o.request_id=? ORDER BY o.created_at DESC", [parsedId.data]);
      let matchingSuppliers = [];
      if (req.user.isAdmin) {
        const needle = String(r.delivery_location || "").trim();
        const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
        const locationFilter = needle ? "AND (LOWER(i.location) LIKE LOWER(?) OR LOWER(?) LIKE CONCAT('%',LOWER(i.location),'%'))" : "";
        const locationScore = needle ? "MAX(CASE WHEN LOWER(i.location) LIKE LOWER(?) THEN 2 ELSE 1 END)" : "0";
        const [matches] = await pool.execute(`SELECT i.owner_id,MAX(i.location) AS location,COUNT(*) AS matching_items,MIN(i.price) AS lowest_price,${locationScore} AS location_score
          FROM items i WHERE i.category=? AND i.owner_id<>? AND i.paused=FALSE ${locationFilter}
            AND NOT EXISTS (SELECT 1 FROM rentals r2 WHERE r2.item_id=i.id AND r2.status IN ('confirmed','active') AND r2.start_at < ? AND r2.end_at > ?)
          GROUP BY i.owner_id ORDER BY location_score DESC,matching_items DESC,lowest_price ASC LIMIT 100`, needle ? [pattern, r.category, r.customer_id, pattern, needle, `${dateOnly(r.end_date)} 00:00:00`, `${dateOnly(r.start_date)} 00:00:00`] : [r.category, r.customer_id, `${dateOnly(r.end_date)} 00:00:00`, `${dateOnly(r.start_date)} 00:00:00`]);
        matchingSuppliers = matches.map((m) => ({ ownerId: String(m.owner_id), location: m.location, matchingItems: Number(m.matching_items), lowestPrice: Number(m.lowest_price), locationScore: Number(m.location_score) }));
      }
      return res.json({ ...publicRequest(r), offers: offers.map(publicOffer), ...(req.user.isAdmin ? { matchingSuppliers } : {}) });
    } catch (e) { console.error("Loading item request failed:", e.message); return fail(res, 500, "Unable to load request."); }
  });

  router.post("/requests/:id/notify-suppliers", ...auth, async (req, res) => {
    if (!req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    const parsedId = id.safeParse(req.params.id), suppliers = z.array(z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String)).min(1).max(100).safeParse(req.body?.candidateOwnerIds || req.body?.ownerIds || req.body?.supplierIds);
    if (!parsedId.success || !suppliers.success) return fail(res, 400, "Select one or more suppliers to notify.");
    try {
      const [rows] = await pool.execute("SELECT id,status FROM item_requests WHERE id=?", [parsedId.data]); if (!rows.length) return fail(res, 404, "Request not found.");
      if (["booking_confirmed","completed","cancelled","expired","unfulfilled"].includes(rows[0].status)) return fail(res, 409, "This request is no longer accepting supplier notifications.");
      const [requestRows] = await pool.execute("SELECT customer_id,category,delivery_location,start_date,end_date FROM item_requests WHERE id=?", [parsedId.data]);
      const [requestDetails] = await pool.execute("SELECT item_name,quantity,budget,delivery_location,start_date,end_date FROM item_requests WHERE id=?", [parsedId.data]);
      const selected = [...new Set(suppliers.data)];
      const location = String(requestRows[0].delivery_location || "").trim(), pattern = `%${location.replace(/[\\%_]/g, "\\$&")}%`;
      const locationFilter = location ? "AND (LOWER(i.location) LIKE LOWER(?) OR LOWER(?) LIKE CONCAT('%',LOWER(i.location),'%'))" : "";
      const locationParams = location ? [pattern, location] : [];
      const [candidateRows] = await pool.execute(`SELECT DISTINCT i.owner_id FROM items i WHERE i.owner_id IN (${selected.map(() => "?").join(",")}) AND i.owner_id<>? AND i.category=? AND i.paused=FALSE ${locationFilter} AND NOT EXISTS (SELECT 1 FROM rentals r2 WHERE r2.item_id=i.id AND r2.status IN ('confirmed','active') AND r2.start_at < ? AND r2.end_at > ?)`, [...selected, requestRows[0].customer_id, requestRows[0].category, ...locationParams, `${dateOnly(requestRows[0].end_date)} 00:00:00`, `${dateOnly(requestRows[0].start_date)} 00:00:00`]);
      const valid = new Set(candidateRows.map((row) => String(row.owner_id)));
      const actual = selected.filter((supplierId) => valid.has(supplierId));
      if (!actual.length) return fail(res, 400, "Choose at least one available matching supplier.");
      await pool.execute("UPDATE item_requests SET status='searching' WHERE id=? AND status IN ('submitted','searching')", [parsedId.data]);
      if (rows[0].status !== "searching") await pool.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('from',?,'to','searching'))", [parsedId.data, req.user.id, "request_status_changed", rows[0].status]);
      for (const supplierId of actual) {
        await pool.execute("INSERT INTO request_supplier_notifications (request_id,supplier_id,admin_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE admin_id=VALUES(admin_id),created_at=UTC_TIMESTAMP()", [parsedId.data, supplierId, req.user.id]);
        await pool.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('supplierId',?))", [parsedId.data, req.user.id, "supplier_notified", supplierId]);
        const details = requestDetails[0], message = `New request: ${details.item_name}; quantity ${details.quantity}; ${dateOnly(details.start_date)} to ${dateOnly(details.end_date)}; ${details.delivery_location ? `delivery to ${details.delivery_location}` : "customer prefers pickup"}${details.budget == null ? "" : `; budget ₦${Number(details.budget).toLocaleString()}`}. Submit an offer in ShedShare.`;
        await pool.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)", [supplierId, "request_notified", message.slice(0, 500), parsedId.data]);
      }
      return res.json({ notifiedSupplierIds: actual });
    } catch (e) { console.error("Notifying suppliers failed:", e.message); return fail(res, 500, "Unable to notify suppliers."); }
  });

  router.post("/requests/:id/mark-unfulfilled", ...auth, async (req, res) => {
    if (!req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    const parsedId = id.safeParse(req.params.id), reason = z.enum(["insufficient_supply","unavailable_dates","quantity_limitation","price_mismatch","delivery_limitation","supplier_non_response","other"]).safeParse(req.body?.unfulfilledReason);
    if (!parsedId.success || !reason.success) return fail(res, 400, "Choose a valid unfulfilled reason.");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT status FROM item_requests WHERE id=? FOR UPDATE", [parsedId.data]);
      if (!rows.length) { await connection.rollback(); return fail(res, 404, "Request not found."); }
      if (["booking_confirmed","completed","cancelled","expired","unfulfilled"].includes(rows[0].status)) { await connection.rollback(); return fail(res, 409, "This request can no longer be marked unfulfilled."); }
      await connection.execute("UPDATE item_requests SET status='unfulfilled',unfulfilled_reason=? WHERE id=?", [reason.data, parsedId.data]);
      await connection.execute("UPDATE request_offers SET status='declined' WHERE request_id=? AND status='pending'", [parsedId.data]);
      await connection.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('reason',?))", [parsedId.data, req.user.id, "marked_unfulfilled", reason.data]);
      await connection.commit(); return res.json({ id: parsedId.data, status: "unfulfilled", unfulfilledReason: reason.data });
    } catch (e) { await connection.rollback(); console.error("Updating request status failed:", e.message); return fail(res, 500, "Unable to update request."); }
    finally { connection.release(); }
  });

  router.post("/offers", ...auth, async (req, res) => {
    const parsed = offerSchema.safeParse(req.body); if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Invalid offer.");
    const d = parsed.data, today = new Date().toISOString().slice(0, 10);
    if (!validDate(d.availableFrom) || !validDate(d.availableTo) || d.availableFrom < today || d.availableFrom >= d.availableTo || new Date(d.expiresAt) <= new Date()) return fail(res, 400, "Offer dates and expiry must be valid and in the future.");
    if (!req.user.emailVerified) return fail(res, 403, "Verify your email before sending an offer.");
    let connection;
    try {
      connection = await pool.getConnection(); await connection.beginTransaction();
      const [requests] = await connection.execute("SELECT * FROM item_requests WHERE id=? FOR UPDATE", [d.requestId]);
      if (!requests.length) { await connection.rollback(); return fail(res, 404, "Request not found."); }
      const request = requests[0];
      if (["booking_confirmed","completed","cancelled","expired","unfulfilled"].includes(request.status)) { await connection.rollback(); return fail(res, 409, "This request is not accepting offers."); }
      if (String(request.customer_id) === String(req.user.id)) { await connection.rollback(); return fail(res, 403, "You cannot offer on your own request."); }
      const [notified] = await connection.execute("SELECT request_id FROM request_supplier_notifications WHERE request_id=? AND supplier_id=?", [d.requestId, req.user.id]);
      if (!notified.length) { await connection.rollback(); return fail(res, 403, "An administrator must invite you to this request before you can offer."); }
      if (d.quantity < Number(request.quantity) || d.availableFrom > dateOnly(request.start_date) || d.availableTo < dateOnly(request.end_date)) { await connection.rollback(); return fail(res, 400, "Offer quantity and availability must cover the request."); }
      if (request.delivery_required && d.deliveryOrCollection !== "delivery") { await connection.rollback(); return fail(res, 400, "This request requires delivery."); }
      if (d.deliveryOrCollection === "delivery" && !request.delivery_location) { await connection.rollback(); return fail(res, 400, "The customer has not provided a delivery destination."); }
      if (d.itemId) { const [items] = await connection.execute("SELECT id FROM items WHERE id=? AND owner_id=?", [d.itemId, req.user.id]); if (!items.length) { await connection.rollback(); return fail(res, 403, "Choose one of your own listings."); } }
      if (d.deliveryOrCollection === "collection" && Number(d.deliveryFee || 0) > 0) { await connection.rollback(); return fail(res, 400, "Collection offers cannot include a delivery fee."); }
      const expiresAt = new Date(d.expiresAt).toISOString().slice(0,19).replace("T", " ");
      const [result] = await connection.execute("INSERT INTO request_offers (request_id,supplier_id,item_id,offered_item_name,quantity,price,available_from,available_to,delivery_or_collection,delivery_fee,deposit,conditions,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [d.requestId, req.user.id, d.itemId || null, d.offeredItemName, d.quantity, d.price, d.availableFrom, d.availableTo, d.deliveryOrCollection, d.deliveryFee ?? null, d.deposit ?? null, d.conditions || null, expiresAt]);
      await connection.execute("UPDATE item_requests SET status='offers_received' WHERE id=? AND status IN ('submitted','searching')", [d.requestId]);
      if (["submitted","searching"].includes(request.status)) await connection.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('from',?,'to','offers_received'))", [d.requestId, req.user.id, "request_status_changed", request.status]);
      await connection.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('offerId',?))", [d.requestId, req.user.id, "offer_created", String(result.insertId)]);
      await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)", [request.customer_id, "request_offer_received", `A supplier made an offer for ${request.item_name}.`, result.insertId]);
      await connection.commit(); return res.status(201).json({ id: String(result.insertId), requestId: d.requestId, status: "pending" });
    } catch (e) { if (connection) await connection.rollback(); console.error("Creating offer failed:", e.message); return fail(res, 500, "Unable to create offer."); }
    finally { if (connection) connection.release(); }
  });

  router.get("/offers", ...auth, async (req, res) => {
    const requestId = id.safeParse(req.query.requestId); if (!requestId.success) return fail(res, 400, "Request id is required.");
    try {
      await pool.execute("UPDATE request_offers SET status='expired' WHERE request_id=? AND status='pending' AND expires_at<=UTC_TIMESTAMP()", [requestId.data]);
      const [rs] = await pool.execute("SELECT customer_id FROM item_requests WHERE id=?", [requestId.data]); if (!rs.length) return fail(res, 404, "Request not found.");
      if (String(rs[0].customer_id) !== String(req.user.id) && !req.user.isAdmin) return fail(res, 403, "You cannot view these offers.");
      const [rows] = await pool.execute("SELECT o.*,u.name AS supplier_name FROM request_offers o JOIN users u ON u.id=o.supplier_id WHERE o.request_id=? ORDER BY o.created_at DESC", [requestId.data]); return res.json(rows.map(publicOffer));
    } catch (e) { console.error("Loading offers failed:", e.message); return fail(res, 500, "Unable to load offers."); }
  });

  router.post("/offers/:id/:action", ...auth, (req, res, next) => req.params.action === "accept" ? requirePaystackMode(req, res, () => checkoutRateLimiter(req, res, next)) : next(), async (req, res) => {
    const offerId = id.safeParse(req.params.id), action = req.params.action; if (!offerId.success || !["accept","decline"].includes(action)) return fail(res, 404, "Offer action not found.");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("UPDATE request_offers SET status='expired' WHERE id=? AND status='pending' AND expires_at<=UTC_TIMESTAMP()", [offerId.data]);
      const [rows] = await connection.execute("SELECT o.*,r.customer_id,r.status AS request_status,r.start_date,r.end_date,r.delivery_location AS request_delivery_location,r.item_name AS request_item_name,r.category AS request_category,r.quantity AS request_quantity,r.delivery_required FROM request_offers o JOIN item_requests r ON r.id=o.request_id WHERE o.id=? FOR UPDATE", [offerId.data]);
      if (!rows.length) { await connection.rollback(); return fail(res, 404, "Offer not found."); }
      const offer = rows[0]; if (String(offer.customer_id) !== String(req.user.id)) { await connection.rollback(); return fail(res, 403, "Only the requesting customer can decide on this offer."); }
      if (offer.status === "expired") { await connection.commit(); return fail(res, 409, "This offer is no longer available."); }
      if (offer.status !== "pending" || new Date(offer.expires_at) <= new Date()) { await connection.rollback(); return fail(res, 409, "This offer is no longer available."); }
      if (["booking_confirmed","completed","cancelled","expired","unfulfilled"].includes(offer.request_status)) { await connection.rollback(); return fail(res, 409, "This request is no longer accepting offer decisions."); }
      if (action === "decline") { await connection.execute("UPDATE request_offers SET status='declined' WHERE id=?", [offerId.data]); await connection.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('offerId',?))", [offer.request_id, req.user.id, "offer_declined", offerId.data]); await connection.commit(); return res.json({ id: offerId.data, status: "declined" }); }
      const [paymentControls] = await connection.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='payments_paused' LIMIT 1");
      if (paymentControls[0]?.setting_value === "1") { await connection.rollback(); return fail(res, 423, "ShedShare has temporarily paused new checkouts."); }
      let itemId = offer.item_id;
      if (Number(offer.quantity) < Number(offer.request_quantity) || dateOnly(offer.available_from) > dateOnly(offer.start_date) || dateOnly(offer.available_to) < dateOnly(offer.end_date) || (offer.delivery_required && offer.delivery_or_collection !== "delivery")) { await connection.rollback(); return fail(res, 409, "This offer no longer covers the request."); }
      if (offer.delivery_required && offer.delivery_or_collection !== "delivery") { await connection.rollback(); return fail(res, 409, "This request requires delivery."); }
      const requestedDays = Math.ceil((new Date(`${dateOnly(offer.end_date)}T00:00:00Z`) - new Date(`${dateOnly(offer.start_date)}T00:00:00Z`)) / 86400000);
      if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 65535) { await connection.rollback(); return fail(res, 400, "The requested rental duration is not supported."); }
      if (!itemId) { const [created] = await connection.execute("INSERT INTO items (owner_id,name,category,item_condition,location,description,price,pricing_unit,min_period,max_period,deposit,delivery_available,delivery_fee) VALUES (?,?,?,'Good','Supplier pickup',?,?,'day',1,?,?,?,?)", [offer.supplier_id, offer.offered_item_name || offer.request_item_name, offer.request_category, offer.conditions || null, offer.price, Math.max(14, requestedDays), offer.deposit || 0, offer.delivery_or_collection === "delivery", offer.delivery_fee || 0]); itemId = created.insertId; }
      const [itemRows] = await connection.execute("SELECT i.name,i.price,i.pricing_unit,i.min_period,i.max_period,i.location,i.paused,i.delivery_available,u.subaccount_code FROM items i JOIN users u ON u.id=i.owner_id WHERE i.id=? AND i.owner_id=? FOR UPDATE", [itemId, offer.supplier_id]);
      if (!itemRows.length || itemRows[0].paused) { await connection.rollback(); return fail(res, 409, "The offered listing is unavailable."); }
      if (offer.delivery_or_collection === "delivery" && !itemRows[0].delivery_available) { await connection.rollback(); return fail(res, 409, "The offered listing does not support delivery."); }
      const unit = itemRows[0].pricing_unit;
      if (unit === "week" && requestedDays % 7 !== 0) { await connection.rollback(); return fail(res, 409, "The request dates do not align with this weekly listing. Offer a daily listing instead."); }
      const units = unit === "week" ? requestedDays / 7 : unit === "hour" ? requestedDays * 24 : requestedDays;
      if (units > 65535) { await connection.rollback(); return fail(res, 409, "The offered rental duration is not supported."); }
      if (units < Number(itemRows[0].min_period) || units > Number(itemRows[0].max_period)) { await connection.rollback(); return fail(res, 409, "The offered listing does not support this rental duration."); }
      const days = unit === "week" ? units * 7 : unit === "hour" ? requestedDays * 24 : requestedDays;
      const startDate = new Date(`${dateOnly(offer.start_date)}T00:00:00.000Z`), endDate = new Date(startDate);
      if (unit === "hour") endDate.setUTCHours(endDate.getUTCHours() + days); else endDate.setUTCDate(endDate.getUTCDate() + days);
      const unitPriceKobo = Math.round(Number(offer.price) * 100), subtotalKobo = unitPriceKobo * units;
      const [conflicts] = await connection.execute("SELECT id FROM rentals WHERE item_id=? AND (status IN ('confirmed','active') OR (status='pending_payment' AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 MINUTE))) AND start_at < ? AND end_at > ? FOR UPDATE", [itemId, endDate.toISOString().slice(0,19).replace("T"," "), startDate.toISOString().slice(0,19).replace("T"," ")]);
      if (conflicts.length) { await connection.rollback(); return fail(res, 409, "The offered item is no longer available for those dates."); }
      if (!itemRows[0].subaccount_code || !process.env.PAYSTACK_SECRET_KEY) { await connection.rollback(); return fail(res, 503, "Verified Paystack checkout is not configured for this supplier."); }
      const subtotal = subtotalKobo / 100, feeKobo = Math.round(subtotalKobo * 15 / 100), fee = feeKobo / 100, deposit = Number(offer.deposit || 0), deliveryFee = offer.delivery_or_collection === "delivery" ? Number(offer.delivery_fee || 0) : 0;
      const paymentReference = `SSRQ${offer.request_id}-${offerId.data}-${crypto.randomBytes(4).toString("hex")}`;
      const [rentResult] = await connection.execute("INSERT INTO rentals (item_id,owner_id,renter_id,item_name,price_per_unit,units,pricing_unit,start_at,end_at,subtotal,deposit,delivery_method,delivery_fee,total,platform_fee_percent,platform_fee,owner_payout,agreement_version,agreement_accepted,accepted_at,status,payment_reference,delivery_location) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'v1',TRUE,UTC_TIMESTAMP(),'pending_payment',?,?)", [itemId, offer.supplier_id, req.user.id, itemRows[0].name, Number(offer.price), units, unit, startDate.toISOString().slice(0,19).replace("T"," "), endDate.toISOString().slice(0,19).replace("T"," "), subtotal, deposit, deliveryFee ? "delivery" : "pickup", deliveryFee, subtotal + deposit + deliveryFee, 15, fee, subtotal - fee, paymentReference, deliveryFee ? offer.request_delivery_location : null]);
      const checkoutResponse = await fetch("https://api.paystack.co/transaction/initialize", { method: "POST", headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: req.user.email, amount: subtotalKobo, reference: paymentReference, subaccount: itemRows[0].subaccount_code, transaction_charge: feeKobo, metadata: { rentalId: String(rentResult.insertId), itemId: String(itemId), purpose: "rental_fee" } }), signal: AbortSignal.timeout(10000) });
      const checkout = await checkoutResponse.json(); let checkoutUrl;
      try { checkoutUrl = new URL(checkout.data?.authorization_url); } catch (_e) {}
      if (!checkoutResponse.ok || !checkout.status || !checkoutUrl || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com" || checkout.data.reference !== paymentReference) { await connection.rollback(); return fail(res, 502, "Unable to initialize Paystack checkout for this offer."); }
      await connection.execute("UPDATE request_offers SET status=IF(id=?,'accepted',IF(status='pending','declined',status)),rental_id=IF(id=?, ?, rental_id) WHERE request_id=?", [offerId.data, offerId.data, rentResult.insertId, offer.request_id]);
      await connection.execute("UPDATE item_requests SET status='booking_confirmed' WHERE id=?", [offer.request_id]);
      await connection.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('from',?,'to','booking_confirmed'))", [offer.request_id, req.user.id, "request_status_changed", offer.request_status]);
      await connection.execute("INSERT INTO request_audit (request_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('offerId',?,'rentalId',?))", [offer.request_id, req.user.id, "offer_accepted", offerId.data, String(rentResult.insertId)]);
      await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)", [offer.supplier_id, "offer_accepted", "Your offer was accepted. A rental payment is being arranged.", offerId.data]);
      await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)", [req.user.id, "offer_accepted", "You accepted an offer. Continue to secure the booking with payment.", offerId.data]);
      await connection.commit(); return res.status(201).json({ id: offerId.data, status: "accepted", rentalId: String(rentResult.insertId), paymentReference, checkoutUrl: checkoutUrl.toString() });
    } catch (e) { await connection.rollback(); console.error("Deciding offer failed:", e.message); return fail(res, 500, "Unable to decide on offer."); }
    finally { connection.release(); }
  });

  return router;
}

function publicRequest(r) {
  const referenceImageUrl = isPrivateReferenceKey(r.reference_image_url, r.customer_id) ? `/api/requests/${encodeURIComponent(String(r.id))}/reference-image` : null;
  return { id: String(r.id), referenceNumber: r.reference_number, customerId: String(r.customer_id), customerName: r.customer_name, itemName: r.item_name, category: r.category, description: r.description || "", quantity: Number(r.quantity), startDate: dateOnly(r.start_date), endDate: dateOnly(r.end_date), deliveryLocation: r.delivery_location || "", pickupPreferred: Boolean(r.pickup_preferred), deliveryRequired: Boolean(r.delivery_required), budget: r.budget == null ? null : Number(r.budget), urgency: r.urgency, referenceImageUrl, notes: r.notes || "", status: r.status, unfulfilledReason: r.unfulfilled_reason, createdAt: new Date(r.created_at).toISOString() };
}
function publicOffer(o) {
  return { id: String(o.id), requestId: String(o.request_id), supplierId: String(o.supplier_id), supplierName: o.supplier_name, itemId: o.item_id == null ? null : String(o.item_id), rentalId: o.rental_id == null ? null : String(o.rental_id), offeredItemName: o.offered_item_name, quantity: Number(o.quantity), price: Number(o.price), availableFrom: dateOnly(o.available_from), availableTo: dateOnly(o.available_to), deliveryOrCollection: o.delivery_or_collection, deliveryFee: o.delivery_fee == null ? null : Number(o.delivery_fee), deposit: o.deposit == null ? null : Number(o.deposit), conditions: o.conditions, expiresAt: new Date(o.expires_at).toISOString(), status: o.status, createdAt: new Date(o.created_at).toISOString() };
}

module.exports = { createWorkflowRouter };
