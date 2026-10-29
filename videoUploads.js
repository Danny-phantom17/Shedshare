"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { CLEANUP_LOCK } = require("./storage-cleanup");
const express = require("express");
const multer = require("multer");
const ffprobe = require("ffprobe-static");
const {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client
} = require("@aws-sdk/client-s3");

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_DURATION_SECONDS = 60;
const REQUIRED_STORAGE_SETTINGS = [
  "STORAGE_S3_BUCKET",
  "STORAGE_S3_REGION",
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
  "STORAGE_PUBLIC_BASE_URL"
];

function positiveIntegerSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

const maxVideoBytes = positiveIntegerSetting(
  "MAX_VIDEO_BYTES",
  DEFAULT_MAX_VIDEO_BYTES
);
const maxVideoDurationSeconds = positiveIntegerSetting(
  "MAX_VIDEO_DURATION_SECONDS",
  DEFAULT_MAX_VIDEO_DURATION_SECONDS
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxVideoBytes,
    files: 1,
    fields: 0
  }
});

function storageConfiguration() {
  const missing = REQUIRED_STORAGE_SETTINGS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return { configured: false, missing };
  }

  let publicBaseUrl;
  try {
    publicBaseUrl = new URL(process.env.STORAGE_PUBLIC_BASE_URL);
  } catch (_error) {
    return { configured: false, missing: ["STORAGE_PUBLIC_BASE_URL (valid absolute URL)"] };
  }

  if (!new Set(["http:", "https:"]).has(publicBaseUrl.protocol)) {
    return { configured: false, missing: ["STORAGE_PUBLIC_BASE_URL (HTTP or HTTPS URL)"] };
  }

  return {
    configured: true,
    bucket: process.env.STORAGE_S3_BUCKET,
    region: process.env.STORAGE_S3_REGION,
    endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === "true",
    publicBaseUrl: publicBaseUrl.toString().replace(/\/+$/, ""),
    credentials: {
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY
    }
  };
}

function createStorageAdapter(configuration) {
  const client = new S3Client({
    region: configuration.region,
    endpoint: configuration.endpoint,
    forcePathStyle: configuration.forcePathStyle,
    credentials: configuration.credentials
  });

  return {
    async putVideo({ body, contentType, extension, key: requestedKey }) {
      const key = requestedKey || `items/videos/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
      await client.send(new PutObjectCommand({
        Bucket: configuration.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable"
      }));

      return {
        key,
        url: `${configuration.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`
      };
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({
        Bucket: configuration.bucket,
        Key: key
      }));
    }
  };
}

function detectContainer(buffer) {
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp"
  ) {
    return { contentType: "video/mp4", extension: "mp4", format: "mp4" };
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { contentType: "video/webm", extension: "webm", format: "webm" };
  }

  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") {
    return { contentType: "video/ogg", extension: "ogv", format: "ogg" };
  }

  return null;
}

async function inspectVideo(buffer, container) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "shedshare-video-"));
  const filePath = path.join(directory, `upload.${container.extension}`);

  try {
    await fs.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
    const { stdout } = await execFileAsync(
      ffprobe.path,
      [
        "-v", "error",
        "-show_entries", "format=duration,format_name:stream=codec_type",
        "-of", "json",
        filePath
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15000
      }
    );

    const metadata = JSON.parse(stdout);
    const formatNames = String(metadata.format?.format_name || "").split(",");
    const hasVideoStream = Array.isArray(metadata.streams) &&
      metadata.streams.some((stream) => stream.codec_type === "video");
    const duration = Number(metadata.format?.duration);

    if (!hasVideoStream) {
      throw new Error("The uploaded file does not contain a video stream.");
    }

    if (!formatNames.includes(container.format)) {
      throw new Error("The video container does not match its file signature.");
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("The video duration could not be determined.");
    }

    if (duration > maxVideoDurationSeconds) {
      throw new Error(`Video duration cannot exceed ${maxVideoDurationSeconds} seconds.`);
    }

    return duration;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function parseItemId(value) {
  return /^\d+$/.test(String(value || "")) ? String(value) : null;
}

function videoObjectKey(value, { supabase, configuration }) {
  try {
    if (typeof value !== "string") return null;
    if (!/^https?:\/\//i.test(value)) return value.startsWith("items/") && !value.split("/").includes("..") ? value : null;
    const url = new URL(value);
    if (supabase) {
      const origin = new URL(process.env.SUPABASE_URL).origin;
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media";
      const prefix = `/storage/v1/object/public/${encodeURIComponent(bucket)}/`;
      if (url.origin !== origin || !url.pathname.startsWith(prefix)) return null;
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      return key.startsWith("items/") && !key.split("/").includes("..") ? key : null;
    }
    if (configuration?.configured && url.origin === new URL(configuration.publicBaseUrl).origin) {
      const prefix = new URL(configuration.publicBaseUrl).pathname.replace(/\/$/, "");
      const key = decodeURIComponent(url.pathname.slice(prefix.length).replace(/^\//, ""));
      return key.startsWith("items/") && !key.split("/").includes("..") ? key : null;
    }
  } catch (_error) { return null; }
  return null;
}

function runUpload(request, response) {
  return new Promise((resolve, reject) => {
    upload.single("video")(request, response, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createVideoUploadsRouter({ pool, authenticate, supabase }) {
  if (!pool) throw new Error("A video upload database pool is required.");
  if (typeof authenticate !== "function") {
    throw new Error("Video upload authentication middleware is required.");
  }

  const router = express.Router();

  router.put("/:id/video", authenticate, async (request, response) => {
    const itemId = parseItemId(request.params.id);
    if (!itemId) {
      return response.status(400).json({ error: "Invalid item id." });
    }

    const configuration = storageConfiguration();
    if (!supabase && !configuration.configured) {
      console.error(
        `Video storage is not configured. Required settings: ${REQUIRED_STORAGE_SETTINGS.join(", ")}. Missing or invalid: ${configuration.missing.join(", ")}.`
      );
      return response.status(503).json({
        error: "Video storage is unavailable. Configure the server storage adapter before uploading videos.",
        requiredSettings: REQUIRED_STORAGE_SETTINGS
      });
    }

    try {
      await runUpload(request, response);
    } catch (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        return response.status(413).json({
          error: `Video cannot exceed ${maxVideoBytes} bytes.`
        });
      }

      if (error instanceof multer.MulterError) {
        return response.status(400).json({ error: "Invalid video upload." });
      }

      console.error("Parsing video upload failed:", error.message);
      return response.status(400).json({ error: "Invalid video upload." });
    }

    if (!request.file || request.file.fieldname !== "video") {
      return response.status(400).json({ error: "Choose a video to upload." });
    }

    const container = detectContainer(request.file.buffer);
    if (!container) {
      return response.status(415).json({
        error: "Unsupported video type. Upload an MP4, WebM, or Ogg video."
      });
    }

    try {
      await inspectVideo(request.file.buffer, container);
    } catch (error) {
      return response.status(400).json({ error: error.message || "Invalid video file." });
    }

    const connection = await pool.getConnection();
    const storage = supabase ? {
      async putVideo({ body, contentType, extension, key: requestedKey }) {
        const key = requestedKey || `items/${request.user.id}/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media").upload(key, body, { contentType, upsert: false, cacheControl: "31536000" });
        if (error) throw error;
        const { data } = supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media").getPublicUrl(key);
        return { key, url: data.publicUrl };
      },
      async delete(key) { const { error } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media").remove([key]); if (error) throw error; }
    } : createStorageAdapter(configuration);
    let storedObject = null;
    let uploadLock = false;
    let videoBucket = "";
    let videoProvider = "";

    try {
      const [lockRows] = await connection.execute("SELECT GET_LOCK(?,10) AS acquired", [CLEANUP_LOCK]);
      if (Number(lockRows[0]?.acquired) !== 1) return response.status(503).json({ error: "Media maintenance is running. Retry the upload shortly." });
      uploadLock = true;
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT owner_id,video FROM items WHERE id = ? LIMIT 1 FOR UPDATE",
        [itemId]
      );

      if (rows.length === 0) {
        await connection.rollback();
        return response.status(404).json({ error: "Item not found." });
      }

      if (String(rows[0].owner_id) !== String(request.user.id)) {
        await connection.rollback();
        return response.status(403).json({ error: "That isn't your listing." });
      }

      const previousVideoKey = videoObjectKey(rows[0].video, { supabase, configuration });
      if (previousVideoKey) await connection.execute("INSERT INTO storage_cleanup_asset_registry(item_id,provider,bucket_name,object_key,asset_type) VALUES(?,?,?,?, 'video') ON DUPLICATE KEY UPDATE item_id=VALUES(item_id)", [itemId, supabase ? "supabase" : "s3", supabase ? (process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media") : configuration.bucket, previousVideoKey]);

      videoBucket = supabase ? (process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media") : configuration.bucket;
      videoProvider = supabase ? "supabase" : "s3";
      const predictedKey = supabase ? `items/${request.user.id}/${crypto.randomUUID()}.${container.extension}` : `items/videos/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${container.extension}`;
      await pool.execute("INSERT INTO storage_cleanup_upload_leases(item_id,provider,bucket_name,object_key,asset_type,status) VALUES(?,?,?,?, 'video','pending')", [itemId, videoProvider, videoBucket, predictedKey]);
      storedObject = await storage.putVideo({
        body: request.file.buffer,
        contentType: container.contentType,
        extension: container.extension,
        key: predictedKey
      });

      await connection.execute(
        "UPDATE items SET video = ? WHERE id = ? AND owner_id = ?",
        [storedObject.url, itemId, request.user.id]
      );
      await connection.execute(
        "INSERT INTO storage_cleanup_asset_registry(item_id,provider,bucket_name,object_key,asset_type) VALUES(?,?,?,?, 'video') ON DUPLICATE KEY UPDATE item_id=VALUES(item_id),asset_type='video'",
        [itemId, videoProvider, videoBucket, storedObject.key]
      );
      await connection.execute("UPDATE storage_cleanup_upload_leases SET status='attached' WHERE provider=? AND bucket_name=? AND object_key=?", [videoProvider, videoBucket, storedObject.key]);
      await connection.commit();

      return response.status(200).json({ video: storedObject.url });
    } catch (error) {
      try {
        await connection.rollback();
      } catch (_rollbackError) {
        // The original failure is logged below.
      }

      if (storedObject) {
        try {
          await storage.delete(storedObject.key);
          await pool.execute("UPDATE storage_cleanup_upload_leases SET status='removed' WHERE provider=? AND bucket_name=? AND object_key=?", [videoProvider, videoBucket, storedObject.key]);
        } catch (cleanupError) {
          console.error("Cleaning up failed video upload failed:", cleanupError.message);
        }
      }

      console.error("Uploading item video failed:", error.message);
      return response.status(500).json({ error: "Unable to upload video." });
    } finally {
      if (uploadLock) { try { await connection.execute("SELECT RELEASE_LOCK(?)", [CLEANUP_LOCK]); } catch (error) { console.error("Releasing video upload lock failed:", error.message); } }
      connection.release();
    }
  });

  router.delete("/:id/video", authenticate, async (request, response) => {
    const itemId = parseItemId(request.params.id);
    if (!itemId) {
      return response.status(400).json({ error: "Invalid item id." });
    }

    const connection = await pool.getConnection();
    let locked = false;
    try {
      const [lockRows] = await connection.execute("SELECT GET_LOCK(?,10) AS acquired", [CLEANUP_LOCK]);
      if (Number(lockRows[0]?.acquired) !== 1) return response.status(503).json({ error: "Media maintenance is running. Retry shortly." });
      locked = true;
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT owner_id,video FROM items WHERE id=? LIMIT 1 FOR UPDATE", [itemId]);
      if (!rows.length) { await connection.rollback(); return response.status(404).json({ error: "Item not found." }); }
      if (String(rows[0].owner_id) !== String(request.user.id)) { await connection.rollback(); return response.status(403).json({ error: "That isn't your listing." }); }
      const videoUrl = rows[0].video;
      if (videoUrl) {
        const videoConfig = storageConfiguration();
        const key = videoObjectKey(videoUrl, { supabase, configuration: videoConfig });
        const provider = supabase ? "supabase" : "s3";
        const bucket = supabase ? (process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media") : videoConfig.bucket || "";
        if (key) {
          await connection.execute("INSERT INTO storage_cleanup_asset_registry(item_id,provider,bucket_name,object_key,asset_type) VALUES(?,?,?,?, 'video') ON DUPLICATE KEY UPDATE item_id=VALUES(item_id),asset_type='video'", [itemId, provider, bucket, key]);
        }
      }
      await connection.execute("UPDATE items SET video=NULL WHERE id=? AND owner_id=?", [itemId, request.user.id]);
      await connection.commit();
      return response.status(200).json({ video: "" });
    } catch (error) {
      try { await connection.rollback(); } catch (_error) {}
      console.error("Removing item video failed:", error.message);
      return response.status(500).json({ error: "Unable to remove video." });
    } finally {
      if (locked) { try { await connection.execute("SELECT RELEASE_LOCK(?)", [CLEANUP_LOCK]); } catch (error) { console.error("Releasing video cleanup lock failed:", error.message); } }
      connection.release();
    }
  });

  return router;
}

module.exports = { createVideoUploadsRouter, videoObjectKey };
