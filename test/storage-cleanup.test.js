"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStorageCleanup, keyFromReference, loadReferencedKeys, ageCutoff, CLEANUP_LOCK } = require("../storage-cleanup");
const { createMediaUploadsRouter } = require("../mediaUploads");
const { videoObjectKey } = require("../videoUploads");
const express = require("express");
const { createAdminRouter } = require("../admin");

test("storage reference parser recognizes listing URLs and excludes unrelated/private paths", () => {
  const config = { supabaseOrigin: "https://project.supabase.co", supabaseBucket: "shedshare-media", s3BaseUrl: "https://cdn.example.test/media" };
  assert.equal(keyFromReference("https://project.supabase.co/storage/v1/object/public/shedshare-media/items/5/photo.jpg", config), "items/5/photo.jpg");
  assert.equal(keyFromReference("https://cdn.example.test/media/items/videos/2026/clip.mp4", config), "items/videos/2026/clip.mp4");
  assert.equal(keyFromReference("requests/5/reference.jpg", config), null);
  assert.equal(keyFromReference("items/../secret", config), null);
});

test("video asset references resolve only within the configured storage origin", () => {
  const configuration = { configured: true, publicBaseUrl: "https://cdn.example.test/media", bucket: "video-bucket" };
  assert.equal(videoObjectKey("https://cdn.example.test/media/items/videos/clip.mp4", { supabase: null, configuration }), "items/videos/clip.mp4");
  assert.equal(videoObjectKey("https://evil.example.test/media/items/videos/clip.mp4", { supabase: null, configuration }), null);
});

test("inventory retains referenced originals and old agreement media, and reports only stale orphan objects", async () => {
  const db = { execute: async sql => {
    if (sql.includes("FROM items")) return [[{ image: "items/9/active.jpg", original_image: null, video: null }], []];
    if (sql.includes("FROM rental_agreement_versions")) return [[{ terms: JSON.stringify({ photo: "items/9/old-agreement.jpg" }) }], []];
    if (sql.includes("storage_cleanup_asset_registry a JOIN rentals")) return [[{ object_key: "items/9/old-agreement.jpg" }], []];
    if (sql.includes("FROM storage_cleanup_asset_registry")) return [["active.jpg","old-agreement.jpg","abandoned.jpg","recent.jpg"].map(name => ({ provider: "supabase", bucket_name: "shedshare-media", object_key: `items/9/${name}` })), []];
    return [[], []];
  } };
  const files = {
    "": [{ name: "items", id: null }],
    "items": [{ name: "9", id: null }],
    "items/9": [
      { name: "active.jpg", id: "a", metadata: { size: 10 }, updated_at: "2025-01-01T00:00:00Z" },
      { name: "old-agreement.jpg", id: "b", metadata: { size: 20 }, updated_at: "2025-01-01T00:00:00Z" },
      { name: "abandoned.jpg", id: "c", metadata: { size: 30 }, updated_at: "2025-01-01T00:00:00Z" },
      { name: "recent.jpg", id: "d", metadata: { size: 40 }, updated_at: "2026-10-26T00:00:00Z" }
    ]
  };
  const supabase = { storage: { from: () => ({ list: async prefix => ({ data: files[prefix] || [], error: null }) }) } };
  const cleanup = createStorageCleanup({ pool: db, supabase, env: { SUPABASE_URL: "https://project.supabase.co", SUPABASE_STORAGE_BUCKET: "shedshare-media", STORAGE_CLEANUP_RETENTION_DAYS: "30" }, now: () => Date.parse("2026-10-27T00:00:00Z") });
  const result = await cleanup.inventory();
  assert.deepEqual(result.candidates.map(item => item.key), ["items/9/abandoned.jpg"]);
  assert.equal(result.estimatedBytes, 30);
});

test("reference scan inspects listing, request, chat, handover and agreement history", async () => {
  const seen = [];
  const db = { execute: async sql => {
    seen.push(sql);
    if (sql.includes("FROM rental_agreement_versions")) return [[{ terms: JSON.stringify({ media: "items/1/historic.jpg" }) }], []];
    return [[], []];
  } };
  const refs = await loadReferencedKeys(db, { supabaseOrigin: null, supabaseBucket: "shedshare-media", s3BaseUrl: null });
  assert.ok(refs.has("items/1/historic.jpg"));
  for (const table of ["items", "item_requests", "chat_messages", "rental_handover_records", "rentals", "rental_agreement_versions", "request_audit", "admin_audit_log"]) assert.ok(seen.some(sql => sql.includes(`FROM ${table}`)));
});

test("cleanup retention cutoff is deterministic", () => {
  assert.equal(ageCutoff(30, Date.parse("2026-10-31T00:00:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
});

test("only upload leases older than 24 hours are considered abandoned temporary objects", async () => {
  const db = { execute: async (sql) => {
    if (sql.includes("FROM storage_cleanup_upload_leases")) return [[{ provider: "supabase", bucket_name: "shedshare-media", object_key: "items/4/pending.jpg" }], []];
    return [[], []];
  } };
  const files = { "": [{ name: "items", id: null }], items: [{ name: "4", id: null }], "items/4": [{ name: "pending.jpg", id: "x", metadata: { size: 12 }, updated_at: "2026-10-25T00:00:00Z" }] };
  const supabase = { storage: { from: () => ({ list: async prefix => ({ data: files[prefix] || [], error: null }) }) } };
  const cleanup = createStorageCleanup({ pool: db, supabase, env: { SUPABASE_URL: "https://project.supabase.co", SUPABASE_STORAGE_BUCKET: "shedshare-media" }, now: () => Date.parse("2026-10-27T00:00:00Z") });
  const report = await cleanup.inventory();
  assert.equal(report.candidates.length, 1); assert.equal(report.candidates[0].temporary, true);
});

test("failed provider deletion can be retried without claiming success", async () => {
  let attempts = 0;
  const cleanup = createStorageCleanup({ pool: { execute: async () => [[], []] }, supabase: { storage: { from: () => ({ remove: async () => { attempts += 1; return attempts === 1 ? { error: { message: "temporary storage error" } } : { error: null }; } }) } }, env: {} });
  const candidate = { provider: "supabase", bucket: "shedshare-media", key: "items/2/orphan.jpg" };
  await assert.rejects(cleanup.remove(candidate), /temporary storage error/);
  await cleanup.remove(candidate);
  assert.equal(attempts, 2);
});

test("concurrent media cleanup lock blocks a new listing photo upload", async t => {
  let stored = false;
  const connection = { execute: async sql => sql.startsWith("SELECT GET_LOCK") ? [[{ acquired: 0 }], []] : [[{}], []], release() {} };
  const app = express(); app.use("/api/items", createMediaUploadsRouter({ pool: { getConnection: async () => connection }, supabase: { storage: { from: () => ({ upload: async () => { stored = true; return { error: null }; } }) } }, authenticate: (req, _res, next) => { req.user = { id: 7 }; next(); } }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const form = new FormData(); form.append("image", new Blob([Buffer.from([0xff,0xd8,0xff])], { type: "image/jpeg" }), "item.jpg");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/items/2/image`, { method: "PUT", headers: { Connection: "close" }, body: form });
  assert.equal(response.status, 503); assert.equal(stored, false); assert.equal(CLEANUP_LOCK, "shedshare_storage_cleanup_v1");
});

test("storage cleanup reports remain administrator-only", async t => {
  let queries = 0;
  const app = express(); app.use(express.json());
  app.use("/api/admin", createAdminRouter({ pool: { execute: async () => { queries += 1; return [[], []]; } }, authenticate: (req, _res, next) => { req.user = { id: 7, isAdmin: false }; next(); }, securityEvents: null }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/storage-cleanup/runs/1`, { headers: { Connection: "close" } });
  assert.equal(response.status, 403); assert.equal(queries, 0);
});
