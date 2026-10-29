"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createAdminRouter}=require("../admin");

async function adminServer(t,{isAdmin=true}={}){
  const calls=[];const connection={beginTransaction:async()=>{},rollback:async()=>{},commit:async()=>{},release:()=>{},execute:async(sql,values=[])=>{calls.push({sql,values});if(sql.startsWith("SELECT id,author_id,target_user_id,status FROM rental_party_reviews"))return [[{id:7,author_id:20,target_user_id:10,status:"pending"}],[]];if(sql.startsWith("SELECT id,review_id,status FROM rental_party_review_reports"))return [[{id:9,review_id:7,status:"open"}],[]];return [{affectedRows:1},[]];}};
  const pool={getConnection:async()=>connection,execute:async(sql,values=[])=>{calls.push({sql,values});return [{affectedRows:1},[]];}};const app=express();app.use(express.json());app.use("/api/admin",createAdminRouter({pool,securityEvents:null,authenticate:(req,_res,next)=>{req.user={id:1,isAdmin};next();}}));const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});t.after(()=>{server.closeAllConnections();server.close();});return{server,calls};
}

test("rental review moderation is administrator-only and writes an audit reason",async t=>{
  const {server,calls}=await adminServer(t);const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/rental-reviews/7`,{method:"PATCH",headers:{"content-type":"application/json",Connection:"close"},body:JSON.stringify({status:"approved",reason:"Verified rental feedback with no personal information."})});assert.equal(response.status,200);assert.equal((await response.json()).status,"approved");assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO admin_audit_log")&&call.values[4].includes("Verified rental feedback")));assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO notifications")&&call.values.includes(10)));
});

test("non-admins cannot access rental review moderation",async t=>{
  const {server,calls}=await adminServer(t,{isAdmin:false});const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/rental-reviews/7`,{method:"PATCH",headers:{"content-type":"application/json",Connection:"close"},body:JSON.stringify({status:"approved",reason:"Authorized reason for approval."})});assert.equal(response.status,403);assert.equal(calls.length,0);
});

test("review report resolution requires a note and is audited",async t=>{
  const {server,calls}=await adminServer(t);const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/rental-review-reports/9`,{method:"PATCH",headers:{"content-type":"application/json",Connection:"close"},body:JSON.stringify({status:"resolved",resolution:"Reviewed the context; no policy violation was found."})});assert.equal(response.status,200);assert.equal((await response.json()).status,"resolved");assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO admin_audit_log")&&call.values[4].includes("no policy violation")));
});
