"use strict";

require("dotenv").config();

const mysql = require("mysql2/promise");
const { createClient } = require("@supabase/supabase-js");

const sourceBucket = process.env.SUPABASE_STORAGE_BUCKET || "shedshare-media";
const privateBucket = process.env.REQUEST_PRIVATE_STORAGE_BUCKET || "shedshare-request-references-private";
const applying = process.argv.includes("--apply");

function privateKey(value, ownerId) {
  if (typeof value !== "string" || !/^requests\/\d+\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(value)) return false;
  return value.startsWith(`requests/${String(ownerId)}/`);
}

function getLegacyObjectKey(value, ownerId, supabaseOrigin) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== supabaseOrigin) return null;
    const prefix = `/storage/v1/object/public/${encodeURIComponent(sourceBucket)}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!key.startsWith(`requests/${String(ownerId)}/`) || !privateKey(key, ownerId)) return null;
    return key;
  } catch (_error) { return null; }
}

async function main() {
  const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "SUPABASE_URL"];
  const missing = required.filter((name) => !process.env[name]);
  if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SECRET_KEY");
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  if (sourceBucket === privateBucket) throw new Error("The request reference bucket must differ from the public media bucket.");

  const supabaseUrl = new URL(process.env.SUPABASE_URL);
  if (supabaseUrl.protocol !== "https:") throw new Error("SUPABASE_URL must use HTTPS.");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionLimit: 2, timezone: "Z" });

  try {
    const { data: bucket, error: bucketError } = await supabase.storage.getBucket(privateBucket);
    if (bucketError || !bucket || bucket.public) throw new Error(`Create ${privateBucket} as a private Supabase Storage bucket before migration.`);
    const [rows] = await pool.execute("SELECT id,customer_id,reference_image_url FROM item_requests WHERE reference_image_url IS NOT NULL ORDER BY id");
    const candidates = rows.map((row) => ({ ...row, key: getLegacyObjectKey(row.reference_image_url, row.customer_id, supabaseUrl.origin) })).filter((row) => row.key);
    const alreadyPrivate = rows.filter((row) => privateKey(row.reference_image_url, row.customer_id)).length;
    const unrecognized = rows.length - candidates.length - alreadyPrivate;
    console.log(`${applying ? "Applying" : "Dry run"}: ${candidates.length} public reference image(s) can be moved; ${alreadyPrivate} already use private keys; ${unrecognized} unrecognized value(s) will be left unchanged.`);
    if (!applying) {
      console.log("No files or database rows changed. Rerun with --apply to copy images, update rows, and remove old public objects.");
      return;
    }

    let moved = 0, failed = 0;
    for (const row of candidates) {
      try {
        const { data, error: downloadError } = await supabase.storage.from(sourceBucket).download(row.key);
        if (downloadError || !data) throw new Error("Could not read source image.");
        const extension = row.key.split(".").pop().toLowerCase();
        const contentType = extension === "jpg" ? "image/jpeg" : extension === "png" ? "image/png" : "image/webp";
        const { error: uploadError } = await supabase.storage.from(privateBucket).upload(row.key, Buffer.from(await data.arrayBuffer()), { contentType, cacheControl: "0", upsert: true });
        if (uploadError) throw new Error("Could not write private image.");
        const [update] = await pool.execute("UPDATE item_requests SET reference_image_url=? WHERE id=? AND reference_image_url=?", [row.key, row.id, row.reference_image_url]);
        if (!update.affectedRows) {
          await supabase.storage.from(privateBucket).remove([row.key]);
          throw new Error("Request changed during migration; private copy was removed.");
        }
        const { error: removeError } = await supabase.storage.from(sourceBucket).remove([row.key]);
        if (removeError) throw new Error("Private copy is active, but old public image could not be removed.");
        moved += 1;
      } catch (error) {
        failed += 1;
        console.error(`Request ${row.id} migration failed: ${error.message}`);
      }
    }
    console.log(`Migration finished: ${moved} moved, ${failed} failed.`);
    if (failed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Request image migration failed: ${error.message}`);
  process.exitCode = 1;
});
