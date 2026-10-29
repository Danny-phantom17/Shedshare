"use strict";

const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const { CLEANUP_LOCK } = require("./storage-cleanup");
const { keyFromReference } = require("./storage-cleanup");

const IMAGE_MAX_BYTES = Number(process.env.MAX_IMAGE_BYTES || 8 * 1024 * 1024);
const VIDEO_MAX_BYTES = Number(process.env.MAX_VIDEO_BYTES || 20 * 1024 * 1024);
if (!Number.isSafeInteger(IMAGE_MAX_BYTES) || IMAGE_MAX_BYTES < 1 || IMAGE_MAX_BYTES > 20 * 1024 * 1024) throw new Error("MAX_IMAGE_BYTES must be between 1 byte and 20 MiB.");
if (!Number.isSafeInteger(VIDEO_MAX_BYTES) || VIDEO_MAX_BYTES < 1 || VIDEO_MAX_BYTES > 50 * 1024 * 1024) throw new Error("MAX_VIDEO_BYTES must be between 1 byte and 50 MiB.");
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 2, fileSize: Math.max(IMAGE_MAX_BYTES, VIDEO_MAX_BYTES) } });

function imageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: "image/png", ext: "png" };
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

function createMediaUploadsRouter({ pool, supabase, authenticate }) {
  const router = express.Router();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media";

  router.put("/:id/image", authenticate, (request, response, next) => upload.fields([{name:"image",maxCount:1},{name:"original",maxCount:1}])(request, response, (error) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ error: "Image is too large." });
    if (error) return response.status(400).json({ error: "Invalid image upload." });
    next();
  }), async (request, response) => {
    if (!/^\d+$/.test(request.params.id)) return response.status(400).json({ error: "Invalid item id." });
    const imageFile=request.files?.image?.[0],originalFile=request.files?.original?.[0];
    if (!imageFile) return response.status(400).json({ error: "Choose an image to upload." });
    const type = imageType(imageFile.buffer),originalType=originalFile?imageType(originalFile.buffer):null;
    if (!type) return response.status(415).json({ error: "Upload a JPEG, PNG, or WebP image." });
    if(originalFile&&!originalType)return response.status(415).json({error:"The original must be a JPEG, PNG, or WebP image."});
    const keys=[];
    const connection = await pool.getConnection();
    let uploadLock = false;
    try {
      const [lockRows] = await connection.execute("SELECT GET_LOCK(?,10) AS acquired", [CLEANUP_LOCK]);
      if (Number(lockRows[0]?.acquired) !== 1) return response.status(503).json({ error: "Media maintenance is running. Retry the upload shortly." });
      uploadLock = true;
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT owner_id,image,original_image,moderation_status FROM items WHERE id = ? FOR UPDATE", [request.params.id]);
      if (!rows.length) { await connection.rollback(); return response.status(404).json({ error: "Item not found." }); }
      if (String(rows[0].owner_id) !== String(request.user.id)) { await connection.rollback(); return response.status(403).json({ error: "That isn't your listing." }); }
      let supabaseOrigin = null; try { supabaseOrigin = new URL(process.env.SUPABASE_URL).origin; } catch {}
      for (const existingValue of [rows[0].image, rows[0].original_image]) {
        const existingKey = keyFromReference(existingValue, { supabaseOrigin, supabaseBucket: bucket, s3BaseUrl: null });
        if (existingKey) await connection.execute("INSERT INTO storage_cleanup_asset_registry(item_id,provider,bucket_name,object_key,asset_type) VALUES(?,?,?,?, 'image') ON DUPLICATE KEY UPDATE item_id=VALUES(item_id)", [request.params.id, "supabase", bucket, existingKey]);
      }
      const store=async(file,fileType,assetType)=>{const key=`items/${request.user.id}/${crypto.randomUUID()}.${fileType.ext}`;await pool.execute("INSERT INTO storage_cleanup_upload_leases(item_id,provider,bucket_name,object_key,asset_type,status) VALUES(?,?,?,?,?,'pending')",[request.params.id,"supabase",bucket,key,assetType]);const {error}=await supabase.storage.from(bucket).upload(key,file.buffer,{contentType:fileType.mime,upsert:false,cacheControl:"31536000"});if(error)throw error;keys.push(key);await connection.execute("INSERT INTO storage_cleanup_asset_registry(item_id,provider,bucket_name,object_key,asset_type) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE item_id=VALUES(item_id),asset_type=VALUES(asset_type)",[request.params.id,"supabase",bucket,key,assetType]);await connection.execute("UPDATE storage_cleanup_upload_leases SET status='attached' WHERE provider='supabase' AND bucket_name=? AND object_key=?",[bucket,key]);return {key,url:supabase.storage.from(bucket).getPublicUrl(key).data.publicUrl};};
      const storedImage=await store(imageFile,type,"image");
      const preserveEnhanced=request.body?.enhanced==="true";
      const storedOriginal=originalFile?await store(originalFile,originalType,"original_image"):null;
      const originalUrl=storedOriginal?.url|| (preserveEnhanced?(rows[0].original_image||rows[0].image):null);
      await connection.execute("UPDATE items SET image=?,original_image=?,moderation_status='pending_analysis' WHERE id=? AND owner_id=?",[storedImage.url,originalUrl,request.params.id,request.user.id]);
      if(rows[0].moderation_status!=="pending_analysis")await connection.execute("INSERT INTO listing_moderation_audit(item_id,actor_id,action,previous_status,new_status,reason) VALUES(?,?,'resubmitted',?,'pending_analysis','Listing photo changed and requires a fresh safety review.')",[request.params.id,request.user.id,rows[0].moderation_status]);
      await connection.commit();
      return response.status(200).json({ image:storedImage.url,originalImage:originalUrl||"" });
    } catch (error) {
      try { await connection.rollback(); } catch (_ignored) {}
      if (keys.length) { const { error: cleanupError } = await supabase.storage.from(bucket).remove(keys); if (cleanupError) console.error("Image cleanup failed:", cleanupError.message); else for (const key of keys) { try { await pool.execute("UPDATE storage_cleanup_upload_leases SET status='removed' WHERE provider='supabase' AND bucket_name=? AND object_key=?", [bucket,key]); } catch (leaseError) { console.error("Updating image upload cleanup lease failed:", leaseError.message); } } }
      console.error("Image upload failed:", error.message, error.cause?.code || "");
      const storageUnavailable = error.message === "fetch failed" || Boolean(error.cause?.code);
      return response.status(storageUnavailable ? 503 : 500).json({ error: storageUnavailable
        ? "ShedShare could not reach Supabase Storage. Check the server internet connection and confirm SUPABASE_URL matches your active Supabase project."
        : "Unable to upload image. Check that the Supabase Storage bucket exists and matches SUPABASE_STORAGE_BUCKET." });
    } finally { if (uploadLock) { try { await connection.execute("SELECT RELEASE_LOCK(?)", [CLEANUP_LOCK]); } catch (error) { console.error("Releasing image upload lock failed:", error.message); } } connection.release(); }
  });

  return router;
}

module.exports = { createMediaUploadsRouter, imageType };
