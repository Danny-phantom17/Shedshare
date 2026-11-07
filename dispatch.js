"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const crypto = require("node:crypto");
const { z } = require("zod");
const deliveryConfig = require("./delivery-config");
const { ensureDeliveryConversations } = require("./chat");
const { createCheckoutRateLimiter } = require("./checkout-rate-limit");
const { isPaystackAvailable, requirePaystackMode } = require("./payment-mode");
const id = z.string().regex(/^\d+$/, "Invalid id.");
const activeTracking = ["awaiting_collection", "collected", "en_route", "arrived", "delivered_awaiting_confirmation"];
function fail(res, status, error) { return res.status(status).json({ error }); }
function haversineMeters(aLat, aLng, bLat, bLng) { const rad = value => value * Math.PI / 180, dLat = rad(bLat-aLat), dLng = rad(bLng-aLng), v = Math.sin(dLat/2)**2 + Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLng/2)**2; return 12742000 * Math.asin(Math.sqrt(Math.min(1,v))); }
function verifiedImageType(buffer){if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return"image/jpeg";if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return"image/png";if(buffer.length>=12&&buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WEBP")return"image/webp";return null;}
async function reofferRiderJob(connection,deliveryId,excludeRiderId=null){
  const [rows]=await connection.execute("SELECT pickup_latitude,pickup_longitude FROM deliveries WHERE id=?",[deliveryId]);if(!rows.length||rows[0].pickup_latitude==null||rows[0].pickup_longitude==null)return;
  const [nearby]=await connection.execute(`SELECT p.user_id FROM rider_profiles p JOIN rider_online_locations o ON o.rider_id=p.user_id WHERE p.application_status='approved' AND p.is_approved=TRUE AND p.availability='active' AND p.current_delivery_id IS NULL AND p.user_id<>? AND o.updated_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? SECOND) AND 6371*2*ASIN(SQRT(POWER(SIN(RADIANS(o.lat-?)/2),2)+COS(RADIANS(?))*COS(RADIANS(o.lat))*POWER(SIN(RADIANS(o.lng-?)/2),2)))<=? ORDER BY o.updated_at DESC LIMIT 100`,[excludeRiderId||"0",deliveryConfig.locationStaleAfterSeconds,rows[0].pickup_latitude,rows[0].pickup_latitude,rows[0].pickup_longitude,deliveryConfig.riderSearchRadiusKm]);
  for(const rider of nearby){await connection.execute("INSERT INTO delivery_offers (delivery_id,rider_id,status,offered_at) VALUES (?,?, 'offered',UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE status='offered',offered_at=UTC_TIMESTAMP()",[deliveryId,rider.user_id]);await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'delivery_offer','A ShedShare delivery is available. Accept within the offer window.',?)",[rider.user_id,deliveryId]);}
}

function createDispatchRouter({ pool, authenticate, supabase }) {
  const router = express.Router();
  const auth = [authenticate];
  const checkoutRateLimiter = createCheckoutRateLimiter(pool);
  const riderUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 5 * 1024 * 1024 } });
  const privateRiderBucket = process.env.RIDER_PRIVATE_STORAGE_BUCKET || "shedshare-rider-private";
  const locationLimiter = rateLimit({ windowMs: 60_000, limit: deliveryConfig.locationRateLimitPerMinute, standardHeaders: "draft-8", legacyHeaders: false, validate: { ip: false }, keyGenerator: req => String(req.user.id), message: { error: "Location updates are arriving too quickly. Try again shortly." } });
  const handoverLimiter=rateLimit({windowMs:15*60_000,limit:8,standardHeaders:"draft-8",legacyHeaders:false,keyGenerator:req=>String(req.user.id),message:{error:"Too many hand-over code attempts. Try again later."}});

  router.post("/rider/application-documents/:kind", ...auth, (req,res,next)=>riderUpload.single("image")(req,res,error=>{if(error instanceof multer.MulterError&&error.code==="LIMIT_FILE_SIZE")return fail(res,413,"Rider documents must be 5 MiB or smaller.");if(error)return fail(res,400,"Invalid document upload.");next();}), async(req,res)=>{
    if(!supabase)return fail(res,503,"Private rider document storage is not configured.");
    const kind=z.enum(["profile","id"]).safeParse(req.params.kind);if(!kind.success||!req.file)return fail(res,400,"Choose a photo or ID document.");
    const mime=verifiedImageType(req.file.buffer);if(!mime)return fail(res,415,"Upload a JPEG, PNG, or WebP image.");
    try{const path=`rider-applications/${req.user.id}/${kind.data}/${crypto.randomUUID()}.${mime.split("/")[1]}`;const {error}=await supabase.storage.from(privateRiderBucket).upload(path,req.file.buffer,{contentType:mime,upsert:false,cacheControl:"0"});if(error)throw error;return res.status(201).json({path});}
    catch(e){console.error("Saving private rider document failed:",e.message);return fail(res,500,"Unable to save this private document.");}
  });

  router.post("/rider/apply", ...auth, async (req, res) => {
    const parsed = z.object({ fullName:z.string().trim().min(2).max(120),phone: z.string().trim().min(5).max(40),city:z.string().trim().min(1).max(100),state:z.string().trim().min(1).max(100),vehicleType:z.enum(["bike","tricycle","car","van"]),plateNumber:z.string().trim().min(2).max(40),profilePhotoPath:z.string().trim().min(1).max(512),idDocumentPath:z.string().trim().min(1).max(512) }).strict().safeParse(req.body);
    if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message || "Enter all rider application details.");
    const prefix=`rider-applications/${req.user.id}/`;
    if(!parsed.data.profilePhotoPath.startsWith(`${prefix}profile/`)||!parsed.data.idDocumentPath.startsWith(`${prefix}id/`))return fail(res,400,"Upload your photo and ID through this application first.");
    try {
      const [existing] = await pool.execute("SELECT id,application_status FROM rider_profiles WHERE user_id=?", [req.user.id]);
      if (existing.length) return fail(res, 409, "A rider application already exists. Contact support if you need a review.");
      const [user] = await pool.execute("SELECT subaccount_code FROM users WHERE id=?",[req.user.id]);
      if(!user[0]?.subaccount_code)return fail(res,409,"Connect your payout account using the existing Paystack account setup before applying.");
      const d=parsed.data;
      const [result] = await pool.execute("INSERT INTO rider_profiles (user_id,full_name,phone,city,state,vehicle_type,plate_number,profile_photo_path,id_document_path,profile_photo_url,id_document_reference,application_status,is_approved,availability) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,'pending',FALSE,'inactive')", [req.user.id,d.fullName,d.phone,d.city,d.state,d.vehicleType,d.plateNumber,d.profilePhotoPath,d.idDocumentPath]);
      await pool.execute("UPDATE users SET is_rider=TRUE WHERE id=?", [req.user.id]);
      await pool.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'rider_application','Your rider application is pending review.',?)",[req.user.id,result.insertId]);
      const [admins] = await pool.execute("SELECT id FROM users WHERE is_admin=TRUE");
      for (const admin of admins) await pool.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'rider_application_review','A new rider application is awaiting your review.',?)",[admin.id,result.insertId]);
      return res.status(201).json({ id: String(result.insertId), status:"pending", availability: "inactive" });
    } catch (e) { console.error("Rider application failed:", e.message); return fail(res, 500, "Unable to submit rider application."); }
  });

  router.get("/rider/profile", ...auth, async (req, res) => {
    try {
      const [rows] = await pool.execute("SELECT phone,full_name,city,state,vehicle_type,plate_number,availability,is_approved,application_status,rejection_reason,cancellation_count,rating_sum,rating_count,flagged_low_rating FROM rider_profiles WHERE user_id=? LIMIT 1", [req.user.id]);
      if (!rows.length) return fail(res, 404, "No rider application was found.");
      const [payout]=await pool.execute("SELECT subaccount_code FROM users WHERE id=?",[req.user.id]);
      return res.json({ phone: rows[0].phone,fullName:rows[0].full_name,city:rows[0].city,state:rows[0].state,plateNumber:rows[0].plate_number,vehicleType: rows[0].vehicle_type, availability: rows[0].availability,isApproved: Boolean(rows[0].is_approved),status:rows[0].application_status,rejectionReason:rows[0].rejection_reason,cancellationCount:Number(rows[0].cancellation_count),averageRating:rows[0].rating_count?Number(rows[0].rating_sum)/Number(rows[0].rating_count):null,ratingCount:Number(rows[0].rating_count),flaggedLowRating:Boolean(rows[0].flagged_low_rating),payoutConnected:Boolean(payout[0]?.subaccount_code) });
    } catch (e) { console.error("Loading rider profile failed:", e.message); return fail(res, 500, "Unable to load rider profile."); }
  });

  router.get("/rider/earnings",...auth,async(req,res)=>{
    try{const [profile]=await pool.execute("SELECT application_status,rating_sum,rating_count FROM rider_profiles WHERE user_id=?",[req.user.id]);if(!profile.length||profile[0].application_status!=="approved")return fail(res,403,"Approved rider access required.");const [rows]=await pool.execute("SELECT d.id,d.reference_number,d.updated_at,r.item_name,r.delivery_fee,COALESCE(p.rider_payout,ROUND(r.delivery_fee*100)) rider_payout,COALESCE(p.platform_fee,0) platform_fee FROM deliveries d JOIN rentals r ON r.id=d.rental_id LEFT JOIN rider_delivery_payment_attempts p ON p.delivery_id=d.id AND p.status='success' WHERE d.rider_id=? AND d.status='completed' ORDER BY d.updated_at DESC LIMIT 200",[req.user.id]);return res.json({deliveries:rows.map(r=>({deliveryId:String(r.id),referenceNumber:r.reference_number,itemName:r.item_name,amount:Number(r.rider_payout||0)/100,grossAmount:Number(r.delivery_fee||0),platformFee:Number(r.platform_fee||0)/100,completedAt:new Date(r.updated_at).toISOString()})),total:rows.reduce((sum,r)=>sum+Number(r.rider_payout||0)/100,0),averageRating:profile[0].rating_count?Number(profile[0].rating_sum)/Number(profile[0].rating_count):null,ratingCount:Number(profile[0].rating_count)});}
    catch(e){console.error("Loading rider earnings failed:",e.message);return fail(res,500,"Unable to load rider earnings.");}
  });

  router.patch("/rider/applications/:id/review",...auth,async(req,res)=>{
    if(!req.user.isAdmin)return fail(res,403,"Administrator access required.");
    const riderId=id.safeParse(req.params.id),data=z.object({status:z.enum(["approved","rejected","suspended"]),reason:z.string().trim().max(500).optional().default("")}).strict().safeParse(req.body);
    if(!riderId.success||!data.success)return fail(res,400,"Choose approve, reject, or suspend and provide a rejection reason when needed.");
    if(data.data.status==="rejected"&&!data.data.reason)return fail(res,400,"Add a reason when rejecting an application.");
    const c=await pool.getConnection();
    try{
      await c.beginTransaction();const [rows]=await c.execute("SELECT id,user_id,application_status,current_delivery_id FROM rider_profiles WHERE id=? FOR UPDATE",[riderId.data]);if(!rows.length){await c.rollback();return fail(res,404,"Rider application not found.");}
      const r=rows[0],next=data.data.status;
      if(next==="approved"&&r.application_status!=="pending"){await c.rollback();return fail(res,409,"Only a pending application can be approved. Rider approval is one-time.");}
      if(next==="rejected"&&r.application_status!=="pending"){await c.rollback();return fail(res,409,"Only a pending application can be rejected.");}
      if(next==="suspended"&&r.application_status!=="approved"){await c.rollback();return fail(res,409,"Only an approved rider can be suspended.");}
      await c.execute("UPDATE rider_profiles SET application_status=?,rejection_reason=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),is_approved=?,availability=IF(?='approved',availability,'inactive') WHERE id=?",[next,next==="rejected"?data.data.reason:null,req.user.id,Number(next==="approved"),next,r.id]);
      await c.execute("DELETE FROM rider_online_locations WHERE rider_id=?",[r.user_id]);
      if(next==="suspended"&&r.current_delivery_id){
        const [d]=await c.execute("SELECT d.id,d.status,r.renter_id,r.owner_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE",[r.current_delivery_id]);
        if(d.length&&["rider_assigned","awaiting_collection"].includes(d[0].status)){await c.execute("UPDATE deliveries SET rider_id=NULL,status='awaiting_rider',offer_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),tracking_ends_at=NULL WHERE id=?",[deliveryConfig.offerTimeoutMinutes,d[0].id]);await c.execute("UPDATE delivery_offers SET status='expired' WHERE delivery_id=? AND status IN ('offered','accepted')",[d[0].id]);await c.execute("UPDATE conversations cv JOIN conversation_participants cp ON cp.conversation_id=cv.id SET cv.closed_at=COALESCE(cv.closed_at,UTC_TIMESTAMP()) WHERE cv.delivery_id=? AND cp.user_id=?",[d[0].id,r.user_id]);await c.execute("DELETE FROM location_updates WHERE delivery_id=?",[d[0].id]);await c.execute("UPDATE rider_profiles SET current_delivery_id=NULL WHERE id=?",[r.id]);await reofferRiderJob(c,d[0].id,r.user_id);}
        else if(d.length&&["collected","en_route","arrived","delivered_awaiting_confirmation"].includes(d[0].status)){await c.execute("UPDATE deliveries SET status='exception',tracking_ends_at=UTC_TIMESTAMP() WHERE id=?",[d[0].id]);await c.execute("DELETE FROM location_updates WHERE delivery_id=?",[d[0].id]);await c.execute("UPDATE rider_profiles SET current_delivery_id=NULL WHERE id=?",[r.id]);await c.execute("UPDATE conversations SET closed_at=COALESCE(closed_at,UTC_TIMESTAMP()) WHERE delivery_id=? AND kind IN ('delivery_renter','delivery_owner')",[d[0].id]);await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'delivery_exception','Your delivery needs support because the assigned rider was suspended. Contact ShedShare support.',?),(?,'delivery_exception','A delivery was paused after rider suspension and needs support follow-up.',?)",[d[0].renter_id,d[0].id,d[0].owner_id,d[0].id]);}
      }
      await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'rider_application_status',?,?)",[r.user_id,next==="approved"?"Your rider application was approved. You can now go online.":next==="rejected"?`Your rider application was not approved: ${data.data.reason}`:"Your rider account was suspended and set offline.",r.id]);
      await c.commit();return res.json({id:riderId.data,status:next});
    }catch(e){await c.rollback();console.error("Reviewing rider application failed:",e.message);return fail(res,500,"Unable to update rider application.");}finally{c.release();}
  });

  router.get("/rider/applications", ...auth, async (req, res) => {
    if (!req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    try {
      const [rows] = await pool.execute("SELECT p.id,p.user_id,p.full_name,p.phone,p.city,p.state,p.vehicle_type,p.plate_number,p.application_status,p.rejection_reason,p.availability,p.is_approved,p.current_delivery_id,p.cancellation_count,p.rating_sum,p.rating_count,p.flagged_low_rating,p.profile_photo_path,p.id_document_path,u.email,u.subaccount_code,u.created_at FROM rider_profiles p JOIN users u ON u.id=p.user_id ORDER BY FIELD(p.application_status,'pending','approved','rejected','suspended'),p.id DESC LIMIT 200");
      return res.json(rows.map((r) => ({ id: String(r.id), userId: String(r.user_id), name:r.full_name||"",email:r.email,phone:r.phone,city:r.city,state:r.state,vehicleType:r.vehicle_type,plateNumber:r.plate_number,status:r.application_status,rejectionReason:r.rejection_reason,availability:r.availability,isApproved:Boolean(r.is_approved),payoutConnected:Boolean(r.subaccount_code),profilePhotoAvailable:Boolean(r.profile_photo_path),idDocumentAvailable:Boolean(r.id_document_path),cancellationCount:Number(r.cancellation_count),averageRating:r.rating_count?Number(r.rating_sum)/Number(r.rating_count):null,ratingCount:Number(r.rating_count),flaggedLowRating:Boolean(r.flagged_low_rating),currentDeliveryId:r.current_delivery_id==null?null:String(r.current_delivery_id),createdAt:new Date(r.created_at).toISOString() })));
    } catch (e) { console.error("Loading rider applications failed:", e.message); return fail(res, 500, "Unable to load rider applications."); }
  });

  router.get("/rider/applications/:id/document/:kind",...auth,async(req,res)=>{
    if(!req.user.isAdmin)return fail(res,403,"Administrator access required.");if(!supabase)return fail(res,503,"Private document storage is not configured.");
    const riderId=id.safeParse(req.params.id),kind=z.enum(["profile","id"]).safeParse(req.params.kind);if(!riderId.success||!kind.success)return fail(res,400,"Choose a valid rider document.");
    try{const [rows]=await pool.execute("SELECT profile_photo_path,id_document_path FROM rider_profiles WHERE id=?",[riderId.data]);if(!rows.length)return fail(res,404,"Rider application not found.");const path=kind.data==="profile"?rows[0].profile_photo_path:rows[0].id_document_path;if(!path)return fail(res,404,"Document not available.");const {data,error}=await supabase.storage.from(privateRiderBucket).download(path);if(error)throw error;const buffer=Buffer.from(await data.arrayBuffer()),mime=verifiedImageType(buffer);if(!mime)return fail(res,415,"Stored document is not a supported image.");res.set({"Content-Type":mime,"Content-Length":buffer.length,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});return res.send(buffer);}
    catch(e){console.error("Reading private rider document failed:",e.message);return fail(res,500,"Unable to load rider document.");}
  });

  router.patch("/rider/availability", ...auth, async (req, res) => {
    const value = z.enum(["active", "inactive"]).safeParse(req.body?.availability); if (!value.success) return fail(res, 400, "Availability must be active or inactive.");
    try {
      const body = req.body?.availability === "active" ? z.object({ availability: z.literal("active"), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict().safeParse(req.body) : z.object({ availability: z.literal("inactive") }).strict().safeParse(req.body);
      if (!body.success) return fail(res, 400, "Going online requires a valid device location.");
      const [rows] = await pool.execute("SELECT id,is_approved,current_delivery_id FROM rider_profiles WHERE user_id=?", [req.user.id]);
      if (!rows.length) return fail(res, 403, "Apply to become a rider first.");
      if (!rows[0].is_approved && value.data === "active") return fail(res, 403, "Your rider application must be approved first.");
      if (value.data === "inactive" && rows[0].current_delivery_id) {
        const [delivery] = await pool.execute("SELECT status FROM deliveries WHERE id=?", [rows[0].current_delivery_id]);
        if (delivery.length && !["completed", "exception"].includes(delivery[0].status)) return fail(res, 409, "Complete or resolve your active delivery before going inactive.");
      }
      await pool.execute("UPDATE rider_profiles SET availability=? WHERE id=?", [value.data, rows[0].id]);
      if (value.data === "active") await pool.execute("INSERT INTO rider_online_locations (rider_id,lat,lng,updated_at) VALUES (?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE lat=VALUES(lat),lng=VALUES(lng),updated_at=VALUES(updated_at)", [req.user.id, body.data.lat, body.data.lng]);
      else await pool.execute("DELETE FROM rider_online_locations WHERE rider_id=?", [req.user.id]);
      return res.json({ availability: value.data });
    } catch (e) { console.error("Updating rider availability failed:", e.message); return fail(res, 500, "Unable to update availability."); }
  });

  router.get("/rider/deliveries", ...auth, async (req, res) => {
    try {
      const [riders] = await pool.execute("SELECT id FROM rider_profiles WHERE user_id=? AND is_approved=TRUE", [req.user.id]); if (!riders.length) return fail(res, 403, "Approved rider access required.");
      const [availability] = await pool.execute("SELECT availability FROM rider_profiles WHERE user_id=? AND application_status='approved' AND is_approved=TRUE",[req.user.id]);
      const [offers] = availability.length&&availability[0].availability==='active' ? await pool.execute(`SELECT d.id,d.rental_id,d.rider_id,d.reference_number,d.status,d.delivery_method,d.pickup_latitude,d.pickup_longitude,d.created_at,o.offered_at,r.delivery_fee,r.delivery_latitude,r.delivery_longitude,i.name AS item_name,i.image AS item_image,i.area_name AS pickup_area,i.city AS pickup_city,i.state AS pickup_state,
        (SELECT CONCAT_WS(', ',gc.area_name,gc.city,gc.state) FROM geocode_cache gc WHERE r.delivery_latitude IS NOT NULL AND r.delivery_longitude IS NOT NULL ORDER BY 6371*2*ASIN(SQRT(POWER(SIN(RADIANS(gc.latitude-r.delivery_latitude)/2),2)+COS(RADIANS(r.delivery_latitude))*COS(RADIANS(gc.latitude))*POWER(SIN(RADIANS(gc.longitude-r.delivery_longitude)/2),2))) LIMIT 1) AS dropoff_area,
        (SELECT 6371*2*ASIN(SQRT(POWER(SIN(RADIANS(o2.lat-d.pickup_latitude)/2),2)+COS(RADIANS(d.pickup_latitude))*COS(RADIANS(o2.lat))*POWER(SIN(RADIANS(o2.lng-d.pickup_longitude)/2),2)))) FROM rider_online_locations o2 WHERE o2.rider_id=? LIMIT 1) AS distance_km
        FROM delivery_offers o JOIN deliveries d ON d.id=o.delivery_id JOIN rentals r ON r.id=d.rental_id JOIN items i ON i.id=r.item_id
        WHERE o.rider_id=? AND o.status='offered' AND o.offered_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? MINUTE) AND d.status='awaiting_rider' AND (d.offer_expires_at IS NULL OR d.offer_expires_at>UTC_TIMESTAMP()) ORDER BY o.offered_at LIMIT 50`,[req.user.id,req.user.id,deliveryConfig.riderJobOfferMinutes]) : [[]];
      const [rows] = await pool.execute(`SELECT d.*,r.item_name,r.start_at,r.end_at,r.delivery_fee,r.delivery_latitude,r.delivery_longitude,i.image AS item_image,i.area_name AS pickup_area,i.city AS pickup_city,i.state AS pickup_state,
        (SELECT CONCAT_WS(', ',gc.area_name,gc.city,gc.state) FROM geocode_cache gc WHERE r.delivery_latitude IS NOT NULL AND r.delivery_longitude IS NOT NULL ORDER BY 6371*2*ASIN(SQRT(POWER(SIN(RADIANS(gc.latitude-r.delivery_latitude)/2),2)+COS(RADIANS(r.delivery_latitude))*COS(RADIANS(gc.latitude))*POWER(SIN(RADIANS(gc.longitude-r.delivery_longitude)/2),2))) LIMIT 1) AS dropoff_area
        FROM deliveries d JOIN rentals r ON r.id=d.rental_id JOIN items i ON i.id=r.item_id WHERE d.rider_id=? ORDER BY d.created_at DESC`, [req.user.id]);
      const riderRows=rows.map(r=>{const data=publicDelivery(r);if(r.status==="rider_assigned"){data.pickupLocation=[r.pickup_area,r.pickup_city,r.pickup_state].filter(Boolean).join(", ")||"Approximate pickup area";data.dropoffLocation=r.dropoff_area||"Approximate drop-off area";}data.itemImage=r.item_image||"";data.deliveryFee=Number(r.delivery_fee||0);data.riderPaymentStatus=r.rider_payment_status||"not_required";return data;});
      return res.json({ deliveries: riderRows, offers: offers.map(r=>({id:String(r.id),rentalId:String(r.rental_id),itemName:r.item_name,itemImage:r.item_image||"",referenceNumber:r.reference_number,status:r.status,pickupArea:[r.pickup_area,r.pickup_city,r.pickup_state].filter(Boolean).join(", ")||"Approximate pickup area",dropoffArea:r.dropoff_area||"Approximate drop-off area",distanceKm:r.distance_km==null?null:Number(r.distance_km),deliveryFee:Number(r.delivery_fee||0),offerExpiresAt:new Date(new Date(r.offered_at).getTime()+deliveryConfig.riderJobOfferMinutes*60_000).toISOString()})) });
    } catch (e) { console.error("Loading rider deliveries failed:", e.message); return fail(res, 500, "Unable to load deliveries."); }
  });

  router.post("/deliveries/:id/accept-offer", ...auth, async (req, res) => {
    const deliveryId = id.safeParse(req.params.id); if (!deliveryId.success) return fail(res, 400, "Invalid delivery id.");
    const quote = z.object({ deliveryFee: z.number().finite().positive().max(10_000_000) }).strict().safeParse(req.body);
    if (!quote.success) return fail(res, 400, "Enter a delivery fee between ₦0.01 and ₦10,000,000.");
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [delivery] = await c.execute("SELECT d.*,r.renter_id,r.item_name,r.delivery_method AS rental_delivery_method FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE", [deliveryId.data]);
      const [profile] = await c.execute("SELECT user_id,is_approved,application_status,availability,current_delivery_id FROM rider_profiles WHERE user_id=? FOR UPDATE", [req.user.id]);
      const [payout] = await c.execute("SELECT subaccount_code FROM users WHERE id=?", [req.user.id]);
      const [offer] = await c.execute("SELECT status FROM delivery_offers WHERE delivery_id=? AND rider_id=? FOR UPDATE", [deliveryId.data, req.user.id]);
      const [offerTime]=offer.length?await c.execute("SELECT offered_at FROM delivery_offers WHERE delivery_id=? AND rider_id=?",[deliveryId.data,req.user.id]):[[]];
      if (!delivery.length || !profile.length || !profile[0].is_approved || profile[0].application_status!=="approved" || profile[0].availability !== "active" || profile[0].current_delivery_id || delivery[0].status !== "awaiting_rider" || (delivery[0].offer_expires_at && new Date(delivery[0].offer_expires_at) <= new Date()) || !offer.length || offer[0].status !== "offered" || !offerTime.length || Date.now()-new Date(offerTime[0].offered_at).getTime()>deliveryConfig.riderJobOfferMinutes*60_000) { await c.rollback(); return fail(res, 409, "Job no longer available."); }
      if (!payout[0]?.subaccount_code || delivery[0].rental_delivery_method !== "rider_delivery") { await c.rollback(); return fail(res, 409, "A connected Paystack payout account and rider delivery booking are required."); }
      const deliveryFeeKobo = Math.round(quote.data.deliveryFee * 100);
      const [commissionRows] = await c.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='rider_commission_percent' LIMIT 1");
      const commissionPercent = isPaystackAvailable() ? Number(commissionRows[0]?.setting_value ?? 5) : 0;
      if(!Number.isFinite(commissionPercent)||commissionPercent<0||commissionPercent>100){await c.rollback();return fail(res,503,"Rider commission settings are invalid. Contact ShedShare support.");}
      const platformFee = Math.round(deliveryFeeKobo*commissionPercent/100), riderPayout = deliveryFeeKobo-platformFee;
      const [claim] = await c.execute("UPDATE deliveries SET rider_id=?,rider_commission_percent=?,status='awaiting_collection',tracking_ends_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? HOUR) WHERE id=? AND rider_id IS NULL AND status='awaiting_rider'", [req.user.id, commissionPercent, deliveryConfig.maxTrackingHours, deliveryId.data]);
      const [busy] = await c.execute("UPDATE rider_profiles SET current_delivery_id=? WHERE user_id=? AND current_delivery_id IS NULL", [deliveryId.data, req.user.id]);
      if (!claim.affectedRows || !busy.affectedRows) { await c.rollback(); return fail(res, 409, "Job no longer available."); }
      await c.execute("UPDATE rentals SET delivery_fee=?,total=subtotal+? WHERE id=?", [deliveryFeeKobo / 100, deliveryFeeKobo / 100, delivery[0].rental_id]);
      await c.execute("UPDATE deliveries SET rider_payment_status='pending' WHERE id=?", [deliveryId.data]);
      await c.execute("UPDATE delivery_offers SET status=IF(rider_id=?,'accepted','expired') WHERE delivery_id=? AND status='offered'", [req.user.id, deliveryId.data]);
      if(!delivery[0].rider_handover_code_hash){const code=String(crypto.randomInt(1000,10000)),hash=crypto.createHmac("sha256",process.env.JWT_SECRET).update(`${deliveryId.data}:${code}`).digest("hex"),[rental]=await c.execute("SELECT renter_id FROM rentals WHERE id=?",[delivery[0].rental_id]);await c.execute("UPDATE deliveries SET delivery_pin=?,rider_handover_code_hash=? WHERE id=?",[code,hash,deliveryId.data]);if(rental.length)await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'delivery_handover_code',?,?)",[rental[0].renter_id,`Give your rider this 4-digit hand-over code when the item arrives: ${code}`,deliveryId.data]);}
      try { await ensureDeliveryConversations(c, deliveryId.data, req.user.id); }
      catch (chatError) { console.error("Delivery accepted; chat setup failed:", chatError.message); }
      await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'rider_delivery_quote',?,?)", [delivery[0].renter_id, `A rider accepted your delivery and quoted ₦${(deliveryFeeKobo/100).toLocaleString("en-NG",{minimumFractionDigits:2})}. Pay through ShedShare to confirm.${commissionPercent > 0 ? ` ShedShare keeps ${commissionPercent}%; the rider receives ${100-commissionPercent}%.` : " The rider receives the full quoted fee."}`, deliveryId.data]);
      await c.commit(); return res.json({ id: deliveryId.data, status: "awaiting_collection", deliveryFee: deliveryFeeKobo/100, commissionPercent, platformFee: platformFee/100, riderPayout: riderPayout/100 });
    } catch (e) { await c.rollback(); console.error("Accepting delivery offer failed:", e.message); return fail(res, 500, "Unable to accept this delivery."); }
    finally { c.release(); }
  });

  router.post("/deliveries/:id/rider-payment", ...auth, requirePaystackMode, checkoutRateLimiter, async (req,res) => {
    const deliveryId = id.safeParse(req.params.id);
    if (!deliveryId.success) return fail(res,400,"Invalid delivery id.");
    if (!req.user.emailVerified) return fail(res,403,"Verify your email before paying a rider.");
    if (!process.env.PAYSTACK_SECRET_KEY) return fail(res,503,"Verified Paystack checkout is not configured.");
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows]=await c.execute("SELECT d.id,d.rental_id,d.rider_id,d.status,d.rider_payment_status,d.rider_commission_percent,r.renter_id,r.delivery_fee,r.item_name,r.status rental_status,ru.subaccount_code FROM deliveries d JOIN rentals r ON r.id=d.rental_id JOIN users ru ON ru.id=d.rider_id WHERE d.id=? FOR UPDATE",[deliveryId.data]);
      if(!rows.length){await c.rollback();return fail(res,404,"Delivery payment was not found.");}
      const delivery=rows[0];
      const [settings]=await c.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='payments_paused' LIMIT 1");
      if(settings[0]?.setting_value==="1"){await c.rollback();return fail(res,423,"ShedShare has temporarily paused new checkouts.");}
      if(String(delivery.renter_id)!==String(req.user.id)){await c.rollback();return fail(res,403,"Only the renter can pay this delivery fee.");}
      if(delivery.status!=="awaiting_collection"||delivery.rider_payment_status!=="pending"||!delivery.subaccount_code||Number(delivery.delivery_fee)<=0||!["confirmed","active"].includes(delivery.rental_status)){await c.rollback();return fail(res,409,"This rider quote is not payable now.");}
      const commissionPercent=Number(delivery.rider_commission_percent),amount=Math.round(Number(delivery.delivery_fee)*100),platformFee=Math.round(amount*commissionPercent/100),riderPayout=amount-platformFee;
      const [existing]=await c.execute("SELECT reference,checkout_url,amount FROM rider_delivery_payment_attempts WHERE delivery_id=? AND status='initialized' ORDER BY id DESC LIMIT 1 FOR UPDATE",[delivery.id]);
      if(existing.length&&existing[0].checkout_url){
        try{
          const verify=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(existing[0].reference)}`,{headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`},signal:AbortSignal.timeout(10000)});
          const result=await verify.json(),state=result.data;
          if(verify.ok&&result.status&&state?.reference===existing[0].reference&&Number(state?.amount)===Number(existing[0].amount)&&state?.currency==="NGN"&&state.status==="success"){await c.commit();return fail(res,409,"Paystack confirms this payment. Refresh in a moment while ShedShare records it.");}
          if(verify.ok&&result.status&&state?.reference===existing[0].reference&&Number(state?.amount)===Number(existing[0].amount)&&state?.currency==="NGN"&&["failed","abandoned"].includes(state.status))await c.execute("UPDATE rider_delivery_payment_attempts SET status='failed' WHERE reference=? AND status='initialized'",[existing[0].reference]);
          else{await c.commit();return res.json({checkoutUrl:existing[0].checkout_url});}
        }catch(_error){await c.commit();return res.json({checkoutUrl:existing[0].checkout_url});}
      }
      if(existing.length)await c.execute("UPDATE rider_delivery_payment_attempts SET status='failed' WHERE reference=? AND status='initialized'",[existing[0].reference]);
      if(amount<1||riderPayout<1){await c.rollback();return fail(res,400,"The rider quote is too small to process.");}
      const reference=`SSRD${Date.now()}${crypto.randomBytes(5).toString("hex")}`;
      if(!Number.isFinite(commissionPercent)||commissionPercent<0||commissionPercent>100){await c.rollback();return fail(res,409,"The rider commission saved for this quote is invalid.");}
      const [attempt]=await c.execute("INSERT INTO rider_delivery_payment_attempts(delivery_id,rental_id,renter_id,rider_id,reference,amount,platform_fee,rider_payout,commission_percent,status) VALUES(?,?,?,?,?,?,?,?,?,'initialized')",[delivery.id,delivery.rental_id,req.user.id,delivery.rider_id,reference,amount,platformFee,riderPayout,commissionPercent]);
      const paystackResponse=await fetch("https://api.paystack.co/transaction/initialize",{method:"POST",headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({email:req.user.email,amount,reference,subaccount:delivery.subaccount_code,transaction_charge:platformFee,bearer:"account",metadata:{purpose:"rider_delivery_fee",deliveryId:String(delivery.id),rentalId:String(delivery.rental_id),renterId:String(req.user.id),riderId:String(delivery.rider_id),paymentAttemptId:String(attempt.insertId),commissionPercent:commissionPercent.toFixed(2),grossDeliveryFeeKobo:String(amount),platformFeeKobo:String(platformFee),riderPayoutKobo:String(riderPayout)}}),signal:AbortSignal.timeout(10000)});
      const checkout=await paystackResponse.json();let checkoutUrl;try{checkoutUrl=new URL(checkout.data?.authorization_url);}catch(_error){}
      if(!paystackResponse.ok||!checkout.status||!checkoutUrl||checkoutUrl.protocol!=="https:"||checkoutUrl.hostname!=="checkout.paystack.com"||checkout.data.reference!==reference){await c.execute("UPDATE rider_delivery_payment_attempts SET status='failed' WHERE id=?",[attempt.insertId]);await c.commit();return fail(res,502,"Unable to initialize Paystack checkout for the rider fee.");}
      await c.execute("UPDATE rider_delivery_payment_attempts SET checkout_url=? WHERE id=?",[checkoutUrl.toString(),attempt.insertId]);
      await c.commit();
      return res.status(201).json({checkoutUrl:checkoutUrl.toString(),amount:amount/100,commissionPercent,platformFee:platformFee/100,riderPayout:riderPayout/100});
    }catch(e){await c.rollback();console.error("Initializing rider delivery checkout failed:",e.message);return fail(res,500,"Unable to start rider payment.");}finally{c.release();}
  });

  router.post("/deliveries/:id/decline-rider-quote", ...auth, async (req,res) => {
    const deliveryId=id.safeParse(req.params.id);if(!deliveryId.success)return fail(res,400,"Invalid delivery id.");
    const c=await pool.getConnection();
    try{
      await c.beginTransaction();
      const [rows]=await c.execute("SELECT d.id,d.rental_id,d.rider_id,d.status,d.rider_payment_status,r.renter_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE",[deliveryId.data]);
      if(!rows.length){await c.rollback();return fail(res,404,"Delivery not found.");}
      const d=rows[0];if(String(d.renter_id)!==String(req.user.id)){await c.rollback();return fail(res,403,"Only the renter can respond to this rider quote.");}
      if(d.status!=="awaiting_collection"||d.rider_payment_status!=="pending"||!d.rider_id){await c.rollback();return fail(res,409,"There is no pending rider quote to decline.");}
      const [attempts]=await c.execute("SELECT id,reference,amount FROM rider_delivery_payment_attempts WHERE delivery_id=? AND status='initialized' ORDER BY id DESC LIMIT 1 FOR UPDATE",[d.id]);
      if(attempts.length){
        let verify;
        try{verify=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(attempts[0].reference)}`,{headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`},signal:AbortSignal.timeout(10000)});}catch(_error){await c.rollback();return fail(res,503,"Could not verify the current Paystack payment. Try again shortly.");}
        let result;try{result=await verify.json();}catch(_error){await c.rollback();return fail(res,503,"Could not verify the current Paystack payment. Try again shortly.");}
        const payment=result.data;
        if(!verify.ok||!result.status||payment?.reference!==attempts[0].reference||Number(payment?.amount)!==Number(attempts[0].amount)||payment?.currency!=="NGN"){await c.rollback();return fail(res,503,"Could not verify the current Paystack payment. Try again shortly.");}
        if(payment.status==="success"){await c.rollback();return fail(res,409,"Paystack confirms the rider fee was paid. Refresh ShedShare while the payment is recorded.");}
        if(!["failed","abandoned"].includes(payment.status)){await c.rollback();return fail(res,409,"A Paystack checkout is still active. Complete it before declining the quote.");}
        await c.execute("UPDATE rider_delivery_payment_attempts SET status='failed' WHERE id=? AND status='initialized'",[attempts[0].id]);
      }
      await c.execute("UPDATE deliveries SET status='fallback_available',rider_payment_status='declined',tracking_ends_at=NULL WHERE id=?",[d.id]);
      await c.execute("UPDATE rider_profiles SET current_delivery_id=NULL WHERE user_id=? AND current_delivery_id=?",[d.rider_id,d.id]);
      await c.execute("UPDATE delivery_offers SET status='expired' WHERE delivery_id=? AND status IN ('offered','accepted')",[d.id]);
      await c.execute("DELETE FROM location_updates WHERE delivery_id=?",[d.id]);
      await c.execute("UPDATE conversations SET closed_at=COALESCE(closed_at,UTC_TIMESTAMP()) WHERE delivery_id=? AND kind IN ('delivery_renter','delivery_owner')",[d.id]);
      await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rider_quote_declined','The renter declined your delivery quote. This job is available for a different delivery choice.',?),(?,'delivery_fallback','You declined the rider quote. Choose pickup or owner delivery to continue.',?)",[d.rider_id,d.id,d.renter_id,d.id]);
      await c.commit();return res.json({declined:true,status:"fallback_available"});
    }catch(e){await c.rollback();console.error("Declining rider fee quote failed:",e.message);return fail(res,500,"Unable to decline the rider quote.");}finally{c.release();}
  });

  router.post("/deliveries/:id/decline-offer",...auth,async(req,res)=>{
    const deliveryId=id.safeParse(req.params.id);if(!deliveryId.success)return fail(res,400,"Invalid delivery id.");
    try{const [profile]=await pool.execute("SELECT application_status,is_approved FROM rider_profiles WHERE user_id=?",[req.user.id]);if(!profile.length||profile[0].application_status!=="approved"||!profile[0].is_approved)return fail(res,403,"Approved rider access required.");const [delivery]=await pool.execute("SELECT status,offer_expires_at FROM deliveries WHERE id=?",[deliveryId.data]);const [offer]=await pool.execute("SELECT status,offered_at FROM delivery_offers WHERE delivery_id=? AND rider_id=?",[deliveryId.data,req.user.id]);if(!delivery.length||delivery[0].status!=="awaiting_rider"||!offer.length||offer[0].status!=="offered"||Date.now()-new Date(offer[0].offered_at).getTime()>deliveryConfig.riderJobOfferMinutes*60_000)return fail(res,409,"Job no longer available.");await pool.execute("UPDATE delivery_offers SET status='declined' WHERE delivery_id=? AND rider_id=? AND status='offered'",[deliveryId.data,req.user.id]);return res.json({declined:true});}
    catch(e){console.error("Declining rider offer failed:",e.message);return fail(res,500,"Unable to decline this offer.");}
  });

  router.post("/deliveries/:id/fallback", ...auth, async (req, res) => {
    const deliveryId=id.safeParse(req.params.id), choice=z.enum(["pickup","owner_delivery"]).safeParse(req.body?.choice);
    if(!deliveryId.success||!choice.success)return fail(res,400,"Choose Pickup or Owner delivers.");
    const c=await pool.getConnection();
    try{await c.beginTransaction();const [rows]=await c.execute("SELECT d.id,d.rental_id,d.status,r.renter_id,r.owner_id,r.item_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE",[deliveryId.data]);if(!rows.length){await c.rollback();return fail(res,404,"Delivery not found.");}const row=rows[0];if(String(row.renter_id)!==String(req.user.id)){await c.rollback();return fail(res,403,"Only the renter can choose a delivery fallback.");}if(row.status!=="fallback_available"){await c.rollback();return fail(res,409,"Delivery fallback is not available.");}if(choice.data==="pickup"){await c.execute("UPDATE rentals SET delivery_method='pickup',delivery_location=NULL,delivery_latitude=NULL,delivery_longitude=NULL,delivery_fee=0,total=subtotal+deposit WHERE id=?",[row.rental_id]);await c.execute("UPDATE deliveries SET status='cancelled',tracking_ends_at=UTC_TIMESTAMP() WHERE id=?",[deliveryId.data]);await c.execute("DELETE FROM location_updates WHERE delivery_id=?",[deliveryId.data]);}else{const [item]=await c.execute("SELECT delivery_available,delivery_fee,latitude,longitude,pickup_address FROM items WHERE id=?",[row.item_id]);if(!item.length||!item[0].delivery_available){await c.rollback();return fail(res,409,"Owner delivery is unavailable for this item.");}await c.execute("UPDATE rentals SET delivery_method='owner_delivery',delivery_fee=?,total=subtotal+deposit+? WHERE id=?",[item[0].delivery_fee,item[0].delivery_fee,row.rental_id]);await c.execute("UPDATE deliveries SET delivery_method='owner_delivery',status='requested',pickup_location=?,pickup_latitude=?,pickup_longitude=?,tracking_ends_at=NULL WHERE id=?",[item[0].pickup_address||"Pickup location",item[0].latitude,item[0].longitude,deliveryId.data]);}await c.execute("UPDATE conversations SET closed_at=COALESCE(closed_at,UTC_TIMESTAMP()) WHERE delivery_id=? AND kind IN ('delivery_renter','delivery_owner')",[deliveryId.data]);await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)",[row.owner_id,"delivery_fallback_choice",choice.data==="pickup"?"The renter selected pickup after rider delivery was unavailable.":"The renter selected owner delivery after rider delivery was unavailable.",row.rental_id]);await c.commit();return res.json({deliveryId:deliveryId.data,choice:choice.data});}catch(e){await c.rollback();console.error("Selecting delivery fallback failed:",e.message);return fail(res,500,"Unable to update delivery choice.");}finally{c.release();}
  });

  router.post("/deliveries/:id/assign", ...auth, async (req, res) => {
    if (!req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    const deliveryId = id.safeParse(req.params.id), riderId = id.safeParse(String(req.body?.riderId ?? ""));
    if (!deliveryId.success || !riderId.success) return fail(res, 400, "Choose a valid delivery and rider.");
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.execute("SELECT d.status,r.delivery_method FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE", [deliveryId.data]);
      if (!rows.length) { await c.rollback(); return fail(res, 404, "Delivery not found."); }
      if(rows[0].delivery_method==="rider_delivery"){await c.rollback();return fail(res,409,"Assign rider delivery jobs through the live rider offer so the rider can quote the fee and receive the 95% Paystack split.");}
      if (!["requested", "awaiting_rider"].includes(rows[0].status)) { await c.rollback(); return fail(res, 409, "Delivery cannot be assigned in its current state."); }
      const [riders] = await c.execute("SELECT user_id,availability,is_approved,current_delivery_id FROM rider_profiles WHERE user_id=? FOR UPDATE", [riderId.data]);
      if (!riders.length || !riders[0].is_approved || riders[0].availability !== "active" || riders[0].current_delivery_id) { await c.rollback(); return fail(res, 409, "Rider is not approved and available."); }
      await c.execute("UPDATE deliveries SET rider_id=?,status='rider_assigned' WHERE id=?", [riderId.data, deliveryId.data]);
      await c.execute("UPDATE rider_profiles SET current_delivery_id=? WHERE user_id=?", [deliveryId.data, riderId.data]);
      await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?)", [riderId.data, "delivery_assigned", "A delivery has been assigned to you.", deliveryId.data]);
      await c.execute("INSERT INTO delivery_audit (delivery_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('riderId',?))", [deliveryId.data, req.user.id, "rider_assigned", riderId.data]);
      await c.commit(); return res.json({ id: deliveryId.data, riderId: riderId.data, status: "rider_assigned" });
    } catch (e) { await c.rollback(); console.error("Assigning delivery failed:", e.message); return fail(res, 500, "Unable to assign delivery."); }
    finally { c.release(); }
  });

  router.get("/deliveries", ...auth, async (req, res) => {
    if (req.query.role !== "admin") return fail(res, 400, "Use role=admin to list deliveries.");
    if (!req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    try {
      const configuredWindow = Number(process.env.DELIVERY_CONFIRMATION_WINDOW_HOURS || 24), reviewHours = Number.isInteger(configuredWindow) && configuredWindow >= 1 && configuredWindow <= 720 ? configuredWindow : 24;
      const [rows] = await pool.execute(`SELECT d.*,r.item_name,r.start_at,r.end_at,
        owner.name AS owner_name,renter.name AS renter_name,renter.email AS renter_email,renter.phone AS renter_phone,
        rider.name AS rider_name,
        (SELECT lu.lat FROM location_updates lu WHERE lu.delivery_id=d.id ORDER BY lu.recorded_at DESC,lu.id DESC LIMIT 1) AS last_lat,
        (SELECT lu.lng FROM location_updates lu WHERE lu.delivery_id=d.id ORDER BY lu.recorded_at DESC,lu.id DESC LIMIT 1) AS last_lng,
        (SELECT lu.recorded_at FROM location_updates lu WHERE lu.delivery_id=d.id ORDER BY lu.recorded_at DESC,lu.id DESC LIMIT 1) AS last_location_at,
        (d.status='delivered_awaiting_confirmation' AND d.updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL ? HOUR)) AS confirmation_needs_review,
        (SELECT e.type FROM delivery_exceptions e WHERE e.delivery_id=d.id ORDER BY e.id DESC LIMIT 1) AS exception_type,
        (SELECT e.status FROM delivery_exceptions e WHERE e.delivery_id=d.id ORDER BY e.id DESC LIMIT 1) AS exception_status
        FROM deliveries d JOIN rentals r ON r.id=d.rental_id
        JOIN users owner ON owner.id=r.owner_id JOIN users renter ON renter.id=r.renter_id
        LEFT JOIN users rider ON rider.id=d.rider_id ORDER BY d.created_at DESC LIMIT 500`, [reviewHours]);
      return res.json(rows.map(publicDelivery));
    }
    catch (e) { console.error("Loading deliveries failed:", e.message); return fail(res, 500, "Unable to load deliveries."); }
  });

  router.get("/deliveries/:id/handover-code",...auth,async(req,res)=>{
    const deliveryId=id.safeParse(req.params.id);if(!deliveryId.success)return fail(res,400,"Invalid delivery id.");
    try{const [rows]=await pool.execute("SELECT d.delivery_pin,d.status,r.renter_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=?",[deliveryId.data]);if(!rows.length)return fail(res,404,"Delivery not found.");if(String(rows[0].renter_id)!==String(req.user.id))return fail(res,403,"Only the renter can view the hand-over code.");if(!rows[0].delivery_pin)return fail(res,404,"Hand-over code is not available.");return res.json({code:rows[0].delivery_pin,status:rows[0].status});}
    catch(e){console.error("Loading delivery hand-over code failed:",e.message);return fail(res,500,"Unable to load hand-over code.");}
  });

  router.post("/deliveries/:id/rating",...auth,async(req,res)=>{
    const deliveryId=id.safeParse(req.params.id),data=z.object({rating:z.number().int().min(1).max(5)}).strict().safeParse(req.body);if(!deliveryId.success||!data.success)return fail(res,400,"Choose a rating from 1 to 5.");
    const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT d.status,d.rider_id,r.renter_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE",[deliveryId.data]);if(!rows.length){await c.rollback();return fail(res,404,"Delivery not found.");}const d=rows[0];if(String(d.renter_id)!==String(req.user.id)){await c.rollback();return fail(res,403,"Only the renter can rate this delivery.");}if(d.status!=="completed"||!d.rider_id){await c.rollback();return fail(res,409,"Rate the rider after delivery is complete.");}
      const [insert]=await c.execute("INSERT IGNORE INTO delivery_ratings (delivery_id,renter_id,rider_id,rating) VALUES (?,?,?,?)",[deliveryId.data,req.user.id,d.rider_id,data.data.rating]);if(!insert.affectedRows){await c.rollback();return fail(res,409,"You already rated this delivery.");}
      await c.execute("UPDATE rider_profiles SET rating_sum=rating_sum+?,rating_count=rating_count+1 WHERE user_id=?",[data.data.rating,d.rider_id]);const [profile]=await c.execute("SELECT rating_sum,rating_count FROM rider_profiles WHERE user_id=?",[d.rider_id]);const average=Number(profile[0].rating_sum)/Number(profile[0].rating_count),flagged=Number(profile[0].rating_count)>=deliveryConfig.lowRatingMinimumCount&&average<deliveryConfig.lowRatingThreshold;await c.execute("UPDATE rider_profiles SET flagged_low_rating=? WHERE user_id=?",[Number(flagged),d.rider_id]);if(flagged){const [admins]=await c.execute("SELECT id FROM users WHERE is_admin=TRUE");for(const admin of admins)await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'rider_rating_review','A rider has fallen below the rating threshold and needs review.',?)",[admin.id,d.rider_id]);}
      await c.commit();return res.status(201).json({rating:data.data.rating,averageRating:average,flaggedLowRating:flagged});
    }catch(e){await c.rollback();console.error("Recording rider rating failed:",e.message);return fail(res,500,"Unable to save rider rating.");}finally{c.release();}
  });

  router.post("/deliveries/:id/:action", ...auth, (req,res,next)=>req.params.action==="location"?locationLimiter(req,res,next):req.params.action==="mark-delivered"?handoverLimiter(req,res,next):next(), async (req, res) => {
    const deliveryId = id.safeParse(req.params.id), action = req.params.action;
    const actions = new Set(["accept", "decline", "cancel", "collect", "location", "arrived", "mark-delivered", "confirm-receipt", "report-problem"]);
    if (!deliveryId.success || !actions.has(action)) return fail(res, 404, "Delivery action not found.");
    const cancellationReason=action==="cancel"?z.object({reason:z.string().trim().max(500).optional().default("")}).strict().safeParse(req.body):null;
    if(cancellationReason&&!cancellationReason.success)return fail(res,400,"Invalid cancellation reason.");
    if (action === "location") {
      const point = z.object({ lat: z.number().finite().min(4).max(14), lng: z.number().finite().min(2).max(15), timestamp: z.number().int().optional() }).strict().safeParse(req.body);
      if (!point.success) return fail(res, 400, "Enter valid latitude and longitude.");
      try {
        const [rows] = await pool.execute("SELECT d.status,d.rider_id,d.delivery_method,d.rider_payment_status,d.tracking_ends_at,d.pickup_latitude,d.pickup_longitude,r.owner_id,r.renter_id,p.current_delivery_id,p.is_approved FROM deliveries d JOIN rentals r ON r.id=d.rental_id LEFT JOIN rider_profiles p ON p.user_id=d.rider_id WHERE d.id=?", [deliveryId.data]);
        const assignedRider=String(rows[0]?.rider_id||"")===String(req.user.id)&&String(rows[0]?.current_delivery_id||"")===deliveryId.data&&Boolean(rows[0]?.is_approved), ownerDelivery=rows[0]?.delivery_method==="owner_delivery"&&String(rows[0]?.owner_id)===String(req.user.id);
        if (!rows.length || (!assignedRider&&!ownerDelivery)) return fail(res, 403, "This delivery is not currently assigned to you.");
        if (assignedRider && rows[0].delivery_method === "rider_delivery" && rows[0].rider_payment_status !== "paid") return fail(res,409,"The renter must complete the rider fee checkout before delivery can start.");
        if (!activeTracking.includes(rows[0].status)) return fail(res, 409, "Location tracking is not active for this delivery.");
        if (rows[0].tracking_ends_at && new Date(rows[0].tracking_ends_at).getTime() <= Date.now()) { await pool.execute("DELETE FROM location_updates WHERE delivery_id=?", [deliveryId.data]); return fail(res, 409, "The delivery tracking window has ended."); }
        if (point.data.timestamp && Math.abs(Date.now() - point.data.timestamp) > 60_000) return fail(res, 400, "Location timestamp is too old or too far in the future.");
        const [previous] = await pool.execute("SELECT lat,lng,recorded_at FROM location_updates WHERE delivery_id=? LIMIT 1", [deliveryId.data]);
        if (previous.length) {
          const elapsed = Math.max(1, (Date.now() - new Date(previous[0].recorded_at).getTime()) / 1000), moved = haversineMeters(Number(previous[0].lat), Number(previous[0].lng), point.data.lat, point.data.lng);
          if (moved / elapsed > deliveryConfig.plausibleMaxSpeedMps) return fail(res, 400, "Location change is faster than a delivery could travel.");
          if (moved < deliveryConfig.locationMinMovementMeters && elapsed < deliveryConfig.locationUpdateIntervalSeconds) return res.json({ recordedAt: new Date(previous[0].recorded_at).toISOString(), skipped: true });
        }
        await pool.execute("INSERT INTO location_updates (delivery_id,rider_id,lat,lng,recorded_at) VALUES (?,?,?, ?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE rider_id=VALUES(rider_id),lat=VALUES(lat),lng=VALUES(lng),recorded_at=VALUES(recorded_at)", [deliveryId.data, req.user.id, point.data.lat, point.data.lng]);
        return res.status(201).json({ recordedAt: new Date().toISOString() });
      } catch (e) { console.error("Saving location failed:", e.message); return fail(res, 500, "Unable to save location."); }
    }
    if (action === "report-problem") {
      const issue = z.object({ type: z.string().trim().min(1).max(80), notes: z.string().trim().max(5000).optional().default("") }).strict().safeParse(req.body);
      if (!issue.success) return fail(res, 400, issue.error.issues[0]?.message || "Describe the problem.");
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
      const [rows] = await c.execute("SELECT d.status,d.delivery_method,d.pickup_latitude,d.pickup_longitude,r.renter_id,r.owner_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE", [deliveryId.data]);
        if (!rows.length) { await c.rollback(); return fail(res, 404, "Delivery not found."); }
        if (String(rows[0].renter_id) !== String(req.user.id) || !activeTracking.includes(rows[0].status)) { await c.rollback(); return fail(res, 403, "Only the recipient can report a problem on an active delivery."); }
        await c.execute("INSERT INTO delivery_exceptions (delivery_id,reported_by,type,notes) VALUES (?,?,?,?)", [deliveryId.data, req.user.id, issue.data.type, issue.data.notes || null]);
        await c.execute("UPDATE deliveries SET status='exception' WHERE id=?", [deliveryId.data]);
        await c.execute("UPDATE rider_profiles SET current_delivery_id=NULL WHERE current_delivery_id=?", [deliveryId.data]);
        await c.execute("DELETE FROM location_updates WHERE delivery_id=?", [deliveryId.data]);
        await c.execute("INSERT INTO delivery_audit (delivery_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('type',?))", [deliveryId.data, req.user.id, "problem_reported", issue.data.type]);
        await c.commit(); return res.status(201).json({ deliveryId: deliveryId.data, status: "exception" });
      } catch (e) { await c.rollback(); console.error("Reporting delivery problem failed:", e.message); return fail(res, 500, "Unable to report delivery problem."); }
      finally { c.release(); }
    }

    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.execute("SELECT d.*,r.renter_id,r.owner_id FROM deliveries d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE", [deliveryId.data]);
      if (!rows.length) { await c.rollback(); return fail(res, 404, "Delivery not found."); }
      const d = rows[0], rider = String(d.rider_id || "") === String(req.user.id), ownerDelivery=String(d.owner_id)===String(req.user.id)&&d.delivery_method==="owner_delivery", recipient = String(d.renter_id) === String(req.user.id);
      let status = d.status, trackingStarted = d.tracking_ends_at;
      const previousStatus = status;
      if(action==="cancel"&&rider&&d.delivery_method==="rider_delivery"&&d.rider_payment_status==="pending"){
        const [attempts]=await c.execute("SELECT id FROM rider_delivery_payment_attempts WHERE delivery_id=? AND status='initialized' LIMIT 1 FOR UPDATE",[d.id]);
        if(attempts.length){await c.rollback();return fail(res,409,"The renter has an active Paystack checkout. They must complete it or decline the quote before you can cancel.");}
      }
      if (["accept", "decline", "cancel", "collect", "arrived", "mark-delivered"].includes(action)) {
        if (!rider && !(ownerDelivery&&["accept","collect","arrived","mark-delivered"].includes(action))) { await c.rollback(); return fail(res, 403, "Only the assigned delivery person can perform this action."); }
        const transitions = { accept: [ownerDelivery ? "requested" : "rider_assigned", "awaiting_collection"], decline: ["rider_assigned", "awaiting_rider"], cancel: [["rider_assigned","awaiting_collection","collected","en_route","arrived"].includes(status) ? status : "", "awaiting_rider"], collect: ["awaiting_collection", "collected"], arrived: [["collected", "en_route"].includes(status) ? status : "", "arrived"], "mark-delivered": [["collected", "en_route", "arrived"].includes(status) ? status : "", "delivered_awaiting_confirmation"] };
        const [expected, next] = transitions[action]; if (status !== expected) { await c.rollback(); return fail(res, 409, `Cannot ${action} a delivery in ${status} state.`); }
        if (rider && action !== "decline") {
          const [profile] = await c.execute("SELECT is_approved,current_delivery_id FROM rider_profiles WHERE user_id=? FOR UPDATE", [req.user.id]);
          if (!profile.length || !profile[0].is_approved || String(profile[0].current_delivery_id || "") !== deliveryId.data) { await c.rollback(); return fail(res, 403, "Approved rider assignment required."); }
        }
        status = next;
        if (action === "accept") {
          trackingStarted = true;
          await c.execute("UPDATE deliveries SET status=?,tracking_ends_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? HOUR) WHERE id=?", [status, deliveryConfig.maxTrackingHours, deliveryId.data]);
          if (rider) { try { await ensureDeliveryConversations(c,deliveryId.data,req.user.id); } catch (chatError) { console.error("Delivery accepted; chat setup failed:",chatError.message); } }
        }
        else if (action === "collect" && ownerDelivery && !d.tracking_ends_at) { trackingStarted = true; await c.execute("UPDATE deliveries SET status=?,tracking_ends_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? HOUR) WHERE id=?", [status, deliveryConfig.maxTrackingHours, deliveryId.data]); }
        else if (action === "decline" || action === "cancel") {
          await c.execute("UPDATE conversations cv JOIN conversation_participants cp ON cp.conversation_id=cv.id SET cv.closed_at=COALESCE(cv.closed_at,UTC_TIMESTAMP()) WHERE cv.delivery_id=? AND cv.kind IN ('delivery_renter','delivery_owner') AND cp.user_id=?",[deliveryId.data,req.user.id]);
          await c.execute("UPDATE deliveries SET rider_id=NULL,status=?,rider_payment_status=IF(delivery_method='rider_delivery','not_required',rider_payment_status),offer_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),tracking_ends_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? HOUR) WHERE id=?", [status,deliveryConfig.offerTimeoutMinutes,deliveryConfig.maxTrackingHours, deliveryId.data]);
          if(rider&&d.delivery_method==="rider_delivery")await c.execute("UPDATE rentals SET delivery_fee=0,total=subtotal WHERE id=?",[d.rental_id]);
          await c.execute("UPDATE rider_profiles SET current_delivery_id=NULL WHERE current_delivery_id=?", [deliveryId.data]);
          await c.execute("DELETE FROM location_updates WHERE delivery_id=?", [deliveryId.data]);
          await c.execute("UPDATE delivery_offers SET status='expired' WHERE delivery_id=? AND status IN ('offered','accepted')",[deliveryId.data]);
          if(action==="cancel"){
            await c.execute("INSERT INTO delivery_rider_cancellations (delivery_id,rider_id,reason) VALUES (?,?,?)",[deliveryId.data,req.user.id,cancellationReason.data.reason||null]);
            await c.execute("UPDATE rider_profiles SET cancellation_count=cancellation_count+1 WHERE user_id=?",[req.user.id]);
            const [profile]=await c.execute("SELECT cancellation_count FROM rider_profiles WHERE user_id=?",[req.user.id]);const count=Number(profile[0]?.cancellation_count||0);
            if(count>=deliveryConfig.cancellationReviewThreshold){const [admins]=await c.execute("SELECT id FROM users WHERE is_admin=TRUE");for(const admin of admins)await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'rider_cancellation_review','A rider has reached the cancellation review threshold.',?)",[admin.id,req.user.id]);}
            if(count>=deliveryConfig.cancellationWarningThreshold)await c.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,'rider_cancellation_warning','You have cancelled several accepted deliveries. Further cancellations may be reviewed by ShedShare.',?)",[req.user.id,req.user.id]);
          }
          if (action === "cancel" || d.delivery_method === "rider_delivery") {
            await reofferRiderJob(c,deliveryId.data,action==="cancel"?req.user.id:null);
          }
        }
        else if (action === "mark-delivered") {
          const code=z.string().regex(/^\d{4}$/).safeParse(req.body?.code);if(!code.success||!d.delivery_pin||!d.rider_handover_code_hash){await c.rollback();return fail(res,400,"Enter the renter's 4-digit hand-over code.");}
          const actual=crypto.createHmac("sha256",process.env.JWT_SECRET).update(`${d.id}:${code.data}`).digest("hex"),expected=Buffer.from(d.rider_handover_code_hash,"hex"),provided=Buffer.from(actual,"hex");
          if(expected.length!==provided.length||!crypto.timingSafeEqual(expected,provided)){await c.rollback();return fail(res,403,"That hand-over code is incorrect.");}
          // The renter's one-time hand-over code is their confirmation that the
          // item reached them; record both confirmations in the same transaction.
          await c.execute("UPDATE deliveries SET status=?,rider_confirmed_at=UTC_TIMESTAMP(),recipient_confirmed_at=UTC_TIMESTAMP() WHERE id=?", [status, deliveryId.data]);
        }
        else await c.execute("UPDATE deliveries SET status=? WHERE id=?", [status, deliveryId.data]);
      } else if (action === "confirm-receipt") {
        if (!recipient || !activeTracking.includes(status)) { await c.rollback(); return fail(res, 403, "Only the recipient can confirm this active delivery."); }
        await c.execute("UPDATE deliveries SET recipient_confirmed_at=COALESCE(recipient_confirmed_at,UTC_TIMESTAMP()),status=IF(rider_confirmed_at IS NOT NULL,'completed',status) WHERE id=?", [deliveryId.data]);
        const [updated] = await c.execute("SELECT status FROM deliveries WHERE id=?", [deliveryId.data]); status = updated[0].status;
      }
      if (["mark-delivered", "confirm-receipt"].includes(action)) {
        const [confirmations] = await c.execute("SELECT rider_confirmed_at,recipient_confirmed_at FROM deliveries WHERE id=?", [deliveryId.data]);
        if (confirmations[0].rider_confirmed_at && confirmations[0].recipient_confirmed_at) {
          status = "completed"; await c.execute("UPDATE deliveries SET status='completed' WHERE id=?", [deliveryId.data]);
          await c.execute("UPDATE rider_profiles SET current_delivery_id=NULL WHERE current_delivery_id=?", [deliveryId.data]);
          await c.execute("DELETE FROM location_updates WHERE delivery_id=?", [deliveryId.data]);
        }
      }
      if (["completed","cancelled","exception","fallback_available"].includes(status)) {
        try { await c.execute("UPDATE conversations SET closed_at=COALESCE(closed_at,UTC_TIMESTAMP()) WHERE delivery_id=? AND kind IN ('delivery_renter','delivery_owner')",[deliveryId.data]); }
        catch (chatError) { console.error("Delivery updated; chat close failed:", chatError.message); }
        await c.execute("DELETE FROM location_updates WHERE delivery_id=?",[deliveryId.data]);
      }
      if (rider && d.delivery_method === "rider_delivery" && ["accept","collect","arrived","mark-delivered","location"].includes(action) && d.rider_payment_status !== "paid") { await c.rollback(); return fail(res,409,"The renter must complete the rider fee checkout before delivery can start."); }
      await c.execute("INSERT INTO delivery_audit (delivery_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('from',?,'to',?))", [deliveryId.data, req.user.id, action, previousStatus, status]);
      await c.commit(); return res.json({ id: deliveryId.data, status, trackingStarted: Boolean(trackingStarted) });
    } catch (e) { await c.rollback(); console.error("Updating delivery failed:", e.message); return fail(res, 500, "Unable to update delivery."); }
    finally { c.release(); }
  });

  router.get("/deliveries/:id/track", ...auth, async (req, res) => {
    const deliveryId = id.safeParse(req.params.id); if (!deliveryId.success) return fail(res, 400, "Invalid delivery id.");
    try {
      const [rows] = await pool.execute("SELECT d.*,r.renter_id,r.owner_id,r.item_name,u.name AS rider_name FROM deliveries d JOIN rentals r ON r.id=d.rental_id LEFT JOIN users u ON u.id=d.rider_id WHERE d.id=?", [deliveryId.data]);
      if (!rows.length) return fail(res, 404, "Delivery not found.");
      const d = rows[0], allowed = req.user.isAdmin || [String(d.renter_id),String(d.owner_id),String(d.rider_id || "")].includes(String(req.user.id)); if (!allowed) return fail(res, 403, "You are not allowed to view this delivery location.");
      if (d.status === "awaiting_rider" && d.offer_expires_at && new Date(d.offer_expires_at) <= new Date()) {
        const [changed] = await pool.execute("UPDATE deliveries SET status='fallback_available' WHERE id=? AND rider_id IS NULL AND status='awaiting_rider'", [deliveryId.data]);
        if (changed.affectedRows) await pool.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?),(?,?,?,?)", [d.renter_id, "delivery_fallback", "No rider accepted within 10 minutes. Choose Pickup or Owner delivers to continue.", d.rental_id, d.owner_id, "delivery_fallback", "No rider accepted this delivery. Contact the renter to arrange pickup or owner delivery.", d.rental_id]);
        d.status = "fallback_available";
      }
      let lastLocation = null, staleAgeSeconds = null;
      const trackingEnded = ["completed","exception","cancelled","fallback_available"].includes(d.status) || (d.tracking_ends_at && new Date(d.tracking_ends_at).getTime() <= Date.now());
      if (trackingEnded) {
        await pool.execute("DELETE FROM location_updates WHERE delivery_id=?", [deliveryId.data]);
        if(d.tracking_ends_at&&new Date(d.tracking_ends_at).getTime()<=Date.now()&&activeTracking.includes(d.status)){await pool.execute("UPDATE rider_profiles SET current_delivery_id=NULL WHERE current_delivery_id=?",[deliveryId.data]);await pool.execute("UPDATE deliveries SET status='exception' WHERE id=? AND status IN ('collected','en_route','arrived','delivered_awaiting_confirmation')",[deliveryId.data]);}
      }
      if (activeTracking.includes(d.status) && !trackingEnded) {
        const [locations] = await pool.execute("SELECT lat,lng,recorded_at FROM location_updates WHERE delivery_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1", [deliveryId.data]);
        if (locations.length) { const ageSeconds = Math.max(0, (Date.now()-new Date(locations[0].recorded_at).getTime())/1000); staleAgeSeconds = ageSeconds > deliveryConfig.locationStaleAfterSeconds ? ageSeconds : null; lastLocation = ageSeconds > deliveryConfig.locationStaleAfterSeconds ? null : { lat: Number(locations[0].lat), lng: Number(locations[0].lng), recordedAt: new Date(locations[0].recorded_at).toISOString(), ageSeconds }; }
      }
      return res.json({ id: String(d.id), referenceNumber: d.reference_number, status: d.status, trackingState: trackingEnded ? "ended" : staleAgeSeconds!=null ? "stale" : lastLocation ? "live" : "not_started", staleAgeSeconds, fallbackAvailable:d.status==="fallback_available", ownerDelivery: d.delivery_method === "owner_delivery", pickupLocation: d.pickup_location, dropoffLocation: d.dropoff_location, pickupPoint: d.pickup_latitude == null || trackingEnded ? null : {lat:Number(d.pickup_latitude),lng:Number(d.pickup_longitude)}, destinationPoint: d.dropoff_latitude == null || trackingEnded ? null : {lat:Number(d.dropoff_latitude),lng:Number(d.dropoff_longitude)}, rider: d.rider_name ? { name: d.rider_name } : null, lastLocation });
    } catch (e) { console.error("Tracking delivery failed:", e.message); return fail(res, 500, "Unable to track delivery."); }
  });

  router.patch("/deliveries/:id/exception", ...auth, async (req, res) => {
    if (!req.user.isAdmin) return fail(res, 403, "Administrator access required.");
    const deliveryId = id.safeParse(req.params.id), data = z.object({ status: z.enum(["reviewing", "resolved"]), adminNotes: z.string().trim().max(5000).optional().default("") }).strict().safeParse(req.body);
    if (!deliveryId.success || !data.success) return fail(res, 400, "Choose a valid exception status.");
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [rows] = await c.execute("SELECT id FROM delivery_exceptions WHERE delivery_id=? AND status<>'resolved' ORDER BY id DESC LIMIT 1 FOR UPDATE", [deliveryId.data]);
      if (!rows.length) { await c.rollback(); return fail(res, 404, "Open delivery exception not found."); }
      await c.execute("UPDATE delivery_exceptions SET status=?,admin_notes=? WHERE id=?", [data.data.status, data.data.adminNotes || null, rows[0].id]);
      await c.execute("INSERT INTO delivery_audit (delivery_id,actor_id,action,details) VALUES (?,?,?,JSON_OBJECT('exceptionId',?,'status',?,'adminNotes',?))", [deliveryId.data, req.user.id, "exception_updated", String(rows[0].id), data.data.status, data.data.adminNotes]);
      if (data.data.status === "resolved") await c.execute("UPDATE deliveries SET status='completed' WHERE id=? AND rider_confirmed_at IS NOT NULL AND recipient_confirmed_at IS NOT NULL", [deliveryId.data]);
      await c.commit(); return res.json({ deliveryId: deliveryId.data, exceptionStatus: data.data.status });
    } catch (e) { await c.rollback(); console.error("Resolving delivery exception failed:", e.message); return fail(res, 500, "Unable to update exception."); }
    finally { c.release(); }
  });

  return router;
}

function publicDelivery(d) { return { id: String(d.id), rentalId: String(d.rental_id), itemName: d.item_name, riderId: d.rider_id == null ? null : String(d.rider_id), riderName: d.rider_name || "", pickupLocation: d.pickup_location, dropoffLocation: d.dropoff_location, referenceNumber: d.reference_number, status: d.status, riderConfirmedAt: d.rider_confirmed_at ? new Date(d.rider_confirmed_at).toISOString() : null, recipientConfirmedAt: d.recipient_confirmed_at ? new Date(d.recipient_confirmed_at).toISOString() : null, confirmationNeedsReview: Boolean(d.confirmation_needs_review), exception: d.exception_type ? { type: d.exception_type, status: d.exception_status } : null, lastLocation: d.last_lat == null || d.last_lng == null ? null : { lat: Number(d.last_lat), lng: Number(d.last_lng), recordedAt: new Date(d.last_location_at).toISOString() }, renter: d.renter_email ? { name: d.renter_name, email: d.renter_email, phone: d.renter_phone } : null, ownerName: d.owner_name || "", createdAt: new Date(d.created_at).toISOString() }; }
module.exports = { createDispatchRouter };
