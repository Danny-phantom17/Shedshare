"use strict";

const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { imageType } = require("./mediaUploads");

const MAX_BYTES = 8 * 1024 * 1024;
// Basic, non-generative transformations only. Deliberately excludes auto_enhance,
// enhance, upscale, background removal, and all generative effects.
const TRANSFORMATION = "e_auto_brightness,e_auto_contrast,e_auto_color,e_sharpen:40,q_auto:good,f_jpg";
const responseCache = new Map();
const inFlight = new Map();

function cloudinaryConfig(env = process.env) {
  const credentialsPresent = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
  const explicitlyEnabled = env.CLOUDINARY_PHOTO_ENHANCEMENT_ENABLED === "true";
  return { cloudName: env.CLOUDINARY_CLOUD_NAME || "", apiKey: env.CLOUDINARY_API_KEY || "", apiSecret: env.CLOUDINARY_API_SECRET || "", configured: credentialsPresent, enabled: credentialsPresent && explicitlyEnabled };
}

function cacheKey(userId, buffer) { return `${String(userId)}:${crypto.createHash("sha256").update(buffer).digest("hex")}`; }
function cacheGet(key) { const entry=responseCache.get(key);if(!entry)return null;if(entry.expiresAt<=Date.now()){responseCache.delete(key);return null;}return entry.buffer; }
function cacheSet(key, buffer) { responseCache.set(key,{buffer,expiresAt:Date.now()+15*60*1000});while(responseCache.size>50)responseCache.delete(responseCache.keys().next().value); }
function jsonHeaders(config) { return { Authorization:`Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64")}` }; }

async function enhanceWithCloudinary(buffer, mime, { config = cloudinaryConfig(), fetchImpl = fetch } = {}) {
  if (!config.enabled) { const error=new Error(config.configured ? "Cloudinary photo cleaning is disabled until CLOUDINARY_PHOTO_ENHANCEMENT_ENABLED=true is explicitly set after reviewing account usage." : "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET on the server first.");error.status=503;throw error; }
  const publicId=`shedshare-clean-preview/${crypto.randomUUID()}`;
  const timestamp=Math.floor(Date.now()/1000);
  let uploaded=false;
  try {
    const form=new FormData();
    form.append("file",new Blob([buffer],{type:mime}),`listing-photo.${mime==="image/png"?"png":mime==="image/webp"?"webp":"jpg"}`);
    form.append("public_id",publicId);form.append("timestamp",String(timestamp));form.append("transformation",TRANSFORMATION);form.append("overwrite","false");form.append("tags","shedshare-clean-preview");
    const base=`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image`;
    const uploadResponse=await fetchImpl(`${base}/upload`,{method:"POST",headers:jsonHeaders(config),body:form,signal:AbortSignal.timeout(30_000)});
    const uploadPayload=await uploadResponse.json().catch(()=>({}));
    if(!uploadResponse.ok||!uploadPayload.secure_url||uploadPayload.public_id!==publicId){const error=new Error(uploadPayload.error?.message||"Cloudinary could not clean this photo.");error.status=uploadResponse.status;throw error;}
    uploaded=true;
    const transformedUrl=new URL(uploadPayload.secure_url);
    if(transformedUrl.protocol!=="https:"||transformedUrl.hostname!=="res.cloudinary.com"||transformedUrl.pathname.split("/")[1]!==config.cloudName)throw new Error("Cloudinary returned an unexpected preview URL.");
    const imageResponse=await fetchImpl(transformedUrl,{method:"GET",redirect:"error",signal:AbortSignal.timeout(30_000)});
    if(!imageResponse.ok)throw new Error("Cloudinary created the preview but could not return the cleaned image.");
    const outputType=(imageResponse.headers.get("content-type")||"").split(";")[0].toLowerCase();
    const outputBuffer=Buffer.from(await imageResponse.arrayBuffer());
    if(!imageType(outputBuffer)||outputType!=="image/jpeg")throw new Error("Cloudinary returned an unsupported image format.");
    if(outputBuffer.length>MAX_BYTES){const error=new Error("The cleaned image is larger than ShedShare’s 8 MiB upload limit. Keep the original photo.");error.status=413;throw error;}
    return outputBuffer;
  } finally {
    if(uploaded){
      try { const deletion=new FormData();deletion.append("public_id",publicId);deletion.append("timestamp",String(Math.floor(Date.now()/1000)));deletion.append("invalidate","false");const removed=await fetchImpl(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/destroy`,{method:"POST",headers:jsonHeaders(config),body:deletion,signal:AbortSignal.timeout(10_000)});const result=await removed.json().catch(()=>({}));if(!removed.ok||result.result!=="ok")console.error("Temporary Cloudinary photo cleanup failed; review the tagged shedshare-clean-preview asset."); }
      catch(_error){console.error("Temporary Cloudinary photo cleanup failed; review the tagged shedshare-clean-preview asset.");}
    }
  }
}

function createCloudinaryPhotoRouter({ pool, authenticate, fetchImpl = fetch }) {
  const router=express.Router();
  const upload=multer({storage:multer.memoryStorage(),limits:{files:1,fileSize:MAX_BYTES}});
  const limiter=rateLimit({windowMs:15*60_000,limit:4,standardHeaders:"draft-8",legacyHeaders:false,keyGenerator:req=>String(req.user.id),message:{error:"Photo cleaning is rate limited. Keep the original or try again later."}});
  router.post("/photo-enhancement",authenticate,limiter,(req,res,next)=>upload.single("image")(req,res,error=>{if(error instanceof multer.MulterError&&error.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Photo must be 8 MiB or smaller."});if(error)return res.status(400).json({error:"Invalid photo upload."});next();}),async(req,res)=>{
    const config=cloudinaryConfig();if(!config.enabled)return res.status(503).json({error:config.configured?"Cloudinary photo cleaning is disabled until the account configuration and usage are approved.":"Cloudinary photo cleaning is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to the server environment."});
    let source=req.file?.buffer||null;
    if(req.body?.itemId!==undefined){if(typeof req.body.itemId!=="string"||!/^\d+$/.test(req.body.itemId))return res.status(400).json({error:"Invalid listing."});try{const [rows]=await pool.execute("SELECT image FROM items WHERE id=? AND owner_id=? LIMIT 1",[req.body.itemId,req.user.id]);if(!rows.length)return res.status(404).json({error:"Listing not found or you are not its owner."});if(!source){if(!rows[0].image)return res.status(400).json({error:"This listing has no saved photo to clean."});const storageOrigin=(()=>{try{return new URL(process.env.SUPABASE_URL).origin;}catch{return "";}})();let imageUrl;try{imageUrl=new URL(rows[0].image);}catch{return res.status(409).json({error:"The saved photo cannot be loaded for cleaning. Upload the image again instead."});}if(!storageOrigin||imageUrl.origin!==storageOrigin)return res.status(409).json({error:"The saved photo is not in ShedShare storage. Upload the image again before cleaning it."});const sourceResponse=await fetchImpl(imageUrl,{redirect:"error",signal:AbortSignal.timeout(10_000)});if(!sourceResponse.ok)return res.status(502).json({error:"Could not retrieve the saved original photo. It remains unchanged."});source=Buffer.from(await sourceResponse.arrayBuffer());if(source.length>MAX_BYTES)return res.status(413).json({error:"The saved photo exceeds ShedShare’s 8 MiB limit. Upload a smaller photo to clean it."});}}catch(error){if(res.headersSent)return;console.error("Loading saved photo for Cloudinary failed:",error.message);return res.status(502).json({error:"Could not retrieve the saved original photo. It remains unchanged."});}}
    if(!source)return res.status(400).json({error:"Choose a photo to clean."});const type=imageType(source);if(!type)return res.status(415).json({error:"Choose a JPEG, PNG, or WebP photo."});
    const key=cacheKey(req.user.id,source),cached=cacheGet(key);if(cached)return res.json({imageDataUrl:`data:image/jpeg;base64,${cached.toString("base64")}`,cached:true});
    try{let pending=inFlight.get(key),wasCached=Boolean(pending);if(!pending){pending=enhanceWithCloudinary(source,type.mime,{config,fetchImpl}).then(result=>{cacheSet(key,result);return result;}).finally(()=>inFlight.delete(key));inFlight.set(key,pending);}const result=await pending;return res.json({imageDataUrl:`data:image/jpeg;base64,${result.toString("base64")}`,cached:wasCached});}
    catch(error){if(error.status===503)return res.status(503).json({error:error.message});if(error.status===413)return res.status(413).json({error:error.message});console.error("Cloudinary photo enhancement failed:",error.message);return res.status(502).json({error:"Cloudinary could not clean this photo right now. Your original remains unchanged; you can retry or continue with the original."});}
  });
  return router;
}

module.exports={createCloudinaryPhotoRouter,cloudinaryConfig,enhanceWithCloudinary,TRANSFORMATION,MAX_BYTES};
