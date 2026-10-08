"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
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
    async putVideo({ body, contentType, extension }) {
      const key = `items/videos/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
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
      async putVideo({ body, contentType, extension }) {
        const key = `items/${request.user.id}/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media").upload(key, body, { contentType, upsert: false, cacheControl: "31536000" });
        if (error) throw error;
        const { data } = supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media").getPublicUrl(key);
        return { key, url: data.publicUrl };
      },
      async delete(key) { const { error } = await supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media").remove([key]); if (error) throw error; }
    } : createStorageAdapter(configuration);
    let storedObject = null;

    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT owner_id FROM items WHERE id = ? LIMIT 1 FOR UPDATE",
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

      storedObject = await storage.putVideo({
        body: request.file.buffer,
        contentType: container.contentType,
        extension: container.extension
      });

      await connection.execute(
        "UPDATE items SET video = ? WHERE id = ? AND owner_id = ?",
        [storedObject.url, itemId, request.user.id]
      );
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
        } catch (cleanupError) {
          console.error("Cleaning up failed video upload failed:", cleanupError.message);
        }
      }

      console.error("Uploading item video failed:", error.message);
      return response.status(500).json({ error: "Unable to upload video." });
    } finally {
      connection.release();
    }
  });

  router.delete("/:id/video", authenticate, async (request, response) => {
    const itemId = parseItemId(request.params.id);
    if (!itemId) {
      return response.status(400).json({ error: "Invalid item id." });
    }

    try {
      const [result] = await pool.execute(
        "UPDATE items SET video = NULL WHERE id = ? AND owner_id = ?",
        [itemId, request.user.id]
      );

      if (result.affectedRows === 0) {
        const [rows] = await pool.execute(
          "SELECT owner_id FROM items WHERE id = ? LIMIT 1",
          [itemId]
        );
        if (rows.length === 0) {
          return response.status(404).json({ error: "Item not found." });
        }
        return response.status(403).json({ error: "That isn't your listing." });
      }

      return response.status(200).json({ video: "" });
    } catch (error) {
      console.error("Removing item video failed:", error.message);
      return response.status(500).json({ error: "Unable to remove video." });
    }
  });

  return router;
}

module.exports = { createVideoUploadsRouter };
