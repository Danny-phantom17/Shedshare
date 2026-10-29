"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {cloudinaryConfig,enhanceWithCloudinary,createCloudinaryPhotoRouter,TRANSFORMATION}=require("../cloudinary-photo");

const credentials={cloudName:"test-cloud",apiKey:"test-key",apiSecret:"server-only",configured:true,enabled:true};
const input=Buffer.from([0xff,0xd8,0xff,0x01,0x02]);
const cleaned=Buffer.from([0xff,0xd8,0xff,0x09,0x08]);
function jsonResponse(value,status=200){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}

test("Cloudinary photo cleaning is disabled by default and requires credentials plus explicit opt-in",()=>{
  assert.equal(cloudinaryConfig({}).enabled,false);
  assert.equal(cloudinaryConfig({CLOUDINARY_CLOUD_NAME:"x",CLOUDINARY_API_KEY:"y",CLOUDINARY_API_SECRET:"z"}).enabled,false);
  assert.equal(cloudinaryConfig({CLOUDINARY_CLOUD_NAME:"x",CLOUDINARY_API_KEY:"y",CLOUDINARY_API_SECRET:"z",CLOUDINARY_PHOTO_ENHANCEMENT_ENABLED:"true"}).enabled,true);
});

test("successful enhancement returns Cloudinary-transformed bytes and deletes its temporary upload",async()=>{
  const calls=[];const fetchImpl=async(url,options={})=>{calls.push({url:String(url),options});if(String(url).endsWith("/image/upload")){const id=options.body.get("public_id");assert.equal(options.body.get("transformation"),TRANSFORMATION);assert.match(options.headers.Authorization,/^Basic /);return jsonResponse({public_id:id,secure_url:`https://res.cloudinary.com/test-cloud/image/upload/${id}.jpg`});}if(String(url).includes("res.cloudinary.com"))return new Response(cleaned,{status:200,headers:{"content-type":"image/jpeg"}});if(String(url).endsWith("/image/destroy")){assert.ok(options.body.get("timestamp"));return jsonResponse({result:"ok"});}throw new Error("Unexpected provider call");};
  const output=await enhanceWithCloudinary(input,"image/jpeg",{config:credentials,fetchImpl});assert.deepEqual(output,cleaned);assert.equal(calls.length,3);assert.ok(calls[2].url.endsWith("/image/destroy"));
});

test("Cloudinary upload errors propagate without claiming enhancement succeeded",async()=>{
  let calls=0;await assert.rejects(()=>enhanceWithCloudinary(input,"image/jpeg",{config:credentials,fetchImpl:async()=>{calls++;return jsonResponse({error:{message:"account unavailable"}},401);}}),/account unavailable/);assert.equal(calls,1);
});

test("failed preview retrieval still attempts temporary Cloudinary cleanup",async()=>{
  let id="",deleted=false;const fetchImpl=async(url,options={})=>{if(String(url).endsWith("/image/upload")){id=options.body.get("public_id");return jsonResponse({public_id:id,secure_url:`https://res.cloudinary.com/test-cloud/image/upload/${id}.jpg`});}if(String(url).includes("res.cloudinary.com"))return new Response("unavailable",{status:503});if(String(url).endsWith("/image/destroy")){deleted=options.body.get("public_id")===id;return jsonResponse({result:"ok"});}throw new Error("Unexpected provider call");};
  await assert.rejects(()=>enhanceWithCloudinary(input,"image/jpeg",{config:credentials,fetchImpl}),/could not return the cleaned image/);assert.equal(deleted,true);
});

test("authenticated photo endpoint returns only a review preview, never a Cloudinary asset URL",async t=>{
  const previous={CLOUDINARY_CLOUD_NAME:process.env.CLOUDINARY_CLOUD_NAME,CLOUDINARY_API_KEY:process.env.CLOUDINARY_API_KEY,CLOUDINARY_API_SECRET:process.env.CLOUDINARY_API_SECRET,CLOUDINARY_PHOTO_ENHANCEMENT_ENABLED:process.env.CLOUDINARY_PHOTO_ENHANCEMENT_ENABLED};
  Object.assign(process.env,{CLOUDINARY_CLOUD_NAME:"test-cloud",CLOUDINARY_API_KEY:"test-key",CLOUDINARY_API_SECRET:"test-secret",CLOUDINARY_PHOTO_ENHANCEMENT_ENABLED:"true"});
  const app=express();app.use("/api/items",createCloudinaryPhotoRouter({pool:{execute:async()=>[[]]},authenticate:(req,_res,next)=>{req.user={id:"test-user"};next();},fetchImpl:async(url,options={})=>{if(String(url).endsWith("/image/upload")){const id=options.body.get("public_id");return jsonResponse({public_id:id,secure_url:`https://res.cloudinary.com/test-cloud/image/upload/${id}.jpg`});}if(String(url).includes("res.cloudinary.com"))return new Response(cleaned,{headers:{"content-type":"image/jpeg"}});return jsonResponse({result:"ok"});}}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});t.after(()=>{server.closeAllConnections();server.close();});t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const form=new FormData();form.append("image",new Blob([Buffer.from([0xff,0xd8,0xff,0x31,0x32])],{type:"image/jpeg"}),"original.jpg");const response=await fetch(`http://127.0.0.1:${server.address().port}/api/items/photo-enhancement`,{method:"POST",headers:{Connection:"close"},body:form});const result=await response.json();assert.equal(response.status,200);assert.equal(result.imageDataUrl,`data:image/jpeg;base64,${cleaned.toString("base64")}`);assert.equal(result.cached,false);assert.equal(Object.hasOwn(result,"secure_url"),false);
});
