"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createRentalTrustRouter,trustSummary}=require("../rental-trust");

const validListerReview={overallRating:5,communicationRating:4,accuracyRating:5,reliabilityRating:5,fulfillmentRating:4,body:"The item was accurately described and the lister communicated clearly throughout this completed rental."};
async function serverFor(t,{userId="20",rental={id:101,owner_id:10,renter_id:20,status:"completed",payment_verified_at:new Date(),safety_hold:0},alreadyReviewed=false,insertDuplicate=false,access=true}={}){
  const calls=[];const connection={beginTransaction:async()=>{},rollback:async()=>{},commit:async()=>{},release:()=>{},execute:async(sql,values=[])=>{calls.push({sql,values});if(sql.startsWith("SELECT id,owner_id,renter_id,status,payment_verified_at,safety_hold FROM rentals"))return [[rental],[]];if(sql.startsWith("SELECT id FROM rental_party_reviews WHERE rental_id"))return [alreadyReviewed?[{id:77}]:[],[]];if(sql.startsWith("INSERT INTO rental_party_reviews")){if(insertDuplicate){const error=new Error("duplicate");error.code="ER_DUP_ENTRY";throw error;}return [{insertId:88},[]];}if(sql.startsWith("INSERT INTO notifications"))return [{affectedRows:0},[]];throw new Error(`Unexpected transaction SQL ${sql}`);}};
  const pool={getConnection:async()=>connection,execute:async(sql,values=[])=>{calls.push({sql,values});if(sql.startsWith("SELECT id FROM rentals WHERE owner_id=? AND renter_id=?"))return [access?[{id:1}]:[],[]];throw new Error(`Unexpected SQL ${sql}`);}};
  const app=express();app.use(express.json());app.use("/api/trust",createRentalTrustRouter({pool,authenticate:(req,_res,next)=>{req.user={id:userId};next();}}));const instance=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>{instance.closeAllConnections();instance.close();});return {server:instance,calls};
}
async function postReview(server,body=validListerReview){return fetch(`http://127.0.0.1:${server.address().port}/api/trust/rentals/101/reviews`,{method:"POST",headers:{"content-type":"application/json",Connection:"close"},body:JSON.stringify(body)});}

test("only a participant can review a completed, payment-verified rental and lister accuracy is captured",async t=>{
  const {server,calls}=await serverFor(t);const response=await postReview(server);const body=await response.json();assert.equal(response.status,201);assert.equal(body.status,"pending");const insert=calls.find(call=>call.sql.startsWith("INSERT INTO rental_party_reviews"));assert.ok(insert);assert.deepEqual(insert.values.slice(1,5),["20",10,"lister",5]);assert.equal(insert.values[6],5);assert.match(insert.sql,/status\) VALUES\(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,'pending'\)/);
});

test("lister reviews target the renter and cannot submit an item accuracy score",async t=>{
  const {server}=await serverFor(t,{userId:"10"});const response=await postReview(server,{...validListerReview,accuracyRating:4});assert.equal(response.status,400);assert.match((await response.json()).error,/only when reviewing a lister/);
});

test("a lister can rate the renter without an item-accuracy field",async t=>{
  const {server,calls}=await serverFor(t,{userId:"10"});const body={...validListerReview};delete body.accuracyRating;const response=await postReview(server,body);assert.equal(response.status,201);const insert=calls.find(call=>call.sql.startsWith("INSERT INTO rental_party_reviews"));assert.equal(insert.values[2],20);assert.equal(insert.values[3],"renter");assert.equal(insert.values[6],null);
});

test("renter review requires item accuracy and duplicate rental reviews are rejected",async t=>{
  const noAccuracy={...validListerReview};delete noAccuracy.accuracyRating;const {server:candidate}=await serverFor(t);const invalid=await postReview(candidate,noAccuracy);assert.equal(invalid.status,400);
  const {server}=await serverFor(t,{alreadyReviewed:true});const duplicate=await postReview(server);assert.equal(duplicate.status,409);assert.match((await duplicate.json()).error,/already submitted/);
  const {server:raced}=await serverFor(t,{insertDuplicate:true});const race=await postReview(raced);assert.equal(race.status,409);assert.match((await race.json()).error,/already submitted/);
});

test("unpaid, incomplete, or safety-held rentals cannot receive reviews",async t=>{
  const {server}=await serverFor(t,{rental:{id:101,owner_id:10,renter_id:20,status:"active",payment_verified_at:new Date(),safety_hold:0}});const active=await postReview(server);assert.equal(active.status,409);
  const {server:held}=await serverFor(t,{rental:{id:101,owner_id:10,renter_id:20,status:"completed",payment_verified_at:new Date(),safety_hold:1}});const hold=await postReview(held);assert.equal(hold.status,409);
});

test("account verification stays separate from verified completed rentals and empty ratings",()=>{
  const summary=trustSummary({email_verified:1,lister_completed_rentals:0,lister_average_rating:null,lister_review_count:0,lister_communication_rating:null,lister_accuracy_rating:null,lister_reliability_rating:null,lister_fulfillment_rating:null},"lister");assert.equal(summary.account.emailVerified,true);assert.equal(summary.completedVerifiedRentals,0);assert.equal(summary.averageRating,null);assert.equal(summary.reviewCount,0);assert.deepEqual(summary.reviews,[]);
});

test("renter trust details are not available to listers without a rental relationship",async t=>{
  const {server}=await serverFor(t,{access:false});const response=await fetch(`http://127.0.0.1:${server.address().port}/api/trust/renters/44`,{headers:{Connection:"close"}});assert.equal(response.status,403);assert.match((await response.json()).error,/only to listers/);
});

test("public lister profile exposes anonymized approved reviews and no private account contact fields",async t=>{
  const app=express();app.use(express.json());app.use("/api/trust",createRentalTrustRouter({authenticate:(_req,_res,next)=>next(),pool:{execute:async(sql)=>{if(sql.startsWith("SELECT id FROM items"))return [[{id:5}],[]];if(sql.includes("FROM users u WHERE u.id"))return [[{email_verified:1,lister_completed_rentals:3,lister_average_rating:"4.50",lister_review_count:2,lister_communication_rating:"4",lister_accuracy_rating:"5",lister_reliability_rating:"4",lister_fulfillment_rating:"4"}],[]];if(sql.startsWith("SELECT rv.id"))return [[{id:7,target_role:"lister",overall_rating:5,communication_rating:5,accuracy_rating:5,reliability_rating:5,fulfillment_rating:5,body:"The item matched its listing and the lister followed the agreed return arrangements.",created_at:new Date(),item_name:"Camera"}],[]];throw new Error(`Unexpected SQL ${sql}`);}}}));const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});t.after(()=>{server.closeAllConnections();server.close();});const response=await fetch(`http://127.0.0.1:${server.address().port}/api/trust/listers/10`,{headers:{Connection:"close"}});const body=await response.json();assert.equal(response.status,200);assert.equal(body.lister.averageRating,4.5);assert.equal(body.lister.completedVerifiedRentals,3);assert.equal(body.lister.account.emailVerified,true);assert.equal(body.lister.reviews[0].verifiedRental,true);assert.equal(body.lister.reviews[0].authorRole,"renter");assert.equal(JSON.stringify(body).includes("@"),false);assert.equal(JSON.stringify(body).includes("phone"),false);assert.equal(Object.hasOwn(body.lister.reviews[0],"authorId"),false);
});
