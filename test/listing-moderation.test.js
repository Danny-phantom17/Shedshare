"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {DEFAULT_POLICY,parseAssessment,policyMatch}=require("../listing-moderation");
const {createItemsRouter,buildBudgetSearchQuery}=require("../items");
const {createAdminRouter}=require("../admin");
const oldGeminiKey=process.env.GEMINI_API_KEY,oldAiFeatures=process.env.AI_FEATURES_ENABLED;
process.env.GEMINI_API_KEY="test-gemini-key-not-used-by-mocked-moderation";process.env.AI_FEATURES_ENABLED="true";
const oldSupabaseUrl=process.env.SUPABASE_URL;
process.env.SUPABASE_URL="https://demo.supabase.co";
test.after(()=>{if(oldGeminiKey===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=oldGeminiKey;if(oldAiFeatures===undefined)delete process.env.AI_FEATURES_ENABLED;else process.env.AI_FEATURES_ENABLED=oldAiFeatures;if(oldSupabaseUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldSupabaseUrl;});

const answer=(recommendation="approve",confidence=.99,concerns=[])=>JSON.stringify({itemSummary:"Portable table fan",shortDescription:"A black portable electric fan with a circular grille.",recommendation,confidence,concerns});

test("safe listings auto-approve and low value, small, unusual items are not policy concerns",()=>{
  const result=parseAssessment(answer(),{name:"Small used fan",category:"Other",description:"Cheap portable fan"},DEFAULT_POLICY);
  assert.equal(result.outcome,"auto_approved");assert.equal(result.shortDescription,"A black portable electric fan with a circular grille.");
});

test("AI concern, uncertainty, prohibited configured terms, and malformed output require human review",()=>{
  assert.equal(parseAssessment(answer("review",.99,["possible weapon in photo"]),{name:"Tool",category:"Other"}).outcome,"pending_review");
  assert.equal(parseAssessment(answer("approve",.55),{name:"Unknown item",category:"Other"}).outcome,"pending_review");
  assert.equal(parseAssessment(answer(),{name:"Item",category:"Other",description:"Replica firearm"},{...DEFAULT_POLICY,prohibitedTerms:["firearm"]}).outcome,"pending_review");
  assert.throws(()=>parseAssessment("not json",{name:"Item"}),/invalid moderation response/);
  assert.equal(policyMatch("begun working on it",["gun"]),null);
});

function moderationPool({itemStatus="pending_analysis",assessment}){
  const state={itemStatus,jobStatus:null,audit:[],notifications:[],assessment};
  const item={id:1,owner_id:8,name:"Fan",category:"Other",item_condition:"Good",description:"Black desk fan",ai_description:null,image:"https://demo.supabase.co/storage/v1/object/public/shedshare-media/items/8/fan.jpg",city:"Lagos",state:"Lagos",area_name:"Yaba",latitude:null,longitude:null,price:2500,moderation_status:itemStatus,paused:0};
  const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},execute:async(sql,values=[])=>{
    if(sql.includes("FROM items WHERE id=? FOR UPDATE"))return [[{...item,moderation_status:state.itemStatus}]];
    if(sql.includes("FROM listing_moderation_settings"))return [[{enabled:true,policy_text:DEFAULT_POLICY.policyText,prohibited_terms:[],review_terms:[],auto_approval_confidence:.9}]];
    if(sql.includes("FROM ai_control_settings"))return [[{enabled:true}]];
    if(sql.includes("FROM listing_moderation_jobs WHERE item_id=? FOR UPDATE"))return [state.jobStatus?[{id:2,status:state.jobStatus,input_hash:"different",updated_at:new Date()}]:[]];
    if(sql.startsWith("INSERT INTO listing_moderation_jobs")){state.jobStatus="processing";return [{insertId:2}];}
    if(sql.includes("UPDATE listing_moderation_jobs SET submitted_by")){state.jobStatus="processing";return [{affectedRows:1}];}
    if(sql.includes("SELECT status FROM listing_moderation_jobs"))return [[{status:state.jobStatus}]];
    if(sql.startsWith("UPDATE items SET moderation_status")){state.itemStatus=values[0];return [{affectedRows:1}];}
    if(sql.includes("UPDATE listing_moderation_jobs SET status='completed'")){state.jobStatus="completed";return [{affectedRows:1}];}
    if(sql.includes("INSERT INTO listing_moderation_audit")){state.audit.push(values);return [{insertId:1}];}
    if(sql.includes("INSERT INTO notifications")){state.notifications.push(values);return [{insertId:1}];}
    throw new Error(`Unexpected mock SQL: ${sql}`);
  }};
  const pool={getConnection:async()=>connection,execute:async sql=>{if(sql.includes("FROM referrals"))return [[]];if(sql.includes("COUNT(*) total FROM items"))return [[{total:1}]];if(sql.includes("FROM location_alerts"))return [[]];throw new Error(`Unexpected pool SQL: ${sql}`);}};
  return {pool,connection,state,item};
}

async function startModerationServer(t,options={}){
  const mocks=moderationPool(options),supabase={storage:{from:()=>({download:async()=>({data:new Blob([Buffer.from([0xff,0xd8,0xff,1])]),error:null})})}};
  const app=express();app.use(express.json());app.use("/api/items",createItemsRouter({pool:mocks.pool,supabase,moderateListing:async()=>{if(options.throwAi)throw new Error("Gemini unavailable");return options.assessment||parseAssessment(answer(),mocks.item,DEFAULT_POLICY);},authenticate:(req,_res,next)=>{req.user={id:"8",emailVerified:true};next();}}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});t.after(()=>{server.closeAllConnections();server.close();});return {...mocks,server};
}

test("listing moderation publishes safe items and sends one success notification",async t=>{
  const mock=await startModerationServer(t),response=await fetch(`http://127.0.0.1:${mock.server.address().port}/api/items/1/moderate`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.status,"approved",JSON.stringify(body));assert.equal(mock.state.itemStatus,"approved");assert.equal(mock.state.audit.length,1);assert.equal(mock.state.notifications.length,1);
});

test("Gemini errors and flagged assessments leave the listing private and pending review",async t=>{
  const flagged=await startModerationServer(t,{assessment:parseAssessment(answer("review",.8,["safety unclear"]),{name:"Fan"})});
  const flaggedResponse=await fetch(`http://127.0.0.1:${flagged.server.address().port}/api/items/1/moderate`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});assert.equal((await flaggedResponse.json()).status,"pending_review");assert.equal(flagged.state.itemStatus,"pending_review");
  const failed=await startModerationServer(t,{throwAi:true});const failedResponse=await fetch(`http://127.0.0.1:${failed.server.address().port}/api/items/1/moderate`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});assert.equal((await failedResponse.json()).status,"pending_review");assert.equal(failed.state.notifications.length,1);
});

test("admin-only listing moderation policy and listing decisions are audited and notify the lister",async t=>{
  const state={status:"pending_review",audit:0,notices:0};const pool={getConnection:async()=>({beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},execute:async sql=>{if(sql.includes("FROM items WHERE id=? FOR UPDATE"))return [[{id:1,owner_id:8,name:"Fan",category:"Other",price:1,city:"Lagos",state:"Lagos",area_name:"Yaba",latitude:null,longitude:null,moderation_status:state.status,ai_description:"Fan"}]];if(sql.includes("UPDATE items SET moderation_status")){state.status="approved";return [{affectedRows:1}];}if(sql.includes("INSERT INTO listing_moderation_audit")){state.audit++;return [{insertId:1}];}if(sql.includes("INSERT INTO admin_audit_log"))return [{insertId:1}];if(sql.includes("INSERT INTO notifications")){state.notices++;return [{insertId:1}];}throw new Error(sql);}}),execute:async()=>[[]]};
  const app=express();app.use(express.json());app.use("/api/admin",createAdminRouter({pool,authenticate:(req,_res,next)=>{req.user={id:"4",isAdmin:true};next();}}));const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});t.after(()=>{server.closeAllConnections();server.close();});const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/listings/1/moderation`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"approve",reason:"Reviewed the submitted listing and photo."})});assert.equal(response.status,200);assert.equal(state.status,"approved");assert.equal(state.audit,1);assert.equal(state.notices,1);
  const nonAdmin=express();nonAdmin.use(express.json());nonAdmin.use("/api/admin",createAdminRouter({pool,authenticate:(req,_res,next)=>{req.user={id:"8",isAdmin:false};next();}}));const other=await new Promise(resolve=>{const instance=nonAdmin.listen(0,"127.0.0.1",()=>resolve(instance));});t.after(()=>{other.closeAllConnections();other.close();});const denied=await fetch(`http://127.0.0.1:${other.address().port}/api/admin/listings/moderation`);assert.equal(denied.status,403);
});

test("public budget search requires approved moderation status",()=>{assert.match(buildBudgetSearchQuery({}).sql,/i\.moderation_status='approved'/);});
