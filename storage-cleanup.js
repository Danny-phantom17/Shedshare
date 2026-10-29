"use strict";

const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const CLEANUP_LOCK = "shedshare_storage_cleanup_v1";
const DEFAULT_RETENTION_DAYS = 30;
const MAX_CANDIDATES = 200;
const MAX_DELETE_PER_RUN = 50;

function ageCutoff(days, now = Date.now()) { return new Date(now - days * 86400000); }
function collectStrings(value, output = new Set()) {
  if (typeof value === "string") output.add(value);
  else if (Array.isArray(value)) value.forEach(entry => collectStrings(entry, output));
  else if (value && typeof value === "object") Object.values(value).forEach(entry => collectStrings(entry, output));
  return output;
}
function safeJson(value) { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
function keyFromReference(value, { supabaseOrigin, supabaseBucket, s3BaseUrl }) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const validKey = key => typeof key === "string" && !key.startsWith("/") && !key.split("/").some(part => part === "..") && /^(items\/|items\/videos\/)/.test(key);
  if (validKey(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (supabaseOrigin && url.origin === supabaseOrigin) {
      const prefix = `/storage/v1/object/(?:public|sign)/${encodeURIComponent(supabaseBucket)}/`;
      const match = url.pathname.match(new RegExp(prefix));
      if (match) { const key = decodeURIComponent(url.pathname.slice(match[0].length)); return validKey(key) ? key : null; }
    }
    if (s3BaseUrl && url.origin === new URL(s3BaseUrl).origin) {
      const basePath = new URL(s3BaseUrl).pathname.replace(/\/$/, "");
      const key = decodeURIComponent(url.pathname.slice(basePath.length).replace(/^\//, ""));
      return validKey(key) ? key : null;
    }
  } catch { /* Non-URL values are not object references. */ }
  return null;
}

async function loadReferencedKeys(pool, config) {
  const refs = new Set();
  const queries = [
    ["SELECT image,original_image,video FROM items", row => [row.image,row.original_image,row.video]],
    ["SELECT a.object_key FROM storage_cleanup_asset_registry a JOIN rentals r ON r.item_id=a.item_id", row => [row.object_key]],
    ["SELECT reference_image_url FROM item_requests", row => [row.reference_image_url]],
    ["SELECT attachment_path FROM chat_messages", row => [row.attachment_path]],
    ["SELECT evidence_path FROM rental_handover_records", row => [row.evidence_path]],
    ["SELECT agreement_terms FROM rentals", row => [safeJson(row.agreement_terms)]],
    ["SELECT terms FROM rental_agreement_versions", row => [safeJson(row.terms)]],
    ["SELECT details FROM request_audit", row => [safeJson(row.details)]],
    ["SELECT metadata FROM admin_audit_log", row => [safeJson(row.metadata)]]
  ];
  for (const [sql, select] of queries) {
    const [rows] = await pool.execute(sql);
    for (const row of rows) for (const value of select(row)) {
      for (const string of collectStrings(value)) {
        const key = keyFromReference(string, config);
        if (key) refs.add(key);
      }
    }
  }
  return refs;
}

async function loadTrackedAssets(pool, now = Date.now()) {
  const [rows] = await pool.execute("SELECT provider,bucket_name,object_key FROM storage_cleanup_asset_registry");
  const assets = new Set(rows.map(row => `${row.provider}\0${row.bucket_name}\0${row.object_key}`));
  const abandonedBefore = new Date(now - 24 * 60 * 60 * 1000);
  const [leases] = await pool.execute("SELECT provider,bucket_name,object_key FROM storage_cleanup_upload_leases WHERE status='pending' AND created_at<=?", [abandonedBefore]);
  const abandoned = new Set(leases.map(row => `${row.provider}\0${row.bucket_name}\0${row.object_key}`));
  return { assets, abandoned };
}

async function listSupabaseObjects(supabase, bucket, maxObjects = 100000) {
  const found = [];
  const queue = [""];
  while (queue.length && found.length < maxObjects) {
    const prefix = queue.shift();
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`Supabase object listing failed for ${bucket}/${prefix}: ${error.message}`);
      const rows = data || [];
      for (const row of rows) {
        const key = prefix ? `${prefix}/${row.name}` : row.name;
        if (row.id == null && !row.metadata && (key === "items" || key.startsWith("items/"))) queue.push(key);
        else if (/^items\//.test(key)) found.push({ provider: "supabase", bucket, key, size: Number(row.metadata?.size || row.metadata?.contentLength || 0), lastModified: row.updated_at || row.created_at || null });
      }
      if (rows.length < 100) break;
      if (found.length >= maxObjects) break;
    }
  }
  if (queue.length || found.length >= maxObjects) throw new Error(`Storage inventory reached its ${maxObjects} object safety limit. Narrow the inventory before cleanup.`);
  return found;
}

async function listS3Objects(configuration, maxObjects = 100000) {
  const client = new S3Client({ region: configuration.region, endpoint: configuration.endpoint, forcePathStyle: configuration.forcePathStyle, credentials: configuration.credentials });
  const found = [];
  let continuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: configuration.bucket, Prefix: "items/", ContinuationToken: continuationToken, MaxKeys: 1000 }));
    for (const row of page.Contents || []) found.push({ provider: "s3", bucket: configuration.bucket, key: row.Key, size: Number(row.Size || 0), lastModified: row.LastModified || null });
    if (found.length > maxObjects) throw new Error(`S3 inventory reached its ${maxObjects} object safety limit.`);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return { client, found };
}

function s3Configuration(env = process.env) {
  if (!["STORAGE_S3_BUCKET","STORAGE_S3_REGION","STORAGE_S3_ACCESS_KEY_ID","STORAGE_S3_SECRET_ACCESS_KEY","STORAGE_PUBLIC_BASE_URL"].every(name => env[name])) return null;
  let base; try { base = new URL(env.STORAGE_PUBLIC_BASE_URL); } catch { return null; }
  return { bucket: env.STORAGE_S3_BUCKET, region: env.STORAGE_S3_REGION, endpoint: env.STORAGE_S3_ENDPOINT || undefined, forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE === "true", publicBaseUrl: base.toString().replace(/\/$/, ""), credentials: { accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY } };
}

function createStorageCleanup({ pool, supabase, env = process.env, now = () => Date.now() }) {
  const supabaseBucket = env.SUPABASE_STORAGE_BUCKET || "shedshare-media";
  const supabaseOrigin = (() => { try { return new URL(env.SUPABASE_URL).origin; } catch { return null; } })();
  const s3Config = s3Configuration(env);
  const s3BaseUrl = s3Config?.publicBaseUrl || null;
  async function inventory() {
    if (!supabase && !s3Config) throw new Error("No supported object storage provider is configured.");
    const [refs, trackedAssets, supabaseObjects, s3Data] = await Promise.all([
      loadReferencedKeys(pool, { supabaseOrigin, supabaseBucket, s3BaseUrl }),
      loadTrackedAssets(pool, now()),
      supabase ? listSupabaseObjects(supabase, supabaseBucket) : Promise.resolve([]),
      s3Config ? listS3Objects(s3Config) : Promise.resolve(null)
    ]);
    const objects = [...supabaseObjects, ...(s3Data?.found || [])];
    const retentionDays = Number(env.STORAGE_CLEANUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
    if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) throw new Error("STORAGE_CLEANUP_RETENTION_DAYS must be between 30 and 3650.");
    const cutoff = ageCutoff(retentionDays, now());
    const candidates = objects.filter(object => {
      if (refs.has(object.key)) return false;
      const identity = `${object.provider}\0${object.bucket}\0${object.key}`;
      const temporary = trackedAssets.abandoned.has(identity);
      if (!temporary && !trackedAssets.assets.has(identity)) return false;
      if (!object.lastModified || new Date(object.lastModified).getTime() > ageCutoff(temporary ? 1 : retentionDays, now()).getTime()) return false;
      return { ...object };
    }).map(object => {
      const identity = `${object.provider}\0${object.bucket}\0${object.key}`;
      const temporary = trackedAssets.abandoned.has(identity);
      return { ...object, temporary, reason: temporary ? "Unattached upload lease older than 24 hours with no database reference" : "Tracked listing asset with no live or historical references, older than configured retention window", lastModified: object.lastModified ? new Date(object.lastModified).toISOString() : null };
    });
    if (candidates.length > MAX_CANDIDATES) throw new Error(`Inventory found ${candidates.length} candidates, above the ${MAX_CANDIDATES} per-run safety limit. Review storage manually and narrow the cleanup scope.`);
    return { candidates, retentionDays, estimatedBytes: candidates.reduce((sum, item) => sum + item.size, 0), s3Client: s3Data?.client || null };
  }
  async function remove(object, s3Client) {
    if (object.provider === "supabase") {
      const { error } = await supabase.storage.from(object.bucket).remove([object.key]);
      if (error) throw new Error(error.message || "Supabase deletion failed.");
      return;
    }
    await s3Client.send(new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key }));
  }
  return { inventory, remove };
}

module.exports = { CLEANUP_LOCK, DEFAULT_RETENTION_DAYS, MAX_CANDIDATES, MAX_DELETE_PER_RUN, collectStrings, keyFromReference, loadReferencedKeys, loadTrackedAssets, listSupabaseObjects, createStorageCleanup, ageCutoff };
