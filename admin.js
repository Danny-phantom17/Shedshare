"use strict";

const express = require("express");
const { z } = require("zod");
const { getAiControlState, PROVIDERS } = require("./ai");
const { createAdminReferralRouter } = require("./referrals");
const { createStorageCleanup, CLEANUP_LOCK, MAX_DELETE_PER_RUN } = require("./storage-cleanup");
const { DEFAULT_POLICY } = require("./listing-moderation");
const { haversineKm } = require("./items");

function createAdminRouter({ pool, authenticate, securityEvents, supabase }) {
  const router = express.Router();
  router.use(authenticate, (req, res, next) => req.user.isAdmin
    ? next()
    : res.status(403).json({ error: "Administrator access required." }));
  router.use(async (req, _res, next) => {
    try {
      if (securityEvents && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        await securityEvents.record("admin_action", req, { email: req.user.email, userId: req.user.id, details: { action: `${req.method} ${req.baseUrl}${req.path}` } });
      }
      next();
    } catch (error) {
      console.error("Admin action security log failed:", error.message);
      next(error);
    }
  });

  const storageCleanup = createStorageCleanup({ pool, supabase });
  router.get("/storage-cleanup/runs/:id", async (req, res) => {
    const id = z.string().regex(/^\d+$/).safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "Invalid cleanup run id." });
    try {
      const [runs] = await pool.execute("SELECT id,mode,status,reason,retention_days,candidate_count,bytes_estimated,created_at FROM storage_cleanup_runs WHERE id=? LIMIT 1", [id.data]);
      if (!runs.length) return res.status(404).json({ error: "Cleanup report not found." });
      const [items] = await pool.execute("SELECT provider,bucket_name,object_key,size_bytes,last_modified,reason,status,error_message FROM storage_cleanup_run_items WHERE run_id=? ORDER BY id LIMIT 500", [id.data]);
      const run = runs[0];
      return res.json({ id: String(run.id), mode: run.mode, status: run.status, reason: run.reason, retentionDays: Number(run.retention_days), candidateCount: Number(run.candidate_count), estimatedBytes: Number(run.bytes_estimated), createdAt: new Date(run.created_at).toISOString(), candidates: items.map(item => ({ provider: item.provider, bucket: item.bucket_name, key: item.object_key, sizeBytes: Number(item.size_bytes), lastModified: item.last_modified ? new Date(item.last_modified).toISOString() : null, reason: item.reason, status: item.status, error: item.error_message || null })) });
    } catch (error) { console.error("Loading storage cleanup report failed:", error.message); return res.status(500).json({ error: "Unable to load the storage cleanup report." }); }
  });
  router.post("/storage-cleanup", async (req, res) => {
    const body = z.object({
      mode: z.enum(["dry_run", "delete"]),
      reason: z.string().trim().min(8).max(1000),
      runId: z.string().regex(/^\d+$/).optional(),
      confirmation: z.string().optional()
    }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Choose dry run or delete and provide a reason." });
    if (body.data.mode === "delete" && !body.data.runId) return res.status(400).json({ error: "A completed dry-run id is required before deletion." });
    if (body.data.mode === "delete" && body.data.confirmation !== "DELETE UNREFERENCED MEDIA") return res.status(400).json({ error: "Type DELETE UNREFERENCED MEDIA to confirm this destructive action." });
    if (body.data.mode === "delete" && process.env.STORAGE_CLEANUP_DELETE_ENABLED !== "true") return res.status(503).json({ error: "Permanent storage deletion is disabled. Set STORAGE_CLEANUP_DELETE_ENABLED=true only after reviewing the dry-run report and approval." });
    let connection;
    let locked = false;
    try {
      connection = await pool.getConnection();
      if (body.data.mode === "delete") {
        const [lockRows] = await connection.execute("SELECT GET_LOCK(?,0) AS acquired", [CLEANUP_LOCK]);
        if (Number(lockRows[0]?.acquired) !== 1) return res.status(409).json({ error: "A media upload or another cleanup is in progress. Retry after it finishes." });
        locked = true;
        const [previous] = await connection.execute("SELECT id,admin_id,status,created_at FROM storage_cleanup_runs WHERE id=? AND mode='dry_run' LIMIT 1", [body.data.runId]);
        if (!previous.length || previous[0].status !== "completed" || String(previous[0].admin_id) !== String(req.user.id) || Date.now() - new Date(previous[0].created_at).getTime() > 24 * 60 * 60 * 1000) return res.status(409).json({ error: "The dry-run report must be complete, less than 24 hours old, and created by this administrator." });
        const [approvedItems] = await connection.execute("SELECT provider,bucket_name,object_key FROM storage_cleanup_run_items WHERE run_id=? AND status='candidate' ORDER BY id LIMIT ?", [body.data.runId, MAX_DELETE_PER_RUN + 1]);
        if (!approvedItems.length || approvedItems.length > MAX_DELETE_PER_RUN) return res.status(409).json({ error: `Deletion requires 1 to ${MAX_DELETE_PER_RUN} reviewed candidates per run.` });
        const current = await storageCleanup.inventory();
        const eligible = new Map(current.candidates.map(item => [`${item.provider}\0${item.bucket}\0${item.key}`, item]));
        const reviewed = approvedItems.map(item => eligible.get(`${item.provider}\0${item.bucket_name}\0${item.object_key}`)).filter(Boolean);
        if (reviewed.length !== approvedItems.length) return res.status(409).json({ error: "One or more files are no longer eligible. Run a fresh dry run; nothing was deleted." });
        await connection.execute("INSERT INTO storage_cleanup_runs(admin_id,mode,status,reason,retention_days,candidate_count,bytes_estimated) VALUES(?,'delete','partial',?,?,?,?)", [req.user.id, body.data.reason, current.retentionDays, reviewed.length, reviewed.reduce((n, item) => n + item.size, 0)]);
        const [runRows] = await connection.execute("SELECT LAST_INSERT_ID() AS id");
        const runId = String(runRows[0].id);
        for (const item of reviewed) await connection.execute("INSERT INTO storage_cleanup_run_items(run_id,provider,bucket_name,object_key,size_bytes,last_modified,reason,status) VALUES(?,?,?,?,?,?,?,'candidate')", [runId, item.provider, item.bucket, item.key, item.size, item.lastModified ? new Date(item.lastModified) : null, item.reason]);
        await connection.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('sourceDryRunId',?,'candidateCount',?,'state','deletion_started'))", [req.user.id, "storage_cleanup_delete", "storage_cleanup_run", runId, body.data.reason, body.data.runId, reviewed.length]);
        const results = [];
        for (let index = 0; index < reviewed.length; index += 1) {
          const item = reviewed[index];
          let status = "deleted", errorMessage = null;
          try { await storageCleanup.remove(item, current.s3Client); }
          catch (error) { status = "failed"; errorMessage = error.message.slice(0, 500); }
          await connection.execute("UPDATE storage_cleanup_run_items SET status=?,error_message=? WHERE run_id=? AND provider=? AND bucket_name=? AND object_key=?", [status, errorMessage, runId, item.provider, item.bucket, item.key]);
          if (status === "deleted" && item.temporary) await connection.execute("UPDATE storage_cleanup_upload_leases SET status='removed' WHERE provider=? AND bucket_name=? AND object_key=? AND status='pending'", [item.provider, item.bucket, item.key]);
          results.push({ key: item.key, status });
        }
        await connection.execute("UPDATE storage_cleanup_runs SET status=? WHERE id=?", [results.some(x => x.status === "failed") ? "partial" : "completed", runId]);
        await connection.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('sourceDryRunId',?,'candidateCount',?,'deletedCount',?))", [req.user.id, "storage_cleanup_delete", "storage_cleanup_run", runId, body.data.reason, body.data.runId, reviewed.length, results.filter(x => x.status === "deleted").length]);
        return res.json({ runId, deleted: results.filter(x => x.status === "deleted").length, failed: results.filter(x => x.status === "failed").length, results });
      }

      const inventory = await storageCleanup.inventory();
      await connection.beginTransaction();
      await connection.execute("INSERT INTO storage_cleanup_runs(admin_id,mode,status,reason,retention_days,candidate_count,bytes_estimated) VALUES(?,'dry_run','completed',?,?,?,?)", [req.user.id, body.data.reason, inventory.retentionDays, inventory.candidates.length, inventory.estimatedBytes]);
      const [runRows] = await connection.execute("SELECT LAST_INSERT_ID() AS id");
      const runId = String(runRows[0].id);
      for (const item of inventory.candidates) await connection.execute("INSERT INTO storage_cleanup_run_items(run_id,provider,bucket_name,object_key,size_bytes,last_modified,reason,status) VALUES(?,?,?,?,?,?,?,'candidate')", [runId, item.provider, item.bucket, item.key, item.size, item.lastModified ? new Date(item.lastModified) : null, item.reason]);
      await connection.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('candidateCount',?,'bytesEstimated',?,'retentionDays',?))", [req.user.id, "storage_cleanup_dry_run", "storage_cleanup_run", runId, body.data.reason, inventory.candidates.length, inventory.estimatedBytes, inventory.retentionDays]);
      await connection.commit();
      return res.json({ runId, dryRun: true, retentionDays: inventory.retentionDays, candidateCount: inventory.candidates.length, estimatedBytes: inventory.estimatedBytes, candidates: inventory.candidates.map(item => ({ provider: item.provider, bucket: item.bucket, key: item.key, sizeBytes: item.size, lastModified: item.lastModified, reason: item.reason })) });
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch {} }
      console.error("Storage cleanup operation failed:", error.message);
      return res.status(500).json({ error: "Storage cleanup could not complete. Review server logs and run a fresh dry run." });
    } finally {
      if (locked) { try { await connection.execute("SELECT RELEASE_LOCK(?)", [CLEANUP_LOCK]); } catch (error) { console.error("Releasing cleanup lock failed:", error.message); } }
      connection?.release();
    }
  });

  router.get("/ai-settings", async (_req, res) => {
    const settings = await getAiControlState(pool);
    if (settings.setupRequired) return res.status(503).json({ error: "Run npm run migrate to install the AI control settings table." });
    return res.json(settings);
  });

  router.get("/listing-moderation/settings",async(_req,res)=>{try{const [rows]=await pool.execute("SELECT enabled,policy_text,prohibited_terms,review_terms,auto_approval_confidence FROM listing_moderation_settings WHERE setting_id=1");if(!rows.length)return res.status(503).json({error:"Listing moderation settings are not installed."});const row=rows[0],asArray=value=>Array.isArray(value)?value:JSON.parse(value||"[]"),aiControl=await getAiControlState(pool);return res.json({enabled:Boolean(row.enabled),policyText:row.policy_text,prohibitedTerms:asArray(row.prohibited_terms),reviewTerms:asArray(row.review_terms),autoApprovalConfidence:Number(row.auto_approval_confidence),geminiConfigured:Boolean(process.env.GEMINI_API_KEY),aiPlatformEnabled:aiControl.enabled});}catch(error){console.error("Loading listing moderation settings failed:",error.message);return res.status(500).json({error:"Unable to load listing moderation settings."});}});
  router.put("/listing-moderation/settings",async(req,res)=>{const body=z.object({enabled:z.boolean(),policyText:z.string().trim().min(40).max(5000),prohibitedTerms:z.array(z.string().trim().min(2).max(100)).max(100),reviewTerms:z.array(z.string().trim().min(2).max(100)).max(100),autoApprovalConfidence:z.number().finite().min(0.5).max(1)}).strict().safeParse(req.body);if(!body.success)return res.status(400).json({error:"Check moderation policy text, terms, and confidence."});const aiControl=await getAiControlState(pool);if(body.data.enabled&&!aiControl.enabled)return res.status(409).json({error:"Enable the existing AI provider in ShedShare admin settings and configure the server-side Gemini key before turning on listing moderation."});try{await pool.execute("UPDATE listing_moderation_settings SET enabled=?,policy_text=?,prohibited_terms=?,review_terms=?,auto_approval_confidence=?,updated_by=? WHERE setting_id=1",[body.data.enabled,body.data.policyText,JSON.stringify([...new Set(body.data.prohibitedTerms.map(x=>x.toLowerCase()))]),JSON.stringify([...new Set(body.data.reviewTerms.map(x=>x.toLowerCase()))]),body.data.autoApprovalConfidence,req.user.id]);await pool.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('enabled',?,'confidence',?))",[req.user.id,"listing_moderation_policy","platform_setting","listing_moderation", "Admin updated AI listing moderation configuration",body.data.enabled,body.data.autoApprovalConfidence]);return res.json({enabled:body.data.enabled,policyText:body.data.policyText,prohibitedTerms:body.data.prohibitedTerms,reviewTerms:body.data.reviewTerms,autoApprovalConfidence:body.data.autoApprovalConfidence,geminiConfigured:Boolean(process.env.GEMINI_API_KEY),aiPlatformEnabled:aiControl.enabled});}catch(error){console.error("Saving listing moderation settings failed:",error.message);return res.status(500).json({error:"Unable to save listing moderation settings."});}});
  router.get("/listings/moderation",async(_req,res)=>{try{const [rows]=await pool.execute(`SELECT i.id,i.owner_id,i.name,i.category,i.item_condition,i.location,i.description,i.ai_description,i.image,i.price,i.pricing_unit,i.created_at,i.moderation_status,u.name lister_name,u.email lister_email,u.phone lister_phone,j.item_summary,j.ai_description generated_description,j.reason flag_reason,j.confidence,j.provider_error,j.updated_at moderation_updated_at FROM items i JOIN users u ON u.id=i.owner_id LEFT JOIN listing_moderation_jobs j ON j.item_id=i.id WHERE i.moderation_status IN ('pending_review','needs_information') ORDER BY i.created_at ASC LIMIT 250`);return res.json(rows.map(row=>({id:String(row.id),ownerId:String(row.owner_id),name:row.name,category:row.category,condition:row.item_condition,location:row.location,description:row.description||"",image:row.image||"",price:Number(row.price),pricingUnit:row.pricing_unit,submittedAt:new Date(row.created_at).toISOString(),status:row.moderation_status,lister:{name:row.lister_name,email:row.lister_email,phone:row.lister_phone},itemSummary:row.item_summary||"Not available",aiDescription:row.generated_description||row.ai_description||"",reason:row.flag_reason||"Automated moderation did not complete; human review is required.",confidence:row.confidence==null?null:Number(row.confidence),providerError:Boolean(row.provider_error),updatedAt:row.moderation_updated_at?new Date(row.moderation_updated_at).toISOString():null})));}catch(error){console.error("Loading listing moderation queue failed:",error.message);return res.status(500).json({error:"Unable to load listing review queue."});}});
  router.patch("/listings/:id/moderation",async(req,res)=>{const id=z.string().regex(/^\d+$/).safeParse(req.params.id),body=z.object({action:z.enum(["approve","decline","request_information"]),reason:z.string().trim().min(4).max(2000)}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Choose a decision and provide a clear audit reason."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT id,owner_id,name,category,price,city,state,area_name,latitude,longitude,moderation_status,ai_description FROM items WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Listing not found."});}const item=rows[0];if(!["pending_review","needs_information"].includes(item.moderation_status)){await c.rollback();return res.status(409).json({error:"This listing is not currently awaiting an administrator decision."});}const next=body.data.action==="approve"?"approved":body.data.action==="decline"?"declined":"needs_information",action=body.data.action==="approve"?"approved":body.data.action==="decline"?"declined":"information_requested";await c.execute("UPDATE items SET moderation_status=? WHERE id=?",[next,id.data]);await c.execute("INSERT INTO listing_moderation_audit(item_id,actor_id,action,previous_status,new_status,reason,ai_description) VALUES(?,?,?,?,?,?,?)",[id.data,req.user.id,action,item.moderation_status,next,body.data.reason,item.ai_description]);await c.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('from',?,'to',?))",[req.user.id,"listing_moderation_decision","item",id.data,body.data.reason,item.moderation_status,next]);const notice=next==="approved"?"An administrator approved your listing. It is now eligible to appear publicly.":next==="declined"?`An administrator declined your listing: ${body.data.reason}`:`An administrator needs more information about your listing: ${body.data.reason}`;await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES(?,?,?,?)",[item.owner_id,`listing_${action}`,notice,id.data]);await c.commit();if(next==="approved"){try{const [count]=await pool.execute("SELECT COUNT(*) total FROM items WHERE owner_id=? AND moderation_status='approved' AND paused=FALSE",[item.owner_id]);if(Number(count[0]?.total)===1)await require("./referrals").recordReferralEvent(pool,item.owner_id,"first_public_listing",`first-public-listing:${item.owner_id}`,{itemId:String(id.data)});const [alerts]=await pool.execute("SELECT id,renter_id,latitude,longitude,radius_km FROM location_alerts WHERE status='active' AND category=? AND (max_price IS NULL OR max_price>=?) AND LOWER(city)=LOWER(?) AND LOWER(state)=LOWER(?)",[item.category,item.price,item.city,item.state]);for(const alert of alerts){if(item.latitude!=null&&alert.latitude!=null&&alert.longitude!=null&&haversineKm(Number(alert.latitude),Number(alert.longitude),Number(item.latitude),Number(item.longitude))>Number(alert.radius_km))continue;await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'location_alert_match',?,?)",[alert.renter_id,`A newly approved listing is available near ${item.area_name}, ${item.city}.`,id.data]);await pool.execute("UPDATE location_alerts SET status='matched' WHERE id=? AND status='active'",[alert.id]);}}catch(error){console.error("Recording listing publication events failed:",error.message);}}return res.json({id:id.data,status:next});}catch(error){await c.rollback();console.error("Saving listing moderation decision failed:",error.message);return res.status(500).json({error:"Unable to save listing decision."});}finally{c.release();}});
  router.put("/ai-settings", async (req, res) => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose whether to enable Gemini listing helpers." });
    if (parsed.data.enabled && process.env.AI_FEATURES_ENABLED === "false") return res.status(503).json({ error: "AI_FEATURES_ENABLED is set to false in the server environment." });
    if (parsed.data.enabled && !process.env[PROVIDERS.gemini.key]) return res.status(409).json({ error: "Configure the AI API key in the server environment before enabling AI tools." });
    try {
      await pool.execute("INSERT INTO ai_control_settings (setting_id,provider,enabled,updated_by) VALUES (1,'gemini',?,?) ON DUPLICATE KEY UPDATE provider='gemini',enabled=VALUES(enabled),updated_by=VALUES(updated_by)", [parsed.data.enabled, req.user.id]);
      return res.json(await getAiControlState(pool));
    } catch (error) { console.error("Saving AI settings failed:", error.message); return res.status(500).json({ error: "Unable to save AI settings." }); }
  });

  router.get("/map-settings", async (_req, res) => {
    try {
      const [rows] = await pool.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='maps_enabled' LIMIT 1");
      return res.json({ enabled: rows[0]?.setting_value === "1", browserKeyConfigured: Boolean(process.env.GEOAPIFY_MAPS_BROWSER_KEY), geocodingKeyConfigured: Boolean(process.env.GEOAPIFY_API_KEY) });
    } catch (error) { console.error("Loading map settings failed:", error.message); return res.status(500).json({ error: "Unable to load map settings." }); }
  });
  router.put("/map-settings", async (req, res) => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose whether to enable map features." });
    if (parsed.data.enabled && (!process.env.GEOAPIFY_MAPS_BROWSER_KEY || !process.env.GEOAPIFY_API_KEY)) {
      return res.status(409).json({ error: "Add a Geoapify browser map key and server geocoding key before enabling map features." });
    }
    try {
      await pool.execute("INSERT INTO shedshare_settings(setting_key,setting_value,updated_by) VALUES('maps_enabled',?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_by=VALUES(updated_by)", [parsed.data.enabled ? "1" : "0", req.user.id]);
      await pool.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('enabled',?))", [req.user.id, "map_control", "platform_setting", "maps_enabled", "Admin changed Geoapify map feature availability", parsed.data.enabled]);
      return res.json({ enabled: parsed.data.enabled, browserKeyConfigured: Boolean(process.env.GEOAPIFY_MAPS_BROWSER_KEY), geocodingKeyConfigured: Boolean(process.env.GEOAPIFY_API_KEY) });
    } catch (error) { console.error("Saving map settings failed:", error.message); return res.status(500).json({ error: "Unable to update map settings." }); }
  });

  router.get("/testimonials", async (_req, res) => {
    try {
      const [rows] = await pool.execute("SELECT id,display_name,body,created_at FROM testimonials WHERE status='pending' ORDER BY created_at ASC LIMIT 100");
      return res.json(rows.map(row => ({ id: String(row.id), displayName: row.display_name, body: row.body, createdAt: new Date(row.created_at).toISOString() })));
    } catch (error) { console.error("Loading pending testimonials failed:", error.message); return res.status(500).json({ error: "Unable to load testimonials." }); }
  });
  router.patch("/testimonials/:id", async (req, res) => {
    const id = z.string().regex(/^\d+$/).safeParse(req.params.id);
    const body = z.object({ status: z.enum(["approved", "rejected"]) }).strict().safeParse(req.body);
    if (!id.success || !body.success) return res.status(400).json({ error: "Choose a valid testimonial review action." });
    try {
      const [result] = await pool.execute("UPDATE testimonials SET status=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=? AND status='pending'", [body.data.status, req.user.id, id.data]);
      if (!result.affectedRows) return res.status(404).json({ error: "Pending testimonial not found." });
      return res.json({ id: id.data, status: body.data.status });
    } catch (error) { console.error("Reviewing testimonial failed:", error.message); return res.status(500).json({ error: "Unable to review this testimonial." }); }
  });

  router.get("/rental-reviews",async(_req,res)=>{
    try{const [rows]=await pool.execute(`SELECT rv.id,rv.rental_id,rv.author_id,rv.target_user_id,rv.target_role,rv.overall_rating,rv.communication_rating,rv.accuracy_rating,rv.reliability_rating,rv.fulfillment_rating,rv.body,rv.status,rv.created_at,r.item_name,a.name author_name FROM rental_party_reviews rv JOIN rentals r ON r.id=rv.rental_id JOIN users a ON a.id=rv.author_id WHERE rv.status IN ('pending','approved','hidden') ORDER BY (rv.status='pending') DESC,rv.created_at ASC LIMIT 200`);return res.json(rows.map(row=>({id:String(row.id),rentalId:String(row.rental_id),authorId:String(row.author_id),authorName:row.author_name,targetUserId:String(row.target_user_id),targetRole:row.target_role,overallRating:Number(row.overall_rating),communicationRating:Number(row.communication_rating),accuracyRating:row.accuracy_rating==null?null:Number(row.accuracy_rating),reliabilityRating:Number(row.reliability_rating),fulfillmentRating:Number(row.fulfillment_rating),body:row.body,status:row.status,itemName:row.item_name,createdAt:new Date(row.created_at).toISOString()})));}
    catch(error){console.error("Loading rental reviews for moderation failed:",error.message);return res.status(500).json({error:"Unable to load rental reviews."});}
  });
  router.get("/rental-review-reports",async(_req,res)=>{
    try{const [rows]=await pool.execute(`SELECT rp.id,rp.review_id,rp.reporter_id,rp.reason,rp.details,rp.status,rp.resolution,rp.created_at,rv.body review_body,rv.status review_status,r.item_name,u.name reporter_name FROM rental_party_review_reports rp JOIN rental_party_reviews rv ON rv.id=rp.review_id JOIN rentals r ON r.id=rv.rental_id JOIN users u ON u.id=rp.reporter_id WHERE rp.status IN ('open','reviewing') ORDER BY rp.created_at ASC LIMIT 200`);return res.json(rows.map(row=>({id:String(row.id),reviewId:String(row.review_id),reporterId:String(row.reporter_id),reporterName:row.reporter_name,reason:row.reason,details:row.details,status:row.status,resolution:row.resolution||"",reviewBody:row.review_body,reviewStatus:row.review_status,itemName:row.item_name,createdAt:new Date(row.created_at).toISOString()})));}
    catch(error){console.error("Loading rental review reports failed:",error.message);return res.status(500).json({error:"Unable to load review reports."});}
  });
  router.patch("/rental-reviews/:id",async(req,res)=>{
    const id=z.string().regex(/^\d+$/).safeParse(req.params.id),body=z.object({status:z.enum(["approved","rejected","hidden"]),reason:z.string().trim().min(5).max(1000)}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Choose a review status and provide a moderation reason."});
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [rows]=await connection.execute("SELECT id,author_id,target_user_id,status FROM rental_party_reviews WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await connection.rollback();return res.status(404).json({error:"Rental review not found."});}const review=rows[0];if(review.status===body.data.status){await connection.rollback();return res.status(409).json({error:"This review already has that status."});}await connection.execute("UPDATE rental_party_reviews SET status=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(),moderation_reason=? WHERE id=?",[body.data.status,req.user.id,body.data.reason,id.data]);await connection.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('from',?,'to',?))",[req.user.id,"rental_review_moderation","rental_party_review",id.data,body.data.reason,review.status,body.data.status]);if(body.data.status==="approved")await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rental_review_approved','Your rental review was approved and is now visible on the trust profile.',?),(?,'rental_review_received','A verified rental review was published on your trust profile.',?)",[review.author_id,id.data,review.target_user_id,id.data]);if(body.data.status==="rejected")await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rental_review_rejected','Your rental review was not approved for publication. The review remains in your rental history.',?)",[review.author_id,id.data]);await connection.commit();return res.json({id:id.data,status:body.data.status});}catch(error){await connection.rollback();console.error("Moderating rental review failed:",error.message);return res.status(500).json({error:"Unable to moderate rental review."});}finally{connection.release();}
  });
  router.patch("/rental-review-reports/:id",async(req,res)=>{
    const id=z.string().regex(/^\d+$/).safeParse(req.params.id),body=z.object({status:z.enum(["reviewing","resolved"]),resolution:z.string().trim().min(5).max(1000)}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Choose report status and add a resolution note."});
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [rows]=await connection.execute("SELECT id,review_id,status FROM rental_party_review_reports WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await connection.rollback();return res.status(404).json({error:"Review report not found."});}const report=rows[0];if(report.status==="resolved"){await connection.rollback();return res.status(409).json({error:"This report is already resolved."});}await connection.execute("UPDATE rental_party_review_reports SET status=?,resolution=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?",[body.data.status,body.data.resolution,req.user.id,id.data]);await connection.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('from',?,'to',?,'reviewId',?))",[req.user.id,"rental_review_report_moderation","rental_party_review_report",id.data,body.data.resolution,report.status,body.data.status,report.review_id]);await connection.commit();return res.json({id:id.data,status:body.data.status});}catch(error){await connection.rollback();console.error("Updating rental review report failed:",error.message);return res.status(500).json({error:"Unable to update review report."});}finally{connection.release();}
  });

  router.get("/listers", async (_req, res) => {
    try {
      const [rows] = await pool.execute(`
        SELECT u.id,u.name,u.email,u.phone,u.brand,u.created_at,
               COUNT(i.id) AS listing_count,
               COALESCE(SUM(i.paused=FALSE),0) AS active_listing_count
          FROM users u JOIN items i ON i.owner_id=u.id
         GROUP BY u.id,u.name,u.email,u.phone,u.brand,u.created_at
         ORDER BY u.created_at DESC LIMIT 500`);
      return res.json(rows.map((row) => ({ id: String(row.id), name: row.name, email: row.email, phone: row.phone || "", brand: row.brand || "", listingCount: Number(row.listing_count), activeListingCount: Number(row.active_listing_count), joinedAt: new Date(row.created_at).toISOString() })));
    } catch (error) { console.error("Loading listers failed:", error.message); return res.status(500).json({ error: "Unable to load listers." }); }
  });

  router.get("/users", async (_req, res) => {
    try {
      const [rows] = await pool.execute(`
        SELECT id,name,email,phone,brand,email_verified,is_rider,is_admin,created_at
          FROM users
         ORDER BY created_at DESC, id DESC`);
      return res.json(rows.map((row) => ({
        id: String(row.id), name: row.name, email: row.email,
        phone: row.phone || "", brand: row.brand || "",
        emailVerified: Boolean(row.email_verified), isRider: Boolean(row.is_rider),
        isAdmin: Boolean(row.is_admin), joinedAt: new Date(row.created_at).toISOString()
      })));
    } catch (error) {
      console.error("Loading registered users failed:", error.message);
      return res.status(500).json({ error: "Unable to load registered users." });
    }
  });

  router.patch("/listers/:id/listings", async (req, res) => {
    const userId = z.string().regex(/^\d+$/).safeParse(req.params.id);
    const body = z.object({ paused: z.boolean() }).strict().safeParse(req.body);
    if (!userId.success || !body.success) return res.status(400).json({ error: "Choose a lister and whether to pause or resume their listings." });
    try {
      const [result] = await pool.execute("UPDATE items SET paused=? WHERE owner_id=?", [body.data.paused, userId.data]);
      return res.json({ listerId: userId.data, paused: body.data.paused, updatedListings: result.affectedRows });
    } catch (error) { console.error("Updating lister listings failed:", error.message); return res.status(500).json({ error: "Unable to update listings." }); }
  });

  router.delete("/listers/:id/listings", async (req, res) => {
    const userId = z.string().regex(/^\d+$/).safeParse(req.params.id);
    if (!userId.success) return res.status(400).json({ error: "Choose a valid lister." });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [items] = await connection.execute(`
        SELECT i.id
          FROM items i
         WHERE i.owner_id = ?
           AND NOT EXISTS (SELECT 1 FROM rentals r WHERE r.item_id = i.id)
           AND NOT EXISTS (SELECT 1 FROM rental_inspections ri WHERE ri.item_id = i.id)
         FOR UPDATE`, [userId.data]);
      let deletedCount = 0;
      let skippedCount = 0;
      for (const item of items) {
        await connection.query("SAVEPOINT delete_lister_item");
        try {
          const [result] = await connection.execute("DELETE FROM items WHERE id = ? AND owner_id = ?", [item.id, userId.data]);
          deletedCount += result.affectedRows;
        } catch (error) {
          if (error.code !== "ER_ROW_IS_REFERENCED_2") throw error;
          await connection.query("ROLLBACK TO SAVEPOINT delete_lister_item");
          skippedCount += 1;
        }
      }
      await connection.commit();
      return res.json({ listerId: userId.data, deletedCount, skippedCount });
    } catch (error) {
      await connection.rollback();
      console.error("Deleting lister listings failed:", error.message);
      return res.status(500).json({ error: "Unable to delete this lister’s eligible listings." });
    } finally {
      connection.release();
    }
  });

  router.get("/controls", async (_req, res) => {
    try {
      const [rows] = await pool.execute("SELECT setting_value FROM shedshare_settings WHERE setting_key='payments_paused' LIMIT 1");
      return res.json({ paymentsPaused: rows[0]?.setting_value === "1" });
    } catch (error) { console.error("Loading admin controls failed:", error.message); return res.status(500).json({ error: "Unable to load marketplace controls." }); }
  });

  router.get("/commission-settings", async (_req, res) => {
    try {
      const [rows] = await pool.execute("SELECT setting_key,setting_value FROM shedshare_settings WHERE setting_key IN ('rental_commission_percent','rider_commission_percent')");
      const settings = Object.fromEntries(rows.map(row => [row.setting_key, Number(row.setting_value)]));
      return res.json({ rentalPercent: settings.rental_commission_percent ?? 15, riderPercent: settings.rider_commission_percent ?? 5 });
    } catch (error) { console.error("Loading commission settings failed:", error.message); return res.status(500).json({ error: "Unable to load commission settings." }); }
  });

  router.put("/commission-settings", async (req, res) => {
    const body = z.object({ rentalPercent: z.number().finite().min(0).max(100), riderPercent: z.number().finite().min(0).max(100), reason: z.string().trim().min(5).max(500) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Enter commission rates from 0% to 100% and a reason for the change." });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const [key, value] of [["rental_commission_percent", body.data.rentalPercent], ["rider_commission_percent", body.data.riderPercent]]) {
        await connection.execute("INSERT INTO shedshare_settings(setting_key,setting_value,updated_by) VALUES(?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_by=VALUES(updated_by)", [key, value.toFixed(2), req.user.id]);
      }
      await connection.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('rentalPercent',?,'riderPercent',?))", [req.user.id, "commission_rates_update", "platform_setting", "commission_rates", body.data.reason, body.data.rentalPercent, body.data.riderPercent]);
      await connection.commit();
      return res.json({ rentalPercent: body.data.rentalPercent, riderPercent: body.data.riderPercent });
    } catch (error) { await connection.rollback(); console.error("Saving commission settings failed:", error.message); return res.status(500).json({ error: "Unable to save commission settings." }); }
    finally { connection.release(); }
  });

  router.get("/contact-flags", async (_req, res) => {
    try {
      const [rows] = await pool.execute(`SELECT m.id,m.item_id,m.sender_id,m.text,m.created_at,
          item.name AS item_name,sender.name AS sender_name,
          CASE WHEN m.sender_id=m.owner_id THEN renter.name ELSE owner.name END AS recipient_name
        FROM messages m JOIN items item ON item.id=m.item_id
        JOIN users sender ON sender.id=m.sender_id JOIN users owner ON owner.id=m.owner_id
        JOIN users renter ON renter.id=m.renter_id
        WHERE m.contact_flagged=TRUE ORDER BY m.created_at DESC LIMIT 100`);
      return res.json(rows.map((row) => ({ id: String(row.id), itemName: row.item_name, senderName: row.sender_name, recipientName: row.recipient_name, text: row.text, createdAt: new Date(row.created_at).toISOString() })));
    } catch (error) { console.error("Loading contact flags failed:", error.message); return res.status(500).json({ error: "Unable to load message safety flags." }); }
  });

  router.get("/external-business-leads", async (_req,res)=>{
    try{
      const [rows]=await pool.execute(`SELECT place_id,item_term,city,state,action,COUNT(*) AS lead_count,MAX(created_at) AS last_lead_at FROM external_business_leads GROUP BY place_id,item_term,city,state,action ORDER BY lead_count DESC,last_lead_at DESC LIMIT 500`);
      return res.json(rows.map(row=>({placeId:row.place_id,item:row.item_term,city:row.city,state:row.state,action:row.action,count:Number(row.lead_count),lastLeadAt:new Date(row.last_lead_at).toISOString()})));
    }catch(error){console.error("Loading external business leads failed:",error.message);return res.status(500).json({error:"Unable to load external business leads."});}
  });

  router.patch("/controls", async (req, res) => {
    const body = z.object({ paymentsPaused: z.boolean() }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Choose whether new checkouts should be paused." });
    try {
      await pool.execute(`INSERT INTO shedshare_settings (setting_key,setting_value,updated_by)
        VALUES ('payments_paused',?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_by=VALUES(updated_by)`, [body.data.paymentsPaused ? "1" : "0", req.user.id]);
      await pool.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('paymentsPaused',?))",[req.user.id,"checkout_pause","platform_setting","payments_paused","Emergency checkout control changed",body.data.paymentsPaused]);
      return res.json({ paymentsPaused: body.data.paymentsPaused });
    } catch (error) { console.error("Updating admin controls failed:", error.message); return res.status(500).json({ error: "Unable to update marketplace controls." }); }
  });

  router.get("/financial-ledger",async(_req,res)=>{try{const [rows]=await pool.execute(`SELECT l.id,l.rental_id,l.entry_type,l.amount,l.currency,l.reference,l.created_at,r.owner_id,r.renter_id,r.item_name FROM rental_financial_ledger l JOIN rentals r ON r.id=l.rental_id ORDER BY l.created_at DESC LIMIT 2000`);return res.json(rows.map(r=>({id:String(r.id),rentalId:String(r.rental_id),type:r.entry_type,amountMinor:Number(r.amount),currency:r.currency,reference:r.reference,createdAt:new Date(r.created_at).toISOString(),itemName:r.item_name,ownerId:String(r.owner_id),renterId:String(r.renter_id)})));}catch(e){console.error("Loading admin ledger failed:",e.message);return res.status(500).json({error:"Unable to load financial ledger."});}});
  router.get("/commission-obligations",async(_req,res)=>{try{const [rows]=await pool.execute("SELECT c.*,r.item_name,o.name owner_name,u.name renter_name FROM rental_commission_obligations c JOIN rentals r ON r.id=c.rental_id JOIN users o ON o.id=c.owner_id JOIN users u ON u.id=c.renter_id ORDER BY c.created_at DESC LIMIT 2000");return res.json(rows.map(x=>({id:String(x.id),rentalId:String(x.rental_id),agreementId:String(x.agreement_id),itemName:x.item_name,ownerName:x.owner_name,renterName:x.renter_name,ratePercent:Number(x.rate_percent),basisAmount:Number(x.basis_amount)/100,amountDue:Number(x.amount_due)/100,amountReceived:Number(x.amount_received)/100,outstanding:Number(x.amount_due-x.amount_received)/100,status:x.status,createdAt:new Date(x.created_at).toISOString()})));}catch(e){console.error("Loading commission obligations failed:",e.message);return res.status(500).json({error:"Unable to load commission obligations."});}});
  router.post("/commission-obligations/:id/receipts",async(req,res)=>{const id=z.string().regex(/^\d+$/).safeParse(req.params.id),body=z.object({amount:z.number().finite().positive().max(9999999999.99),reference:z.string().trim().min(1).max(120),note:z.string().trim().max(500).optional().default("")}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Provide a valid obligation, amount, and reconciliation reference."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT * FROM rental_commission_obligations WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Commission obligation not found."});}const obligation=rows[0],[duplicate]=await c.execute("SELECT id,amount FROM rental_commission_events WHERE obligation_id=? AND reference=?",[id.data,body.data.reference]);const amount=Math.round(body.data.amount*100);if(duplicate.length){if(Number(duplicate[0].amount)!==amount){await c.rollback();return res.status(409).json({error:"This reconciliation reference was already recorded with a different amount."});}await c.commit();return res.json({status:obligation.status,idempotent:true});}const outstanding=Number(obligation.amount_due)-Number(obligation.amount_received);if(amount>outstanding){await c.rollback();return res.status(409).json({error:"The recorded amount exceeds the outstanding commission."});}const received=Number(obligation.amount_received)+amount,status=received===Number(obligation.amount_due)?"paid":"partially_paid";await c.execute("INSERT INTO rental_commission_events(obligation_id,actor_id,amount,reference,note) VALUES(?,?,?,?,?)",[id.data,req.user.id,amount,body.data.reference,body.data.note||null]);await c.execute("UPDATE rental_commission_obligations SET amount_received=?,status=? WHERE id=?",[received,status,id.data]);await c.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('amountMinor',?,'reference',?))",[req.user.id,"commission_receipt_recorded","commission_obligation",id.data,body.data.note||"Administrator recorded actual commission receipt.",amount,body.data.reference]);await c.commit();return res.json({status,amountReceived:received/100,outstanding:(Number(obligation.amount_due)-received)/100});}catch(e){await c.rollback();console.error("Recording commission receipt failed:",e.message);return res.status(500).json({error:"Unable to record commission receipt."});}finally{c.release();}});
  router.get("/disputes",async(_req,res)=>{try{const [rows]=await pool.execute("SELECT d.id,d.rental_id,d.reason,d.status,d.created_at,r.item_name,d.opened_by FROM rental_disputes d JOIN rentals r ON r.id=d.rental_id ORDER BY d.created_at DESC LIMIT 300");return res.json(rows.map(r=>({id:String(r.id),rentalId:String(r.rental_id),reason:r.reason,status:r.status,createdAt:new Date(r.created_at).toISOString(),itemName:r.item_name,openedBy:String(r.opened_by)})));}catch(e){console.error("Loading disputes failed:",e.message);return res.status(500).json({error:"Unable to load disputes."});}});
  router.patch("/users/:id/trust-role",async(req,res)=>{const id=z.string().regex(/^\d+$/).safeParse(req.params.id),body=z.object({trustRole:z.enum(["none","super_admin","trust_and_safety"]),reason:z.string().trim().min(5).max(500)}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Choose an authorized role and give a reason."});if(req.user.trustRole!=="super_admin")return res.status(403).json({error:"Only a super admin can assign trust roles."});try{await pool.execute("UPDATE users SET trust_role=? WHERE id=?",[body.data.trustRole,id.data]);await pool.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES(?,?,?,?,?,JSON_OBJECT('trustRole',?))",[req.user.id,"trust_role_update","user",id.data,body.data.reason,body.data.trustRole]);return res.json({userId:id.data,trustRole:body.data.trustRole});}catch(e){console.error("Updating trust role failed:",e.message);return res.status(500).json({error:"Unable to update trust role."});}});
  router.patch("/disputes/:id",async(req,res)=>{const id=z.string().regex(/^\d+$/).safeParse(req.params.id),body=z.object({status:z.enum(["reviewing","resolved"]),reason:z.string().trim().min(5).max(1000),resolution:z.string().max(3000).optional().default("")}).strict().safeParse(req.body);if(!id.success||!body.success)return res.status(400).json({error:"Provide a status and reason for the action."});const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT d.id,d.rental_id,d.status,r.dispute_return_status,r.renter_id,r.owner_id FROM rental_disputes d JOIN rentals r ON r.id=d.rental_id WHERE d.id=? FOR UPDATE",[id.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Dispute not found."});}const dispute=rows[0];if(dispute.status==="resolved"){await c.rollback();return res.status(409).json({error:"This dispute is already resolved."});}await c.execute("UPDATE rental_disputes SET status=?,resolution=?,resolved_by=IF(?='resolved',?,NULL),resolved_at=IF(?='resolved',UTC_TIMESTAMP(),NULL) WHERE id=?",[body.data.status,body.data.resolution,body.data.status,req.user.id,body.data.status,id.data]);await c.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES (?,?,?,?,?,JSON_OBJECT('status',?,'resolution',?))",[req.user.id,"dispute_update","rental_dispute",id.data,body.data.reason,body.data.status,body.data.resolution]);if(body.data.status==="resolved"){await c.execute("UPDATE rentals SET status=COALESCE(dispute_return_status,'confirmed'),dispute_return_status=NULL,safety_hold=FALSE,safety_hold_reason=NULL WHERE id=? AND status='disputed'",[dispute.rental_id]);await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'rental_dispute_update','ShedShare resolved the rental dispute.',?),(?,'rental_dispute_update','ShedShare resolved the rental dispute.',?)",[dispute.renter_id,dispute.rental_id,dispute.owner_id,dispute.rental_id]);}await c.commit();return res.json({id:id.data,status:body.data.status});}catch(e){await c.rollback();console.error("Updating dispute failed:",e.message);return res.status(500).json({error:"Unable to update dispute."});}finally{c.release();}});
  router.get("/audit",async(_req,res)=>{try{const [rows]=await pool.execute("SELECT a.id,a.admin_id,u.name admin_name,a.action,a.entity_type,a.entity_id,a.reason,a.metadata,a.created_at FROM admin_audit_log a JOIN users u ON u.id=a.admin_id ORDER BY a.created_at DESC LIMIT 1000");return res.json(rows.map(r=>({id:String(r.id),adminId:String(r.admin_id),adminName:r.admin_name,action:r.action,entityType:r.entity_type,entityId:r.entity_id,reason:r.reason,metadata:r.metadata,createdAt:new Date(r.created_at).toISOString()})));}catch(e){console.error("Loading audit log failed:",e.message);return res.status(500).json({error:"Unable to load audit log."});}});
  router.patch("/settings/:key",async(req,res)=>{const key=z.enum(["checkout_reservation_minutes"]).safeParse(req.params.key),body=z.object({value:z.number().finite(),reason:z.string().trim().min(5).max(500)}).strict().safeParse(req.body);if(!key.success||!body.success)return res.status(400).json({error:"Invalid platform setting."});if(body.data.value<5||body.data.value>120)return res.status(400).json({error:"Checkout reservation must be between 5 and 120 minutes."});try{await pool.execute("INSERT INTO shedshare_settings(setting_key,setting_value,updated_by) VALUES(?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_by=VALUES(updated_by)",[key.data,String(body.data.value),req.user.id]);await pool.execute("INSERT INTO admin_audit_log(admin_id,action,entity_type,entity_id,reason,metadata) VALUES (?,?,?,?,?,JSON_OBJECT('value',?))",[req.user.id,"setting_update","platform_setting",key.data,body.data.reason,String(body.data.value)]);return res.json({key:key.data,value:body.data.value});}catch(e){console.error("Updating admin setting failed:",e.message);return res.status(500).json({error:"Unable to update platform setting."});}});

  router.patch("/rentals/:id/hold", async (req, res) => {
    const rentalId = z.string().regex(/^\d+$/).safeParse(req.params.id);
    const body = z.object({ hold: z.boolean(), reason: z.string().trim().max(500).optional().default("") }).strict().safeParse(req.body);
    if (!rentalId.success || !body.success) return res.status(400).json({ error: "Invalid rental hold request." });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT id,owner_id,renter_id,status FROM rentals WHERE id=? FOR UPDATE", [rentalId.data]);
      if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "Rental not found." }); }
      const rental = rows[0];
      if (!["confirmed", "active"].includes(rental.status)) { await connection.rollback(); return res.status(409).json({ error: "Safety holds are available for confirmed or active rentals." }); }
      if (body.data.hold && !body.data.reason) { await connection.rollback(); return res.status(400).json({ error: "Add a short reason for the safety hold." }); }
      await connection.execute("UPDATE rentals SET safety_hold=?,safety_hold_reason=? WHERE id=?", [body.data.hold, body.data.hold ? body.data.reason : null, rentalId.data]);
      const notice = body.data.hold ? "An administrator placed this rental on a safety hold. Contact ShedShare support before continuing." : "The safety hold on this rental has been released.";
      await connection.execute("INSERT INTO notifications (user_id,type,message,related_id) VALUES (?,?,?,?),(?,?,?,?)", [rental.owner_id, "rental_safety_hold", notice, rentalId.data, rental.renter_id, "rental_safety_hold", notice, rentalId.data]);
      await connection.commit();
      return res.json({ rentalId: rentalId.data, onHold: body.data.hold });
    } catch (error) { await connection.rollback(); console.error("Updating rental safety hold failed:", error.message); return res.status(500).json({ error: "Unable to update rental safety hold." }); }
    finally { connection.release(); }
  });

  router.use("/referrals", createAdminReferralRouter({ pool }));
  return router;
}

module.exports = { createAdminRouter };
