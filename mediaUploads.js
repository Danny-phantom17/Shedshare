"use strict";

const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");

const IMAGE_MAX_BYTES = Number(process.env.MAX_IMAGE_BYTES || 8 * 1024 * 1024);
const VIDEO_MAX_BYTES = Number(process.env.MAX_VIDEO_BYTES || 20 * 1024 * 1024);
if (!Number.isSafeInteger(IMAGE_MAX_BYTES) || IMAGE_MAX_BYTES < 1 || IMAGE_MAX_BYTES > 20 * 1024 * 1024) throw new Error("MAX_IMAGE_BYTES must be between 1 byte and 20 MiB.");
if (!Number.isSafeInteger(VIDEO_MAX_BYTES) || VIDEO_MAX_BYTES < 1 || VIDEO_MAX_BYTES > 50 * 1024 * 1024) throw new Error("MAX_VIDEO_BYTES must be between 1 byte and 50 MiB.");
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: Math.max(IMAGE_MAX_BYTES, VIDEO_MAX_BYTES) } });

function imageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: "image/png", ext: "png" };
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

function createMediaUploadsRouter({ pool, supabase, authenticate }) {
  const router = express.Router();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media";

  router.put("/:id/image", authenticate, (request, response, next) => upload.single("image")(request, response, (error) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ error: "Image is too large." });
    if (error) return response.status(400).json({ error: "Invalid image upload." });
    next();
  }), async (request, response) => {
    if (!/^\d+$/.test(request.params.id)) return response.status(400).json({ error: "Invalid item id." });
    if (!request.file) return response.status(400).json({ error: "Choose an image to upload." });
    const type = imageType(request.file.buffer);
    if (!type) return response.status(415).json({ error: "Upload a JPEG, PNG, or WebP image." });
    const key = `items/${request.user.id}/${crypto.randomUUID()}.${type.ext}`;
    const connection = await pool.getConnection();
    let uploaded = false;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT owner_id FROM items WHERE id = ? FOR UPDATE", [request.params.id]);
      if (!rows.length) { await connection.rollback(); return response.status(404).json({ error: "Item not found." }); }
      if (String(rows[0].owner_id) !== String(request.user.id)) { await connection.rollback(); return response.status(403).json({ error: "That isn't your listing." }); }
      const { error } = await supabase.storage.from(bucket).upload(key, request.file.buffer, { contentType: type.mime, upsert: false, cacheControl: "31536000" });
      if (error) throw error;
      uploaded = true;
      const { data } = supabase.storage.from(bucket).getPublicUrl(key);
      await connection.execute("UPDATE items SET image = ? WHERE id = ? AND owner_id = ?", [data.publicUrl, request.params.id, request.user.id]);
      await connection.commit();
      return response.status(200).json({ image: data.publicUrl });
    } catch (error) {
      try { await connection.rollback(); } catch (_ignored) {}
      if (uploaded) { const { error: cleanupError } = await supabase.storage.from(bucket).remove([key]); if (cleanupError) console.error("Image cleanup failed:", cleanupError.message); }
      console.error("Image upload failed:", error.message);
      return response.status(500).json({ error: "Unable to upload image." });
    } finally { connection.release(); }
  });

  return router;
}

module.exports = { createMediaUploadsRouter };
